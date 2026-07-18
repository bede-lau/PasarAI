# ADR 0004: Versioned cash purchase intake with explicit confirmation

Date: 2026-07-16

## Status

Accepted

## Context

Merchants sometimes pay cash for ingredients and receive no receipt. PasarAI must accept these purchases from the web dashboard and Telegram text or voice, retain their metadata, and reflect the changed ingredient cost on the dashboard. Telegram messages may be incomplete and must not write financial data until the merchant confirms a complete summary.

The existing `costs.create` service already validates merchant ownership, requires evidence, appends an auditable cost event, updates versioned recipe component snapshots, and makes those snapshots available to daily dashboard summaries. Its request is intentionally a strict commit contract and should not also represent incomplete conversational data.

## Decision

1. Introduce a canonical, versioned `PurchaseIntake` aggregate for incomplete or unconfirmed purchases.
2. `purchase-intake.upsert` creates or updates an intake. Each edit increments its version and invalidates its previous confirmation token.
3. Complete intakes enter `ready_for_confirmation`; incomplete intakes enter `clarification_required` and return explicit missing fields.
4. `purchase-intake.confirm` requires the exact intake ID, expected version, and confirmation token shown during review. It is the only new public confirmation path.
5. Confirmation delegates the final financial write to the existing `costs.create` service, preserving its validation, evidence, idempotency, and recipe snapshot behavior.
6. Add a merchant-scoped read-only component catalog endpoint backed by current recipe component snapshots. Web and Telegram use this catalog for valid item IDs.
7. Extend the final costs request non-breakingly with optional source, source language, and purchase metadata. Cash purchase metadata records `payment_method: cash` and may include a merchant note.
8. The web flow lives on Receipts as a peer to receipt-image upload. It validates locally, creates the persisted intake before review, then confirms through an authenticated same-origin BFF route.
9. Telegram resolves an active intake by merchant and chat:
   - partial text or voice details are merged into the active intake;
   - missing required fields produce localized clarification prompts;
   - complete details produce a localized confirmation summary;
   - deterministic localized confirm or cancel commands resolve the intake;
   - unrelated mutating operations are blocked while an intake is active;
   - read-only summaries and simulations remain available;
   - only a matching current-version confirmation commits.
10. Intake snapshots are append-only ledger events. This preserves state across page reloads and process restarts without adding a separate mutable persistence subsystem.
11. Final writes use intake-derived idempotency and evidence identities, preventing repeated confirmation updates from creating duplicate costs.
12. Every update, confirmation, or cancellation for one intake version is
    serialized through a shared transition claim. Concurrent actions cannot
    append competing next versions or commit after a cancellation wins.
13. The web stores a merchant-scoped recovery pointer, draft, review response,
    and stable idempotency keys in browser storage. Reload and uncertain network
    retries reuse the same server mutation identity; editing rotates the upsert
    key, and a successful commit clears recovery state.
14. A Telegram conversation generation is derived from its prior intake IDs.
    Closing one intake therefore advances the creation lock and allows the same
    chat to start a later purchase without weakening first-message concurrency.

## Required purchase fields

- Existing merchant recipe component
- Supplier
- Purchase quantity
- Purchase unit
- Number of base units contained in one purchase unit
- Total price paid
- Purchase date/time

Optional metadata is a note. Payment method is recorded as cash for this flow.

## Aggregate state

```text
draft
  -> clarification_required
  -> ready_for_confirmation
  -> committed

draft | clarification_required | ready_for_confirmation
  -> cancelled
```

The persisted aggregate contains:

- `intake_id`, `merchant_id`, `state`, and `version`
- source, source language, occurred time, and immutable evidence references
- supplier and bounded purchase metadata
- one merchant-entered item with optional fields until complete
- missing fields
- content fingerprint and confirmation token
- optional conversation key for channel resumption
- committed event ID after confirmation

## Consequences

- Cash purchases update the same cost stack and evidence projection as receipt-confirmed purchases.
- A merchant cannot create an unrelated catalog item from this flow. The item must map to an existing recipe component so its effect on product cost is defined.
- Web component choices always reflect database-backed recipe components.
- Telegram collection resumes from persisted intake snapshots by conversation
  key. Web review resumes from merchant-scoped browser recovery state backed by
  the persisted intake ID, version, token, and stable idempotency keys.
- Existing complete Telegram purchase phrases now require explicit confirmation before commit.

## Rejected alternatives

- Direct channel-specific database writes: rejected because they bypass contract validation, evidence handling, idempotency, and recipe snapshot updates.
- Frontend hard-coded component lists: rejected because they can diverge from merchant data.
- Reusing receipt clarification tasks for conversational drafts: rejected because receipt clarification models one immutable source event, while Telegram needs multi-message accumulation and cancellation.
- Committing complete Telegram messages immediately: rejected because the requested workflow requires a confirmation step for all manually entered purchases.
- Adding incomplete states directly to `costs.create`: rejected because it mixes draft interpretation with a strict financial commit contract.

## Verification

- Contract validation and generated artifacts
- API catalog, purchase-intake, stale-confirmation, and cost service tests
- Telegram text, voice, missing-field, confirmation, cancellation, persistence, and duplicate-confirmation tests
- Web BFF, form validation, review, localization, responsive browser, and dashboard-link tests
- Full lint, typecheck, unit, contract, integration, web build, and browser checks
