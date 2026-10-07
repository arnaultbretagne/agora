"""A flow step on Agora: one Workstream, one execution, one prompt, the agent's answer.

Every id a step sends is derived from the step's identity (run, step, round), never drawn at random:
running the same step again finds the same Workstream, and Agora answers a command it already
accepted with its first answer and writes nothing (docs/specs/log.md, "Commands"). So a step that
Prefect retries, resumes or re-runs never starts a second agent on the same work
(docs/specs/flows.md). Standard library only: the flows' image is Prefect's, unchanged.
"""

from __future__ import annotations

import json
import math
import time
import urllib.error
import urllib.request
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable

# The namespace of every id a flow derives; fixed, so that the same step gives the same ids anywhere.
NAMESPACE = uuid.uuid5(uuid.NAMESPACE_URL, "https://agora.bretagne.dev/flows")

TERMINAL = {"done", "cancelled", "failed"}
# The Workstream view's states after which the execution will not answer (docs/specs/log.md, "The Workstream view").
GONE = {"ended", "failed", "lost", "stopped"}
# Write refusals that clear on their own while the execution opens (docs/specs/log.md, "Commands").
TRANSIENT_WRITE = {"settings_pending", "opening_session", "disconnected", "unavailable"}


def step_id(run: str, step: str, round: int) -> str:
    """The step's Workstream: the same run, step and round always name the same one."""
    return str(uuid.uuid5(NAMESPACE, f"{run}/{step}/{round}"))


def command_id(workstream: str, name: str) -> str:
    """A command of the step's Workstream, named by its place in the step (`create`, `write-1`, `stop`)."""
    return str(uuid.uuid5(uuid.UUID(workstream), name))


class Escalation(Exception):
    """What the step must not decide alone: an uncertain turn, an execution gone, a refusal it cannot clear."""


@dataclass
class StepSpec:
    run: str
    step: str
    round: int
    harness: str
    prompt: str
    profiles: list[str] = field(default_factory=list)
    settings: dict[str, str] = field(default_factory=dict)
    lease_seconds: int = 300
    turn_cap_seconds: int = 3600
    poll_seconds: float = 5.0
    ready_timeout_seconds: float = 900.0

    def __post_init__(self) -> None:
        for name in ("poll_seconds", "ready_timeout_seconds"):
            value = getattr(self, name)
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not value > 0:
                raise ValueError(f"{name} must be a finite number greater than 0")


@dataclass
class StepResult:
    workstream: str
    execution: str
    status: str
    stop_reason: str | None
    text: str


