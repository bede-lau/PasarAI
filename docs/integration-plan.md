# Integration plan

## Contract authority

`packages/contracts` is the sole canonical v1 contract authority. Every workstream imports its schemas and generated types; no application, service, finance, or data-platform directory may create a competing payload definition.

## Ownership boundaries

- `apps/web`: prompt 05 frontend owner; dashboard and ElevenLabs widget.
- `services/api`: prompt 01 backend owner, except prompt 04 Telegram/media modules.
- `packages/finance`: prompt 01 deterministic decimal finance owner.
- `databricks/`: prompt 02 Lakebase, notebooks, and pipeline owner.
- `packages/elevenlabs-agent`: prompt 03 ElevenLabs configuration, multilingual prompt, tool declarations, and conversation tests.
- Telegram and receipt ingestion: prompt 04.
- QA and demo hardening: prompt 06.
- Root configuration, CI, contracts, integration documents, and ADRs: integration lead.

Prompts 01-05 now have active owned implementation roots. Prompt 06 remains the QA/demo-hardening workstream and must consume the same canonical contracts.

## Integration rules

1. Consume `@pasarai/contracts/v1`; do not copy schemas.
2. Keep API money values as MYR decimal strings.
3. Keep mutations idempotent and evidence-preserving.
4. Run `pnpm ci:check` before handoff.
5. Escalate contract changes through `docs/contract-change-process.md`.

## Integration evidence

Each workstream returns changed files, commands, tests, unresolved risks, and manual actions. Integration accepts a branch only when owned tests pass and contract drift remains clean.

## Prompts 01â€“05 composition

- `/api/v1/*` is merchant-bound bearer authenticated; Telegram remains on the
  single secret-validated `/webhooks/telegram` route.
- The Node API composition root uses `LakebaseLedgerStore`, durable
  idempotency/clarification tables, file evidence storage on a configured
  volume, optional receipt/interpreter adapters, and a production HTTP server.
- Telegram text/voice can invoke the shared business service through an
  injected canonical message interpreter instead of stopping in an isolated
  ingestion store.
- Receipt upload is evidence-first, review-gated, and commits recognized cost
  lines only through the explicit confirmation endpoint.
- Dashboard and Telegram cash purchases share a versioned append-only purchase
  intake. Missing fields are clarified before a version-bound confirmation
  delegates to the canonical cost commit.
- Item mapping is merchant-scoped through the recipe-component catalog rather
  than a frontend or interpreter hard-coded authority.
- Daily summary now carries deterministic price-floor, cost-stack, and evidence
  projections consumed by the live dashboard.
- Browser mutations use authenticated Next.js BFF routes; bearer credentials
  are never exposed as `NEXT_PUBLIC_*` values.
- Google Sheets uses the same merchant-bound BFF boundary, encrypted OAuth
  tokens, durable sync jobs and row versions, token-validated Drive
  notifications, and append-only sale corrections for selective edits.
- The web BFF derives the merchant from a signed HttpOnly session and rejects
  cross-origin mutation requests before attaching the API bearer.
- The Lakebase snapshot notebook lands the operational tables into immutable
  Delta sources before the single triggered Lakeflow pipeline runs.
- Lakeflow consumes canonical `sale` events, line-scoped corrections,
  seven-day historical sales, merchant-local dates, sale-date component
  snapshots, and accepted receipt lines reconciled from purchase lines.
