"""The team a lead runs: the role cards, the envelope the human approves, the lead's decisions and
what the flow accepts of them, and every prompt the members read.

No Prefect and no network here: flows.py carries out what this accepts. The lead decides; the flow
holds the rules (docs/specs/flows.md): the judge is the flow's and reads only; access beyond the
approved envelope comes only through the human; a feature is done only once judged shippable after
its last change; verifications and decisions are counted.
"""

from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

ROLES = Path(__file__).resolve().parent / "roles"
# The roles a lead staffs; the lead is the run's own, the judge the flow's.
STAFFED = ("dev", "sre")
OVERRIDABLE = ("harness", "model", "effort")
# A setting's id per harness: effort is `reasoning_effort` for codex.
EFFORT_IDS = ("effort", "reasoning_effort")
NAME = re.compile(r"^[a-z0-9][a-z0-9-]{0,39}$")
REPO = re.compile(r"^github:([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+):(read|write)$")
MAX_FEATURES, MAX_MEMBERS, MAX_CRITERIA, MAX_STEPS = 8, 8, 15, 10
KINDS = ("plan", "steps", "verify", "ask", "done", "stop")


class Refused(Exception):
    """A decision the flow does not carry out; the reason goes back to the lead."""


# ---------------------------------------------------------------- role cards

@dataclass
class Card:
    role: str
    summary: str
    harness: str
    model: str
    effort: str
    text: str
    rubric: list[str] = field(default_factory=list)


def parse_card(source: str) -> Card:
    """A card: `key: value` front matter between `---` lines, then the persona in Markdown; the
    judge's `## Base rubric` is its numbered list."""
    match = re.match(r"^---\n(.*?)\n---\n(.*)$", source, re.S)
    if not match:
        raise ValueError("a role card starts with its front matter between --- lines")
    meta = dict(line.split(":", 1) for line in match.group(1).splitlines() if ":" in line)
    meta = {k.strip(): v.strip() for k, v in meta.items()}
    text = match.group(2).strip()
    rubric: list[str] = []
    section = re.search(r"^## Base rubric\n(.*?)(?=^## |\Z)", text, re.S | re.M)
    if section:
        items = re.split(r"^\d+\.\s+", section.group(1), flags=re.M)[1:]
        rubric = [" ".join(item.split()) for item in items]
    return Card(
        role=meta["role"], summary=meta.get("summary", ""), harness=meta["harness"], model=meta.get("model", "default"),
        effort=meta.get("effort", "default"), text=text, rubric=rubric,
    )


def load_cards(directory: Path = ROLES) -> dict[str, Card]:
    cards = {}
    for path in sorted(directory.glob("*.md")):
        card = parse_card(path.read_text(encoding="utf-8"))
        cards[card.role] = card
    missing = {"lead", "judge", *STAFFED} - cards.keys()
    if missing:
        raise ValueError(f"role cards missing: {sorted(missing)}")
    return cards


def with_overrides(cards: dict[str, Card], overrides: dict[str, dict[str, str]]) -> dict[str, Card]:
    """The cards with the launch's overrides: a role's harness, model or effort, never its text."""
    result = {role: Card(**asdict(card)) for role, card in cards.items()}
    for role, values in (overrides or {}).items():
        if role not in result:
            raise ValueError(f"override of an unknown role {role!r}; roles: {sorted(result)}")
        unknown = set(values) - set(OVERRIDABLE)
        if unknown:
            raise ValueError(f"{role}: only {', '.join(OVERRIDABLE)} can be overridden, not {sorted(unknown)}")
        for key, value in values.items():
            setattr(result[role], key, str(value))
    return result


# ---------------------------------------------------------------- what Agora offers

