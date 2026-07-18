# ADR 0002: Canonical endpoint manifest

Status: Accepted

## Context

JSON Schema describes payloads but not paths, methods, headers, idempotency, read-only behavior, or response-state sets.

## Decision

`packages/contracts/src/v1/endpoint-manifest.json` is the canonical endpoint metadata artifact. An OpenAPI wrapper is deferred and, if introduced, must be generated and non-canonical.

## Consequences

- Endpoint semantics remain small and reviewable.
- Backend route design is not implemented by the foundation.
- Future OpenAPI output must drift-check against schemas and the endpoint manifest.
