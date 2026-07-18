# PasarAI API service

The package contains two isolated surfaces:

- `@pasarai/api` provides Telegram and receipt-ingestion exports.
- `@pasarai/api/backend` provides the deterministic ledger, finance services,
  idempotent API operations, corrections, clarification state and HTTP routes.

## Telegram and receipt ingestion

`createTelegramIngestion` validates the Telegram webhook secret, claims the
`update_id` before processing, stores source evidence before interpretation and
handles text, voice notes and receipt photos. Duplicate deliveries return the
original event identity without storing a second raw event.

The ingestion surface also exports:

- `createTelegramBotClient` for Bot API file download.
- `createElevenLabsScribeTranscriber` for Scribe v2 voice-note transcription.
- `qwen-message-interpreter.js` for multilingual intent routing into the six
  contract-backed business tools through Model Studio function calling, with
  local schema validation and automatic parser fallback. Cash-purchase text and
  voice messages create versioned purchase intakes, request missing fields and
  require an explicit confirmation before the cost ledger is updated.
- `createFileEvidenceStore` for immutable local evidence storage.
- In-memory event and evidence stores for tests.

Receipt extractor output is validated through `@pasarai/contracts` and evaluated
with the canonical confidence, required-pack-size and RM0.05 reconciliation
rules. The live receipt provider remains injected because its Databricks model
and endpoint must be selected from the actual workspace configuration.

The production event store must enforce durable Telegram `update_id` uniqueness
in Lakebase. The in-memory store is a test double, not a live idempotency
guarantee.

All `/api/v1/*` routes are deny-by-default and require an injected
authenticator. `createBearerAuthenticator` binds one configured bearer secret to
one merchant for the hackathon deployment. The Telegram webhook remains on the
single `/webhooks/telegram` route and uses Telegram's secret-token header.

## Cash purchase intake

- `GET /api/v1/catalog/components` returns the authenticated merchant's active
  recipe components for item selection and interpreter grounding.
- `POST /api/v1/purchase-intakes` appends a partial or complete intake snapshot.
  Complete snapshots return a version-bound confirmation token.
- `POST /api/v1/purchase-intakes/confirm` rejects stale versions and delegates
  the final idempotent write to the existing cost service.
- Updates, confirmations and cancellations for the same intake version share
  one transition claim, so concurrent actions produce only one next state.
- Intake snapshots, source evidence, the committed cost event and recipe
  component snapshots are persisted in Lakebase. Reloading a process does not
  discard an active Telegram intake.

## Manual configuration

- Register the Telegram webhook using `TELEGRAM_WEBHOOK_SECRET`.
- Configure `TELEGRAM_BOT_TOKEN` and `ELEVENLABS_API_KEY`.
- Configure `DASHSCOPE_API_KEY`, optionally override
  `DASHSCOPE_ORCHESTRATOR_MODEL`, and set
  `PASARAI_MESSAGE_INTERPRETER_MODULE` to
  `services/api/src/providers/qwen-message-interpreter.js`.
- Optionally set comma-separated `ELEVENLABS_SCRIBE_KEYTERMS` for domain terms
  that Scribe commonly mishears.
- Configure the server-side PasarAI API bearer token and matching ElevenLabs
  secret environment variable `pasarai_api_bearer`.
- Inject the selected live receipt provider.
- Run the Lakebase migration and mount the configured evidence directory on
  durable storage before deployment.

## Production composition

```text
pnpm --filter @pasarai/api db:migrate
pnpm --filter @pasarai/api db:seed:synthetic
pnpm --filter @pasarai/api start
```

`start` constructs the merchant-bound bearer authenticator, JavaScript
Lakebase ledger, shared business service, single Telegram route, evidence
storage and optional provider adapters. Receipt and Telegram interpretation
adapters are loaded only from explicitly configured module paths; the runtime
does not invent a model or endpoint.