@dataclass
class Catalogue:
    """The harnesses a run may use, each with its settings' values, and the profiles Agora offers."""
    harnesses: dict[str, dict[str, list[str]]]
    offered: list[str]

    @staticmethod
    def from_agora(pools: list[dict[str, Any]], offered: list[str], harnesses: set[str] | None = None,
                   exclude: set[str] | None = None) -> "Catalogue":
        found: dict[str, dict[str, list[str]]] = {}
        for pool in pools:
            harness = pool.get("harness")
            if not harness or (harnesses and harness not in harnesses) or (exclude and harness in exclude):
                continue
            settings = {s.get("id"): [str(o.get("value")) for o in s.get("options") or []] for s in pool.get("settings") or []}
            found[harness] = {k: v for k, v in settings.items() if k}
        return Catalogue(harnesses=found, offered=list(offered))

    def settings(self, harness: str, model: str, effort: str) -> dict[str, str]:
        """The Create's settings for a model and an effort; `default` sends none. Refused when the
        harness does not offer them."""
        if harness not in self.harnesses:
            raise Refused(f"no harness {harness!r}; available: {', '.join(sorted(self.harnesses))}")
        offered = self.harnesses[harness]
        result: dict[str, str] = {}
        if model and model != "default":
            if model not in offered.get("model", []):
                raise Refused(f"{harness} has no model {model!r}; its models: {', '.join(offered.get('model', [])) or 'none'}")
            result["model"] = model
        if effort and effort != "default":
            key = next((k for k in EFFORT_IDS if k in offered), None)
            if key is None or effort not in offered[key]:
                raise Refused(f"{harness} has no effort {effort!r}; its efforts: {', '.join(offered.get(key or '', [])) or 'none'}")
            result[key] = effort
        return result

    def allows(self, profile: str) -> bool:
        """Offered as is, or a repository's read where its write is offered."""
        if profile in self.offered:
            return True
        match = REPO.match(profile)
        return bool(match and match.group(2) == "read" and f"github:{match.group(1)}:write" in self.offered)

    def repositories(self) -> list[str]:
        return sorted({m.group(1) for p in self.offered if (m := REPO.match(p))})


def read_only(profiles: list[str]) -> list[str]:
    """The same repositories, read only, and the Internet; nothing else."""
    result: list[str] = []
    for profile in profiles:
        match = REPO.match(profile)
        read = f"github:{match.group(1)}:read" if match else ("internet" if profile == "internet" else None)
        if read and read not in result:
            result.append(read)
    return result


# ---------------------------------------------------------------- the run's state

@dataclass
class Feature:
    id: str
    title: str
    repo: str
    base: str
    criteria: list[str]
    branch: str


@dataclass
class Member:
    name: str
    role: str
    harness: str
    model: str
    effort: str
    access: list[str]
    turns: int = 0


@dataclass
class Team:
    """Everything the flow knows of the run; rebuilt the same way each time Prefect re-runs it."""
    run: str
    goal: str
    max_verifications: int
    max_decisions: int
    # The launch's overrides, by role: they win over what the lead proposes.
    overrides: dict[str, dict[str, str]] = field(default_factory=dict)
    approved: bool = False
    features: dict[str, Feature] = field(default_factory=dict)
    members: dict[str, Member] = field(default_factory=dict)
    decisions: int = 0
    verifications: int = 0
    # A feature's last shippable pass and last change, by decision number.
    passed: dict[str, int] = field(default_factory=dict)
    changed: dict[str, int] = field(default_factory=dict)

    @property
    def tag(self) -> str:
        return f"[flow {self.run[:8]}]"

    def branch(self, feature: str) -> str:
        return f"flow/{self.run[:8]}/{feature}"

    def shippable(self) -> list[str]:
        return [f for f in self.features if f in self.passed and self.passed[f] > self.changed.get(f, 0)]


# ---------------------------------------------------------------- the lead's decisions

def _text(value: Any, what: str, limit: int = 4000) -> str:
    if not isinstance(value, str) or not value.strip():
        raise Refused(f"{what} must be a non-empty string")
    if len(value) > limit:
        raise Refused(f"{what} is over {limit} characters")
    return value.strip()


def _list(value: Any, what: str, low: int, high: int) -> list[Any]:
    if not isinstance(value, list) or not low <= len(value) <= high:
        raise Refused(f"{what} must be a list of {low} to {high} items")
    return value


def _name(value: Any, what: str) -> str:
    if not isinstance(value, str) or not NAME.match(value):
        raise Refused(f"{what} {value!r} must be lowercase letters, digits and dashes, at most 40")
    return value


