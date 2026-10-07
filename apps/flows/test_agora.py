"""Unit cases of docs/specs/flows.md: a step against a stand-in Agora (`stub`), no process or network.

The stand-in keeps the one rule the step relies on — a command id already accepted answers its first
answer and writes nothing; another request under it is `command_conflict` — and moves an execution
from starting to ready, a turn from in progress to done, as the polls go.
"""

from __future__ import annotations

import json
import unittest
from typing import Any

from agora import Escalation, StepSpec, Thread, command_id, last_json, run_step, step_id


class FakeAgora:
    def __init__(self, ready_after: int = 2, answer_after: int = 2, refusals: list[str] | None = None, turn_end: str = "done") -> None:
        self.ready_after = ready_after
        self.answer_after = answer_after
        self.refusals = list(refusals or [])  # Write refusals before the first acceptance
        self.turn_end = turn_end
        self.workstreams: set[str] = set()
        self.commands: dict[tuple[str, str], tuple[str, dict[str, Any]]] = {}
        self.sent: list[str] = []  # kinds of the commands accepted for the first time
        self.view: dict[str, Any] = {"state": "none", "execution": None, "session": None, "configuring": False}
        self.turn: dict[str, Any] | None = None
        self.polls = 0
        self.position = 10

    def pool_for(self, harness: str) -> str:
        return f"{harness}-pool"

    def ensure_workstream(self, workstream: str) -> None:
        self.workstreams.add(workstream)

    def command(self, workstream: str, id: str, kind: str, target: dict[str, Any], body: dict[str, Any]) -> dict[str, Any]:
        fingerprint = json.dumps([kind, target, body], sort_keys=True)
        if (workstream, id) in self.commands:
            first, answer = self.commands[(workstream, id)]
            return answer if first == fingerprint else {"accepted": False, "reason": "command_conflict"}
        if kind == "Write" and self.refusals:
            return {"accepted": False, "reason": self.refusals.pop(0)}
        answer: dict[str, Any] = {"accepted": True, "command": id}
        if kind == "Create":
            self.view.update(state="starting", execution="e-1")
            self.polls = 0
            answer["execution"] = "e-1"
        elif kind == "Write":
            if self.view["state"] != "ready" or target.get("session") != self.view["session"]:
                return {"accepted": False, "reason": "stale_session"}
            self.position += 1
            self.turn = {"status": "in_progress", "requestPosition": str(self.position), "stopReason": None}
            self.polls = 0
            answer["requestId"] = f"agora-e-1-{self.position}"
        elif kind == "Stop":
            self.view["state"] = "stopped"
        self.commands[(workstream, id)] = (fingerprint, answer)
        self.sent.append(kind)
        return answer

    def snapshot(self, workstream: str, after: str) -> tuple[list[dict[str, Any]], str]:
        self.polls += 1
        if self.view["state"] == "starting" and self.polls > self.ready_after:
            self.view.update(state="ready", session="s-1")
        if self.turn and self.turn["status"] == "in_progress" and self.polls > self.answer_after:
            self.turn.update(status=self.turn_end, stopReason="end_turn" if self.turn_end == "done" else None)
        rows = [{"type": "snapshot", "operation": "upsert", "kind": "workstream", "id": workstream, "object": dict(self.view)}]
        if self.turn:
            rows.append({"type": "snapshot", "operation": "upsert", "kind": "turn", "id": "t-1", "object": dict(self.turn)})
            if self.turn["status"] == "done":
                for rank, text in enumerate(["Hello", ", world."]):
                    rows.append({"type": "snapshot", "operation": "upsert", "kind": "element", "id": f"c-{rank}",
                                 "object": {"type": "agent_message_chunk", "turn": "t-1", "text": text, "firstPosition": str(20 + rank)}})
        return rows, "99"


SPEC = StepSpec(run="run-1", step="development", round=1, harness="mock", prompt="do it")


def quiet(_: str) -> None:
    pass


def run(agora: FakeAgora, spec: StepSpec = SPEC):
    return run_step(agora, spec, log=quiet, sleep=lambda _: None, poll=0, ready_timeout=5)  # type: ignore[arg-type]