class Agora:
    """Agora's server API (docs/specs/log.md, "HTTP"), reached in-cluster: the owner comes from the body."""

    def __init__(self, base: str, owner: str, timeout: float = 30.0) -> None:
        self.base = base.rstrip("/")
        self.owner = owner
        self.timeout = timeout

    def _call(self, method: str, path: str, body: dict[str, Any] | None = None) -> tuple[int, dict[str, Any]]:
        data = None if body is None else json.dumps(body).encode()
        request = urllib.request.Request(self.base + path, data=data, method=method)
        request.add_header("content-type", "application/json")
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                raw = response.read()
                return response.status, json.loads(raw) if raw else {}
        except urllib.error.HTTPError as error:
            raw = error.read()
            try:
                return error.code, json.loads(raw) if raw else {}
            except ValueError:
                return error.code, {}

    def pools(self) -> list[dict[str, Any]]:
        status, body = self._call("GET", "/api/pools")
        if status != 200:
            raise RuntimeError(f"pools: {status}")
        return body.get("pools", [])

    def pool_for(self, harness: str) -> str:
        """Pools are named after their image; a step asks for a harness."""
        for pool in self.pools():
            if pool.get("harness") == harness:
                return pool["name"]
        raise Escalation(f"no pool for harness {harness!r}")

    def ensure_workstream(self, workstream: str) -> None:
        status, body = self._call("POST", "/api/workstreams", {"id": workstream, "owner": self.owner})
        if status == 409:
            raise Escalation(f"Workstream {workstream} belongs to another owner")
        if status != 200:
            raise RuntimeError(f"create Workstream: {status} {body}")

    def command(self, workstream: str, id: str, kind: str, target: dict[str, Any], body: dict[str, Any]) -> dict[str, Any]:
        """The answer, accepted or refused with its reason; 503 is `unavailable`, worth retrying."""
        status, answer = self._call("POST", f"/api/workstreams/{workstream}/commands", {"id": id, "kind": kind, "target": target, "body": body})
        if status in (200, 409, 503):
            return answer if answer else {"accepted": False, "reason": "unavailable"}
        raise RuntimeError(f"{kind}: {status} {answer}")

    def snapshot(self, workstream: str, after: str) -> tuple[list[dict[str, Any]], str]:
        """The thread's rows after a cursor, through its high-water mark (docs/specs/log.md, "The thread")."""
        request = urllib.request.Request(f"{self.base}/api/workstreams/{workstream}/thread?after={after}")
        rows: list[dict[str, Any]] = []
        with urllib.request.urlopen(request, timeout=self.timeout) as response:
            for line in response:
                if not line.startswith(b"data: "):
                    continue
                row = json.loads(line[6:])
                if row.get("type") == "snapshot-end":
                    return rows, str(row["position"])
                rows.append(row)
        raise RuntimeError("thread closed before snapshot-end")


class Thread:
    """The step's view of its Workstream, folded from the thread's rows."""

    def __init__(self, agora: Agora, workstream: str) -> None:
        self.agora = agora
        self.workstream = workstream
        self.cursor = "0"
        self.objects: dict[tuple[str, str], dict[str, Any]] = {}

    def refresh(self) -> None:
        rows, end = self.agora.snapshot(self.workstream, self.cursor)
        self.apply(rows)
        self.cursor = end

    def apply(self, rows: list[dict[str, Any]]) -> None:
        for row in rows:
            if row.get("operation") == "reset":
                self.objects.clear()
            elif row.get("operation") == "remove":
                self.objects.pop((row["kind"], row["id"]), None)
            elif row.get("operation") == "upsert":
                self.objects[(row["kind"], row["id"])] = {**row["object"], "id": row["id"]}

    def view(self) -> dict[str, Any] | None:
        return self.objects.get(("workstream", self.workstream))

    def turns(self) -> list[dict[str, Any]]:
        """The Workstream's turns in prompt order: the step's n-th Write is its n-th turn."""
        turns = [o for (kind, _), o in self.objects.items() if kind == "turn"]
        return sorted(turns, key=lambda t: int(t.get("requestPosition") or 0))

    def text(self, turn: str) -> str:
        """The agent's answer in a turn: its message chunks in order, neither reasoning nor tools."""
        chunks = [
            o for (kind, _), o in self.objects.items()
            if kind == "element" and o.get("type") == "agent_message_chunk" and o.get("turn") == turn
        ]
        return "".join(c.get("text", "") for c in sorted(chunks, key=lambda c: int(c.get("firstPosition") or 0)))

    def pending_permission(self) -> bool:
        return any(kind == "element" and o.get("type") == "permission" and o.get("status") == "pending" for (kind, _), o in self.objects.items())


