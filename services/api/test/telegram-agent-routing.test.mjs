import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createInMemoryEvidenceStore,
  createInMemoryIngestionStore,
  createTelegramIngestion,
} from "../src/index.js";

function telegramBody(updateId, text) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId + 1_000,
      date: Math.floor(Date.parse("2026-07-15T03:30:00.000Z") / 1_000),
      chat: { id: 9001 },
      text,
    },
  };
}

function createRoutingHarness({
  operation,
  service,
}) {
  const replies = [];
  const eventStore = createInMemoryIngestionStore();
  return {
    replies,
    eventStore,
    ingestion: createTelegramIngestion({
      webhookSecret: "telegram-secret",
      eventStore,
      evidenceStore: createInMemoryEvidenceStore(),
      telegramClient: {
        async sendMessage(message) {
          replies.push(message);
        },
      },
      messageInterpreter: {
        async interpret(input) {
          return typeof operation === "function"
            ? operation(input)
            : operation;
        },
      },
      service,
      merchantResolver: async (body) =>
        body.message?.chat?.id === 9001 ? "m_kak_lina_001" : null,
    }),
  };
}

async function handle(ingestion, body) {
  return ingestion.handleWebhook({
    headers: {
      "x-telegram-bot-api-secret-token": "telegram-secret",
    },
    body,
  });
}

test("Telegram sends an LLM clarification without invoking a business mutation", async () => {
  const service = new Proxy({}, {
    get() {
      throw new Error("No business service method should be called");
    },
  });
  const { ingestion, replies } = createRoutingHarness({
    operation: {
      endpoint_id: "agent.reply",
      payload: {
        text: "Which product did you sell, and what were the quantity and price?",
        reply_language: "en",
      },
    },
    service,
  });
  const body = telegramBody(701, "I sold some food.");
  const response = await handle(ingestion, body);

  assert.equal(response.body.state, "completed");
  assert.deepEqual(response.body.business_result, {
    state: "completed",
    endpoint_id: "agent.reply",
    read_only: true,
    reply_language: "en",
    text: "Which product did you sell, and what were the quantity and price?",
  });
  assert.deepEqual(replies, [{
    chatId: 9001,
    replyToMessageId: 1701,
    text: "Which product did you sell, and what were the quantity and price?",
  }]);
});

test("Telegram executes read-only price simulations and reports exact service values", async () => {
  let simulationCount = 0;
  const { ingestion, replies } = createRoutingHarness({
    operation: {
      endpoint_id: "price-simulation.create",
      payload: {
        product_id: "p_nlb_001",
        quantity: "35",
        proposed_unit_price_rm: "5.50",
        as_of: "2026-07-15",
        reply_language: "en",
      },
    },
    service: {
      async simulatePrice(request) {
        simulationCount += 1;
        assert.deepEqual(request, {
          merchant_id: "m_kak_lina_001",
          product_id: "p_nlb_001",
          quantity: "35",
          proposed_unit_price_rm: "5.50",
          as_of: "2026-07-15",
        });
        return {
          revenue_rm: "192.50",
          cogs_rm: "111.30",
          gross_profit_rm: "81.20",
          gross_margin_pct: "42.18",
          incremental_gross_profit_vs_today_rm: "8.40",
          assumption: "constant_demand",
        };
      },
    },
  });
  const body = telegramBody(
    702,
    "What if I sell 35 nasi lemak biasa at RM5.50?",
  );
  const response = await handle(ingestion, body);

  assert.equal(response.body.state, "completed");
  assert.equal(response.body.business_result.read_only, true);
  assert.equal(simulationCount, 1);
  assert.deepEqual(replies, [{
    chatId: 9001,
    replyToMessageId: 1702,
    text:
      "Price simulation only; no ledger record was changed.\n"
      + "RM192.50 revenue, RM111.30 COGS, RM81.20 gross profit "
      + "(42.18% gross margin).\n"
      + "Gross profit change versus today: RM8.40.\n"
      + "Assumption: demand stays constant.",
  }]);
});

