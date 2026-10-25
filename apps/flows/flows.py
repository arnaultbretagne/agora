"""Agora's workflows on Prefect: a lead decides, the flow carries out, each member works in its own
Workstream (agora.py), turn after turn.

The lead never touches Prefect or Agora: it answers each turn with one decision (team.py), and the
flow carries it out within the envelope the person approved, then comes back to the lead with the
outcome. Whatever needs the person — the envelope, what the lead asks, a turn the flow cannot settle —
is a question in the lead's Workstream, answered in Agora's client; the run waits for the answer on
the thread's stream. The flow names everything — branches, Workstreams, who reads what — and each
agent only does its work and ends with a short JSON report (docs/specs/flows.md).

What a person reads in Prefect: each flow's description and documented parameters; each run's graph —
the lead's turns, and between them each decision as a subflow holding its turns and its waits; and its
pages under Artifacts — the run, the envelope, each decision, each turn with its exact prompt and
answer, a summary.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from dataclasses import asdict, replace
from typing import Any

from prefect import flow, get_run_logger, task
from prefect.artifacts import create_markdown_artifact, create_table_artifact
from prefect.runtime import flow_run

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from agora import Agora, Escalation, TurnSpec, ask, command_id, run_turn, split_last_json, wait_answer, workstream_id  # noqa: E402
from team import (  # noqa: E402
    STAFFED, Catalogue, Member, Refused, Team, approve, asked, decide, decision_json, envelope, grant,
    judge_access, judge_prompt, lead_brief, lead_update, load_cards, member_prompt, read_only,
    required_checks, verdict, with_overrides,
)

# The owner of the live cases (apps/server/scripts): a rehearsal's Workstreams stay out of the
# operator's list, and purge-live-cases.sql removes them.
REHEARSAL_OWNER = "c45e0000-0000-4000-8000-000000000000"
SOURCE = "https://github.com/arnaultbretagne/agora"
# What the lead reads of a member's answer; the whole answer stays in the member's Workstream.
ANSWER_TO_LEAD = 6000

# The options of the person's three questions (docs/specs/log.md, "Commands": Ask).
ENVELOPE_OPTIONS = [
    {"optionId": "approve", "name": "Approve", "kind": "allow_once"},
    {"optionId": "revise", "name": "Revise", "kind": "reject_once"},
    {"optionId": "stop", "name": "Stop", "kind": "reject_always"},
]
ASK_OPTIONS = [
    {"optionId": "yes", "name": "Yes", "kind": "allow_once"},
    {"optionId": "no", "name": "No", "kind": "reject_once"},
]
SETTLE_OPTIONS = [
    {"optionId": "retry", "name": "Retry", "kind": "allow_once"},
    {"optionId": "abort", "name": "Abort the run", "kind": "reject_always"},
]


def agora(owner: str | None) -> Agora:
    """The worker's Agora; the Workstreams belong to the operator unless a run names another owner."""
    return Agora(os.environ["AGORA_URL"], owner or os.environ["AGORA_OWNER"])


def source_link(path: str) -> str:
    """A file of this directory at the commit the run cloned."""
    here = os.path.dirname(os.path.abspath(__file__))
    try:
        sha = subprocess.run(["git", "-C", here, "rev-parse", "HEAD"], capture_output=True, text=True, timeout=10).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        sha = ""
    return f"{SOURCE}/blob/{sha}/apps/flows/{path}" if sha else f"{SOURCE}/tree/design/agora-foundations/apps/flows/{path}"


def fenced(text: str, lang: str = "text") -> str:
    """Text shown as is, whatever fences it holds itself."""
    return f"````{lang}\n{text}\n````"


def page_key(run: str, name: str) -> str:
    """A page's key: the same page published again — a run retried — is a new version, not a second page."""
    return re.sub(r"[^a-z0-9]+", "-", f"flow-{run[:8]}-{name}".lower()).strip("-")[:100]


def one_line(text: str, limit: int = 150) -> str:
    line = " ".join(text.split())
    return line if len(line) <= limit else line[: limit - 1] + "…"


# ---------------------------------------------------------------- turns and the person