def run_step(
    agora: Agora,
    spec: StepSpec,
    log: Callable[[str], None] = print,
    sleep: Callable[[float], None] = time.sleep,
    clock: Callable[[], float] = time.monotonic,
) -> StepResult:
    """Runs the step, or finds it again where it is: created, written, answered, stopped."""
    workstream = step_id(spec.run, spec.step, spec.round)
    agora.ensure_workstream(workstream)
    thread = Thread(agora, workstream)
    thread.refresh()

    # Create: once. A replay reads the execution the first Create obtained instead of asking again —
    # the pool's name follows its image, so an identical Create cannot be counted on.
    view = thread.view()
    if view is None or view.get("state") in (None, "none"):
        body: dict[str, Any] = {
            "pool": agora.pool_for(spec.harness),
            "limits": {"leaseSeconds": spec.lease_seconds, "turnCapSeconds": spec.turn_cap_seconds},
        }
        if spec.settings:
            body["settings"] = spec.settings
        if spec.profiles:
            body["profiles"] = spec.profiles
        while True:
            answer = agora.command(workstream, command_id(workstream, "create"), "Create", {}, body)
            if answer.get("accepted"):
                log(f"{spec.step}: execution {answer['execution']} in Workstream {workstream}")
                break
            if answer.get("reason") in ("quota", "unavailable"):
                log(f"{spec.step}: Create refused ({answer['reason']}), retrying")
                sleep(15)
                continue
            raise Escalation(f"Create refused: {answer.get('reason')}")
    else:
        log(f"{spec.step}: found Workstream {workstream} in state {view.get('state')}")

    # Write: once, once the Session is open and its settings applied.
    deadline = clock() + spec.ready_timeout_seconds
    while not thread.turns():
        thread.refresh()
        if thread.turns():
            break
        view = thread.view() or {}
        state = view.get("state")
        if state in GONE:
            raise Escalation(f"execution {state} before the prompt was written")
        if state == "ready" and not view.get("configuring") and view.get("session"):
            target = {"execution": view["execution"], "session": view["session"]}
            answer = agora.command(workstream, command_id(workstream, "write-1"), "Write", target, {"prompt": [{"type": "text", "text": spec.prompt}]})
            if answer.get("accepted"):
                log(f"{spec.step}: prompt written ({answer.get('requestId')})")
                thread.refresh()
                if thread.turns():
                    break
            elif answer.get("reason") not in TRANSIENT_WRITE:
                raise Escalation(f"Write refused: {answer.get('reason')}")
        if clock() > deadline:
            raise Escalation(f"execution not ready after {spec.ready_timeout_seconds:g} s (state {state})")
        sleep(spec.poll_seconds)

    # The turn: waited for, never resent.
    warned = False
    while True:
        turn = thread.turns()[0]
        status = turn.get("status")
        if status in TERMINAL:
            break
        if status == "uncertain":
            raise Escalation(f"turn uncertain in Workstream {workstream}: Agora never resends it; decide by hand")
        if thread.pending_permission() and not warned:
            log(f"{spec.step}: the agent asks a permission — answer it in Agora, Workstream {workstream}")
            warned = True
        sleep(spec.poll_seconds)
        thread.refresh()

    view = thread.view() or {}
    result = StepResult(
        workstream=workstream,
        execution=view.get("execution") or "",
        status=status,
        stop_reason=turn.get("stopReason"),
        text=thread.text(turn["id"]),
    )
    # Stop: the execution has done its step; its claim goes at its deadline, freeing a slot of the quota.
    if view.get("state") not in GONE and view.get("execution"):
        answer = agora.command(workstream, command_id(workstream, "stop"), "Stop", {"execution": view["execution"]}, {})
        if not answer.get("accepted") and answer.get("reason") not in ("stopped", "execution_unavailable"):
            log(f"{spec.step}: Stop refused ({answer.get('reason')})")
    log(f"{spec.step}: turn {status} ({result.stop_reason}), {len(result.text)} characters")
    return result


def last_json(text: str) -> dict[str, Any] | None:
    """The last JSON object of an answer: what a step's prompt asks the agent to end with."""
    decoder = json.JSONDecoder()
    found: dict[str, Any] | None = None
    index = text.find("{")
    while index != -1:
        try:
            value, end = decoder.raw_decode(text, index)
        except ValueError:
            index = text.find("{", index + 1)
            continue
        if isinstance(value, dict):
            found = value
        index = text.find("{", end)
    return found