test("Telegram confirms append-only corrections before applying them", async () => {
  let correctionCount = 0;
  const { ingestion, replies } = createRoutingHarness({
    operation: {
      endpoint_id: "corrections.create",
      payload: {
        target_event_id: "sale-001",
        occurred_at: "2026-07-15T03:30:00.000Z",
        reason: "Quantity should be 38.",
        replacement_payload: {
          changes: [{
            kind: "decimal",
            field: "quantity",
            previous_value: "40",
            corrected_value: "38",
          }],
        },
        reply_language: "en",
      },
    },
    service: {
      async recordCorrection(request, { idempotencyKey }) {
        correctionCount += 1;
        assert.equal(idempotencyKey, "telegram:703:corrections.create");
        assert.equal(request.merchant_id, "m_kak_lina_001");
        assert.equal(request.evidence.transcript, "Correct sale-001 to 38.");
        assert.equal(
          request.evidence.external_message_id,
          "telegram:703:corrections.create",
        );
        return {
          state: "committed",
          correction_event_id: "correction-001",
          target_event_id: "sale-001",
          changes: [{
            field: "quantity",
            before_value: "40",
            after_value: "38",
          }],
        };
      },
    },
  });
  const body = telegramBody(703, "Correct sale-001 to 38.");
  const response = await handle(ingestion, body);

  assert.equal(response.body.state, "confirmation_required");
  assert.equal(correctionCount, 0);
  assert.match(
    replies[0].text,
    /I understood this for 2026-07-15:\n- Correct sale-001: quantity: 40 -> 38/,
  );

  const confirmed = await handle(
    ingestion,
    telegramBody(706, "confirm"),
  );

  assert.equal(confirmed.body.state, "committed");
  assert.equal(correctionCount, 1);
  assert.deepEqual(replies[1], {
    chatId: 9001,
    replyToMessageId: 1706,
    text: "Done, I've saved the correction: quantity: 40 -> 38.",
  });
});

