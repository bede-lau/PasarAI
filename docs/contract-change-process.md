# Contract change process

## Non-breaking changes

1. Update canonical JSON Schemas or endpoint manifest.
2. Update valid and invalid fixtures.
3. Run generation and commit generated artifacts.
4. Run `pnpm ci:check`.
5. Notify affected workstream owners in the integration handoff.

## Breaking changes

A breaking change includes removed or renamed fields, narrowed accepted values, changed endpoint identity or headers, changed response states, or incompatible generated types.

Before approval:

1. Explain the need and migration impact.
2. Update schemas, endpoint manifest, generated types, fixtures, and contract tests together.
3. Notify all prompts 01-06 owners and identify required consumer updates.
4. Obtain integration-lead approval before merge.
5. Merge contracts first, then update consumers in dependency order.

Never create a second schema authority to avoid coordinating a breaking change.
