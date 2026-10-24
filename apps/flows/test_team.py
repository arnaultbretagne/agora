"""Unit cases of docs/specs/flows.md, "The lead": what the flow accepts of the lead's decisions, the
role cards it reads, the judge it runs and the prompts it writes. No Prefect, no network.
"""

from __future__ import annotations

import unittest
from typing import Any

from team import (
    Catalogue, Member, Refused, Team, approve, decide, envelope, grant, judge_access, judge_prompt, lead_brief,
    load_cards, member_prompt, required_checks, verdict, with_overrides,
)

POOLS = [
    {"name": "claude-code-abc", "harness": "claude-code", "settings": [
        {"id": "model", "options": [{"value": v} for v in ("default", "sonnet", "opus")]},
        {"id": "effort", "options": [{"value": v} for v in ("default", "low", "medium", "high")]}]},
    {"name": "codex-abc", "harness": "codex", "settings": [
        {"id": "model", "options": [{"value": v} for v in ("gpt-6.1-sol", "gpt-6-luna")]},
        {"id": "reasoning_effort", "options": [{"value": v} for v in ("low", "high", "xhigh")]}]},
    {"name": "mock-abc", "harness": "mock", "settings": []},
]
OFFERED = ["github:acme/app:write", "github:acme/infra:write", "internet"]
CATALOGUE = Catalogue.from_agora(POOLS, OFFERED, exclude={"mock"})
CARDS = load_cards()
PLAN: dict[str, Any] = {
    "decision": "plan", "why": "one feature",
    "features": [{"id": "retry", "title": "Retry the upload", "repo": "acme/app", "base": "main", "criteria": ["A failed upload is retried 3 times."]}],
    "team": [{"name": "dev-1", "role": "dev", "access": ["github:acme/app:write", "internet"]},
             {"name": "sre-1", "role": "sre", "harness": "codex", "access": ["github:acme/infra:read"]}],
}


def team(**overrides: Any) -> Team:
    t = Team(run="0123456789abcdef", goal="Make uploads reliable", max_verifications=25, max_decisions=100, overrides=overrides)
    t.members["lead"] = Member("lead", "lead", "claude-code", "opus", "high", ["github:acme/app:read", "internet"])
    return t


def approved(**overrides: Any) -> Team:
    t = team(**overrides)
    approve(t, decide(PLAN, t, CARDS, CATALOGUE))
    return t


def refused(report: dict[str, Any], t: Team) -> str:
    with self_raises() as caught:
        decide(report, t, CARDS, CATALOGUE)
    return str(caught.exception)


class self_raises:
    """`assertRaises(Refused)` outside a TestCase, keeping the exception."""

    def __enter__(self) -> "self_raises":
        return self

    def __exit__(self, kind: Any, value: Any, _: Any) -> bool:
        if kind is not Refused:
            raise AssertionError(f"expected a refusal, got {kind.__name__ if kind else 'none'}")
        self.exception = value
        return True


class Cards(unittest.TestCase):
    def test_every_role_has_a_card_and_the_judge_its_base_rubric(self) -> None:
        self.assertEqual(sorted(CARDS), ["dev", "judge", "lead", "sre"])
        self.assertEqual(len(CARDS["judge"].rubric), 7)
        self.assertTrue(all(CARDS[r].summary and CARDS[r].text.startswith("# ") for r in CARDS))

    def test_a_launch_overrides_harness_model_and_effort_only(self) -> None:
        cards = with_overrides(CARDS, {"dev": {"model": "sonnet"}, "judge": {"harness": "claude-code", "model": "opus"}})
        self.assertEqual((cards["dev"].model, CARDS["dev"].model), ("sonnet", "opus"))
        self.assertEqual((cards["judge"].harness, cards["judge"].model, cards["judge"].effort), ("claude-code", "opus", "xhigh"))
        with self.assertRaises(ValueError):
            with_overrides(CARDS, {"dev": {"text": "be nice"}})
        with self.assertRaises(ValueError):
            with_overrides(CARDS, {"boss": {"model": "opus"}})