def turn_page(label: str, spec: TurnSpec, result: dict[str, Any]) -> str:
    body, report = split_last_json(result.get("text", ""))
    rows = [
        ("Harness", f"`{spec.harness}`" + (f", {', '.join(f'{k} `{v}`' for k, v in spec.settings.items())}" if spec.settings else "")),
        ("Access", ", ".join(f"`{p}`" for p in spec.profiles) or "none"),
        ("Agora Workstream", f"`{result.get('workstream', '')}`, turn {spec.turn}"),
        ("Execution", f"`{result.get('execution', '')}`"),
        ("Turn", f"{result.get('status')} ({result.get('stop_reason')})"),
    ]
    table = "\n".join(["| | |", "| --- | --- |", *(f"| {k} | {v} |" for k, v in rows)])
    return (
        f"# {label}\n\n{table}\n\n## Report\n\n{fenced(json.dumps(report, indent=2, ensure_ascii=False), 'json') if report else '_No JSON report at the end of the answer._'}"
        f"\n\n## Answer\n\n{body or '_Empty._'}\n\n## Prompt sent\n\n{fenced(spec.prompt)}\n"
    )


@task(retries=3, retry_delay_seconds=20, persist_result=True, task_run_name="{label}")
def member_turn(spec: dict[str, Any], label: str, owner: str | None = None) -> dict[str, Any]:
    """One turn of one member, its answer, and its page among the run's artifacts. The spec's
    `attempt` tells a retry the person asked for from a cached result."""
    turn = TurnSpec(**spec)
    key = page_key(turn.run, f"{turn.member}-turn-{turn.turn}")
    try:
        result = {"ok": True, **asdict(run_turn(agora(owner), turn, log=get_run_logger().info))}
    except Escalation as escalation:
        create_markdown_artifact(
            markdown=f"# {label}\n\n**Needs you:** {escalation}\n\n## Prompt\n\n{fenced(turn.prompt)}\n",
            key=key,
            description=f"{label} — needs you",
        )
        return {"ok": False, "escalation": str(escalation)}
    create_markdown_artifact(markdown=turn_page(label, turn, result), key=key, description=label)
    return result


@task(retries=3, retry_delay_seconds=20, persist_result=True, task_run_name="Waiting for you: {title}")
def human(run: str, key: str, title: str, text: str, options: list[dict[str, str]], note: bool, owner: str | None = None,
          scripted: dict[str, Any] | None = None, workstream: str = "") -> dict[str, Any]:
    """A question to the person in the lead's Workstream, and their answer — its option and note —
    once given, read on the thread's stream. `scripted`, in a rehearsal only: the answer the script gives."""
    client = agora(owner)
    workstream = workstream or workstream_id(run, "lead")
    client.ensure_workstream(workstream)
    position = ask(client, workstream, key, {"title": title, "text": text, "options": options, "note": note})
    get_run_logger().info(f"asked in the lead's Workstream {workstream}: {title}")
    if scripted is not None:
        client.command(workstream, command_id(workstream, f"answer-{key}"), "Answer", {"question": position}, scripted)
    return wait_answer(client, workstream, position)


def turn(spec: TurnSpec, label: str, owner: str | None, after: Any = None,
         lead: tuple[str, str | None] = ("", None)) -> tuple[dict[str, Any], Any]:
    """A turn, with what it cannot settle asked of the person until they abort or it succeeds; its
    result, and its state for the next task's edge in the graph. `owner` owns the member's Workstream;
    `lead`, the lead's Workstream and its owner, where the person is asked."""
    while True:
        state = member_turn(asdict(spec), label, owner, wait_for=[after] if after is not None else None, return_state=True)
        result = state.result()
        if result["ok"]:
            return result, state
        get_run_logger().warning(f"{label}: {result['escalation']}")
        answer = human(
            spec.run, f"escalation-{spec.member}-{spec.turn}-{spec.attempt}", one_line(f"{label} needs you"),
            f"> {result['escalation']}\n\nSettle it in Agora if it can be, then retry; or abort the run.",
            SETTLE_OPTIONS, False, lead[1], None, lead[0], wait_for=[state],
        )
        if answer.get("optionId") != "retry":
            raise RuntimeError(f"aborted at {label}")
        spec, after = replace(spec, attempt=spec.attempt + 1), None