def _features(team: Team, catalogue: Catalogue, raw: Any, low: int = 1) -> list[Feature]:
    features = []
    for i, item in enumerate(_list(raw, "features", low, MAX_FEATURES - len(team.features))):
        if not isinstance(item, dict):
            raise Refused(f"features[{i}] must be an object")
        id = _name(item.get("id"), "feature id")
        if id in team.features or any(f.id == id for f in features):
            raise Refused(f"feature {id!r} exists already")
        repo = _text(item.get("repo"), f"feature {id}: repo", 200)
        if repo not in catalogue.repositories():
            raise Refused(f"feature {id}: repository {repo!r} is not offered; offered: {', '.join(catalogue.repositories())}")
        base = _text(item.get("base"), f"feature {id}: base", 200)
        criteria = [_text(c, f"feature {id}: a criterion", 600) for c in _list(item.get("criteria"), f"feature {id}: criteria", 1, MAX_CRITERIA)]
        features.append(Feature(id=id, title=_text(item.get("title"), f"feature {id}: title", 200), repo=repo, base=base,
                                criteria=criteria, branch=team.branch(id)))
    return features


def _access(catalogue: Catalogue, raw: Any, what: str) -> list[str]:
    profiles = [_text(p, f"{what}: a profile", 200) for p in _list(raw, f"{what}: access", 0, 20)]
    refused = [p for p in profiles if not catalogue.allows(p)]
    if refused:
        raise Refused(f"{what}: access {', '.join(refused)} is not offered; offered: {', '.join(catalogue.offered)} (a repository's :read where its :write is)")
    return list(dict.fromkeys(profiles))


def _members(team: Team, cards: dict[str, Card], catalogue: Catalogue, raw: Any, low: int = 1) -> list[Member]:
    members = []
    for i, item in enumerate(_list(raw, "team", low, MAX_MEMBERS - len(team.members))):
        if not isinstance(item, dict):
            raise Refused(f"team[{i}] must be an object")
        name = _name(item.get("name"), "member name")
        if name in team.members or name == "lead" or name.startswith("judge") or any(m.name == name for m in members):
            raise Refused(f"member name {name!r} is taken or reserved")
        role = item.get("role")
        if role not in STAFFED:
            raise Refused(f"{name}: role must be one of {', '.join(STAFFED)}; the judge is the flow's")
        card, forced = cards[role], team.overrides.get(role, {})
        # The launch's overrides win; then the lead's proposal; then the card.
        harness = str(forced.get("harness") or item.get("harness") or card.harness)
        model = str(forced.get("model") or item.get("model") or (card.model if harness == card.harness else "default"))
        effort = str(forced.get("effort") or item.get("effort") or (card.effort if harness == card.harness else "default"))
        catalogue.settings(harness, model, effort)
        members.append(Member(name=name, role=role, harness=harness, model=model, effort=effort,
                              access=_access(catalogue, item.get("access"), name)))
    return members


@dataclass
class Decision:
    kind: str
    why: str
    data: dict[str, Any]


