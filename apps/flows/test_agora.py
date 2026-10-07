"""Unit cases of docs/specs/flows.md: a step against a stand-in Agora (`stub`), no process or network.

The stand-in keeps the one rule the step relies on — a command id already accepted answers its first
answer and writes nothing; another request under it is `command_conflict` — and moves an execution
from starting to ready, a turn from in progress to done, as the polls go.
"""

from __future__ import annotations

import json
import unittest
from dataclasses import asdict, replace
from typing import Any, Callable

from agora import Escalation, StepSpec, Thread, command_id, last_json, run_step, step_id


class FakeClock:
    def __init__(self) -> None:
        self.now = 0.0
        self.sleeps: list[float] = []

    def __call__(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.now += seconds


class FakeAgora:
    def __init__(self, ready_after: int = 2, answer_after: int = 2, refusals: list[str] | None = None, turn_end: str = "done",
                 ready_at: float | None = None, clock: Callable[[], float] | None = None, create_refusals: list[str] | None = None) -> None:
        self.ready_after = ready_after
        self.ready_at = ready_at
        self.clock = clock
        self.answer_after = answer_after
        self.refusals = list(refusals or [])  # Write refusals before the first acceptance
        self.create_refusals = list(create_refusals or [])
        self.turn_end = turn_end
        self.workstreams: set[str] = set()
        self.commands: dict[tuple[str, str], tuple[str, dict[str, Any]]] = {}
        self.sent: list[str] = []  # kinds of the commands accepted for the first time
        self.view: dict[str, Any] = {"state": "none", "execution": None, "session": None, "configuring": False}
        self.turn: dict[str, Any] | None = None
        self.polls = 0
        self.position = 10
        self.requests = 0

    def pool_for(self, harness: str) -> str:
        self.requests += 1
        return f"{harness}-pool"

    def ensure_workstream(self, workstream: str) -> None:
        self.requests += 1
        self.workstreams.add(workstream)

    def command(self, workstream: str, id: str, kind: str, target: dict[str, Any], body: dict[str, Any]) -> dict[str, Any]:
        self.requests += 1
        fingerprint = json.dumps([kind, target, body], sort_keys=True)
        if (workstream, id) in self.commands:
            first, answer = self.commands[(workstream, id)]
            return answer if first == fingerprint else {"accepted": False, "reason": "command_conflict"}
        if kind == "Write" and self.refusals:
            return {"accepted": False, "reason": self.refusals.pop(0)}
        if kind == "Create" and self.create_refusals:
            return {"accepted": False, "reason": self.create_refusals.pop(0)}
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
        self.requests += 1
        self.polls += 1
        ready = self.clock() >= self.ready_at if self.clock is not None and self.ready_at is not None else self.polls > self.ready_after
        if self.view["state"] == "starting" and ready:
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


SPEC = StepSpec(run="run-1", step="development", round=1, harness="mock", prompt="do it", poll_seconds=0.25, ready_timeout_seconds=5)


def quiet(_: str) -> None:
    pass


def run(agora: FakeAgora, spec: StepSpec = SPEC):
    clock = FakeClock()
    return run_step(agora, spec, log=quiet, sleep=clock.sleep, clock=clock)  # type: ignore[arg-type]


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
            run_step(agora, SPEC, log=quiet, sleep=_dies_after(6))  # type: ignore[arg-type]
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

    def test_F9_custom_and_default_poll_intervals_apply_in_both_loops(self) -> None:
        for timing, expected in (({"poll_seconds": 0.125}, 0.125), ({}, 5.0)):
            with self.subTest(timing=timing):
                spec = StepSpec(run="run-1", step="development", round=1, harness="mock", prompt="do it", **timing)
                agora = FakeAgora()
                clock = FakeClock()
                pauses: dict[str, list[float]] = {"ready": [], "turn": []}

                def sleep(seconds: float) -> None:
                    pauses["ready" if agora.turn is None else "turn"].append(seconds)
                    clock.sleep(seconds)

                result = run_step(agora, spec, log=quiet, sleep=sleep, clock=clock)  # type: ignore[arg-type]
                for stage, seconds in pauses.items():
                    self.assertTrue(seconds, stage)
                    self.assertEqual(seconds, [expected] * len(seconds))
                self.assertEqual(agora.sent, ["Create", "Write", "Stop"])
                self.assertEqual(result.text, "Hello, world.")

    def test_F10_a_short_timeout_escalates_and_a_longer_one_allows_the_same_execution(self) -> None:
        for timeout, succeeds in ((0.6, False), (2, True)):
            with self.subTest(timeout=timeout):
                clock = FakeClock()
                agora = FakeAgora(ready_at=1.0, clock=clock)
                spec = replace(SPEC, poll_seconds=0.25, ready_timeout_seconds=timeout)
                if succeeds:
                    result = run_step(agora, spec, log=quiet, sleep=clock.sleep, clock=clock)  # type: ignore[arg-type]
                    self.assertEqual(agora.sent, ["Create", "Write", "Stop"])
                    self.assertEqual((result.status, result.text), ("done", "Hello, world."))
                else:
                    with self.assertRaises(Escalation) as raised:
                        run_step(agora, spec, log=quiet, sleep=clock.sleep, clock=clock)  # type: ignore[arg-type]
                    self.assertEqual(str(raised.exception), "execution not ready after 0.6 s (state starting)")
                    self.assertEqual(agora.sent, ["Create"])
                    self.assertGreater(clock.now, timeout)
                    self.assertLess(clock.now - timeout, spec.poll_seconds)
                    self.assertLessEqual(clock.now - spec.poll_seconds, timeout)

    def test_F10_the_default_timeout_escalates_on_the_first_read_past_900_seconds(self) -> None:
        clock = FakeClock()
        agora = FakeAgora(ready_at=float("inf"), clock=clock)
        spec = StepSpec(run="run-1", step="development", round=1, harness="mock", prompt="do it", poll_seconds=7)
        with self.assertRaises(Escalation) as raised:
            run_step(agora, spec, log=quiet, sleep=clock.sleep, clock=clock)  # type: ignore[arg-type]
        self.assertEqual(str(raised.exception), "execution not ready after 900 s (state starting)")
        self.assertEqual(agora.sent, ["Create"])
        self.assertGreater(clock.now, 900)
        self.assertLess(clock.now - 900, spec.poll_seconds)
        self.assertLessEqual(clock.now - spec.poll_seconds, 900)

    def test_F10_readiness_first_seen_past_the_timeout_does_not_write(self) -> None:
        clock = FakeClock()
        agora = FakeAgora(ready_at=0.7, clock=clock)
        spec = replace(SPEC, ready_timeout_seconds=0.6)
        with self.assertRaises(Escalation) as raised:
            run_step(agora, spec, log=quiet, sleep=clock.sleep, clock=clock)  # type: ignore[arg-type]
        self.assertEqual(str(raised.exception), "execution not ready after 0.6 s (state ready)")
        self.assertEqual(agora.sent, ["Create"])
        self.assertGreater(clock.now, spec.ready_timeout_seconds)
        self.assertLess(clock.now - spec.ready_timeout_seconds, spec.poll_seconds)

    def test_F11_invalid_cadence_is_refused_before_any_request(self) -> None:
        for name in ("poll_seconds", "ready_timeout_seconds"):
            for value in (0, -1, True, False, "5", None, float("nan")):
                with self.subTest(field=name, value=value):
                    agora = FakeAgora()
                    with self.assertRaisesRegex(ValueError, name):
                        run(agora, replace(SPEC, **{name: value}))
                    self.assertEqual(agora.requests, 0)

    def test_F11_positive_integer_and_fractional_cadences_are_accepted(self) -> None:
        for value in (1, 0.125):
            with self.subTest(value=value):
                agora = FakeAgora()
                spec = replace(SPEC, poll_seconds=value, ready_timeout_seconds=10 * value)
                self.assertEqual(run(agora, spec).text, "Hello, world.")
                self.assertEqual(agora.sent, ["Create", "Write", "Stop"])

    def test_create_retries_keep_their_15_second_pause(self) -> None:
        clock = FakeClock()
        agora = FakeAgora(create_refusals=["quota", "unavailable"])
        result = run_step(agora, SPEC, log=quiet, sleep=clock.sleep, clock=clock)  # type: ignore[arg-type]
        self.assertEqual(clock.sleeps[:2], [15, 15])
        self.assertEqual(clock.sleeps[2:], [SPEC.poll_seconds] * 4)
        self.assertEqual(agora.sent, ["Create", "Write", "Stop"])
        self.assertEqual(result.text, "Hello, world.")


class Ids(unittest.TestCase):
    def test_cadence_changes_task_inputs_but_not_workstream_or_command_ids(self) -> None:
        changed = replace(SPEC, poll_seconds=1, ready_timeout_seconds=30)
        self.assertNotEqual(asdict(SPEC), asdict(changed))
        original_ws = step_id(SPEC.run, SPEC.step, SPEC.round)
        changed_ws = step_id(changed.run, changed.step, changed.round)
        self.assertEqual(original_ws, changed_ws)
        for name in ("create", "write-1", "stop"):
            self.assertEqual(command_id(original_ws, name), command_id(changed_ws, name))
        agora = FakeAgora()
        first = run(agora)
        again = run(agora, changed)
        self.assertEqual(first, again)
        self.assertEqual(agora.sent, ["Create", "Write", "Stop"])

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
