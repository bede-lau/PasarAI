# PasarAI

PasarAI is a multilingual, voice-first daily margin copilot for Malaysian
owner-operated food businesses. It turns sales updates, supplier changes,
cash purchases, and receipt evidence into a merchant-confirmed ledger, then
shows traceable gross-margin insights and read-only price or volume scenarios.

The product supports English, Bahasa Melayu, Simplified Chinese, and natural
Manglish input. Financial results are calculated deterministically with
decimal-safe code; ambiguous inputs remain pending until the merchant confirms
them.

## Core Capabilities

- Capture sales, purchases, and corrections through Telegram text or voice.
- Extract receipt details while retaining the original evidence for review.
- Require explicit confirmation before financial data is committed.
- Track component costs, per-pack cost, revenue, gross profit, and margin.
- Run read-only price and volume simulations without mutating ledger state.
- Review daily performance through a responsive Next.js dashboard.
- Synchronize supported data with Google Sheets through a merchant-bound
  server-side integration.
- Snapshot Lakebase data into a quota-aware Databricks Bronze, Silver, and Gold
  pipeline.

## Architecture

| Area | Path | Responsibility |
| --- | --- | --- |
| Web dashboard | `apps/web` | Next.js merchant dashboard, receipt review, purchases, simulations, and integration settings |
| API service | `services/api` | Authenticated HTTP API, Telegram ingestion, evidence storage, purchase intake, and Google Sheets integration |
| Contracts | `packages/contracts` | Canonical JSON schemas, generated runtime validators, and public endpoint manifest |
| Finance | `packages/finance` | Deterministic decimal-safe financial calculations |
| Analytics | `packages/analytics` | Demand forecasting and price-volume scenario calculations |
| Voice agent | `packages/elevenlabs-agent` | Multilingual agent configuration, tools, prompts, and conversation tests |
| Data platform | `databricks` | Lakebase migrations, Delta snapshot notebooks, Lakeflow pipeline, and forecast publishing |
| Fixtures | `fixtures` | Contract examples, synthetic seed snapshots, QA cases, and demo state |

`packages/contracts` is the authority for public API payloads. Applications and
services consume those contracts instead of defining competing schemas.

## Requirements

- Node.js 22, 23, or 24
- pnpm 10.x
- Python 3 for the Databricks unit tests

The repository declares pnpm `10.29.3`. Corepack can activate the configured
package manager:

```bash
corepack enable
pnpm install --frozen-lockfile
```

## Quick Start

The synthetic web preview runs without provider credentials, Lakebase, or a
live API.

PowerShell:

```powershell
Copy-Item apps/web/.env.example apps/web/.env.local
pnpm --filter @pasarai/web dev
```

macOS or Linux:

```bash
cp apps/web/.env.example apps/web/.env.local
pnpm --filter @pasarai/web dev
```

Open `http://localhost:3000`. Synthetic preview mode is visibly marked and is
rejected by production builds.

## Full-Stack Development

The production API fails closed until its merchant, database, and bearer
configuration is supplied.

1. Copy `.env.example` to `services/api/.env`.
2. Copy `apps/web/.env.example` to `apps/web/.env.local`.
3. Configure at least `PASARAI_MERCHANT_ID`, `LAKEBASE_DATABASE_URL`, and
   `PASARAI_API_BEARER_TOKEN` for the API.
4. Configure the matching API base URL, bearer token, merchant, and product
   values for the web application.
5. Run both services:

```bash
pnpm dev
```

The web application runs on port `3000` by default. The API runs on port `3001`
unless `PORT` is configured.

Telegram, ElevenLabs, DashScope, Databricks, receipt extraction, and Google
Sheets are optional integrations with separate credentials and setup
requirements. Keep real values in ignored local environment files; committed
environment examples contain names and placeholders only.

## Synthetic Data and Demo

The repository includes deterministic synthetic merchant, product, sales,
ingredient-cost, receipt, and expected-metric fixtures.

```bash
pnpm seed:synthetic:reset
pnpm demo:reset
pnpm demo:rehearse
```

`seed:synthetic:reset` operates only under `fixtures/synthetic` and performs no
network access. `demo:reset` restores local fixtures and changes live Lakebase
state only when the required live configuration is present.

See [the demo rehearsal](docs/demo-120-second-rehearsal.md) for the golden
workflow and disclosure-safe recovery paths.

## Quality Commands

```bash
pnpm contracts:check
pnpm lint
pnpm typecheck
pnpm typecheck:web
pnpm test
pnpm build:web
pnpm test:web:browser
pnpm ci:check
```

The test suites cover canonical contracts, finance, analytics, API behavior,
Telegram ingestion, receipt evidence, purchase intake, Google Sheets
integration, Databricks transformations, the web dashboard, and deterministic
demo reset behavior.

## Safety and Data Rules

- API money values use MYR decimal strings.
- Mutations are idempotent and merchant-scoped.
- Evidence is stored before interpretation or financial commitment.
- Corrections append new facts instead of rewriting source events.
- Receipt and cash-purchase writes require explicit review or confirmation.
- Missing or low-confidence information remains visible and uncommitted.
- Synthetic outputs must never be presented as live merchant data.
- Credentials, local environment files, generated caches, and runtime evidence
  are excluded from repository history.

## Documentation

- [Product definition](PRODUCT.md)
- [Design system and interaction rules](DESIGN.md)
- [Integration architecture](docs/integration-plan.md)
- [Contract change process](docs/contract-change-process.md)
- [Google Sheets integration](docs/google-sheets-integration.md)
- [QA and demo release checklist](docs/qa-demo-release-checklist.md)
- [Web application](apps/web/README.md)
- [API service](services/api/README.md)
- [Databricks platform](databricks/README.md)
