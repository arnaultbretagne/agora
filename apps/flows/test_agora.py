"""Unit cases of docs/specs/flows.md: a member's turns against a stand-in Agora, no process or network.

The stand-in keeps the rules the turns rely on — a command id already accepted answers its first
answer and writes nothing; another request under it is `command_conflict`; a Create is refused while
the Workstream's execution exists, until its claim has gone — and moves an execution from starting to
ready, a turn from in progress to done, as the polls go; an idle execution ends when a case says so.
"""

from __future__ import annotations

import json
import unittest
from typing import Any

from agora import Escalation, Thread, TurnSpec, command_id, last_json, run_turn, split_last_json, workstream_id


class FakeAgora:
    def __init__(self, ready_after: int = 2, answer_after: int = 2, refusals: list[str] | None = None, turn_end: str = "done",
                 claim_lag: int = 0) -> None:
        self.ready_after = ready_after
        self.answer_after = answer_after
        self.refusals = list(refusals or [])  # Write refusals before the next acceptance
        self.turn_end = turn_end
        self.claim_lag = claim_lag  # polls after a Stop before the claim is gone
        self.claim_left = 0
        self.workstreams: set[str] = set()
        self.commands: dict[tuple[str, str], tuple[str, dict[str, Any]]] = {}
        self.sent: list[str] = []  # kinds of the commands accepted for the first time
        self.view: dict[str, Any] = {"state": "none", "execution": None, "session": None, "configuring": False}
        self.turns: list[dict[str, Any]] = []
        self.executions = 0
        self.polls = 0
        self.position = 10

    def expire(self) -> None:
        self.view["state"] = "ended"
        self.claim_left = self.claim_lag

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
            reason = self.refusals.pop(0)
            if reason == "execution_ending":  # its deadline has passed: it ends, its claim goes a little later
                self.expire()
            return {"accepted": False, "reason": reason}
        answer: dict[str, Any] = {"accepted": True, "command": id}
        if kind == "Create":
            if self.view["execution"] and (self.view["state"] not in ("stopped", "ended", "failed", "lost") or self.claim_left > 0):
                self.claim_left = max(0, self.claim_left - 1)  # time passes between the retries
                return {"accepted": False, "reason": "execution_active"}
            self.executions += 1
            execution = f"e-{self.executions}"
            self.view.update(state="starting", execution=execution, session=None)
            self.polls = 0
            answer["execution"] = execution
        elif kind == "Write":
            if self.view["state"] != "ready" or target.get("session") != self.view["session"] or target.get("execution") != self.view["execution"]:
                return {"accepted": False, "reason": "stale_session"}
            self.position += 1
            self.turns.append({"id": f"t-{len(self.turns) + 1}", "status": "in_progress", "requestPosition": str(self.position),
                               "stopReason": None, "execution": self.view["execution"]})
            self.polls = 0
            answer["requestId"] = f"agora-{self.view['execution']}-{self.position}"
        elif kind == "Stop":
            if target.get("execution") != self.view["execution"]:
                return {"accepted": False, "reason": "execution_unavailable"}
            self.view["state"] = "stopped"
            self.claim_left = self.claim_lag
        self.commands[(workstream, id)] = (fingerprint, answer)
        self.sent.append(kind)
        return answer

    def snapshot(self, workstream: str, after: str) -> tuple[list[dict[str, Any]], str]:
        self.polls += 1
        self.claim_left = max(0, self.claim_left - 1)
        if self.view["state"] == "starting" and self.polls > self.ready_after:
            self.view.update(state="ready", session=f"s-{self.executions}")
        rows = [{"type": "snapshot", "operation": "upsert", "kind": "workstream", "id": workstream, "object": dict(self.view)}]
        for n, turn in enumerate(self.turns, 1):
            if turn["status"] == "in_progress" and self.polls > self.answer_after:
                turn.update(status=self.turn_end, stopReason="end_turn" if self.turn_end == "done" else None)
            rows.append({"type": "snapshot", "operation": "upsert", "kind": "turn", "id": turn["id"], "object": dict(turn)})
            if turn["status"] == "done":
                for rank, text in enumerate([f"Answer {n}", "."]):
                    rows.append({"type": "snapshot", "operation": "upsert", "kind": "element", "id": f"c-{n}-{rank}",
                                 "object": {"type": "agent_message_chunk", "turn": turn["id"], "text": text, "firstPosition": str(100 * n + rank)}})
        return rows, "99"


def spec(turn: int = 1, attempt: int = 0) -> TurnSpec:
    return TurnSpec(run="run-1", member="dev-1", turn=turn, harness="mock", prompt=f"do it, turn {turn}", attempt=attempt)


def quiet(_: str) -> None:
    pass


def run(agora: FakeAgora, turn: int = 1, attempt: int = 0):
    return run_turn(agora, spec(turn, attempt), log=quiet, sleep=lambda _: None, poll=0, ready_timeout=5)  # type: ignore[arg-type]


