# Telegram response and latency architecture plan

## Evidence

The pre-change text probe on 27 July 2026 found:

- Clear revenue reads were locally deterministic in about 2-52 ms before the
  business-service call.
- Clear sale, cost-change, and cash-purchase messages still called Qwen and
  took about 1.2-2.3 seconds only to select an operation that the local parser
  had already identified.
- A price simulation, which currently needs Qwen interpretation, took about
  2.0 seconds and remains within the demo target.
- Live local API p95 was about 261 ms for the catalog, 780 ms for the daily
  summary, and 270 ms for receipt-review history.
- Several deterministic replies contain system language such as "ledger",
  "COGS", raw ISO dates, internal correction field names, and arrow syntax.

## Target architecture

### 1. Deterministic text fast path

Run the local parser first. For `telegram_text`, accept a local result without
calling Qwen only when it is structurally complete and high-confidence:

- one or more recognized sales with product, quantity, and price;
- a cost change with a known component and amount;
- a cash purchase with a known component plus concrete purchase fields;
- deterministic summary and trend reads.

All mutations still enter the existing confirmation gate. Ambiguous,
unsupported, correction, simulation, and conversational messages continue to
Qwen.

### 2. Validated model fallback

Qwen remains an intent and tool-selection layer, not a financial calculator.
Its output must continue through the local allowlist, schemas, catalog IDs, and
mutation confirmation boundary. A timeout or invalid tool result falls back to
the previously computed local result when one exists.

### 3. Merchant-facing response renderer

Keep business execution results structured, then render them with one
merchant-facing copy layer:

- format dates by reply language;
- map product, component, and correction fields to merchant terms;
- use "sales", "product costs", "gross profit", and "saved records";
- make confirmation-first wording explicit;
- state when a simulation did not save anything without mentioning a ledger;
- ask one clear next question for missing information;
- never let model-generated prose state an unverified financial amount.

The orchestration layer should decide state and permitted operations. The
renderer should decide wording only.

### 4. Bounded provider calls

Every Telegram Bot API request must have a timeout. Clear text paths should not
pay model latency. Qwen remains bounded by the configured timeout and fallback
model policy. Reply-delivery failures must remain retryable without repeating
the business mutation.

## Implementation sequence

1. Restore the fixed `2026-07-16` demo-date contract for undated reads and
   writes; explicit dates continue to override it.
2. Add the high-confidence local text fast path and tests proving that Qwen is
   not called for clear sale, cost-change, purchase, summary, or trend text.
3. Humanize confirmation, completion, simulation, correction, purchase, and
   error wording while preserving exact financial values.
4. Add Telegram client timeouts and delivery-failure retry tests.
5. Run the complete text matrix, provider preflight, targeted tests, and
   latency probe again.

## Acceptance criteria

- Clear text sale, cost-change, and complete purchase interpretation is under
  100 ms locally before database work.
- Qwen-backed text remains below 8 seconds p95 and 15 seconds maximum during
  the demo pass.
- Every mutation still requires explicit confirmation.
- Undated text always resolves to 16 July 2026 in demo mode.
- No tested reply exposes internal IDs, raw ISO dates, "ledger", "mutation",
  or unexplained "COGS".
- Telegram request failures are bounded and cannot create a duplicate
  financial effect.

## Implemented result

The text-agent path now:

- treats the resolved Telegram business date as authoritative, even if a
  model proposes another date;
- bypasses Qwen for complete sales, cost changes, purchases, summaries, and
  trends;
- keeps incomplete multi-operation updates pending until every required
  field is present;
- preserves the original sale when a follow-up supplies the packaging
  denominator;
- retries failed Telegram reply delivery without replaying the mutation;
- formats confirmations and summaries in merchant language without raw ISO
  dates, database terms, `ledger`, or unexplained `COGS`;
- bounds Telegram Bot API requests at 10 seconds and uses a 90-second
  processing lease.

## Grounding guarantees

Neither interpretation path may invent a financial value. The deterministic
parser only reads a number when the token is not adjacent to a sign, a
thousands separator, another digit, or exponent notation, and only accepts a
sale line with a positive quantity at or below 100,000 units and a positive
unit price at or below RM10,000. The orchestration layer answers a message that
still contains an unreadable number, or a date that does not exist on the
calendar, with one merchant-language question instead of a preview.

Model output passes the same discipline before it reaches the confirmation
gate: a sale must carry plausible numbers, a text message must actually name
the product it books, and a cost change must carry a positive increase. A tool
call that fails any of these is discarded rather than corrected, so an
unverifiable amount can never become a pending mutation.

Every discard is reported rather than swallowed. The model interpreter emits a
tagged reason for each rejection - `request_failed`, `http_error`,
`invalid_response_body`, `unknown_tool`, `invalid_tool_arguments`,
`schema_invalid`, `unsupported_operation`, `unsafe_selection`,
`implausible_sale_numbers`, `unnamed_product`, `non_positive_cost_change`, and
a final `no_verified_operation` naming the fallback that was used. Diagnostics
never block interpretation, and a message that still cannot be interpreted is
answered in the merchant's own language with one concrete next step rather than
a generic failure line.
