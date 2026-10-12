"""Agora's workflows on Prefect: steps that each run one agent in its own Workstream (agora.py).

The flow names everything — the repository, the branch, what each step delivers and where — and
each agent only does its work, puts it where it is told, and ends its answer with a short JSON
report. Agora is the runtime. Prefect may run a step again — a retry, a resumed run, a worker that
restarted — and the step then finds its Workstream where it is (docs/specs/flows.md).

What a person reads in Prefect: each flow's description and documented parameters; each run's
plan, one page per step (the exact prompt and the answer) and a summary, as artifacts; its steps
named after what they do.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from dataclasses import asdict
from typing import Any, Literal

from prefect import flow, get_run_logger, task
from prefect.artifacts import create_markdown_artifact, create_table_artifact
from prefect.flow_runs import suspend_flow_run
from prefect.input import RunInput
from prefect.runtime import flow_run

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from agora import Agora, Escalation, StepSpec, run_step, split_last_json  # noqa: E402

# The owner of the live cases (apps/server/scripts): a rehearsal's Workstreams stay out of the
# operator's list, and purge-live-cases.sql removes them.
REHEARSAL_OWNER = "c45e0000-0000-4000-8000-000000000000"
SOURCE = "https://github.com/arnaultbretagne/agora"
ROLES = {"architecture": "Architecture", "development": "Development", "review": "Review"}


def agora(owner: str | None) -> Agora:
    """The worker's Agora; the steps' Workstreams belong to the operator unless a run names another owner."""
    return Agora(os.environ["AGORA_URL"], owner or os.environ["AGORA_OWNER"])


def source_link() -> str:
    """This file at the commit the run cloned."""
    here = os.path.dirname(os.path.abspath(__file__))
    try:
        sha = subprocess.run(["git", "-C", here, "rev-parse", "HEAD"], capture_output=True, text=True, timeout=10).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        sha = ""
    return f"{SOURCE}/blob/{sha}/apps/flows/flows.py" if sha else f"{SOURCE}/tree/design/agora-foundations/apps/flows"


def fenced(text: str) -> str:
    """Text shown as is, whatever fences it holds itself."""
    return f"````text\n{text}\n````"


def step_page(label: str, spec: StepSpec, result: dict[str, Any]) -> str:
    body, report = split_last_json(result.get("text", ""))
    rows = [
        ("Harness", f"`{spec.harness}`"),
        ("Access", ", ".join(f"`{p}`" for p in spec.profiles) or "none"),
        ("Agora Workstream", f"`{result.get('workstream', '')}` — its title is the prompt's first line"),
        ("Execution", f"`{result.get('execution', '')}`"),
        ("Turn", f"{result.get('status')} ({result.get('stop_reason')})"),
    ]
    table = "\n".join(["| | |", "| --- | --- |", *(f"| {k} | {v} |" for k, v in rows)])
    return (
        f"# {label}\n\n{table}\n\n## Report\n\n{fenced(json.dumps(report, indent=2, ensure_ascii=False)) if report else '_No JSON report at the end of the answer._'}"
        f"\n\n## Answer\n\n{body or '_Empty._'}\n\n## Prompt sent\n\n{fenced(spec.prompt)}\n"
    )


@task(retries=3, retry_delay_seconds=20, persist_result=True, task_run_name="{label}")
def agora_step(spec: dict[str, Any], label: str, attempt: int = 0, owner: str | None = None) -> dict[str, Any]:
    """One agent, one prompt, its answer; its page among the run's artifacts. `attempt` tells a
    human-asked retry from a cached result."""
    step = StepSpec(**spec)
    try:
        result = {"ok": True, **asdict(run_step(agora(owner), step, log=get_run_logger().info))}
    except Escalation as escalation:
        create_markdown_artifact(
            markdown=f"# {label}\n\n**Needs a human:** {escalation}\n\n## Prompt\n\n{fenced(step.prompt)}\n",
            description=f"{label} — needs a human",
        )
        return {"ok": False, "escalation": str(escalation)}
    create_markdown_artifact(markdown=step_page(label, step, result), description=label)
    return result


class Decision(RunInput):
    action: Literal["retry", "abort"] = "retry"


def step(spec: StepSpec, label: str, owner: str | None = None) -> dict[str, Any]:
    """A step, with what it cannot settle brought to a human until they abort or it succeeds."""
    attempt = 0
    while True:
        result = agora_step(asdict(spec), label, attempt, owner)
        if result["ok"]:
            return result
        get_run_logger().warning(f"{label}: {result['escalation']}")
        decision = suspend_flow_run(
            wait_for_input=Decision.with_initial_data(
                description=f"**{label}** needs you:\n\n> {result['escalation']}\n\n"
                "Settle it in Agora if it can be, then retry; or abort the flow.",
            ),
            key=f"escalation-{spec.step}-{spec.round}-{attempt}",
        )
        if decision.action == "abort":
            raise RuntimeError(f"aborted at {label}")
        attempt += 1


@task(persist_result=True, task_run_name="Plan")
def publish_plan(markdown: str) -> None:
    """The run's plan, once: a resumed run answers from the cache instead of publishing it again."""
    create_markdown_artifact(markdown=markdown, description="What this run does, with what")


