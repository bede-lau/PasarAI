# ADR 0003: Local synthetic seed boundary

Status: Accepted

## Context

Foundation verification needs deterministic merchant data, but live Lakebase and provider configuration belongs to specialist workstreams and manual setup.

## Decision

`pnpm seed:synthetic:reset` creates synthetic, local-only output under `fixtures/synthetic/seed-output`. It validates authoritative handoff data, records provenance, and performs no network access.

## Consequences

- Tests are repeatable without credentials or providers.
- The output must never be presented as a live database seed.
- Future provider seeders consume this boundary but remain separately owned and configured.