def decide(report: dict[str, Any] | None, team: Team, cards: dict[str, Card], catalogue: Catalogue) -> Decision:
    """The lead's decision as the flow will carry it out, or the reason it will not."""
    if report is None:
        raise Refused("your answer did not end with a decision: one JSON object, alone on its last lines")
    kind = report.get("decision")
    if kind not in KINDS:
        raise Refused(f"`decision` must be one of {', '.join(KINDS)}")
    why = str(report.get("why") or "")
    if kind == "stop":
        return Decision(kind, why, {"reason": _text(report.get("reason"), "reason")})
    if kind == "ask":
        add = report.get("add") or {}
        if not isinstance(add, dict):
            raise Refused("`add` must be an object")
        if not team.approved and add:
            raise Refused("before your plan is approved, propose features and team in the plan itself")
        data: dict[str, Any] = {"question": _text(report.get("question"), "question")}
        if add.get("features"):
            data["features"] = _features(team, catalogue, add["features"])
        if add.get("team"):
            data["team"] = _members(team, cards, catalogue, add["team"])
        if add.get("access"):
            if not isinstance(add["access"], dict):
                raise Refused("`add.access` maps a member's name to its whole access after the change")
            changes = {}
            for name, profiles in add["access"].items():
                if name not in team.members or name == "lead":
                    raise Refused(f"no member {name!r} to give access to")
                changes[name] = _access(catalogue, profiles, name)
            data["access"] = changes
        return Decision(kind, why, data)
    if kind == "plan":
        if team.approved:
            raise Refused("your plan is approved already; new features, members or access go through `ask`")
        title = _text(report.get("title"), "title", 120)
        if "\n" in title:
            raise Refused("title must be one line")
        features = _features(team, catalogue, report.get("features"))
        members = _members(team, cards, catalogue, report.get("team"))
        return Decision(kind, why, {"title": title, "features": features, "team": members})
    if not team.approved:
        raise Refused("your first decision must be a plan the human approves")
    if kind == "steps":
        steps = []
        for i, item in enumerate(_list(report.get("steps"), "steps", 1, MAX_STEPS)):
            if not isinstance(item, dict):
                raise Refused(f"steps[{i}] must be an object")
            member = team.members.get(str(item.get("member")))
            if member is None or member.role not in STAFFED:
                raise Refused(f"steps[{i}]: no member {item.get('member')!r}; the team: {', '.join(n for n in team.members if n != 'lead')}")
            feature = item.get("feature")
            if feature is None and member.role == "dev":
                raise Refused(f"steps[{i}]: a dev works on one feature; name it")
            if feature is not None and feature not in team.features:
                raise Refused(f"steps[{i}]: no feature {feature!r}")
            steps.append({"member": member.name, "feature": feature, "brief": _text(item.get("brief"), f"steps[{i}]: brief", 12000)})
        return Decision(kind, why, {"steps": steps})
    if kind == "verify":
        if team.verifications >= team.max_verifications:
            raise Refused(f"no verification left: all {team.max_verifications} are spent; decide `done` or `stop`")
        feature = report.get("feature")
        if feature is not None and feature not in team.features:
            raise Refused(f"no feature {feature!r}")
        shippable = report.get("shippable", False)
        if not isinstance(shippable, bool):
            raise Refused("`shippable` must be true or false")
        if shippable and feature is None:
            raise Refused("a shippable verification is of one feature; name it")
        return Decision(kind, why, {"feature": feature, "shippable": shippable, "question": _text(report.get("question"), "question", 8000)})
    # done
    waiting = [f for f in team.features if f not in team.shippable()]
    if waiting:
        raise Refused("`done` needs every feature judged shippable after its last change; not yet: " + ", ".join(waiting))
    return Decision(kind, why, {"summary": _text(report.get("summary"), "summary")})


def approve(team: Team, decision: Decision) -> None:
    """The plan, approved: the envelope's features and members."""
    for feature in decision.data["features"]:
        team.features[feature.id] = feature
    for member in decision.data["team"]:
        team.members[member.name] = member
    team.approved = True


def grant(team: Team, decision: Decision) -> list[str]:
    """What an approved `ask` adds; the lines saying so."""
    lines = []
    for feature in decision.data.get("features", []):
        team.features[feature.id] = feature
        lines.append(f"feature `{feature.id}` added, on branch `{feature.branch}`")
    for member in decision.data.get("team", []):
        team.members[member.name] = member
        lines.append(f"member `{member.name}` ({member.role}, {member.harness}) added, access: {', '.join(member.access) or 'none'}")
    for name, profiles in decision.data.get("access", {}).items():
        team.members[name].access = profiles
        lines.append(f"`{name}` now has access: {', '.join(profiles) or 'none'}")
    return lines


def judge_access(team: Team, feature: str | None, offered: list[str] | None = None) -> list[str]:
    """Read only: the feature's repository, or every repository the team can reach; the Internet; and the
    previews when Agora offers them, to see the change running (docs/specs/credentials.md, "Previews")."""
    previews = ["previews"] if "previews" in (offered or []) else []
    if feature:
        return [f"github:{team.features[feature].repo}:read", "internet", *previews]
    return read_only([p for m in team.members.values() for p in m.access] + ["internet"]) + previews


def required_checks(card: Card, feature: Feature) -> list[str]:
    return [f"R{i}" for i in range(1, len(card.rubric) + 1)] + [f"C{i}" for i in range(1, len(feature.criteria) + 1)]


