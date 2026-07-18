---
name: improve-codebase-architecture
description: Autonomously explore a codebase, surface architectural friction, design competing interfaces, validate the strongest via an expert-validator sub-agent, and file the resulting RFC as a GitHub issue — without human-in-the-loop. Use when the user wants to improve architecture, find refactoring opportunities, consolidate tightly-coupled modules, or make a codebase more AI-navigable.
---

# Improve Codebase Architecture (Autonomous)

Explore a codebase like an AI would, surface architectural friction, design competing interfaces in parallel, have an **expert architecture validator** agent score them on concrete criteria, file the winning design as an RFC, and surface the link. No human gate between candidate-selection and RFC filing — the validator agent owns the decision.

A **deep module** (John Ousterhout, "A Philosophy of Software Design") has a small interface hiding a large implementation. Deep modules are more testable, more AI-navigable, and let you test at the boundary instead of inside.

## When to interrupt the autonomous flow

Default: run end-to-end without prompting. Only stop and ask the user when one of the following holds:

- The codebase has zero candidates worth filing (degenerate case — say so and stop).
- A candidate would touch >40% of files in a top-level directory (blast radius too high to autodecide — surface and confirm).
- The validator returns no winner (all candidates tied / all rejected) — present its reasoning and ask.

In every other case, proceed.

## Process

### 1. Explore the codebase

Use the Agent tool with `subagent_type=Explore` to navigate the codebase naturally. Do NOT follow rigid heuristics — explore organically and note where you experience friction:

- Where does understanding one concept require bouncing between many small files?
- Where are modules so shallow that the interface is nearly as complex as the implementation?
- Where have pure functions been extracted just for testability, but the real bugs hide in how they're called?
- Where do tightly-coupled modules create integration risk in the seams between them?
- Which parts of the codebase are untested, or hard to test?

The friction you encounter IS the signal.

### 2. Surface candidates

Build a numbered list of deepening opportunities. For each candidate, capture:

- **Cluster**: Which modules/concepts are involved
- **Why they're coupled**: Shared types, call patterns, co-ownership of a concept
- **Dependency category**: See [REFERENCE.md](REFERENCE.md) for the four categories
- **Test impact**: What existing tests would be replaced by boundary tests
- **Blast radius score** (1–5): rough fraction of touched files

Print the list to the user as a transparency log — not a question. Continue automatically.

### 3. Auto-rank candidates

Score each candidate on three axes (1–5 each, integer):

- **Friction**: how often this coupling causes navigation/test pain
- **Reversibility**: how cheaply the refactor can be unwound if wrong (5 = trivial, 1 = irreversible)
- **Substrate value**: how much downstream work this unblocks (other RFCs, deferred features, planned tests)

`composite = friction × substrate_value − (6 − reversibility)`. Pick the highest composite score; ties broken by lower blast radius. If the top score is < 8, stop and tell the user no candidate is worth deepening today.

Print the scoring table.

### 4. Frame the problem space

Write a self-contained problem-space brief for the chosen candidate:

- Current state (modules involved, file paths, line counts, the coupling pattern)
- Constraints any new interface must satisfy (existing callers, type guarantees, perf budget, project rules from `AGENTS.md`)
- Dependencies it would rely on, classified per [REFERENCE.md](REFERENCE.md)
- A short illustrative code sketch grounding the constraints (NOT a proposal — a foothold)

This brief becomes the shared context loaded inline into every subsequent agent. Persist it to `.Codex/rfcs/_drafts/<slug>-brief.md` so the validator and design agents read identical bytes.

### 5. Design multiple interfaces in parallel

Spawn 3 sub-agents (or 4 if cross-boundary deps apply) in parallel via the Agent tool. Each receives the brief from Step 4 plus a different design constraint:

- Agent 1 — *Minimize the interface*: 1–3 entry points max
- Agent 2 — *Maximize flexibility*: support many use cases + extension points
- Agent 3 — *Optimize for the common caller*: make the default case trivial
- Agent 4 *(if cross-boundary)* — *Ports & adapters*

Each sub-agent outputs the standard 5 sections (interface signature, usage example, hidden complexity, dependency strategy, trade-offs) and writes its proposal to `.Codex/rfcs/_drafts/<slug>-design-{1..N}.md`.

### 6. Spawn the expert architecture validator

This is the human-replacement step. Spawn ONE sub-agent with a tight, opinionated brief — its job is to **decide**, not to summarize.

**Validator prompt template** (the orchestrator fills in `<…>` slots):

