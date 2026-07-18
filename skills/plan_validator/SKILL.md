---
name: plan_validator
description: Audit a pasted implementation plan against the current codebase before execution. Flags duplicates, conflicts with existing patterns, nonsensical or unsuitable items; extracts manual steps; verifies every external dependency/API/version via research-ops. Triggers when the user pastes a plan and asks to validate, audit, review, sanity-check, or reconcile it.
---

# plan_validator

Audit an implementation plan authored by another agent (pasted into the user prompt) against the current codebase. Read-only. Never edits files. Never calls `ExitPlanMode`.

## Input contract

Plan text must already be present in the user prompt. If absent, ask the user to paste it. Never invent plan content or infer it from earlier messages.

## Workflow

### Phase 1 — Parse

Break the plan into atomic claims. One bullet per: proposed file, proposed function/service/router/table/migration, proposed library or model ID, proposed API call, manual step, assertion about existing code. Keep the parsed list internal; do not echo unless asked.

### Phase 2 — Reconcile against codebase

1. Read `AGENTS.md` first — authoritative on architecture, naming, banned tools, anti-patterns.
2. Load `references/checklist.md` — the reconciliation rubric. Do NOT load earlier.
3. For each atomic claim, use Grep/Glob/Read to determine:
   - Already implemented? → Duplicate.
   - Clashes with a `AGENTS.md` rule or existing pattern? → Conflict.
   - References a file/function/table/model that doesn't exist? → Nonsensical.
4. Every Duplicate or Conflict verdict MUST cite `file:line`. An uncited verdict is not allowed.

### Phase 3 — Clarify

Use `AskUserQuestion` only for genuine ambiguities where user intent changes the verdict. Batch ≤4 per call. Do NOT ask about duplicates (flag them) or items already contradicted by `AGENTS.md` (flag them).

### Phase 4 — Manual-step extraction

List every item requiring action outside agent control: env-var provisioning, OAuth app creation, credential issuance, manual DB migration, third-party dashboard config, paid API access requests, DNS changes, secrets rotation. Signatures in `checklist.md`.

### Phase 5 — External-ref verification

Invoke the `research-ops` skill for EVERY external ref the plan mentions — packages, version pins, third-party APIs, hosted model IDs, framework names. No filtering. Collect evidence-labeled verdicts (up-to-date / deprecated / nonexistent / version-mismatch). Tag each with current date per `research-ops` guardrails. Internal modules and local paths are NOT external.

## Output — fixed inline markdown report

```
## Plan Validator Report
### Duplicates (already implemented)
### Conflicts (clash with AGENTS.md or existing code)
### Nonsensical / unsuitable items
### Manual steps required
### External-ref verification (via research-ops)
### Open clarifications
### Recommendation: proceed | revise | reject
```

Empty sections render as `_none_`. Do not drop the heading.

## Hard rules

- Read-only. Never edit files during an audit.
- Never call `ExitPlanMode`; never write to any plans directory.
- Every Duplicate/Conflict verdict cites `file:line`.
- Every external-ref verdict carries a date.
- `AGENTS.md` wins against the plan on any conflict.
- Do NOT load `references/checklist.md` until Phase 2 begins.
- Do NOT hard-code project-specific rules in this skill. Re-derive them from `AGENTS.md` at audit time so the skill doesn't rot.