def verdict(report: dict[str, Any] | None, required: list[str]) -> tuple[bool, str]:
    """Pass only with a `pass` verdict, no failed check, and every required check passed."""
    if report is None or report.get("verdict") not in ("pass", "fail"):
        return False, "the judge's answer had no verdict"
    checks = [c for c in report.get("checks") or [] if isinstance(c, dict)]
    results = {str(c.get("id")): str(c.get("result")) for c in checks}
    missing = [r for r in required if r not in results]
    failed = [str(c.get("id") or c.get("check")) for c in checks if c.get("result") != "pass"]
    if report["verdict"] != "pass":
        return False, "fail" + (f": {', '.join(failed)}" if failed else "")
    if failed:
        return False, f"pass claimed with checks not passed: {', '.join(failed)}"
    if missing:
        return False, f"pass claimed without checks: {', '.join(missing)}"
    return True, "pass"


# ---------------------------------------------------------------- prompts

REPORT = 'End your answer with one JSON object, alone on its last lines:\n{schema}'
MEMBER_REPORT = '{"status": "done | blocked", "summary": "<what you did, and what the lead must know>", "pull_request": "<its URL, or null>"}'
JUDGE_REPORT = ('{"verdict": "pass | fail", "checks": [{"id": "<R1, C1… or your own: X1…>", "check": "<what you checked>", '
                '"result": "pass | fail", "evidence": "<what you ran or read, and what it showed>"}], "summary": "<one paragraph, notes included>"}')

DECISIONS = """\
| Decision | What the flow does | Its JSON |
| --- | --- | --- |
| `plan` | Shows the human the envelope, under your title: features (each on its own branch, with its acceptance criteria) and team (each member's role, harness, model, effort and access). Their one approval covers the whole run; or they ask you to revise. | `{"decision": "plan", "title": "<your plan's name, one line>", "why": "…", "features": [{"id": "short-name", "title": "…", "repo": "owner/name", "base": "<branch it starts from>", "criteria": ["…"]}], "team": [{"name": "dev-1", "role": "dev", "harness": "…", "model": "…", "effort": "…", "access": ["…"]}]}` |
| `steps` | Runs the steps one after the other, each by a member of the team; each member keeps its context from one step to the next. Comes back with each one's report and answer. | `{"decision": "steps", "why": "…", "steps": [{"member": "dev-1", "feature": "short-name", "brief": "<everything they need: what, why, done when, out of scope>"}]}` |
| `verify` | Has the judge verify what you ask: a fresh context, read-only. `shippable: true` asks whether a feature can ship: its acceptance criteria and the judge's base rubric are checked on top of your question. Comes back with each check and its evidence. | `{"decision": "verify", "why": "…", "feature": "short-name or null", "shippable": true, "question": "<what to verify>"}` |
| `ask` | Asks the human and waits for the answer, the whole run with it: a right, a new member, a new feature, an action only they can take. What `add` holds is added if they say yes. | `{"decision": "ask", "why": "…", "question": "…", "add": {"features": [], "team": [], "access": {"dev-1": ["<the member's whole access after the change>"]}}}` |
| `done` | Ends the run. Accepted only once every feature has been judged shippable after its last change. | `{"decision": "done", "why": "…", "summary": "<what ships, for the human>"}` |
| `stop` | Ends the run without finishing, keeping what was done. | `{"decision": "stop", "why": "…", "reason": "…"}` |
"""


def _table(rows: list[tuple[str, ...]], head: tuple[str, ...]) -> str:
    return "\n".join(["| " + " | ".join(head) + " |", "| " + " | ".join("---" for _ in head) + " |",
                      *("| " + " | ".join(r) + " |" for r in rows)])


