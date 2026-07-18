# PasarAI contracts

This package is the sole canonical authority for PasarAI v1 API and receipt contracts.

- JSON Schema sources: `src/v1/schemas`
- Endpoint metadata: `src/v1/endpoint-manifest.json`
- Generated TypeScript: `src/v1/types/generated.ts`
- Public entry point: `@pasarai/contracts/v1`

OpenAPI is intentionally deferred and is not a canonical contract source.

Cash purchases use the canonical `purchase-intake-upsert.request`,
`purchase-intake-upsert.response`, `purchase-intake-confirm.request`, and
`component-catalog.response` schemas. The strict `costs.request` remains the
final financial commit payload and now accepts bounded purchase provenance
metadata.
