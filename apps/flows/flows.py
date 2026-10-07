"""Agora's workflows on Prefect: steps that each run one agent in its own Workstream (agora.py).

Prefect may run a step's task again — a retry, a resumed run, a worker that restarted — and the step
then finds its Workstream where it is (docs/specs/flows.md). What a step cannot settle alone comes to a
human: the flow suspends with a form, and resumes with the answer.
"""

from __future__ import annotations

import os
import sys
from dataclasses import asdict
from typing import Any, Literal

from prefect import flow, get_run_logger, task
from prefect.flow_runs import suspend_flow_run
from prefect.input import RunInput
from prefect.runtime import flow_run

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from agora import Agora, Escalation, StepSpec, last_json, run_step  # noqa: E402


def agora() -> Agora:
    return Agora(os.environ["AGORA_URL"], os.environ["AGORA_OWNER"])


@task(retries=3, retry_delay_seconds=20, persist_result=True)
def agora_step(spec: dict[str, Any], attempt: int = 0) -> dict[str, Any]:
    """One agent, one prompt, its answer. `attempt` only tells a human-asked retry from a cached result."""
    logger = get_run_logger()
    try:
        return {"ok": True, **asdict(run_step(agora(), StepSpec(**spec), log=logger.info))}
    except Escalation as escalation:
        return {"ok": False, "escalation": str(escalation)}


class Decision(RunInput):
    action: Literal["retry", "abort"] = "retry"


def step(spec: StepSpec) -> dict[str, Any]:
    """A step, with what it cannot settle brought to a human until they abort or it succeeds."""
    attempt = 0
    while True:
        result = agora_step(asdict(spec), attempt)
        if result["ok"]:
            return result
        get_run_logger().warning(f"{spec.step} round {spec.round}: {result['escalation']}")
        decision = suspend_flow_run(
            wait_for_input=Decision.with_initial_data(
                description=f"**{spec.step}, round {spec.round}** needs you:\n\n> {result['escalation']}\n\n"
                "Settle it in Agora if it can be, then retry; or abort the flow.",
            ),
            key=f"escalation-{spec.step}-{spec.round}-{attempt}",
        )
        if decision.action == "abort":
            raise RuntimeError(f"aborted at {spec.step}, round {spec.round}")
        attempt += 1


@flow(name="rehearsal", persist_result=True)
def rehearsal(prompt: str = "/sleep 20", harness: str = "mock", replays: int = 1) -> dict[str, Any]:
    """One step, then the same step again: the replays find the first one's Workstream and answer."""
    spec = StepSpec(run=str(flow_run.id), step="rehearsal", round=1, harness=harness, prompt=prompt, lease_seconds=120)
    first = step(spec)
    again = [agora_step(asdict(spec), attempt) for attempt in range(1, replays + 1)]
    same = all(r["ok"] and (r["workstream"], r["execution"], r["text"]) == (first["workstream"], first["execution"], first["text"]) for r in again)
    get_run_logger().info(f"rehearsal: {replays} replay(s), same Workstream, execution and answer: {same}")
    return {"first": first, "replays": again, "same": same}


class Approval(RunInput):
    approved: bool = True
    notes: str = ""


def verdict(spec: StepSpec, text: str, keys: tuple[str, ...]) -> dict[str, Any]:
    """The JSON an answer ends with; without one, a human reads the answer and gives it."""
    found = last_json(text)
    if found is not None and all(k in found for k in keys):
        return found
    answer = suspend_flow_run(
        wait_for_input=Approval.with_initial_data(
            description=f"**{spec.step}, round {spec.round}** ended without its JSON verdict. Its answer:\n\n{text[-4000:]}\n\n"
            "Approve to go on as if it had succeeded; refuse to ask for another round.",
        ),
        key=f"verdict-{spec.step}-{spec.round}",
    )
    return {"verdict": "approve" if answer.approved else "changes", "comments": [answer.notes] if answer.notes else []}


ENDING = "End your answer with one JSON object, alone on its last lines: {schema}"