@flow(name="decision", flow_run_name="{label}", persist_result=True, validate_parameters=False)
def carry_out(label: str, items: list[dict[str, Any]], owner: str | None = None,
              lead: tuple[str, str | None] = ("", None)) -> list[dict[str, Any]]:
    """One decision of the lead, carried out: its members' turns, or its question to the person, one
    after the other."""
    results: list[dict[str, Any]] = []
    after = None
    for item in items:
        if "question" in item:
            q = item["question"]
            state = human(q["run"], q["key"], q["title"], q["text"], q["options"], q["note"], lead[1], q.get("scripted"), lead[0],
                          wait_for=[after] if after is not None else None, return_state=True)
            results.append(state.result())
            after = state
        else:
            result, after = turn(TurnSpec(**item["turn"]), item["label"], item.get("owner", owner), after, lead)
            results.append(result)
    return results


# ---------------------------------------------------------------- the lead's run

LEAD = """\
**A lead manages a small team towards your goal; you approve its plan once, then answer only what it asks.**

| Who | Does | Access |
| --- | --- | --- |
| **lead** | Cuts the goal into features, staffs them, briefs, sends work to the judge, decides when it is done. Never designs or codes. | Read only, every offered repository; the Internet |
| **dev** | Designs, codes and proves one feature on its own branch `flow/<run>/<feature>`, up to a draft pull request. | What the plan gives it, approved by you |
| **sre** | Owns how things run on the cluster, production only: changes it through its GitOps repository, with a rollout, a way back and proof. | What the plan gives it, approved by you |
| **judge** | Verifies what the lead asks, fresh each time: reads CI, probes where it is blind; a feature ships only once judged shippable. | Read only |

Each answer of the lead is one decision: `plan` (the envelope you approve: features, criteria, team, \
access), `steps` (members work, one after the other), `verify` (the judge), `ask` (you; the whole run \
waits), `done`, `stop`. The flow refuses what leaves the envelope and tells the lead why. Nobody merges \
or deploys. Role cards: `apps/flows/roles`.

You answer in Agora, in the lead's Workstream `[flow <run>] lead: …`, listed "waiting for you" while a \
question waits. The graph shows the lead's turns and, between them, each decision with its turns and \
waits; each run shows the envelope, each decision, each turn with its exact prompt and answer, and a \
summary, under *Artifacts*.
"""


def run_name() -> str:
    goal = str(flow_run.parameters.get("goal", ""))
    return f"{goal[:60]}{'…' if len(goal) > 60 else ''} · flow/{str(flow_run.id)[:8]}"