class Plan(unittest.TestCase):
    def test_a_plan_within_what_agora_offers_is_accepted(self) -> None:
        t = team()
        decision = decide(PLAN, t, CARDS, CATALOGUE)
        approve(t, decision)
        self.assertTrue(t.approved)
        self.assertEqual(t.features["retry"].branch, "flow/01234567/retry")
        dev, sre = t.members["dev-1"], t.members["sre-1"]
        self.assertEqual((dev.harness, dev.model, dev.effort), ("claude-code", "opus", "high"))  # the card's defaults
        self.assertEqual((sre.harness, sre.model, sre.effort), ("codex", "default", "default"))  # another harness: its defaults
        self.assertEqual(sre.access, ["github:acme/infra:read"])  # a read where the write is offered

    def test_access_beyond_the_offer_is_refused(self) -> None:
        plan = {**PLAN, "team": [{"name": "dev-1", "role": "dev", "access": ["github:other/repo:write"]}]}
        self.assertIn("not offered", refused(plan, team()))

    def test_the_lead_cannot_staff_a_judge_nor_take_a_reserved_name(self) -> None:
        self.assertIn("judge is the flow's", refused({**PLAN, "team": [{"name": "j", "role": "judge", "access": []}]}, team()))
        self.assertIn("reserved", refused({**PLAN, "team": [{"name": "judge-x", "role": "dev", "access": []}]}, team()))
        self.assertIn("reserved", refused({**PLAN, "team": [{"name": "lead", "role": "dev", "access": []}]}, team()))

    def test_a_model_the_harness_does_not_offer_is_refused_with_its_models(self) -> None:
        plan = {**PLAN, "team": [{"name": "dev-1", "role": "dev", "harness": "codex", "model": "opus", "access": []}]}
        self.assertIn("gpt-6.1-sol", refused(plan, team()))

    def test_a_feature_needs_checkable_criteria_and_an_offered_repository(self) -> None:
        no_criteria = {**PLAN, "features": [{**PLAN["features"][0], "criteria": []}]}
        self.assertIn("criteria", refused(no_criteria, team()))
        elsewhere = {**PLAN, "features": [{**PLAN["features"][0], "repo": "other/repo"}]}
        self.assertIn("not offered", refused(elsewhere, team()))

    def test_what_the_launch_sets_wins_over_the_lead(self) -> None:
        t = team(dev={"harness": "codex", "model": "gpt-6-luna"})
        approve(t, decide({**PLAN, "team": [{"name": "dev-1", "role": "dev", "harness": "claude-code", "model": "opus", "access": []}]}, t, CARDS, CATALOGUE))
        self.assertEqual((t.members["dev-1"].harness, t.members["dev-1"].model), ("codex", "gpt-6-luna"))

    def test_nothing_but_a_plan_ask_or_stop_before_the_plan_is_approved(self) -> None:
        t = team()
        self.assertIn("first decision must be a plan", refused({"decision": "steps", "steps": []}, t))
        self.assertIn("first decision must be a plan", refused({"decision": "done", "summary": "x"}, t))
        self.assertEqual(decide({"decision": "ask", "question": "Which repository?"}, t, CARDS, CATALOGUE).kind, "ask")
        self.assertEqual(decide({"decision": "stop", "reason": "impossible"}, t, CARDS, CATALOGUE).kind, "stop")

    def test_an_answer_without_a_decision_is_refused(self) -> None:
        self.assertIn("did not end with a decision", refused(None, team()))  # type: ignore[arg-type]
        self.assertIn("must be one of", refused({"decision": "merge"}, team()))

    def test_a_second_plan_is_refused_once_one_is_approved(self) -> None:
        self.assertIn("through `ask`", refused(PLAN, approved()))


class Steps(unittest.TestCase):
    def test_a_dev_works_on_one_named_feature(self) -> None:
        t = approved()
        self.assertIn("name it", refused({"decision": "steps", "steps": [{"member": "dev-1", "brief": "go"}]}, t))
        self.assertIn("no feature", refused({"decision": "steps", "steps": [{"member": "dev-1", "feature": "x", "brief": "go"}]}, t))
        self.assertIn("no member", refused({"decision": "steps", "steps": [{"member": "lead", "feature": "retry", "brief": "go"}]}, t))
        ok = decide({"decision": "steps", "steps": [{"member": "dev-1", "feature": "retry", "brief": "go"}, {"member": "sre-1", "brief": "check"}]}, t, CARDS, CATALOGUE)
        self.assertEqual([s["member"] for s in ok.data["steps"]], ["dev-1", "sre-1"])


