"""A team member's turns on Agora: one Workstream per member, one execution per turn, its answer.

Every id a turn sends is derived from the turn's identity (run, member, turn), never drawn at random:
running the same turn again finds the same Workstream and the same turn, and Agora answers a command
it already accepted with its first answer and writes nothing (docs/specs/log.md, "Commands"). So a
turn that Prefect retries, resumes or re-runs never starts a second agent on the same work
(docs/specs/flows.md). A turn goes to the member's execution while it lives; once it has ended, a new
one continues the member's Session, and Agora gives it what it missed (docs/specs/log.md, "Continuing").
Standard library only: the flows' image is Prefect's, unchanged.
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable, Iterator

# The namespace of every id a flow derives; fixed, so that the same turn gives the same ids anywhere.
NAMESPACE = uuid.uuid5(uuid.NAMESPACE_URL, "https://agora.bretagne.dev/flows")

TERMINAL = {"done", "cancelled", "failed"}
# The Workstream view's states after which the execution will not answer (docs/specs/log.md, "The Workstream view").
GONE = {"ended", "failed", "lost", "stopped"}
# Write refusals that clear on their own while the execution opens (docs/specs/log.md, "Commands").
TRANSIENT_WRITE = {"settings_pending", "opening_session", "disconnected", "unavailable"}


def workstream_id(run: str, member: str) -> str:
    """The member's Workstream: the same run and member always name the same one, turn after turn."""
    return str(uuid.uuid5(NAMESPACE, f"{run}/{member}"))


def command_id(workstream: str, name: str) -> str:
    """A command of the member's Workstream, named by its place among its turns (`create-2`, `write-2`)."""
    return str(uuid.uuid5(uuid.UUID(workstream), name))


class Escalation(Exception):
    """What a turn must not decide alone: an uncertain turn, an execution gone, a refusal it cannot clear."""


@dataclass
class TurnSpec:
    run: str
    member: str
    turn: int
    harness: str
    prompt: str
    profiles: list[str] = field(default_factory=list)
    settings: dict[str, str] = field(default_factory=dict)
    # A human-asked retry after an escalation: new Create and Write ids, the same turn.
    attempt: int = 0
    lease_seconds: int = 300
    turn_cap_seconds: int = 3600


@dataclass
class TurnResult:
    workstream: str
    execution: str
    turn: int
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

    def offered(self) -> list[str]:
        """The profiles an execution may be given (docs/specs/credentials.md, "Offered profiles")."""
        status, body = self._call("GET", "/api/config")
        if status != 200:
            raise RuntimeError(f"config: {status}")
        credentials = body.get("credentials") or {}
        return [p for p in credentials.get("offered") or [] if isinstance(p, str)]

    def pool_for(self, harness: str) -> str:
        """Pools are named after their image; a turn asks for a harness."""
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

    def stream(self, workstream: str, after: str, idle: float) -> Iterator[dict[str, Any]]:
        """The thread from a cursor, snapshot then live rows, as long as the connection lasts: a read
        that waits more than `idle` seconds ends it (docs/specs/log.md, "The thread")."""
        request = urllib.request.Request(f"{self.base}/api/workstreams/{workstream}/thread?after={after}")
        with urllib.request.urlopen(request, timeout=idle) as response:
            for line in response:
                if line.startswith(b"data: "):
                    yield json.loads(line[6:])


class Thread:
    """The member's view of its Workstream, folded from the thread's rows."""

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
        """The Workstream's turns in prompt order: the member's n-th Write is its n-th turn."""
        turns = [o for (kind, _), o in self.objects.items() if kind == "turn"]
        return sorted(turns, key=lambda t: int(t.get("requestPosition") or 0))

    def text(self, turn: str) -> str:
        """The agent's answer in a turn: its message chunks in order, neither reasoning nor tools."""
        chunks = [
            o for (kind, _), o in self.objects.items()
            if kind == "element" and o.get("type") == "agent_message_chunk" and o.get("turn") == turn
        ]
        return "".join(c.get("text", "") for c in sorted(chunks, key=lambda c: int(c.get("firstPosition") or 0)))

    def wait(self, done: Callable[["Thread"], bool], idle: float = 600.0, sleep: Callable[[float], None] = time.sleep) -> None:
        """Follows the thread live until `done` holds. Nothing is polled: a connection idle `idle`
        seconds, or one that drops, is opened again from the cursor."""
        while not done(self):
            try:
                for row in self.agora.stream(self.workstream, self.cursor, idle):
                    if row.get("type") == "snapshot-end":
                        self.cursor = str(row["position"])
                    else:
                        self.apply([row])
                        if row.get("type") != "snapshot" and row.get("position") is not None:
                            self.cursor = str(row["position"])
                    if done(self):
                        return
            except (OSError, ValueError):
                # Idle past `idle`, or dropped: opened again from the cursor, a little later on an error.
                sleep(5)

    def question(self, position: str) -> dict[str, Any] | None:
        """The question asked at that position (docs/specs/log.md, "Elements")."""
        return next((o for (kind, _), o in self.objects.items() if kind == "element" and o.get("type") == "question" and str(o.get("position")) == position), None)

    def pending_permission(self) -> bool:
        return any(kind == "element" and o.get("type") == "permission" and o.get("status") == "pending" for (kind, _), o in self.objects.items())