def drive(goal: str, overrides: dict[str, dict[str, str]], max_verifications: int, max_decisions: int, owner: str | None,
          harnesses: set[str] | None = None, exclude: set[str] | None = None, script: dict[str, Any] | None = None,
          lead_workstream: str | None = None, members_owner: str | None = None) -> dict[str, Any]:
    """The lead's run. `owner` owns the lead's Workstream — `lead_workstream` when Agora created it —
    and is the person asked; `members_owner`, the members' Workstreams, the owner's without it.
    `script`, in a rehearsal only: what the mock, which echoes its prompts, answers, and what the
    person answers."""
    lead_at = (lead_workstream or "", owner)
    members_at = members_owner or owner
    logger = get_run_logger()
    run = str(flow_run.id)
    cards = with_overrides(load_cards(), overrides)
    team = Team(run=run, goal=goal, max_verifications=max_verifications, max_decisions=max_decisions, overrides=overrides)
    client = agora(owner)

    def catalogue() -> Catalogue:
        return Catalogue.from_agora(client.pools(), client.offered(), harnesses, exclude)

    first = catalogue()
    card = cards["lead"]
    lead_settings = first.settings(card.harness, card.model, card.effort)  # a bad launch fails here, before any turn
    lead = Member("lead", "lead", card.harness, card.model, card.effort, read_only([*first.offered, "internet"]))
    team.members["lead"] = lead
    rows: list[dict[str, str]] = []

    def page(name: str, title: str, markdown: str) -> None:
        create_markdown_artifact(markdown=markdown, key=page_key(run, name), description=title)

    def tail(kind: str, number: int = 0, required: list[str] | None = None) -> str:
        """What the mock must echo last, in a rehearsal: the scripted decision, report or verdict."""
        if script is None:
            return ""
        if kind == "lead":
            decisions = script.get("decisions", [])
            chosen = decisions[number - 1] if number <= len(decisions) else {"decision": "stop", "reason": "end of the rehearsal's script"}
        elif kind == "judge":
            verdicts = script.get("verdicts", [])
            given = verdicts[number - 1] if number <= len(verdicts) else "pass"
            chosen = {"verdict": given, "summary": f"rehearsal verdict {number}",
                      "checks": [{"id": r, "check": "rehearsal", "result": given, "evidence": "scripted"} for r in (required or ["X1"])]}
        else:
            chosen = {"status": "done", "summary": "rehearsal step", "pull_request": None}
        return "\n\n" + json.dumps(chosen)

    def said(result: dict[str, Any]) -> tuple[str, dict[str, Any] | None]:
        """An answer and its report. In a rehearsal, the mock's echo only: from its second message on,
        the mock quotes the one before after its echo, the earlier scripted answer with it."""
        text = result["text"]
        if script is not None:
            text = text.split('. Before, you told me "', 1)[0]
        return split_last_json(text)

    def question(key: str, title: str, text: str, options: list[dict[str, str]], scripted: str) -> dict[str, Any]:
        return {"question": {"run": run, "key": key, "title": one_line(title), "text": text, "options": options, "note": True,
                             "scripted": (script or {}).get("answers", {}).get(scripted) if script is not None else None}}

    page("run", "The run", f"# {goal}\n\n{LEAD}\n\n| Parameter | Value |\n| --- | --- |\n"
         + "\n".join(f"| `{k}` | `{json.dumps(v)}` |" for k, v in [("overrides", overrides), ("max_verifications", max_verifications),
                                                                    ("max_decisions", max_decisions)])
         + f"\n\nThe flow's code and role cards at the commit this run used: {source_link('flows.py')}, {source_link('roles')}\n")

    outcome, ended, lead_state = "", None, None
    while team.decisions < team.max_decisions and ended is None:
        team.decisions += 1
        number = team.decisions
        lead.turns += 1
        prompt = lead_brief(team, cards, first, lead) if number == 1 else lead_update(team, outcome)
        answer, lead_state = turn(TurnSpec(run=run, member="lead", turn=lead.turns, harness=lead.harness, prompt=prompt + tail("lead", number),
                                           profiles=lead.access, settings=lead_settings, workstream=lead_at[0]), f"{number} · lead", owner, lead_state, lead_at)
        body, report = said(answer)
        try:
            if answer["status"] != "done":
                raise Refused(f"your turn ended {answer['status']} ({answer['stop_reason']}) before you decided")
            decision = decide(report, team, cards, catalogue())
        except Refused as refusal:
            page(f"decision-{number}", f"Decision {number} · refused", f"# Decision {number}: refused\n\n**{refusal}**\n\n## What the lead answered\n\n"
                 + (fenced(json.dumps(report, indent=2, ensure_ascii=False), "json") if report else "_No decision._"))
            rows.append({"Decision": str(number), "Kind": str((report or {}).get("decision", "—")), "Outcome": f"refused: {refusal}"})
            outcome = f"Decision {number} refused: {refusal}. Nothing was carried out."
            logger.warning(outcome)
            continue
        page(f"decision-{number}", f"Decision {number} · {decision.kind}", f"# Decision {number}: {decision.kind}\n\n{decision.why or '_No reason given._'}\n\n"
             + fenced(decision_json(decision), "json") + (f"\n\n## The lead's answer\n\n{body}" if body else ""))
        logger.info(f"decision {number}: {decision.kind}")
        label = f"{number} · {decision.kind}"

        if decision.kind == "plan":
            text = (f"{envelope(team, decision, cards['judge'])}\n\n---\n\n**Approve** starts the run within this envelope; "
                    "**Revise** sends your note to the lead, who plans again; **Stop** ends the run.")
            [reply] = carry_out(label, [question(f"envelope-{number}", decision.data["title"], text, ENVELOPE_OPTIONS, "envelope")], owner, lead_at)
            choice, note = reply.get("optionId"), str(reply.get("note") or "")
            notes = f" Their note: {note}" if note else ""
            if choice == "approve":
                approve(team, decision)
                page("envelope", "The envelope", f"# {decision.data['title']}\n\n_Approved._\n\n{envelope(team, decision, cards['judge'])}\n\n_Note:_ {note or 'none'}")
                outcome = f"The person approved your plan.{notes} Carry it out."
            elif choice == "revise":
                outcome = f"The person asks you to revise your plan.{notes}"
            else:
                ended = ("stopped by the person at the plan", note)
            rows.append({"Decision": str(number), "Kind": "plan", "Outcome": f"{choice}{notes}"})

        elif decision.kind == "steps":
            items, members = [], []
            for step in decision.data["steps"]:
                member = team.members[step["member"]]
                member.turns += 1
                feature = team.features.get(step["feature"]) if step["feature"] else None
                spec = TurnSpec(run=run, member=member.name, turn=member.turns, harness=member.harness,
                                prompt=member_prompt(team, cards, member, step, member.turns) + tail("member"),
                                profiles=member.access, settings=first.settings(member.harness, member.model, member.effort))
                items.append({"turn": asdict(spec), "label": f"{member.name}{f' · {feature.id}' if feature else ''}", "owner": members_at})
                members.append((member, feature))
            results = carry_out(label, items, owner, lead_at)
            parts = []
            for i, ((member, feature), result) in enumerate(zip(members, results), 1):
                if feature and (member.role == "dev" or f"github:{feature.repo}:write" in member.access):
                    team.changed[feature.id] = number
                text, report = said(result)
                cut = f"\n\n(cut: the whole answer is in {member.name}'s Workstream)" if len(text) > ANSWER_TO_LEAD else ""
                parts.append(f"### Step {i}: {member.name}{f' on {feature.id}' if feature else ''}, turn {result['status']} ({result['stop_reason']})\n\n"
                             f"Report: {json.dumps(report, ensure_ascii=False) if report else 'none'}\n\nAnswer:\n\n{text[:ANSWER_TO_LEAD]}{cut}")
                rows.append({"Decision": str(number), "Kind": "steps",
                             "Outcome": f"{member.name}: {(report or {}).get('status', 'no report')} ({result['status']})"})
            outcome = f"Your steps of decision {number} ran.\n\n" + "\n\n".join(parts)

        elif decision.kind == "verify":
            team.verifications += 1
            feature_id = decision.data["feature"]
            judge = cards["judge"]
            access = judge_access(team, feature_id)
            required = required_checks(judge, team.features[feature_id]) if decision.data["shippable"] else []
            spec = TurnSpec(run=run, member=f"judge-{team.verifications}", turn=1, harness=judge.harness,
                            prompt=judge_prompt(team, judge, team.verifications, decision, access) + tail("judge", team.verifications, required),
                            profiles=access, settings=catalogue().settings(judge.harness, judge.model, judge.effort))
            [result] = carry_out(label, [{"turn": asdict(spec), "label": f"judge-{team.verifications}{f' · {feature_id}' if feature_id else ''}",
                                          "owner": members_at}], owner, lead_at)
            text, report = said(result)
            passed, why = verdict(report, required) if result["status"] == "done" else (False, f"cut, turn {result['status']}")
            if passed and decision.data["shippable"]:
                team.passed[feature_id] = number
            what = "shippable" if decision.data["shippable"] else "verified"
            name = f"Verification {team.verifications}{f' of {feature_id}' if feature_id else ''}"
            if result["status"] != "done":
                outcome = (f"{name}: CUT before its verdict (turn {result['status']}): nothing was judged, and it counts. "
                           f"What the judge had said by then:\n\n{text[-ANSWER_TO_LEAD:]}")
            else:
                outcome = (f"{name}: {'PASS' if passed else 'FAIL'}{f', {feature_id} is {what}' if passed and feature_id else ''} ({why}).\n\n"
                           f"The judge's report:\n\n{json.dumps(report, indent=2, ensure_ascii=False) if report else text[-ANSWER_TO_LEAD:]}")
            rows.append({"Decision": str(number), "Kind": "verify", "Outcome": f"{'pass' if passed else 'fail'} ({why})"})

        elif decision.kind == "ask":
            text = f"{asked(team, decision)}\n\n---\n\n**Yes** adds what it asks for, if anything; your note goes to the lead either way."
            [reply] = carry_out(label, [question(f"ask-{number}", f"The lead asks: {decision.data['question']}", text, ASK_OPTIONS, "ask")], owner, lead_at)
            choice, note = reply.get("optionId"), str(reply.get("note") or "")
            granted = grant(team, decision) if choice == "yes" else []
            outcome = (f"The person answered {choice}." + (f" Their note: {note}" if note else "")
                       + ("\n\n" + "\n".join(f"- {line}" for line in granted) if granted else ""))
            rows.append({"Decision": str(number), "Kind": "ask", "Outcome": str(choice) + (f": {', '.join(granted)}" if granted else "")})

        elif decision.kind == "done":
            ended = ("done", decision.data["summary"])
            rows.append({"Decision": str(number), "Kind": "done", "Outcome": decision.data["summary"][:300]})

        else:
            ended = ("stopped by the lead", decision.data["reason"])
            rows.append({"Decision": str(number), "Kind": "stop", "Outcome": decision.data["reason"][:300]})

    result, why = ended or ("decision limit reached", f"{team.max_decisions} decisions")
    branches = {f.id: f.branch for f in team.features.values()}
    create_table_artifact(table=rows, key=page_key(run, "summary"), description=f"Outcome: {result}: {why[:200]}")
    logger.info(f"run {result}: shippable {team.shippable()}, branches {branches}")
    return {"outcome": result, "why": why, "branches": branches, "shippable": team.shippable(),
            "decisions": team.decisions, "verifications": team.verifications}