class Turns(unittest.TestCase):
    def test_F1_a_first_turn_creates_writes_and_waits(self) -> None:
        agora = FakeAgora()
        result = run(agora)
        self.assertEqual(agora.sent, ["Create", "Write"])
        self.assertEqual(result.workstream, workstream_id("run-1", "dev-1"))
        self.assertEqual((result.execution, result.turn, result.status, result.stop_reason, result.text), ("e-1", 1, "done", "end_turn", "Answer 1."))

    def test_F2_the_same_turn_after_it_ended_sends_nothing_new(self) -> None:
        agora = FakeAgora()
        first = run(agora)
        again = run(agora)
        self.assertEqual(agora.sent, ["Create", "Write"])  # control: the first run did send both
        self.assertEqual((again.workstream, again.execution, again.text), (first.workstream, first.execution, first.text))

    def test_F3_the_same_turn_while_it_runs_waits_for_it(self) -> None:
        agora = FakeAgora(answer_after=1000)
        with self.assertRaises(TimeoutError):  # the first run dies mid-turn
            run_turn(agora, spec(), log=quiet, sleep=_dies_after(6), poll=0)  # type: ignore[arg-type]
        self.assertEqual(agora.sent, ["Create", "Write"])
        self.assertEqual(agora.turns[0]["status"], "in_progress")
        agora.answer_after = 1
        again = run(agora)
        self.assertEqual(agora.sent, ["Create", "Write"])
        self.assertEqual(again.text, "Answer 1.")

    def test_F4_a_write_refused_while_the_session_opens_is_sent_again_under_its_id(self) -> None:
        agora = FakeAgora(refusals=["settings_pending", "opening_session"])
        result = run(agora)
        self.assertEqual(agora.sent, ["Create", "Write"])
        self.assertEqual(result.text, "Answer 1.")

    def test_F5_an_uncertain_turn_is_brought_to_a_human_never_resent(self) -> None:
        agora = FakeAgora(turn_end="uncertain")
        with self.assertRaises(Escalation):
            run(agora)
        self.assertEqual(agora.sent, ["Create", "Write"])
        with self.assertRaises(Escalation):  # a replay finds it uncertain too, and still does not write
            run(agora)
        self.assertEqual(agora.sent, ["Create", "Write"])

    def test_F5_a_refusal_the_turn_cannot_clear_is_brought_to_a_human(self) -> None:
        agora = FakeAgora(refusals=["stopped"])
        with self.assertRaises(Escalation):
            run(agora)
        self.assertEqual(agora.sent, ["Create"])

    def test_F5_a_retry_the_human_asked_for_uses_new_ids_for_the_same_turn(self) -> None:
        agora = FakeAgora()
        ws = workstream_id("run-1", "dev-1")
        agora.command(ws, command_id(ws, "create-1"), "Create", {}, {"pool": "mock-pool", "limits": {"leaseSeconds": 300, "turnCapSeconds": 3600}})
        agora.view["state"] = "lost"  # its execution was lost before the prompt was written
        with self.assertRaises(Escalation):
            run(agora)
        result = run(agora, attempt=1)
        self.assertEqual(agora.sent, ["Create", "Create", "Write"])
        self.assertEqual((result.execution, result.text), ("e-2", "Answer 1."))

    def test_F6_the_next_turn_goes_to_the_members_execution_while_it_lives(self) -> None:
        agora = FakeAgora()
        first = run(agora)
        second = run(agora, turn=2)
        self.assertEqual(agora.sent, ["Create", "Write", "Write"])
        self.assertEqual((first.workstream, first.execution, first.text), (second.workstream, "e-1", "Answer 1."))
        self.assertEqual((second.execution, second.turn, second.text), ("e-1", 2, "Answer 2."))
        again = run(agora, turn=1)  # the first turn, run again, is still the first
        self.assertEqual((again.execution, again.text), ("e-1", "Answer 1."))
        self.assertEqual(agora.sent, ["Create", "Write", "Write"])

    def test_F7_once_the_execution_has_ended_the_next_turn_continues_in_a_new_one(self) -> None:
        agora = FakeAgora(claim_lag=3)
        run(agora)
        agora.expire()  # its deadline passed while the member was idle; its claim goes a little later
        second = run(agora, turn=2)
        self.assertEqual(agora.sent, ["Create", "Write", "Create", "Write"])
        self.assertEqual((second.execution, second.text), ("e-2", "Answer 2."))

    def test_F8_an_execution_ending_as_the_turn_comes_is_replaced(self) -> None:
        agora = FakeAgora()
        run(agora)
        agora.refusals = ["execution_ending"]
        second = run(agora, turn=2)
        self.assertEqual(agora.sent, ["Create", "Write", "Create", "Write"])
        self.assertEqual(second.execution, "e-2")


class Ids(unittest.TestCase):
    def test_ids_depend_on_the_run_and_member_only(self) -> None:
        self.assertEqual(workstream_id("r", "dev-1"), workstream_id("r", "dev-1"))
        self.assertEqual(len({workstream_id("r", "dev-1"), workstream_id("r", "dev-2"), workstream_id("q", "dev-1")}), 3)
        ws = workstream_id("r", "dev-1")
        self.assertEqual(command_id(ws, "write-1"), command_id(ws, "write-1"))
        self.assertNotEqual(command_id(ws, "write-1"), command_id(ws, "write-2"))


class Answers(unittest.TestCase):
    def test_the_last_json_object_of_an_answer(self) -> None:
        text = 'Example: {"verdict": "pass | fail"}\nDone.\n{"verdict": "fail", "checks": ["a {b}"]}\n'
        self.assertEqual(last_json(text), {"verdict": "fail", "checks": ["a {b}"]})
        self.assertIsNone(last_json("no json {here"))

    def test_an_answer_cut_before_its_last_json_object(self) -> None:
        body, report = split_last_json('# Design\n\nUse `{x}` here.\n\n{"status": "done", "summary": "s"}\n')
        self.assertEqual((body, report), ("# Design\n\nUse `{x}` here.", {"status": "done", "summary": "s"}))
        self.assertEqual(split_last_json("no report"), ("no report", None))

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
            raise TimeoutError("the turn's process dies")

    return sleep


if __name__ == "__main__":
    unittest.main()