def run_turn(
    agora: Agora,
    spec: TurnSpec,
    log: Callable[[str], None] = print,
    sleep: Callable[[float], None] = time.sleep,
    poll: float = 5.0,
    ready_timeout: float = 900.0,
) -> TurnResult:
    """Runs the member's turn, or finds it again where it is: written, answered.

    The member's n-th Write is its n-th turn: a turn already in the thread is never written again.
    The turn goes to the member's execution while it lives; once gone, to a new one, which continues
    the member's Session. Nothing stops it: Agora renews an execution only during its turns, so an
    idle one ends at its deadline, a lease after its last turn — a Stop would free nothing sooner
    (docs/specs/executions.md).
    """
    workstream = workstream_id(spec.run, spec.member)
    name = f"{spec.member}, turn {spec.turn}"
    suffix = str(spec.turn) if spec.attempt == 0 else f"{spec.turn}.{spec.attempt}"
    agora.ensure_workstream(workstream)
    thread = Thread(agora, workstream)
    thread.refresh()

    if len(thread.turns()) < spec.turn:
        view = thread.view() or {}
        try:
            if not view.get("execution") or view.get("state") in GONE | {None, "none"}:
                raise _Gone
            log(f"{name}: to its execution {view['execution']}, still there")
            _write(agora, spec, thread, workstream, str(view["execution"]), name, suffix, log, sleep, poll, ready_timeout, reused=True)
        except _Gone:
            execution = _create(agora, spec, thread, workstream, name, suffix, log, sleep, poll, ready_timeout)
            _write(agora, spec, thread, workstream, execution, name, suffix, log, sleep, poll, ready_timeout)
    else:
        log(f"{name}: found in Workstream {workstream}")

    # The turn: waited for, never resent.
    warned = False
    while True:
        turn = thread.turns()[spec.turn - 1]
        status = turn.get("status")
        if status in TERMINAL:
            break
        if status == "uncertain":
            raise Escalation(f"{name} uncertain in Workstream {workstream}: Agora never resends it; decide by hand")
        if thread.pending_permission() and not warned:
            log(f"{name}: the agent asks a permission — answer it in Agora, Workstream {workstream}")
            warned = True
        sleep(poll)
        thread.refresh()

    result = TurnResult(
        workstream=workstream,
        execution=str(turn.get("execution") or ""),
        turn=spec.turn,
        status=status,
        stop_reason=turn.get("stopReason"),
        text=thread.text(turn["id"]),
    )
    log(f"{name}: {status} ({result.stop_reason}), {len(result.text)} characters")
    return result


class _Gone(Exception):
    """The member's execution is gone, or going: the turn needs a new one."""


