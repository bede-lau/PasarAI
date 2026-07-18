# Design

## Source of truth

- Status: Active
- Last refreshed: 2026-07-17
- Primary product surfaces: Dashboard, Receipts, Telegram
- Evidence reviewed: Current dashboard and receipt-review implementation, shared v1 contracts, API cost service, Telegram ingestion and interpreter flows

## Brand

PasarAI is the product name in every locale. The interface should feel like a practical merchant ledger: direct, calm, trustworthy, and optimized for repeated daily use.

## Product goals

- Let merchants record purchases that have no receipt.
- Make the resulting cost update visible on the dashboard immediately.
- Let merchants briefly preview other products sold by the same store without
  implying that placeholder products are connected to live financial records.
- Let merchants add a temporary recipe from the product dialog for demo
  walkthroughs without creating a database record.
- Make the previous-day comparison date prominent beside the baseline cost so
  merchants can explain exactly which business day is being compared.
- Require an explicit review or confirmation before a financial write.
- Keep receipt and cash-purchase evidence distinguishable while using the same cost ledger.
- Make English, Bahasa Melayu, and Simplified Chinese complete product experiences.

## Personas and jobs

- Food-stall owner: record a cash purchase quickly after buying ingredients.
- Owner using Telegram: speak or type partial details and complete them over several messages.
- Owner reviewing costs: understand which purchase changed the cost stack and inspect its evidence.

## Information architecture

- Dashboard remains the financial overview and exposes a compact Add purchase action beside cost data.
- The dashboard product title includes a compact menu button on its left that opens a
  single-select product dialog. Selecting an item closes the dialog and keeps
  the user on the same dashboard.
- The product dialog exposes one inline Add recipe form. A submitted recipe is
  added for the current page session, selected immediately, and discarded on
  reload.
- Receipts becomes the purchase-intake workspace with two peer views: Receipt image and Cash purchase.
- Cash purchase uses a three-state flow: entry, review, committed.
- Telegram uses the same logical flow conversationally: capture, clarify missing fields, summarize, confirm, commit.

## Design principles

- Use one canonical financial write path across channels.
- Ask for only information required to make a valid, attributable cost record.
- Show merchant-entered values before committing them.
- Preserve entered data after validation or network errors.
- Use merchant language, with finance terminology only where it adds precision.

## Visual language

- Continue the existing warm paper-like ledger surface and restrained red accent.
- Use the existing type scale, compact module headings, square-edged controls, and borders.
- Do not introduce marketing layouts, decorative gradients, or nested cards.
- Use icons from `lucide-react` for add, edit, confirm, and navigation actions.

## Components

- `DashboardProductPicker`: left-aligned title icon trigger, modal product list,
  and inline session-only recipe creator.
- `PurchaseIntakeTabs`: Receipt image and Cash purchase segmented views.
- `CashPurchaseFlow`: controlled entry, persisted review, confirm, success, and error states.
- `ComponentSelect`: merchant-scoped recipe component choices from the API catalog.
- `PurchaseReview`: read-only summary of item, supplier, quantity, pack size, total paid, date, payment method, and note.
- `AddPurchaseLink`: dashboard action carrying the selected date and locale into Receipts.
- Cost comparison baseline: show the localized previous-day date in a highlighted
  reference block beneath the baseline RM value.
- Performance trend: use five value intervals and up to seven evenly spaced date
  intervals; every visible point exposes its full localized date and exact
  selected metric value on hover or keyboard focus. Day-quality gaps remain
  encoded directly in the chart without a separate status legend.
- Telegram purchase summary: localized plain-text confirmation with explicit confirm and cancel commands.

## Accessibility

- Every field has a persistent visible label and associated error text.
- Controls meet a minimum 44px touch target.
- The product picker exposes dialog semantics, a labelled close button,
  selected state, Escape dismissal, backdrop dismissal, and focus restoration.
- Tabs expose selected state and keyboard navigation semantics.
- Trend-chart points are keyboard focusable and show the same compact tooltip
  available on pointer hover.
- Review, loading, error, and success changes use appropriate live regions.
- Color is never the only signal for status or validation.
- Focus moves to the review heading after entry submission and to the success heading after commit.

## Responsive behavior

- At 390px, forms and review rows use one column with full-width actions.
- At tablet and desktop widths, related numeric fields may use two columns.
- Labels, amounts, and translated text wrap without clipping or overlap.
- Trend date intervals remain capped at seven so labels stay readable at mobile
  widths while retaining the first and last dates.
- Dashboard Add purchase remains visible in both complete and no-data cost states.

## Interaction states

- Product picker closed: current product title and menu trigger remain visible.
- Product picker open: the current product is marked selected; placeholder
  products use clean recipe names without visible Demo tags.
- Add recipe: reveals one labelled recipe-name field with Add and Cancel
  actions. Submitting a non-empty name creates and selects the recipe.
- Placeholder product selected: dashboard metrics switch to static local data;
  purchase, evidence, and API simulation actions are unavailable.
- Entry: editable fields with inline validation.
- Review: values are locked, with Edit and Confirm purchase actions.
- Submitting: confirm is disabled and displays a loading icon with localized status text.
- Success: shows the committed item and a link back to the selected dashboard date.
- Error: retains the draft and provides a localized retry message.
- Reload recovery: restores the merchant-scoped draft or review and reuses the
  same mutation identity until the merchant edits or commits.
- Telegram collecting: prompts for missing required fields.
- Telegram awaiting confirmation: accepts confirm, cancel, a purchase
  correction, or a read-only summary/simulation. Other mutations are blocked.
- Telegram committed or cancelled: closes the active draft.

## Content voice

- Short, concrete, and non-judgmental.
- Say total paid, quantity bought, and one unit contains instead of exposing internal accounting labels.
- Label the reference explicitly as "Baseline date" in English and use an
  equivalent concise phrase in each supported locale.
- Confirmation text states that this is a cash purchase without a receipt.
- PasarAI is never translated or renamed.

## Implementation constraints

- `packages/contracts` remains the canonical public API authority.
- `Nasi Lemak Biasa` remains the only product connected to live dashboard,
  receipt, purchase, and simulation APIs.
- Additional dashboard products are hard-coded client-only demo snapshots and
  must not add API routes, contract fields, database records, or mutations.
- User-added recipes exist only in React state, reuse a generic placeholder
  snapshot, and must not persist to local storage or any backend.
- The API computes the baseline comparison date as the selected reporting date
  minus one calendar day; the frontend only formats the returned contract date.
- Dashboard and Telegram create the same versioned `PurchaseIntake`.
- `purchase-intake.confirm` is the explicit confirmation boundary and delegates the final ledger write to the existing cost service.
- Item choices come from merchant recipe components, not a frontend hard-coded list.
- A successful but empty merchant catalog is authoritative and renders a
  localized configuration state; it never falls back to demo components.
- Web retries reuse stable idempotency keys, rotate the upsert key after an
  edit, and clear merchant-scoped recovery only after a confirmed commit.
- Existing receipt persistence and review behavior must remain unchanged.
- No new runtime dependency is required.

## Open questions

- A later release may support creating entirely new recipe components. This release records purchases only against existing merchant components because an unmatched item cannot update a product cost stack safely.
- Normalized purchase reporting can later unify receipt and cash-purchase tables; this release retains complete cash-purchase intake and commit payloads in the append-only ledger and recipe snapshots.