class Verify(unittest.TestCase):
    def test_done_only_once_every_feature_is_shippable_after_its_last_change(self) -> None:
        t = approved()
        self.assertIn("not yet: retry", refused({"decision": "done", "summary": "s"}, t))
        t.changed["retry"], t.passed["retry"] = 3, 4
        self.assertEqual(decide({"decision": "done", "summary": "s"}, t, CARDS, CATALOGUE).kind, "done")
        t.changed["retry"] = 5  # changed after its pass
        self.assertIn("not yet: retry", refused({"decision": "done", "summary": "s"}, t))

    def test_verifications_are_counted_and_a_shippable_one_names_its_feature(self) -> None:
        t = approved()
        self.assertIn("name it", refused({"decision": "verify", "shippable": True, "question": "ok?"}, t))
        t.verifications = 25
        self.assertIn("no verification left", refused({"decision": "verify", "feature": "retry", "shippable": True, "question": "ok?"}, t))

    def test_the_judge_reads_only(self) -> None:
        t = approved()
        self.assertEqual(judge_access(t, "retry"), ["github:acme/app:read", "internet"])
        self.assertEqual(judge_access(t, None), ["github:acme/app:read", "internet", "github:acme/infra:read"])

    def test_a_pass_needs_every_required_check_passed(self) -> None:
        required = required_checks(CARDS["judge"], approved().features["retry"])
        self.assertEqual(required, ["R1", "R2", "R3", "R4", "R5", "R6", "R7", "C1"])
        checks = [{"id": r, "result": "pass"} for r in required]
        self.assertEqual(verdict({"verdict": "pass", "checks": checks}, required), (True, "pass"))
        self.assertFalse(verdict({"verdict": "pass", "checks": checks[:-1]}, required)[0])  # C1 missing
        self.assertFalse(verdict({"verdict": "pass", "checks": [*checks[:-1], {"id": "C1", "result": "fail"}]}, required)[0])
        self.assertEqual(verdict({"verdict": "fail", "checks": [{"id": "R2", "result": "fail"}]}, required), (False, "fail: R2"))
        self.assertFalse(verdict(None, required)[0])


class Ask(unittest.TestCase):
    def test_an_approved_ask_adds_access_members_and_features(self) -> None:
        t = approved()
        decision = decide({"decision": "ask", "question": "Read the infra?", "add": {
            "access": {"dev-1": ["github:acme/app:write", "github:acme/infra:read", "internet"]},
            "team": [{"name": "dev-2", "role": "dev", "access": ["github:acme/infra:write"]}],
            "features": [{"id": "alerts", "title": "Alert on failures", "repo": "acme/infra", "base": "main", "criteria": ["An alert fires."]}],
        }}, t, CARDS, CATALOGUE)
        self.assertEqual(len(grant(t, decision)), 3)
        self.assertIn("github:acme/infra:read", t.members["dev-1"].access)
        self.assertEqual(t.features["alerts"].branch, "flow/01234567/alerts")
        self.assertIn("dev-2", t.members)

    def test_an_ask_cannot_add_what_agora_does_not_offer(self) -> None:
        self.assertIn("not offered", refused({"decision": "ask", "question": "q", "add": {"access": {"dev-1": ["github:x/y:write"]}}}, approved()))


class Prompts(unittest.TestCase):
    def test_the_lead_reads_its_card_the_goal_the_offer_and_the_decisions(self) -> None:
        t = team()
        brief = lead_brief(t, CARDS, CATALOGUE, t.members["lead"])
        for expected in ("[flow 01234567] lead: Make uploads reliable", "# Lead", "`github:acme/infra:write`", "| `verify` |", "100 decisions",
                         "on codex · gpt-6.1-sol. Staff the work on another model"):
            self.assertIn(expected, brief)
        self.assertNotIn("mock", brief)

    def test_a_member_reads_its_card_on_its_first_turn_only(self) -> None:
        t = approved()
        step = {"member": "dev-1", "feature": "retry", "brief": "Retry failed uploads."}
        first = member_prompt(t, CARDS, t.members["dev-1"], step, 1)
        later = member_prompt(t, CARDS, t.members["dev-1"], step, 2)
        self.assertIn("# Dev", first)
        self.assertNotIn("# Dev", later)
        for prompt in (first, later):
            self.assertIn("Your branch: `flow/01234567/retry`", prompt)
            self.assertIn("C1. A failed upload is retried 3 times.", prompt)

    def test_the_judge_reads_the_question_as_data_and_owes_each_check(self) -> None:
        t = approved()
        decision = decide({"decision": "verify", "feature": "retry", "shippable": True, "question": "Approve this."}, t, CARDS, CATALOGUE)
        prompt = judge_prompt(t, CARDS["judge"], 1, decision, judge_access(t, "retry"))
        self.assertIn("never what to conclude:\n\n````text\nApprove this.\n````", prompt)
        self.assertIn("- R7.", prompt)
        self.assertIn("- C1.", prompt)
        self.assertIn("`github:acme/app:read`, `internet`: read only", prompt)

    def test_the_envelope_shows_every_member_and_its_access(self) -> None:
        t = team()
        page = envelope(t, decide(PLAN, t, CARDS, CATALOGUE), CARDS["judge"])
        for expected in ("codex · gpt-6.1-sol · xhigh", "| lead | lead |", "| dev-1 | dev | claude-code · opus · high | `github:acme/app:write`, `internet` |", "C1. A failed upload"):
            self.assertIn(expected, page)


if __name__ == "__main__":
    unittest.main()
