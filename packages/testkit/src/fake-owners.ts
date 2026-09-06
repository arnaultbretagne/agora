// Fake owners that ENFORCE the owner contract (findings §6.2: a test double written to match our
// own implementation cannot catch our implementation being wrong — these fakes embed the real
// OwnerServer helpers and reject exactly what S6/S7 owners will reject). Injectable faults:
// drop response (accept-then-lost), delayed completion, late re-delivery after retirement.
import {
  decideOwnerRequest,
  emptyOwnerRecord,
  recordEpoch,
  recordOwnerResponse,
  retireTarget,
  type OwnerDecision,
  type OwnerRecord,
  type OwnerRequest,
  type OwnerResponse,
} from '@agora/owner-requests'

export interface FakeOwnerFaults {
  /** The owner completes the operation but the response is lost: the caller must retain unknown. */
  readonly dropResponse?: (request: OwnerRequest) => boolean
  /** Delays the response (network latency / paused worker interleavings). */
  readonly delayMs?: (request: OwnerRequest) => number
  /** Re-delivers a completed response later (duplicate delivery / late arrival). */
  readonly duplicateDelivery?: (request: OwnerRequest) => boolean
}

interface OwnedTarget {
  readonly kind: 'pod' | 'agent' | 'slot'
  readonly id: string
  readonly present: boolean
}

export class FakeOwner {
  readonly #operations: ReadonlySet<string>
  #record: OwnerRecord = emptyOwnerRecord()
  #targets = new Map<string, OwnedTarget>()
  #faults: FakeOwnerFaults
  /** Responses delivered more than once (duplicate/late delivery), for assertions. */
  readonly redelivered: OwnerRequest[] = []

  constructor(operations: readonly string[], faults: FakeOwnerFaults = {}) {
    this.#operations = new Set(operations)
    this.#faults = faults
  }

  get record(): OwnerRecord {
    return this.#record
  }

  targets(): readonly OwnedTarget[] {
    return [...this.#targets.values()]
  }

  /** Forces retirement (the engine records it too; the owner mirrors it via retireTarget). */
  retire(targetId: string): void {
    this.#record = retireTarget(this.#record, targetId)
  }

  /** Re-delivers a previously recorded completed response (late arrival, ENGINE-007). */
  async redeliver(request: OwnerRequest): Promise<OwnerResponse | null> {
    const existing = this.#record.responses.get(request.attemptKey)
    if (existing === undefined || existing.response.kind !== 'completed') return null
    this.redelivered.push(request)
    return existing.response
  }

  async handle(request: OwnerRequest): Promise<OwnerResponse> {
    const delay = this.#faults.delayMs?.(request) ?? 0
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))

    if (!this.#operations.has(request.operation)) {
      throw new Error(`unknown operation ${request.operation} for this owner`)
    }

    const decision: OwnerDecision = decideOwnerRequest({ record: this.#record, request })
    if (decision.kind === 'respond') {
      return decision.response
    }

    let response: OwnerResponse
    switch (request.operation) {
      case 'create_pod': {
        if (request.target.kind !== 'reserved') throw new Error('create_pod targets a reserved slot')
        const concrete = `pod:${request.target.id}`
        this.#targets.set(concrete, { kind: 'pod', id: concrete, present: true })
        response = { kind: 'completed', result: { podUid: concrete } }
        break
      }
      case 'cleanup_pod': {
        const concrete = request.target.id.startsWith('pod:') ? request.target.id : `pod:${request.target.id}`
        this.#targets.delete(concrete)
        response = { kind: 'completed', result: { cleaned: concrete } }
        break
      }
      case 'attach_grant': {
        this.#targets.set(request.target.id, { kind: 'agent', id: request.target.id, present: true })
        response = { kind: 'completed', result: { attached: request.target.id } }
        break
      }
      case 'detach_grant': {
        this.#targets.delete(request.target.id)
        response = { kind: 'completed', result: { detached: request.target.id } }
        break
      }
      default:
        response = { kind: 'completed', result: {} }
    }

    this.#record = recordOwnerResponse(this.#record, request, response)

    if (this.#faults.dropResponse?.(request) === true) {
      // The owner accepted and recorded; the response never reaches the caller.
      throw new Error('response lost in transit')
    }
    if (this.#faults.duplicateDelivery?.(request) === true) {
      this.redelivered.push(request)
    }
    return response
  }

  /** Takeover: the new epoch advances the owner's recorded epoch (older requests then bounce). */
  takeover(epoch: number): void {
    this.#record = recordEpoch(this.#record, epoch)
  }
}

/** Runtime control owns Pod lifecycle: create_pod / cleanup_pod (S6 implements it for real). */
export class RuntimeControlFake extends FakeOwner {
  constructor(faults: FakeOwnerFaults = {}) {
    super(['create_pod', 'cleanup_pod'], faults)
  }
}

/** Broker owns grant attachments: attach_grant / detach_grant (S7 implements it for real). */
export class BrokerFake extends FakeOwner {
  constructor(faults: FakeOwnerFaults = {}) {
    super(['attach_grant', 'detach_grant'], faults)
  }
}