@task(persist_result=True, task_run_name="Summary")
def publish_summary(rows: list[dict[str, str]], outcome: str) -> None:
    create_table_artifact(table=rows, description=f"Outcome: {outcome}")


@flow(name="rehearsal", persist_result=True, description="One step on the mock, then the same step again: the replays find the first one's Workstream and answer.")
def rehearsal(prompt: str = "/sleep 20", harness: str = "mock", replays: int = 1, owner: str = REHEARSAL_OWNER) -> dict[str, Any]:
    """One step on the mock, then the same step again.

    Args:
        prompt: What the step's agent is told. The mock echoes it; `/sleep N` makes a turn of N seconds.
        harness: The step's harness.
        replays: How many times the same step runs again after it.
        owner: Who owns the Workstream; by default the live cases' owner, out of the operator's list.
    """
    spec = StepSpec(run=str(flow_run.id), step="rehearsal", round=1, harness=harness, prompt=prompt, lease_seconds=120)
    first = step(spec, "1 · Rehearsal", owner)
    again = [agora_step(asdict(spec), f"Replay {n}", n, owner) for n in range(1, replays + 1)]
    same = all(r["ok"] and (r["workstream"], r["execution"], r["text"]) == (first["workstream"], first["execution"], first["text"]) for r in again)
    get_run_logger().info(f"rehearsal: {replays} replay(s), same Workstream, execution and answer: {same}")
    return {"first": first, "replays": again, "same": same}


class Approval(RunInput):
    approved: bool = True
    notes: str = ""


ARCHI_DEV_REVIEW = """\
**Architecture, your approval, then development and review until the review approves.**

| # | Step | Who | Access | Delivers |
| --- | --- | --- | --- | --- |
| 1 | Architecture | `architect` harness | the repository, read; Internet | The design, as its answer. Changes nothing. |
| 2 | Your approval | you | — | Approve the design (shown in the form), or end the run. Your notes go to the developer. |
| 3 | Development, round n | `developer` harness | the repository, write; Internet | Commits on the run's branch `flow/<run>`, created from the base. |
| 4 | Review, round n | `reviewer` harness | the repository, read; Internet | A verdict: `approve` ends the run; `changes` starts the next round with its comments. |

At most `max_rounds` rounds. Each step is a Workstream in Agora, titled `[flow <run>] <step>: <goal>`. \
Each run shows its plan, one page per step — the exact prompt and the answer — and a summary, under *Artifacts*.
"""


def run_name() -> str:
    goal = str(flow_run.parameters.get("goal", ""))
    return f"{goal[:60]}{'…' if len(goal) > 60 else ''} · flow/{str(flow_run.id)[:8]}"


