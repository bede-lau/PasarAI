# Fixtures

- `contracts/v1`: synthetic valid and invalid canonical contract examples.
- `synthetic/seed_data`: committed source snapshot copied from the authoritative handoff.
- `synthetic/seed-output`: deterministic local-only output produced by `pnpm seed:synthetic:reset`.

The reset command validates the committed snapshot against `synthetic/authoritative-source-manifest.json`, normalizes the snapshot into output, and records both source identities in provenance. Reset and CI do not require the handoff package and never contact a live provider, database, or network service.