def lead_brief(team: Team, cards: dict[str, Card], catalogue: Catalogue, lead: Member) -> str:
    """The lead's first prompt: its card, the run, what it can staff and give, how it answers."""
    def defaults(role: str) -> str:
        card, forced = cards[role], team.overrides.get(role, {})
        return " · ".join(f"**{getattr(card, k)}** (set at launch)" if k in forced else getattr(card, k) for k in OVERRIDABLE)
    staff = _table([(role, cards[role].summary, defaults(role)) for role in STAFFED], ("Role", "What they do", "Harness · model · effort"))
    harnesses = _table([(h, ", ".join(s.get("model", [])) or "—", ", ".join(next((s[k] for k in EFFORT_IDS if k in s), [])) or "—")
                        for h, s in sorted(catalogue.harnesses.items())], ("Harness", "Models", "Efforts"))
    access = _table([(f"`{p}`", "pushes branches and opens pull requests on that repository; its `:read` only reads it" if p.endswith(":write")
                      else "reads that repository" if p.endswith(":read") else "the open web: packages, documentation" if p == "internet" else "—")
                     for p in catalogue.offered], ("Access", "Gives"))
    judge = f"{cards['judge'].harness} · {cards['judge'].model}"
    return f"""{team.tag} lead: {team.goal}

{cards['lead'].text}

---

# This run

**Goal:** {team.goal}

## Whom you can staff

{staff}

What is set at launch is not yours to change; the rest is a default you may change per member. The
judge is not yours to staff: the flow runs it when you decide `verify`, read-only, in a fresh context
each time, on {judge}. Staff the work on another model, so that a different one judges it.

## Harnesses

{harnesses}

## Access you can propose

{access}

Your own access: {', '.join(f'`{p}`' for p in lead.access)}. Nobody merges, deploys or acts on a running
system: the run ends with branches and draft pull requests, and the human merges.

## Limits

- {team.max_decisions} decisions, this one included; {team.max_verifications} verifications.
- The steps of a decision run one after the other, never in parallel.
- A member's turn lasts at most an hour; cut, it comes back to you as `cancelled`.

## How you answer

Each of your answers ends with exactly one decision, one JSON object alone on its last lines. The flow
carries it out and comes back to you with the outcome. A decision it refuses comes back with the
reason, and counts.

{DECISIONS}
Your first decision is a `plan`, or an `ask` if only the human can tell you what the plan needs."""


def lead_update(team: Team, outcome: str) -> str:
    """A later prompt of the lead: what its last decision gave, and what is left."""
    return (f"{team.tag} lead: decision {team.decisions}\n\n{outcome}\n\n---\n\n"
            f"This is decision {team.decisions} of {team.max_decisions}; verifications left: {team.max_verifications - team.verifications}. "
            f"Features judged shippable since their last change: {', '.join(team.shippable()) or 'none'}. "
            "Answer with your next decision: one JSON object, alone on its last lines "
            f"(`{'`, `'.join(KINDS)}`).")


def _where(team: Team, feature: Feature | None, member: Member) -> str:
    if feature is None:
        return "Repositories you can reach: " + (", ".join(f"https://github.com/{m.group(1)}" for p in member.access if (m := REPO.match(p))) or "none") + "."
    criteria = "\n".join(f"- C{i}. {c}" for i, c in enumerate(feature.criteria, 1))
    branch = (f"Your branch: `{feature.branch}`. Start it from `{feature.base}` if it does not exist yet, otherwise continue it; "
              f"push your commits there, and keep a draft pull request open from it to `{feature.base}`."
              if member.role == "dev" else f"The feature's work is on the branch `{feature.branch}`.")
    return (f"Feature `{feature.id}`: {feature.title}\n\nRepository https://github.com/{feature.repo}, base `{feature.base}`. {branch}\n\n"
            f"Its acceptance criteria, which the judge will check:\n{criteria}")


def member_prompt(team: Team, cards: dict[str, Card], member: Member, step: dict[str, Any], turn: int) -> str:
    """A step's prompt: the card on the member's first turn, then the lead's brief and where the work goes."""
    feature = team.features.get(step["feature"]) if step.get("feature") else None
    # The turn's number makes each prompt the member's own: its turn is found again by it.
    head = f"{team.tag} {member.name} · turn {turn}: {feature.title if feature else step['brief'].splitlines()[0][:80]}"
    card = (f"{cards[member.role].text}\n\n---\n\n# This run\n\n**Goal of the whole run:** {team.goal}\n\n"
            f"Your access: {', '.join(f'`{p}`' for p in member.access) or 'none'}. Install whatever tools you need yourself.\n\n"
            if turn == 1 else "")
    return (f"{head}\n\n{card}## Your task, from the lead\n\n{step['brief']}\n\n## Where\n\n{_where(team, feature, member)}\n\n"
            f"## When you are done\n\n{REPORT.format(schema=MEMBER_REPORT)}")