@flow(name="archi-dev-review", persist_result=True)
def archi_dev_review(
    goal: str,
    repo: str = "arnaultbretagne/agora",
    base: str = "design/agora-foundations",
    architect: str = "claude-code",
    developer: str = "codex",
    reviewer: str = "claude-code",
    max_rounds: int = 3,
    rehearsal_verdicts: list[str] | None = None,
) -> dict[str, Any]:
    """Architecture, a human's approval, then development and review until the review approves.

    `rehearsal_verdicts` only serves a rehearsal on the mock, which echoes its prompt: the review's
    prompt then ends with the given verdict for each round.
    """
    logger = get_run_logger()
    run = str(flow_run.id)
    branch = f"flow/{run[:8]}"
    write = [f"github:{repo}:write"]
    read = [f"github:{repo}:read"]
    where = f"Repository: https://github.com/{repo}, base branch `{base}`; your branch: `{branch}`."

    design = step(StepSpec(
        run=run, step="architecture", round=1, harness=architect, profiles=write,
        prompt=f"[flow {run[:8]}] Architecture: {goal}\n\n{where}\n\n"
        f"You are the architect. Clone the repository, create `{branch}` from `{base}`, and write the design of this goal "
        "where the repository's own rules put such documents (read its AGENTS.md). Do not write the implementation. "
        f"Commit and push `{branch}` before you answer.\n\n"
        + ENDING.format(schema='{"summary": "<the design in a few lines>", "files": ["<paths you wrote>"]}'),
    ))
    plan = last_json(design["text"]) or {"summary": design["text"][-2000:]}
    approval = suspend_flow_run(
        wait_for_input=Approval.with_initial_data(
            description=f"**Architecture of** {goal}\n\nBranch `{branch}` on {repo}.\n\n{plan.get('summary', '')}\n\n"
            "Approve to start the development; refuse to end the flow here. Notes go to the developer.",
        ),
        key="approve-architecture",
    )
    if not approval.approved:
        logger.info("architecture refused: the flow ends")
        return {"branch": branch, "outcome": "architecture refused", "notes": approval.notes}

    comments: list[str] = [approval.notes] if approval.notes else []
    for round in range(1, max_rounds + 1):
        notes = "\n".join(f"- {c}" for c in comments)
        step(StepSpec(
            run=run, step="development", round=round, harness=developer, profiles=write,
            prompt=f"[flow {run[:8]}] Development, round {round}: {goal}\n\n{where}\n\n"
            f"You are the developer. Clone the repository and check out `{branch}`: the design is on it. Implement it, "
            "following the repository's rules (AGENTS.md); run its checks if you can. Commit and push to "
            f"`{branch}` before you answer."
            + (f"\n\nAddress these review comments:\n{notes}" if notes else "")
            + "\n\n" + ENDING.format(schema='{"summary": "<what you did>", "checks": "passed | failed | not run"}'),
        ))
        forced = rehearsal_verdicts[round - 1] if rehearsal_verdicts and round <= len(rehearsal_verdicts) else None
        review_spec = StepSpec(
            run=run, step="review", round=round, harness=reviewer, profiles=read,
            prompt=f"[flow {run[:8]}] Review, round {round}: {goal}\n\n{where}\n\n"
            f"You are the reviewer. Clone the repository and review `{branch}` against `{base}`: correctness, the "
            "repository's rules, the design on the branch. Do not push.\n\n"
            + ENDING.format(schema='{"verdict": "approve | changes", "comments": ["<one per change asked>"]}')
            + (f'\n\n{{"verdict": "{forced}", "comments": ["rehearsal round {round}"]}}' if forced else ""),
        )
        review = step(review_spec)
        found = verdict(review_spec, review["text"], ("verdict",))
        logger.info(f"review round {round}: {found.get('verdict')}")
        if found.get("verdict") == "approve":
            return {"branch": branch, "outcome": "approved", "rounds": round, "review": found}
        comments = [str(c) for c in found.get("comments", [])] or ["The reviewer asked for changes without details."]
    return {"branch": branch, "outcome": f"not approved after {max_rounds} rounds", "comments": comments}