@flow(name="lead", persist_result=True, flow_run_name=run_name, description=LEAD)
def lead(
    goal: str,
    overrides: dict[str, dict[str, str]] = {},  # noqa: B006 — Prefect copies parameters per run
    max_verifications: int = 25,
    max_decisions: int = 100,
    lead_workstream: str | None = None,
    owner: str | None = None,
    members_owner: str | None = None,
) -> dict[str, Any]:
    """A lead manages a small team towards the goal; you approve its plan once, in Agora.

    Args:
        goal: What the run must achieve, in a few sentences: the lead's only brief.
        overrides: A role's harness, model or effort, set for this run, e.g. `{"dev": {"model": "sonnet"}}`. Roles: lead, dev, sre, judge.
        max_verifications: Verifications by the judge, at most.
        max_decisions: Decisions of the lead, at most, refused ones included.
        lead_workstream: The lead's Workstream, when Agora created it for a team launched from its client.
        owner: Who owns the lead's Workstream and is asked: an identity UUID; the worker's operator without it.
        members_owner: Who owns the members' Workstreams: the agents' identity UUID; the owner's without it.
    """
    return drive(goal, overrides, max_verifications, max_decisions, owner=owner, exclude={"mock"},
                 lead_workstream=lead_workstream, members_owner=members_owner)