def _create(agora: Agora, spec: TurnSpec, thread: Thread, workstream: str, name: str, suffix: str,
            log: Callable[[str], None], sleep: Callable[[float], None], poll: float, ready_timeout: float) -> str:
    """The turn's execution: a Create under the turn's id, which a replay finds accepted already."""
    body: dict[str, Any] = {
        "pool": agora.pool_for(spec.harness),
        "limits": {"leaseSeconds": spec.lease_seconds, "turnCapSeconds": spec.turn_cap_seconds},
    }
    if spec.settings:
        body["settings"] = spec.settings
    if spec.profiles:
        body["profiles"] = spec.profiles
    deadline = time.monotonic() + ready_timeout
    while True:
        answer = agora.command(workstream, command_id(workstream, f"create-{suffix}"), "Create", {}, body)
        reason = answer.get("reason")
        if answer.get("accepted"):
            log(f"{name}: execution {answer['execution']} in Workstream {workstream}")
            return str(answer["execution"])
        if reason == "command_conflict":
            # Accepted before with another body — the pool's name follows its image: the execution it
            # obtained is the Workstream's, unless it is gone already.
            thread.refresh()
            view = thread.view() or {}
            if view.get("execution") and view.get("state") not in GONE:
                return str(view["execution"])
            raise Escalation(f"{name}: its Create was accepted with another body and its execution is {view.get('state')}")
        if reason == "execution_active":
            # The member's previous execution, gone or going: its claim disappears at its deadline.
            log(f"{name}: Create refused (execution_active) while the last execution's claim goes, retrying")
        elif reason in ("quota", "unavailable"):
            log(f"{name}: Create refused ({reason}), retrying")
        else:
            raise Escalation(f"{name}: Create refused: {reason}")
        if time.monotonic() > deadline:
            raise Escalation(f"{name}: Create refused ({reason}) for {int(ready_timeout)} s")
        sleep(15 if reason == "quota" else poll)


def _write(agora: Agora, spec: TurnSpec, thread: Thread, workstream: str, execution: str, name: str, suffix: str,
           log: Callable[[str], None], sleep: Callable[[float], None], poll: float, ready_timeout: float, reused: bool = False) -> None:
    """The prompt, once the turn's execution has its Session open and its settings applied. An
    execution `reused` from the member's last turn that is gone, or going, asks for a new one."""
    deadline = time.monotonic() + ready_timeout
    state = None
    while len(thread.turns()) < spec.turn:
        view = thread.view() or {}
        state = view.get("state")
        if view.get("execution") == execution:
            if state in GONE:
                if reused:
                    raise _Gone
                raise Escalation(f"{name}: execution {state} before the prompt was written")
            if state == "ready" and not view.get("configuring") and view.get("session"):
                target = {"execution": execution, "session": view["session"]}
                answer = agora.command(workstream, command_id(workstream, f"write-{suffix}"), "Write", target, {"prompt": [{"type": "text", "text": spec.prompt}]})
                reason = answer.get("reason")
                if answer.get("accepted"):
                    log(f"{name}: prompt written ({answer.get('requestId')})")
                    thread.refresh()
                    continue
                if reused and reason == "execution_ending":
                    raise _Gone
                if reason not in TRANSIENT_WRITE:
                    raise Escalation(f"{name}: Write refused: {reason}")
        elif reused:
            raise _Gone  # another execution took the Workstream's place
        if time.monotonic() > deadline:
            raise Escalation(f"{name}: execution not ready after {int(ready_timeout)} s (state {state})")
        sleep(poll)
        thread.refresh()


def ask(agora: Agora, workstream: str, key: str, question: dict[str, Any]) -> str:
    """Asks the person in the Workstream (docs/specs/log.md, "Commands"), once: the same key finds the
    question already asked. Its position."""
    answer = agora.command(workstream, command_id(workstream, f"ask-{key}"), "Ask", {}, question)
    if not answer.get("accepted"):
        raise Escalation(f"question {key!r} refused: {answer.get('reason')}")
    return str(answer["position"])


def wait_answer(agora: Agora, workstream: str, position: str, idle: float = 600.0) -> dict[str, Any]:
    """The person's answer to the question at that position — its option and note — once given."""
    thread = Thread(agora, workstream)
    thread.wait(lambda t: (t.question(position) or {}).get("status") == "answered", idle=idle)
    return dict((thread.question(position) or {}).get("answer") or {})


def split_last_json(text: str) -> tuple[str, dict[str, Any] | None]:
    """An answer cut before its last JSON object, and that object: the deliverable and the report."""
    decoder = json.JSONDecoder()
    found: dict[str, Any] | None = None
    start = len(text)
    index = text.find("{")
    while index != -1:
        try:
            value, end = decoder.raw_decode(text, index)
        except ValueError:
            index = text.find("{", index + 1)
            continue
        if isinstance(value, dict):
            found, start = value, index
        index = text.find("{", end)
    return text[:start].rstrip(), found


def last_json(text: str) -> dict[str, Any] | None:
    """The last JSON object of an answer: what a turn's prompt asks the agent to end with."""
    return split_last_json(text)[1]
