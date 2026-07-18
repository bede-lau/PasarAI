# ADR 0001: JSON Schema contract authority

Status: Accepted

## Context

PasarAI workstreams use TypeScript, Python, APIs, fixtures, and data tooling. They require one language-neutral payload authority.

## Decision

JSON Schema 2020-12 under `packages/contracts/src/v1/schemas` is canonical. Generated TypeScript and schema bundles are derived artifacts checked for drift.

## Consequences

- Consumers share portable validation rules.
- Generated files must never be edited as an alternative authority.
- Semantic rules that JSON Schema cannot express remain contract tests.