REHEARSAL_SCRIPT: dict[str, Any] = {
    "decisions": [
        {"decision": "steps", "why": "refused: no plan yet", "steps": [{"member": "dev-1", "feature": "echo", "brief": "too early"}]},
        {"decision": "plan", "title": "Make the mock echo", "why": "One feature, one dev, one sre.",
         "features": [{"id": "echo", "title": "The mock echoes", "repo": "arnaultbretagne/agora", "base": "design/agora-foundations",
                       "criteria": ["The mock answers with its prompt."]}],
         "team": [{"name": "dev-1", "role": "dev", "access": ["github:arnaultbretagne/agora:read", "internet"]},
                  {"name": "sre-1", "role": "sre", "access": ["internet"]}]},
        {"decision": "steps", "why": "Build it.", "steps": [{"member": "dev-1", "feature": "echo", "brief": "Make the mock echo."}]},
        {"decision": "verify", "why": "Ready?", "feature": "echo", "shippable": True, "question": "Does the mock echo?"},
        {"decision": "done", "why": "refused: not judged shippable", "summary": "too early"},
        {"decision": "steps", "why": "Fix what the judge failed.", "steps": [{"member": "dev-1", "feature": "echo", "brief": "Fix the failed checks."}]},
        {"decision": "verify", "why": "Ready now.", "feature": "echo", "shippable": True, "question": "Does the mock echo now?"},
        {"decision": "ask", "why": "The sre must read the infrastructure.", "question": "Give sre-1 read access to infra-k8s?",
         "add": {"access": {"sre-1": ["github:arnaultbretagne/infra-k8s:read", "internet"]}}},
        {"decision": "steps", "why": "Check how it runs.", "steps": [{"member": "sre-1", "brief": "Check how the echo runs."}]},
        {"decision": "done", "why": "Shippable.", "summary": "The mock echoes; branch flow/<run>/echo."},
    ],
    "verdicts": ["fail", "pass"],
    "answers": {"envelope": {"optionId": "approve", "note": "Rehearsal: approved."}, "ask": {"optionId": "yes", "note": "Rehearsal: granted."}},
}


