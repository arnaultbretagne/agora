// ACP Client (pinned SDK) over the journaled stream: the SDK never sees a frame before it is
// committed, and Client callbacks are confined — permissions become projected interactions that
// wait for an operator decision, and fs/terminal capabilities are advertised false in S4 (the
// harness never gets a path into this process's filesystem or a terminal).
import * as acp from '@agentclientprotocol/sdk'
import { journalDuplexStream, type DuplexByteStream, type PersistFrame } from './framing.js'

export interface ClientCallbacks {
  /**
   * A `session/request_permission` from the agent. The returned promise resolves when the operator
   * decides (through the API); the ACP response waits on it — permission interactions are facts
   * first, decisions later.
   */
  onPermissionRequest?(params: unknown): Promise<{ outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } }>
  /**
   * A `session/update` notification from the agent. Observational only — the frame is already
   * captured and committed by the persist seam before this runs, so a callback that throws can
   * never lose a fact. S8 Step 5's recovery reads the `session/load` replay through this.
   */
  onSessionUpdate?(params: unknown): void
}

export function initializeParams(cwd: string): Record<string, unknown> {
  return {
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    },
    cwd,
    mcpServers: [],
  }
}

export function buildClientConnection(
  inner: DuplexByteStream,
  persist: PersistFrame,
  callbacks: ClientCallbacks = {},
): acp.ClientConnection {
  const journaled = journalDuplexStream(inner, persist)
  const stream = acp.ndJsonStream(journaled.writable, journaled.readable)

  const app = acp.client({ name: 'agora-control-plane' })
  app.onRequest(acp.methods.client.session.requestPermission, (request: { params: unknown }) => {
    if (callbacks.onPermissionRequest === undefined) {
      return { outcome: { outcome: 'cancelled' } }
    }
    return callbacks.onPermissionRequest(request.params)
  })
  if (callbacks.onSessionUpdate !== undefined) {
    const onSessionUpdate = callbacks.onSessionUpdate
    app.onNotification(acp.methods.client.session.update, (notification: { params: unknown }) => {
      onSessionUpdate(notification.params)
    })
  }
  return app.connect(stream)
}
