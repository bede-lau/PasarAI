# Reconciliation Checklist

Loaded in Phase 2 only. Rubric for classifying atomic plan claims into Duplicate / Conflict / Nonsensical / Manual / External-ref.

## 1. Duplicate-detection grep patterns

For each claim type, run the listed search. A hit = likely duplicate → read the file, confirm semantic overlap, cite `file:line`. A miss = not a duplicate (still check for conflicts).

- **New service** — `Glob backend/services/**/*.py`; then Grep for the proposed service name or core function. If a file or similarly-named function exists, inspect before flagging.
- **New router / endpoint** — `Glob backend/routers/**/*.py`; Grep for `APIRouter` declarations and the proposed route path (`@router.(get|post|put|delete)`).
- **New model / table** — `Glob backend/models/**/*.py` and `Glob alembic/versions/*.py`; Grep for the proposed table name or Pydantic class.
- **New prompt** — `Glob **/prompt_library/**` and `Grep` for a distinctive phrase from the proposed prompt.
- **New persona** — `Glob **/persona_templates/**/*.json`; check IDs and archetypes.
- **New client wrapper** — `Glob backend/clients/**/*.py`; Grep for the external system name.
- **New frontend component** — `Glob frontend/src/components/**/*.tsx`; Grep for the component name.
- **New migration** — `Glob alembic/versions/*.py`; look for existing migrations touching the same table/column.
- **New chart / metric / report section** — Grep `chart_service.py`, `metrics_service.py`, `backend/templates/report/**`.

Semantic overlap, not just name collision, counts as a duplicate. Two different names doing the same job = duplicate (flag with both paths).

## 2. Conflict heuristics — dynamic, read CLAUDE.md

Do NOT maintain a static list of project rules in this file; they rot. Instead:

1. Open `CLAUDE.md`.
2. For each clause containing "do not", "never", "always", "banned", "preferred", "NOT", "NEVER", "must", or "required", extract the rule.
3. For each plan item, check whether it violates an extracted rule.
4. Cite `CLAUDE.md:line` on every conflict verdict.

Also check for pattern-level conflicts not in `CLAUDE.md` but obvious from code:
- Plan bypasses an existing abstraction (e.g. calls an LLM directly when `context_bridge` or a client wrapper exists).
- Plan adds a parallel module where an extension point already exists.
- Plan proposes a framework/library whose role is already filled by another.

## 3. Nonsensical / unsuitable signals

Generic, project-agnostic red flags:
- Unfalsifiable claims: "guaranteed X", "fully autonomous", "10× faster" without measurement.
- Training or evaluating on the same dataset (leakage).
- Edits to generated / compiled artifacts (build output, lockfiles via hand-edit, migrations already applied upstream).
- Bypassing existing safety/validation layers without stated cause.
- References to files, functions, tables, or model IDs that Grep/Glob confirm do not exist.
- Circular dependencies introduced by proposed module boundaries.

## 4. Manual-step signatures

Flag any claim containing:
- "set env", "export ", "add to `.env`", "add to secrets manager"
- "create OAuth app", "register application", "request API access", "apply for"
- "provision credentials", "issue token", "rotate secret"
- "run migration manually", "apply migration in prod"
- "upload to dashboard", "configure in console", "click through", "sign up for"
- "configure DNS", "add CNAME", "point domain"
- "install locally", "download binary"
- Any step that requires a human account, billing decision, or physical access.

## 5. External-ref extraction rules

External (verify via research-ops):
- pip / npm / cargo / go package names (with or without version pins).
- Version pins of any kind (`foo==1.2.3`, `"bar": "^2.0"`).
- Third-party API domains, endpoints, or product names.
- Hosted model IDs served over HTTP (any provider).
- Framework names (Next.js, FastAPI, Celery, etc.) — verify version currency and any deprecations.
- CLI tools invoked in the plan (docker, gh, gcloud, etc.).

NOT external (skip):
- Internal Python modules (`backend.services.*`, relative imports).
- Relative file paths within the repo.
- Python stdlib modules.
- Locally defined classes, functions, tables.
- Fully local filesystem paths.

For each external ref: one research-ops question → verdict tagged with current date.