@flow(name="lead-rehearsal", persist_result=True, flow_run_name=run_name,
      description="The `lead` flow on the mock, which echoes its prompts: each prompt ends with what the script makes the lead, "
      "the members and the judge answer, and the script answers the person's questions. Its Workstreams belong to the live "
      "cases' owner, out of the operator's list.")
def lead_rehearsal(
    goal: str = "Rehearsal on the mock: the lead's mechanics",
    script: dict[str, Any] = REHEARSAL_SCRIPT,  # noqa: B006 — Prefect copies parameters per run
    max_verifications: int = 25,
    max_decisions: int = 100,
) -> dict[str, Any]:
    """The lead flow on the mock, its answers scripted.

    Args:
        goal: Shown in the pages and the prompts, as a real run's.
        script: `decisions`, the lead's decisions in order; `verdicts`, the judge's (`pass` or `fail`) in order; `answers`, the person's to `envelope` and `ask` (without one, the run waits for an answer in Agora).
        max_verifications: Verifications by the judge, at most.
        max_decisions: Decisions of the lead, at most, refused ones included.
    """
    mock = {"harness": "mock", "model": "default", "effort": "default"}
    return drive(goal, {role: dict(mock) for role in ("lead", "judge", *STAFFED)}, max_verifications, max_decisions,
                 owner=REHEARSAL_OWNER, harnesses={"mock"}, script=script)


@flow(name="rehearsal", persist_result=True, description="One turn on the mock, then the same turn again: the replays find the first one's Workstream and answer.")
def rehearsal(prompt: str = "/sleep 20", harness: str = "mock", replays: int = 1, owner: str = REHEARSAL_OWNER) -> dict[str, Any]:
    """One turn on the mock, then the same turn again.

    Args:
        prompt: What the agent is told. The mock echoes it; `/sleep N` makes a turn of N seconds.
        harness: The turn's harness.
        replays: How many times the same turn runs again after it.
        owner: Who owns the Workstream; by default the live cases' owner, out of the operator's list.
    """
    spec = TurnSpec(run=str(flow_run.id), member="rehearsal", turn=1, harness=harness, prompt=prompt, lease_seconds=120)
    first, _ = turn(spec, "1 · Rehearsal", owner)
    again = [member_turn(asdict(spec), f"Replay {n}", owner) for n in range(1, replays + 1)]
    same = all(r["ok"] and (r["workstream"], r["execution"], r["text"]) == (first["workstream"], first["execution"], first["text"]) for r in again)
    get_run_logger().info(f"rehearsal: {replays} replay(s), same Workstream, execution and answer: {same}")
    return {"first": first, "replays": again, "same": same}