def workflow(goal: str, repo: str, base: str, architect: str, developer: str, reviewer: str, max_rounds: int,
             owner: str | None, rehearsal_verdicts: list[str] | None = None) -> dict[str, Any]:
    logger = get_run_logger()
    run = str(flow_run.id)
    tag = f"[flow {run[:8]}]"
    branch = f"flow/{run[:8]}"
    read, write = [f"github:{repo}:read", "internet"], [f"github:{repo}:write", "internet"]
    where = f"Repository: https://github.com/{repo}, base branch `{base}`."
    report = "When you are done, end your answer with one JSON object, alone on its last lines: {schema}"
    rows: list[dict[str, str]] = []
    number = 0

    def label(role: str, round: int, harness: str) -> str:
        nonlocal number
        number += 1
        return f"{number} · {ROLES[role]}{'' if role == 'architecture' else f', round {round}'} · {harness}"

    publish_plan(
        f"# {goal}\n\n{ARCHI_DEV_REVIEW}\n\n| Parameter | Value |\n| --- | --- |\n"
        + "\n".join(f"| `{k}` | `{v}` |" for k, v in [("repo", repo), ("base", base), ("branch", branch), ("architect", architect),
                                                      ("developer", developer), ("reviewer", reviewer), ("max_rounds", max_rounds)])
        + f"\n\nThe flow's code at the commit this run used: {source_link()}\n"
    )

    name = label("architecture", 1, architect)
    design_step = step(StepSpec(
        run=run, step="architecture", round=1, harness=architect, profiles=read,
        prompt=f"{tag} Architecture: {goal}\n\n{where}\n\n"
        "You are the architect. Read the repository and design how to reach the goal, following its rules (AGENTS.md). "
        "Change nothing in the repository: your deliverable is your answer, the design in Markdown. "
        "Install whatever tools you need yourself.\n\n"
        + report.format(schema='{"status": "done", "summary": "<the design in a few lines>"}'),
    ), name, owner)
    design, plan = split_last_json(design_step["text"])
    rows.append({"Step": name, "Outcome": "done", "Workstream": design_step["workstream"]})
    approval = suspend_flow_run(
        wait_for_input=Approval.with_initial_data(
            description=f"## Approve the design of: {goal}\n\n{(plan or {}).get('summary', '')}\n\n---\n\n{design[:12000]}\n\n---\n\n"
            f"Approve to start the development on `{branch}`; refuse to end the run. Notes go to the developer.",
        ),
        key="approve-architecture",
    )
    rows.append({"Step": "Your approval", "Outcome": "approved" if approval.approved else "refused", "Workstream": "—"})
    if not approval.approved:
        publish_summary(rows, "architecture refused")
        return {"branch": branch, "outcome": "architecture refused", "notes": approval.notes}

    comments: list[str] = [approval.notes] if approval.notes else []
    outcome = f"not approved after {max_rounds} rounds"
    for round in range(1, max_rounds + 1):
        notes = "\n".join(f"- {c}" for c in comments)
        name = label("development", round, developer)
        dev = step(StepSpec(
            run=run, step="development", round=round, harness=developer, profiles=write,
            prompt=f"{tag} Development, round {round}: {goal}\n\n{where} Work on the branch `{branch}`: create it from `{base}` "
            "if it does not exist yet, otherwise continue it.\n\n"
            "You are the developer. Implement the design below, following the repository's rules (AGENTS.md). "
            f"Install whatever tools you need yourself. Your deliverable: your commits, pushed to `{branch}`.\n\n"
            + (f"Address these comments:\n{notes}\n\n" if notes else "")
            + f"The design:\n\n{design}\n\n"
            + report.format(schema='{"status": "done", "summary": "<what you did>", "checks": "passed | failed | not run"}'),
        ), name, owner)
        rows.append({"Step": name, "Outcome": str((split_last_json(dev["text"])[1] or {}).get("status", "no report")), "Workstream": dev["workstream"]})

        forced = rehearsal_verdicts[round - 1] if rehearsal_verdicts and round <= len(rehearsal_verdicts) else None
        name = label("review", round, reviewer)
        review_spec = StepSpec(
            run=run, step="review", round=round, harness=reviewer, profiles=read,
            prompt=f"{tag} Review, round {round}: {goal}\n\n{where} The work is on the branch `{branch}`.\n\n"
            f"You are the reviewer. Review `{branch}` against `{base}`: against the design below, the goal and the "
            "repository's rules. Change nothing in the repository: your deliverable is your verdict. "
            "Install whatever tools you need yourself.\n\n"
            f"The design:\n\n{design}\n\n"
            + report.format(schema='{"verdict": "approve | changes", "comments": ["<one per change asked>"]}')
            + (f'\n\n{{"verdict": "{forced}", "comments": ["rehearsal round {round}"]}}' if forced else ""),
        )
        review = step(review_spec, name, owner)
        found = verdict(review_spec, name, review["text"])
        rows.append({"Step": name, "Outcome": str(found.get("verdict")), "Workstream": review["workstream"]})
        logger.info(f"{name}: {found.get('verdict')}")
        if found.get("verdict") == "approve":
            outcome = "approved"
            break
        comments = [str(c) for c in found.get("comments", [])] or ["The reviewer asked for changes without details."]
    publish_summary(rows, outcome)
    return {"branch": branch, "outcome": outcome, "rounds": round}