```
You are an Expert Architecture Validator. Decide which of the N proposed
interfaces is strongest. Output a single decision plus concrete reasoning.

Inline context (read in this order):
1. .Codex/rfcs/_drafts/<slug>-brief.md         — problem-space brief
2. .Codex/rfcs/_drafts/<slug>-design-1.md      — proposal 1
   .Codex/rfcs/_drafts/<slug>-design-2.md      — proposal 2
   .Codex/rfcs/_drafts/<slug>-design-3.md      — proposal 3
   [.Codex/rfcs/_drafts/<slug>-design-4.md     — proposal 4 if present]
3. AGENTS.md, KARPATHY_GUIDELINES.md            — project rules / coding behavior
4. .Codex/skills/improve-codebase-architecture/REFERENCE.md  — dependency taxonomy + RFC template

Score each proposal on a 0–10 scale across these axes (justify each score
with a one-line citation to a proposal section):

| Axis                     | What "10" looks like                                                   |
|--------------------------|------------------------------------------------------------------------|
| Interface depth          | Small surface hiding large implementation; 1–3 obvious entry points     |
| Caller ergonomics        | Default case is trivial; uncommon cases are still possible              |
| Test boundary            | One boundary test replaces N internal tests; clear in-memory adapter    |
| Migration cost           | Existing callers migrate via mechanical edits, not redesign             |
| Project-rule compliance  | Respects AGENTS.md hard rules + KARPATHY_GUIDELINES.md                  |
| Reversibility            | Can be backed out cleanly if wrong                                      |
| Substrate value          | Unblocks named downstream work                                          |

Then:

- Pick the winner. If two proposals tie within 2 points total, propose a
  HYBRID by name (e.g., "design-2 interface + design-3 dependency strategy"),
  but the hybrid must be concrete — cite which sections come from which doc.
- Write the decision rationale (≤300 words). Lead with what the winner
  hides; close with what it explicitly does NOT solve (so the RFC's
  Out-of-Scope section is grounded).
- Output a final block titled "RFC FILL-INS" containing the exact strings
  that map onto each section of the issue template in REFERENCE.md.

Refuse to pick if and only if all proposals violate a AGENTS.md hard rule.
In that case output {"decision": "REJECT_ALL", "reason": "..."} verbatim
and stop.

Be opinionated. The orchestrator will file your decision as an RFC without
further human review.
```

Persist the validator's output to `.Codex/rfcs/_drafts/<slug>-validator.md`.

### 7. Auto-build the RFC body from validator output

Take the "RFC FILL-INS" block from Step 6. Map each named section onto the issue template in [REFERENCE.md](REFERENCE.md). Do NOT paraphrase — the validator's reasoning IS the RFC body. Add only:

- A frontmatter block with `slug`, `dependency_category`, `winner_design_id` (`design-1` / `design-2` / `design-3` / `design-4` / `hybrid:<a>+<b>`).
- A footer linking back to all 3–4 design drafts under `.Codex/rfcs/_drafts/` so reviewers can audit the trail.

Persist the assembled RFC to `docs/rfcs/<NNNN>-<slug>.md` (next sequential ID).

### 8. File the GitHub issue

Run `gh issue create --title "RFC <NNNN>: <slug>" --body-file docs/rfcs/<NNNN>-<slug>.md --label rfc,architecture`. Capture the URL. If `gh` is not authenticated, surface the assembled RFC path and skip the create step (don't fail the run).

### 9. Final transparency log

Print to the user:

1. Candidate that won + composite score
2. Validator's decision (winner / hybrid / REJECT_ALL) with the one-line lead rationale
3. Path to all `_drafts/` files (so the user can audit if desired)
4. RFC path + GitHub issue URL (or note if `gh` skip)

Stop. Do not ask follow-up questions.

## Anti-patterns (do NOT do these)

- Asking the user "which candidate?" or "is this design ok?" mid-flow. The validator decides.
- Letting the orchestrator pick the winner. Always defer to the validator agent's reasoning — that's the whole point.
- Filing an RFC whose body is your own paraphrase of the validator. The validator's "RFC FILL-INS" block is load-bearing.
- Spawning the validator before all design agents have finished writing to disk. The validator must read the same bytes the user could read.
- Skipping the brief in Step 4. The brief is the shared context that makes the parallel design agents commensurable.

## Why an autonomous validator (not the orchestrator)

The orchestrator wrote the candidate list and the brief — it has hindsight bias toward whichever design agent it primed best. A fresh sub-agent with no orchestrator memory, reading only the persisted artifacts, replicates the "fresh reviewer" property a human RFC reviewer provides. This is the same reason code-review agents are spawned separately from coding agents in adversarial-pair workflows.

## Failure modes & recovery

| Symptom                                            | Recovery                                                                 |
|----------------------------------------------------|--------------------------------------------------------------------------|
| Validator returns `REJECT_ALL`                     | Surface its reason; stop. Do NOT auto-respawn design agents.             |
| All design agents propose nearly identical interfaces | Spawn one more agent with constraint "argue against the consensus"; re-run validator. Cap at one re-spawn. |
| `gh` not authenticated                             | Persist RFC to `docs/rfcs/`; print path; tell the user the manual `gh` command. |
| Two candidates score equally in Step 3             | Pick the lower blast radius; if still tied, pick the one with the clearer dependency category. |