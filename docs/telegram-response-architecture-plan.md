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

## Correction working memory

Previously, the `record_correction` operation required the merchant to provide
a literal `target_event_id`, which meant natural corrections like "correct
that last sale" could not be resolved and were discarded.

PasarAI now resolves addressable sales itself. The
`service.getRecentSaleEvents({ merchantId, limit })` method returns the
merchant's three most recent sale events, newest first, with corrections
already applied. Each event carries `event_id`, `date`, and `lines` containing
`line_index`, `product_id`, `quantity`, and `unit_price_rm`. The query is
backed by a bounded `listRecentEvents` implementation on both the in-memory
and Lakebase stores, with fallback to `listEvents` for stores that do not
implement it.

The event list is injected into the system prompt as "Recent sales available
for correction, newest first". The model may only copy an `event_id` from that
list; it is instructed never to invent, shorten, or reformat one. The list
acts as an allowlist: a proposed `target_event_id` is accepted only if it
appears in the injected list or verbatim in the merchant's message. Any other
target is discarded with reason `unknown_correction_target`.

Corrected numeric values must match numbers the merchant actually stated. When
the message contains digits, the value must match one of them; when spelled
out in English, Malay, or Chinese, the value is accepted and shown in the
confirmation gate. Otherwise, the correction is discarded with reason
`correction_value_unstated`.

Corrected product IDs must be named in the message and matched against the
catalog using the same alias logic as sales; otherwise the correction is
discarded with reason `unnamed_product`.

Discarded corrections do not fall through to generic "I did not catch that"
replies. Instead, PasarAI answers in the merchant's language with the single
missing detail: which sale to correct, or what exact number was meant. PasarAI
never guesses either one.

Corrections remain database mutations and pass through the merchant
confirmation gate before any write occurs.


A message that opens with a correction verb in English, Malay, or Chinese is
never answered with a read-only lookup operation such as `get_daily_summary`
or `get_business_trend`. When the model answers such a message with only a
retrieval operation, PasarAI discards it with reason
`correction_answered_with_retrieval` and asks which sale to correct instead.
This guard exists because the model may read "Correct the sale from last
Tuesday" as a general question about last Tuesday, and prompt instructions
alone did not prevent it from answering with a summary lookup instead of a
correction.

## Grounding guarantees

Neither interpretation path may invent a financial value. The deterministic
parser only reads a number when the token is not adjacent to a sign, a
thousands separator, another digit, or exponent notation, and only accepts a
sale line with a positive quantity at or below 100,000 units and a positive
unit price at or below RM10,000. The orchestration layer answers a message that
still contains an unreadable number, or a date that does not exist on the
calendar, with one merchant-language question instead of a preview.

For typed Telegram messages, every numeric value in a proposed sale
(`quantity` and `unit_price_rm`) and in a proposed cost change (`increase_rm`)
must be one the merchant actually stated in the message, matched by the same
logic as corrected values. When a message contains digits, the value must
match one of them; when spelled out in English, Malay, or Chinese, it is
accepted and shown in the confirmation gate. Voice transcripts are exempt from
this requirement because they are lossy; the merchant confirmation gate guards
those numbers instead. A typed message with an unstated numeric value is
discarded with reason `unstated_sale_numbers` or `unstated_cost_change_amount`
accordingly.

Model output passes the same discipline before it reaches the confirmation
gate: a sale must carry plausible numbers, a text message must actually name
the product it books, and a cost change must carry a positive increase. A tool
call that fails any of these is discarded rather than corrected, so an
unverifiable amount can never become a pending mutation.

Every discard is reported rather than swallowed. The model interpreter emits a
tagged reason for each rejection - `request_failed`, `http_error`,
`invalid_response_body`, `unknown_tool`, `invalid_tool_arguments`,
`schema_invalid`, `unsupported_operation`, `unsafe_selection`,
`implausible_sale_numbers`, `unnamed_product`, `non_positive_cost_change`,
`unknown_correction_target`, `correction_value_unstated`,
`unstated_sale_numbers`, `unstated_cost_change_amount`,
`correction_answered_with_retrieval`, and a final
`no_verified_operation` naming the fallback that was used. Diagnostics never
block interpretation, and a message that still cannot be interpreted is
answered in the merchant's own language with one concrete next step rather than
a generic failure line.