test("Telegram keeps rejected confirmations pending and names what needs clarification", async () => {
  const { ingestion, replies, eventStore } = createRoutingHarness({
    operation: {
      endpoint_id: "sales.create",
      payload: {
        occurred_at: "2026-07-15T03:30:00.000Z",
        source: "telegram_voice",
        source_language: "en",
        reply_language: "en",
        lines: [{
          product_id: "p_nlb_001",
          quantity: "40",
          unit_price_rm: "5.00",
        }],
      },
    },
    service: {
      async recordSale() {
        return {
          state: "rejected",
          errors: [{
            code: "invalid_request",
            message:
              '/lines/0/unit_price_rm must match pattern '
              + '"^(0|[1-9][0-9]*)\\.[0-9]{2}$"',
          }],
        };
      },
    },
  });
  const body = telegramBody(
    704,
    "Today I sold 40 regular nasi lemak at five ringgit each.",
  );
  const response = await handle(ingestion, body);

  assert.equal(response.body.state, "confirmation_required");
  assert.match(
    replies[0].text,
    /I understood this for 2026-07-15/,
  );
  assert.doesNotMatch(replies[0].text, /database|p_nlb_001/i);

  const confirmed = await handle(
    ingestion,
    telegramBody(707, "confirm"),
  );

  assert.deepEqual(confirmed.body.business_result, {
    state: "clarification_required",
    endpoint_id: "telegram.confirmation",
    confirmation_id: "telegram:704:database-confirmation",
    reply_language: "en",
    date: "2026-07-15",
    details: [
      "40 Nasi Lemak Biasa at RM5.00 each",
    ],
    clarification_fields: ["unit_price"],
  });
  assert.match(replies[1].text, /unit price needs clarification/i);
  assert.match(replies[1].text, /restate the update/i);
  assert.doesNotMatch(replies[1].text, /unit_price_rm|pattern|\/lines\//);
  assert.equal(
    (await eventStore.getPendingConfirmation({
      merchantId: "m_kak_lina_001",
      conversationKey: "telegram:9001",
    }))?.confirmation_id,
    "telegram:704:database-confirmation",
  );
});

test("Telegram cancellation discards a pending database update", async () => {
  let mutationCount = 0;
  const { ingestion, replies } = createRoutingHarness({
    operation: {
      endpoint_id: "sales.create",
      payload: {
        occurred_at: "2026-07-15T03:30:00.000Z",
        source: "telegram_text",
        reply_language: "en",
        lines: [{
          product_id: "p_nlb_001",
          quantity: "5",
          unit_price_rm: "5.00",
        }],
      },
    },
    service: {
      async recordSale() {
        mutationCount += 1;
        return { state: "committed", event_id: "sale-cancelled" };
      },
    },
  });

  const staged = await handle(
    ingestion,
    telegramBody(708, "Record five sales."),
  );
  const cancelled = await handle(
    ingestion,
    telegramBody(709, "cancel"),
  );

  assert.equal(staged.body.state, "confirmation_required");
  assert.equal(cancelled.body.state, "cancelled");
  assert.equal(mutationCount, 0);
  assert.equal(replies[1].text, "Okay, I discarded that update.");
});

test("a pending write does not hijack a conversational reply", async () => {
  let mutationCount = 0;
  const { ingestion, replies } = createRoutingHarness({
    operation: ({ text }) => text === "Record five sales."
      ? {
          endpoint_id: "sales.create",
          payload: {
            occurred_at: "2026-07-15T03:30:00.000Z",
            source: "telegram_text",
            source_language: "en",
            reply_language: "en",
            lines: [{
              product_id: "p_nlb_001",
              quantity: "5",
              unit_price_rm: "5.00",
            }],
          },
        }
      : {
          endpoint_id: "agent.reply",
          payload: {
            reply_language: "en",
            text: "Hi! I'm here. How can I help with the shop today?",
          },
        },
    service: {
      async recordSale() {
        mutationCount += 1;
        return { state: "committed", event_id: "sale-after-greeting" };
      },
    },
  });

  const staged = await handle(
    ingestion,
    telegramBody(711, "Record five sales."),
  );
  const greeting = await handle(
    ingestion,
    telegramBody(712, "Hi"),
  );
  const confirmed = await handle(
    ingestion,
    telegramBody(713, "confirm"),
  );

  assert.equal(staged.body.state, "confirmation_required");
  assert.equal(greeting.body.state, "completed");
  assert.equal(greeting.body.business_result.endpoint_id, "agent.reply");
  assert.equal(
    replies[1].text,
    "Hi! I'm here. How can I help with the shop today?",
  );
  assert.equal(confirmed.body.state, "committed");
  assert.equal(mutationCount, 1);
});

test("a pending write allows a read-only business summary", async () => {
  let mutationCount = 0;
  let summaryCount = 0;
  const { ingestion, replies } = createRoutingHarness({
    operation: ({ text }) => text === "Record five sales."
      ? {
          endpoint_id: "sales.create",
          payload: {
            occurred_at: "2026-07-15T03:30:00.000Z",
            source: "telegram_text",
            source_language: "en",
            reply_language: "en",
            lines: [{
              product_id: "p_nlb_001",
              quantity: "5",
              unit_price_rm: "5.00",
            }],
          },
        }
      : {
          endpoint_id: "daily-summary.get",
          payload: {
            date: "2026-07-15",
            reply_language: "en",
          },
        },
    service: {
      async getDailySummary() {
        summaryCount += 1;
        return {
          date: "2026-07-15",
          revenue_rm: "250.00",
          cogs_rm: "160.00",
          gross_profit_rm: "90.00",
          gross_margin_pct: "36.00",
          top_cost_drivers: [],
          data_completeness: { state: "complete" },
        };
      },
      async recordSale() {
        mutationCount += 1;
        return { state: "committed", event_id: "sale-after-summary" };
      },
    },
  });

  const staged = await handle(
    ingestion,
    telegramBody(714, "Record five sales."),
  );
  const summary = await handle(
    ingestion,
    telegramBody(715, "How's the business today?"),
  );

  assert.equal(staged.body.state, "confirmation_required");
  assert.equal(summary.body.state, "completed");
  assert.equal(summary.body.business_result.endpoint_id, "daily-summary.get");
  assert.equal(summaryCount, 1);
  assert.equal(mutationCount, 0);
  assert.equal(
    replies[1].text,
    "For 2026-07-15, sales are RM250.00 and gross profit "
      + "is RM90.00 "
      + "(36.00% margin).\n"
      + "Recorded product costs are RM160.00.\n"
      + "This is gross profit, so operating expenses are not included yet.",
  );
});

test("a newer mutation replaces the pending update and refreshes its product summary", async () => {
  let savedLine = null;
  const { ingestion, replies } = createRoutingHarness({
    operation: ({ text }) => {
      if (text === "Record the old sale.") {
        return {
          endpoint_id: "sales.create",
          payload: {
            occurred_at: "2026-07-15T03:30:00.000Z",
            source: "telegram_text",
            source_language: "en",
            reply_language: "en",
            lines: [{
              product_id: "p_nla_001",
              quantity: "5",
              unit_price_rm: "5.00",
            }],
          },
        };
      }
      if (text === "Today I sold 40 regular nasi lemak at RM5 each.") {
        return {
          endpoint_id: "sales.create",
          payload: {
            occurred_at: "2026-07-15T03:30:00.000Z",
            source: "telegram_text",
            source_language: "en",
            reply_language: "en",
            lines: [{
              product_id: "p_nlb_001",
              quantity: "40",
              unit_price_rm: "5.00",
            }],
          },
        };
      }
      return {
        endpoint_id: "daily-summary.get",
        payload: {
          date: "2026-07-15",
          reply_language: "en",
        },
      };
    },
    service: {
      async recordSale(request) {
        savedLine = request.lines[0];
        return { state: "committed", event_id: "sale-latest" };
      },
      async getDailySummary() {
        const revenue = savedLine
          ? Number(savedLine.quantity) * Number(savedLine.unit_price_rm)
          : 0;
        return {
          date: "2026-07-15",
          revenue_rm: revenue.toFixed(2),
          cogs_rm: "128.80",
          gross_profit_rm: "71.20",
          gross_margin_pct: "35.60",
          top_cost_drivers: [],
          data_completeness: { state: "complete" },
        };
      },
    },
  });

  const original = await handle(
    ingestion,
    telegramBody(716, "Record the old sale."),
  );
  const replacement = await handle(
    ingestion,
    telegramBody(717, "Today I sold 40 regular nasi lemak at RM5 each."),
  );
  const confirmed = await handle(
    ingestion,
    telegramBody(718, "confirm"),
  );
  const summary = await handle(
    ingestion,
    telegramBody(719, "How is regular nasi lemak doing today?"),
  );

  assert.equal(original.body.state, "confirmation_required");
  assert.equal(replacement.body.state, "confirmation_required");
  assert.equal(
    replacement.body.business_result.supersedes_confirmation_id,
    "telegram:716:database-confirmation",
  );
  assert.match(
    replies[1].text,
    /replaced the earlier unsaved update/i,
  );
  assert.match(replies[1].text, /40 Nasi Lemak Biasa at RM5.00 each/);
  assert.equal(confirmed.body.state, "committed");
  assert.deepEqual(savedLine, {
    product_id: "p_nlb_001",
    quantity: "40",
    unit_price_rm: "5.00",
  });
  assert.equal(
    replies[2].text,
    "Done, I've saved this for 2026-07-15:\n"
      + "- 40 Nasi Lemak Biasa at RM5.00 each",
  );
  assert.equal(summary.body.state, "completed");
  assert.match(replies[3].text, /sales are RM200.00/);
});

test("an active purchase draft blocks unrelated model-produced mutations", async () => {
  let mutationCount = 0;
  const { ingestion, replies } = createRoutingHarness({
    operation: [
      {
        endpoint_id: "sales.create",
        payload: {
          occurred_at: "2026-07-15T03:30:00.000Z",
          source: "telegram_text",
          source_language: "en",
          reply_language: "en",
          lines: [{
            product_id: "p_nlb_001",
            quantity: "1",
            unit_price_rm: "5.00",
          }],
        },
      },
      {
        endpoint_id: "costs.create",
        payload: {
          occurred_at: "2026-07-15T03:30:00.000Z",
          source: "telegram_text",
          reply_language: "en",
          supplier_name: "Unexpected Supplier",
          metadata: { payment_method: "cash" },
          lines: [{
            component_id: "c_egg",
            quantity: "1",
            uom: "tray",
            pack_size: "30",
            total_price_rm: "12.00",
          }],
        },
      },
    ],
    service: {
      async getActivePurchaseIntake() {
        return {
          intake_id: "purchase_intake_active",
          state: "ready_for_confirmation",
          version: 2,
          confirmation_token: "confirmation_active",
          request: {
            source_language: "en",
            item: { component_id: "c_egg" },
          },
        };
      },
      async recordSale() {
        mutationCount += 1;
      },
      async recordCost() {
        mutationCount += 1;
      },
    },
  });

  const response = await handle(
    ingestion,
    telegramBody(705, "Unrelated model misclassification"),
  );

  assert.equal(response.body.state, "completed");
  assert.equal(mutationCount, 0);
  assert.deepEqual(replies, [{
    chatId: 9001,
    replyToMessageId: 1705,
    text:
      "Your cash purchase is still waiting for a missing detail, "
      + "confirmation, or cancellation.",
  }]);
});