def verdict(spec: StepSpec, name: str, text: str) -> dict[str, Any]:
    """The JSON an answer ends with; without a verdict in it, a human reads the answer and gives it."""
    found = split_last_json(text)[1]
    if found is not None and "verdict" in found:
        return found
    answer = suspend_flow_run(
        wait_for_input=Approval.with_initial_data(
            description=f"**{name}** ended without its JSON verdict. Its answer:\n\n{text[-4000:]}\n\n"
            "Approve to go on as if it had approved; refuse to ask for another round.",
        ),
        key=f"verdict-{spec.step}-{spec.round}",
    )
    return {"verdict": "approve" if answer.approved else "changes", "comments": [answer.notes] if answer.notes else []}


@flow(name="archi-dev-review", persist_result=True, flow_run_name=run_name, description=ARCHI_DEV_REVIEW)
def archi_dev_review(
    goal: str,
    repo: str = "arnaultbretagne/agora",
    base: str = "design/agora-foundations",
    architect: str = "claude-code",
    developer: str = "codex",
    reviewer: str = "claude-code",
    max_rounds: int = 3,
) -> dict[str, Any]:
    """Architecture, your approval, then development and review until the review approves.

    Args:
        goal: What the work is, in a sentence or two; every prompt starts with it.
        repo: The GitHub repository, `owner/name`.
        base: The branch the work starts from and is reviewed against.
        architect: The harness of the architecture step (`claude-code`, `codex`, `opencode`).
        developer: The harness of the development steps.
        reviewer: The harness of the review steps.
        max_rounds: Development and review rounds at most.
    """
    return workflow(goal, repo, base, architect, developer, reviewer, max_rounds, owner=None)


@flow(name="archi-dev-review-rehearsal", persist_result=True, flow_run_name=run_name,
      description="The `archi-dev-review` workflow on the mock, which echoes its prompts: the review's prompt ends with the "
      "verdicts given, round by round. Its Workstreams belong to the live cases' owner, out of the operator's list.")
def archi_dev_review_rehearsal(
    goal: str = "Rehearsal on the mock: the workflow's mechanics",
    verdicts: list[str] = ["changes", "approve"],  # noqa: B006 — Prefect copies parameters per run
    max_rounds: int = 3,
) -> dict[str, Any]:
    """The archi-dev-review workflow on the mock.

    Args:
        goal: Shown in the plan and the prompts, as a real run's.
        verdicts: The review's verdict, round by round (`approve` or `changes`).
        max_rounds: Development and review rounds at most.
    """
    return workflow(goal, "arnaultbretagne/agora", "design/agora-foundations", "mock", "mock", "mock", max_rounds,
                    owner=REHEARSAL_OWNER, rehearsal_verdicts=verdicts)