class Steps(unittest.TestCase):
    def test_F1_a_step_from_nothing_creates_writes_waits_and_stops(self) -> None:
        agora = FakeAgora()
        result = run(agora)
        self.assertEqual(agora.sent, ["Create", "Write", "Stop"])
        self.assertEqual(result.workstream, step_id("run-1", "development", 1))
        self.assertEqual((result.execution, result.status, result.stop_reason, result.text), ("e-1", "done", "end_turn", "Hello, world."))
        self.assertEqual(agora.view["state"], "stopped")

    def test_F2_the_same_step_after_it_ended_sends_nothing_new(self) -> None:
        agora = FakeAgora()
        first = run(agora)
        again = run(agora)
        self.assertEqual(agora.sent, ["Create", "Write", "Stop"])  # control: the first run did send all three
        self.assertEqual((again.workstream, again.execution, again.text), (first.workstream, first.execution, first.text))

    def test_F3_the_same_step_while_its_turn_runs_waits_for_it(self) -> None:
        agora = FakeAgora(answer_after=1000)
        with self.assertRaises(TimeoutError):  # the first run dies mid-turn
            run_step(agora, SPEC, log=quiet, sleep=_dies_after(6), poll=0)  # type: ignore[arg-type]
        self.assertEqual(agora.sent, ["Create", "Write"])
        self.assertEqual(agora.turn["status"], "in_progress")  # type: ignore[index]
        agora.answer_after = 1
        again = run(agora)
        self.assertEqual(agora.sent, ["Create", "Write", "Stop"])
        self.assertEqual(again.text, "Hello, world.")

    def test_F4_a_write_refused_while_the_session_opens_is_sent_again_under_its_id(self) -> None:
        agora = FakeAgora(refusals=["settings_pending", "opening_session"])
        result = run(agora)
        self.assertEqual(agora.sent, ["Create", "Write", "Stop"])
        self.assertEqual(result.text, "Hello, world.")

    def test_F5_an_uncertain_turn_is_brought_to_a_human_never_resent(self) -> None:
        agora = FakeAgora(turn_end="uncertain")
        with self.assertRaises(Escalation):
            run(agora)
        self.assertEqual(agora.sent, ["Create", "Write"])
        with self.assertRaises(Escalation):  # a replay finds it uncertain too, and still does not write
            run(agora)
        self.assertEqual(agora.sent, ["Create", "Write"])

    def test_F5_a_refusal_the_step_cannot_clear_is_brought_to_a_human(self) -> None:
        agora = FakeAgora(refusals=["stopped"])
        with self.assertRaises(Escalation):
            run(agora)
        self.assertEqual(agora.sent, ["Create"])


class Ids(unittest.TestCase):
    def test_ids_depend_on_the_step_only(self) -> None:
        self.assertEqual(step_id("r", "review", 2), step_id("r", "review", 2))
        self.assertEqual(len({step_id("r", "review", 1), step_id("r", "review", 2), step_id("r", "development", 1), step_id("q", "review", 1)}), 4)
        ws = step_id("r", "review", 1)
        self.assertEqual(command_id(ws, "write-1"), command_id(ws, "write-1"))
        self.assertNotEqual(command_id(ws, "write-1"), command_id(ws, "create"))


class Answers(unittest.TestCase):
    def test_the_last_json_object_of_an_answer(self) -> None:
        text = 'Example: {"verdict": "approve | changes"}\nDone.\n{"verdict": "changes", "comments": ["a {b}"]}\n'
        self.assertEqual(last_json(text), {"verdict": "changes", "comments": ["a {b}"]})
        self.assertIsNone(last_json("no json {here"))

    def test_the_thread_folds_upserts_removes_and_resets(self) -> None:
        thread = Thread(None, "w")  # type: ignore[arg-type]
        thread.apply([
            {"operation": "upsert", "kind": "turn", "id": "b", "object": {"requestPosition": "12"}},
            {"operation": "upsert", "kind": "turn", "id": "a", "object": {"requestPosition": "9"}},
            {"operation": "upsert", "kind": "element", "id": "x", "object": {"type": "permission", "status": "pending"}},
        ])
        self.assertEqual([t["id"] for t in thread.turns()], ["a", "b"])
        self.assertTrue(thread.pending_permission())
        thread.apply([{"operation": "remove", "kind": "element", "id": "x"}])
        self.assertFalse(thread.pending_permission())
        thread.apply([{"operation": "reset", "kind": None, "id": None}])
        self.assertEqual(thread.turns(), [])


def _dies_after(n: int):
    calls = {"n": 0}

    def sleep(_: float) -> None:
        calls["n"] += 1
        if calls["n"] > n:
            raise TimeoutError("the step's process dies")

    return sleep


if __name__ == "__main__":
    unittest.main()