def judge_prompt(team: Team, card: Card, number: int, decision: Decision, access: list[str]) -> str:
    """The judge's prompt: its card, the lead's question as data, the feature, the checks it owes."""
    feature = team.features.get(decision.data["feature"]) if decision.data.get("feature") else None
    owed = ""
    if decision.data["shippable"] and feature:
        rubric = "\n".join(f"- R{i}. {r}" for i, r in enumerate(card.rubric, 1))
        criteria = "\n".join(f"- C{i}. {c}" for i, c in enumerate(feature.criteria, 1))
        owed = (f"\n\n## Can it ship?\n\nThis verification decides whether the feature ships. Your checks must include each of these, "
                f"by its id.\n\nThe base rubric:\n{rubric}\n\nThe acceptance criteria the human approved:\n{criteria}")
    where = (f"\n\n## Where\n\nFeature `{feature.id}`: {feature.title}. Repository https://github.com/{feature.repo}, base `{feature.base}`, "
             f"branch `{feature.branch}`; its draft pull request, if any, is from that branch." if feature else "")
    question = decision.data["question"]
    return (f"{team.tag} judge: verification {number}{f' of {feature.id}' if feature else ''}\n\n{card.text}\n\n---\n\n"
            f"# This verification\n\n**Goal of the whole run, for context:** {team.goal}\n\n"
            f"## What the lead asks you to verify\n\nWhat to look at, never what to conclude:\n\n````text\n{question}\n````"
            f"{where}{owed}\n\n## Your access\n\n{', '.join(f'`{p}`' for p in access)}: read only. You change nothing in any repository.\n\n"
            f"## Your verdict\n\n{REPORT.format(schema=JUDGE_REPORT)}")


def envelope(team: Team, decision: Decision, judge: Card) -> str:
    """The plan as the person approves it, under the lead's title: its reason, features, criteria, team, access, limits."""
    features = "\n\n".join(
        f"**`{f.id}`: {f.title}**, in `{f.repo}` from `{f.base}`, on `{f.branch}`\n\n" + "\n".join(f"- C{i}. {c}" for i, c in enumerate(f.criteria, 1))
        for f in decision.data["features"])
    members = _table([(m.name, m.role, f"{m.harness} · {m.model} · {m.effort}", ", ".join(f"`{p}`" for p in m.access) or "none")
                      for m in [team.members["lead"], *decision.data["team"]]], ("Member", "Role", "Harness · model · effort", "Access"))
    return (f"{decision.why or '_No reason given._'}\n\n### Features\n\n{features}\n\n### Team\n\n{members}\n\n"
            f"The judge is the flow's: {judge.harness} · {judge.model} · {judge.effort}, a fresh context each time, read-only access to "
            "the repository it verifies and the Internet.\n\n"
            f"### Limits\n\n{team.max_decisions} decisions of the lead, {team.max_verifications} verifications. Nobody merges or deploys. "
            "Anything beyond this envelope comes back to you as a question, and the whole run waits for your answer.")


def asked(team: Team, decision: Decision) -> str:
    """An `ask` as the human reads it."""
    lines = [f"## The lead asks\n\n{decision.data['question']}", f"_Why:_ {decision.why}" if decision.why else ""]
    for feature in decision.data.get("features", []):
        lines.append(f"**New feature `{feature.id}`**: {feature.title}, in `{feature.repo}` from `{feature.base}`\n\n"
                     + "\n".join(f"- C{i}. {c}" for i, c in enumerate(feature.criteria, 1)))
    for member in decision.data.get("team", []):
        lines.append(f"**New member `{member.name}`**: {member.role}, {member.harness} · {member.model} · {member.effort}, "
                     f"access {', '.join(f'`{p}`' for p in member.access) or 'none'}")
    for name, profiles in decision.data.get("access", {}).items():
        before = ", ".join(f"`{p}`" for p in team.members[name].access) or "none"
        lines.append(f"**Access of `{name}`**: {before} → {', '.join(f'`{p}`' for p in profiles) or 'none'}")
    return "\n\n".join(line for line in lines if line)


def decision_json(decision: Decision) -> str:
    def plain(value: Any) -> Any:
        if isinstance(value, (Feature, Member)):
            return asdict(value)
        if isinstance(value, list):
            return [plain(v) for v in value]
        if isinstance(value, dict):
            return {k: plain(v) for k, v in value.items()}
        return value
    return json.dumps({"decision": decision.kind, "why": decision.why, **plain(decision.data)}, indent=2, ensure_ascii=False)
