import assert from "node:assert/strict";
import { test } from "node:test";

import {
  InMemoryLedgerStore,
  createPasarAiService,
} from "../src/backend/index.js";
import {
  createInMemoryEvidenceStore,
  createInMemoryIngestionStore,
  createTelegramIngestion,
} from "../src/index.js";
import {
  createMessageInterpreter as createQwenMessageInterpreter,
} from "../src/providers/qwen-message-interpreter.js";

const MERCHANT_ID = "m_kak_lina_001";
const OCCURRED_AT = "2026-07-16T12:00:00+08:00";

const PRODUCT_PROFILE = {
  merchantId: MERCHANT_ID,
  productId: "p_nlb_001",
  baselineUnitCogsRm: "2.90",
  currentUnitCogsRm: "3.18",
  components: [],
};

function createService() {
  let sequence = 0;
  return createPasarAiService({
    store: new InMemoryLedgerStore({ productProfiles: [PRODUCT_PROFILE] }),
    idFactory: (kind) => {
      sequence += 1;
      return `evt_${kind}_${String(sequence).padStart(3, "0")}`;
    },
  });
}

async function seedSale(service, {
  occurredAt = OCCURRED_AT,
  quantity = "40",
  unitPriceRm = "5.50",
  idempotencyKey,
} = {}) {
  const response = await service.recordSale(
    {
      merchant_id: MERCHANT_ID,
      occurred_at: occurredAt,
      source: "telegram_text",
      source_language: "en",
      lines: [
        {
          product_id: "p_nlb_001",
          quantity,
          unit_price_rm: unitPriceRm,
        },
      ],
      evidence: {
        transcript: `Sold ${quantity} nasi lemak biasa at RM${unitPriceRm}.`,
        source_event_id: idempotencyKey,
      },
    },
    { idempotencyKey },
  );
  assert.equal(response.state, "committed");
  return response.event_id;
}

function toolCallResponse(calls) {
  return {
    ok: true,
    async json() {
      return {
        choices: [
          {
            message: {
              tool_calls: calls.map(({ name, input }) => ({
                function: {
                  name,
                  arguments: JSON.stringify(input),
                },
              })),
            },
          },
        ],
      };
    },
  };
}

function createModelInterpreter(planner) {
  const prompts = [];
  const rejections = [];
  const interpreter = createQwenMessageInterpreter({
    environment: { DASHSCOPE_API_KEY: "test-key" },
    onRejection: (reason, detail) => rejections.push({ reason, ...detail }),
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      prompts.push(body.messages[0].content);
      return toolCallResponse(
        typeof planner === "function" ? planner(body) : planner,
      );
    },
  });
  return { interpreter, prompts, rejections };
}

function correctionCall(targetEventId, correctedQuantity) {
  return [{
    name: "record_correction",
    input: {
      target_event_id: targetEventId,
      reason: "Merchant corrected the quantity",
      changes: [{
        kind: "decimal",
        field: "quantity",
        corrected_value: correctedQuantity,
      }],
      reply_language: "en",
    },
  }];
}

test("recent sales are newest first, correction-aware, and bounded", async () => {
  const service = createService();
  const first = await seedSale(service, {
    occurredAt: "2026-07-14T12:00:00+08:00",
    idempotencyKey: "sale-1",
  });
  await seedSale(service, {
    occurredAt: "2026-07-15T12:00:00+08:00",
    idempotencyKey: "sale-2",
  });
  await seedSale(service, {
    occurredAt: "2026-07-16T12:00:00+08:00",
    idempotencyKey: "sale-3",
  });
  const newest = await seedSale(service, {
    occurredAt: "2026-07-17T12:00:00+08:00",
    idempotencyKey: "sale-4",
  });
  const correction = await service.recordCorrection(
    {
      merchant_id: MERCHANT_ID,
      occurred_at: "2026-07-17T13:00:00+08:00",
      target_event_id: newest,
      reason: "Merchant corrected the quantity",
      replacement_payload: {
        changes: [{
          kind: "decimal",
          field: "quantity",
          corrected_value: "30",
        }],
      },
      evidence: { transcript: "Last sale was 30 packs, not 40." },
    },
    { idempotencyKey: "correction-1" },
  );
  assert.equal(correction.state, "committed");

  const recent = await service.getRecentSaleEvents({
    merchantId: MERCHANT_ID,
  });
  assert.equal(recent.events.length, 3);
  assert.equal(recent.events[0].event_id, newest);
  assert.equal(recent.events[0].date, "2026-07-17");
  assert.deepEqual(recent.events[0].lines, [{
    line_index: 0,
    product_id: "p_nlb_001",
    quantity: "30",
    unit_price_rm: "5.50",
  }]);
  assert.ok(
    !recent.events.some((event) => event.event_id === first),
    "the oldest sale falls outside the recent window",
  );
});

test("a recent sale is an addressable correction target", async () => {
  const { interpreter, prompts, rejections } = createModelInterpreter(
    correctionCall("evt_sale_001", "30"),
  );
  const operation = await interpreter.interpret({
    merchantId: MERCHANT_ID,
    text: "Correct that last sale, it was 30 packs not 40.",
    source: "telegram_text",
    occurredAt: OCCURRED_AT,
    recentSales: [{
      event_id: "evt_sale_001",
      date: "2026-07-16",
      lines: [{
        line_index: 0,
        product_id: "p_nlb_001",
        quantity: "40",
        unit_price_rm: "5.50",
      }],
    }],
  });

  assert.equal(operation.endpoint_id, "corrections.create");
  assert.equal(operation.payload.target_event_id, "evt_sale_001");
  assert.deepEqual(rejections, []);
  assert.match(prompts[0], /Recent sales available for correction/);
  assert.match(prompts[0], /evt_sale_001/);
});

test("an event ID the merchant never saw is not a correction target", async () => {
  const { interpreter, rejections } = createModelInterpreter(
    correctionCall("evt_sale_999", "30"),
  );
  const operation = await interpreter.interpret({
    merchantId: MERCHANT_ID,
    text: "Correct that last sale, it was 30 packs not 40.",
    source: "telegram_text",
    occurredAt: OCCURRED_AT,
    recentSales: [{
      event_id: "evt_sale_001",
      date: "2026-07-16",
      lines: [{
        line_index: 0,
        product_id: "p_nlb_001",
        quantity: "40",
        unit_price_rm: "5.50",
      }],
    }],
  });

  assert.equal(operation.endpoint_id, "agent.reply");
  assert.equal(operation.payload.clarification, "unknown_correction_target");
  assert.equal(
    rejections.filter(({ reason }) => reason === "unknown_correction_target")
      .length,
    1,
  );
});

test("a correction without a stated value asks for the number", async () => {
  const { interpreter, rejections } = createModelInterpreter(
    correctionCall("evt_sale_001", "30"),
  );
  const operation = await interpreter.interpret({
    merchantId: MERCHANT_ID,
    text: "Please fix that last sale for me.",
    source: "telegram_text",
    occurredAt: OCCURRED_AT,
    recentSales: [{
      event_id: "evt_sale_001",
      date: "2026-07-16",
      lines: [{
        line_index: 0,
        product_id: "p_nlb_001",
        quantity: "40",
        unit_price_rm: "5.50",
      }],
    }],
  });

  assert.equal(operation.endpoint_id, "agent.reply");
  assert.equal(operation.payload.clarification, "correction_value_unstated");
  assert.equal(rejections[0].reason, "correction_value_unstated");
});

test("a spelled-out correction value stays addressable", async () => {
  const { interpreter, rejections } = createModelInterpreter(
    correctionCall("evt_sale_001", "30"),
  );
  const operation = await interpreter.interpret({
    merchantId: MERCHANT_ID,
    text: "That last sale was thirty packs, not forty.",
    source: "telegram_text",
    occurredAt: OCCURRED_AT,
    recentSales: [{
      event_id: "evt_sale_001",
      date: "2026-07-16",
      lines: [{
        line_index: 0,
        product_id: "p_nlb_001",
        quantity: "40",
        unit_price_rm: "5.50",
      }],
    }],
  });

  assert.equal(operation.endpoint_id, "corrections.create");
  assert.deepEqual(rejections, []);
});

test("an event ID stated in the message stays addressable", async () => {
  const { interpreter, rejections } = createModelInterpreter(
    correctionCall("evt_sale_042", "30"),
  );
  const operation = await interpreter.interpret({
    merchantId: MERCHANT_ID,
    text: "Fix evt_sale_042, the quantity should be 30.",
    source: "telegram_text",
    occurredAt: OCCURRED_AT,
    recentSales: [],
  });

  assert.equal(operation.endpoint_id, "corrections.create");
  assert.equal(operation.payload.target_event_id, "evt_sale_042");
  assert.deepEqual(rejections, []);
});

test("a product named in the message grounds the sale it belongs to", async () => {
  const { interpreter, rejections } = createModelInterpreter([{
    name: "record_sales",
    input: {
      lines: [{
        product_id: "p_nlb_001",
        quantity: "40",
        unit_price_rm: "5.50",
      }],
      source_language: "en",
      reply_language: "en",
    },
  }]);
  const operation = await interpreter.interpret({
    merchantId: MERCHANT_ID,
    text: "Please log a sale of nasi lemak biasa, qty forty, unit price five fifty.",
    source: "telegram_text",
    occurredAt: OCCURRED_AT,
    recentSales: [],
  });

  assert.equal(operation.endpoint_id, "sales.create");
  assert.deepEqual(rejections, []);
});

test("a correction instruction is never answered with a lookup", async () => {
  const { interpreter, rejections } = createModelInterpreter([{
    name: "get_daily_summary",
    input: {
      date: "2026-07-14",
      requested_metric: "overview",
      reply_language: "en",
    },
  }]);
  const operation = await interpreter.interpret({
    merchantId: MERCHANT_ID,
    text: "Correct the sale from last Tuesday to 30 packs.",
    source: "telegram_text",
    occurredAt: OCCURRED_AT,
    recentSales: [],
  });

  assert.equal(operation.endpoint_id, "agent.reply");
  assert.equal(operation.payload.clarification, "unknown_correction_target");
  assert.ok(
    rejections.some(({ reason }) =>
      reason === "correction_answered_with_retrieval"
    ),
  );
});

test("an ordinary question still reaches the daily summary", async () => {
  const { interpreter, rejections } = createModelInterpreter([{
    name: "get_daily_summary",
    input: {
      date: "2026-07-16",
      requested_metric: "gross_margin",
      reply_language: "en",
    },
  }]);
  const operation = await interpreter.interpret({
    merchantId: MERCHANT_ID,
    text: "Is my gross margin correct today?",
    source: "telegram_text",
    occurredAt: OCCURRED_AT,
    recentSales: [],
  });

  assert.equal(operation.endpoint_id, "daily-summary.get");
  assert.deepEqual(rejections, []);
});

function createTelegramHarness({ service, interpreter }) {
  const replies = [];
  let updateId = 7_100;
  const ingestion = createTelegramIngestion({
    webhookSecret: "telegram-secret",
    eventStore: createInMemoryIngestionStore(),
    evidenceStore: createInMemoryEvidenceStore(),
    telegramClient: {
      async sendMessage(message) {
        replies.push(message.text);
      },
    },
    messageInterpreter: interpreter,
    service,
    merchantResolver: async (body) =>
      body.message?.chat?.id === 9001 ? MERCHANT_ID : null,
  });
  return {
    replies,
    async send(text) {
      updateId += 1;
      await ingestion.handleWebhook({
        headers: { "x-telegram-bot-api-secret-token": "telegram-secret" },
        body: {
          update_id: updateId,
          message: {
            message_id: updateId + 1_000,
            date: Math.floor(Date.parse(OCCURRED_AT) / 1_000),
            chat: { id: 9001 },
            text,
          },
        },
      });
    },
  };
}

test("Telegram corrects the last sale without the merchant quoting an event ID", async () => {
  const service = createService();
  const saleEventId = await seedSale(service, { idempotencyKey: "sale-1" });
  const { interpreter, prompts } = createModelInterpreter(
    correctionCall(saleEventId, "30"),
  );
  const harness = createTelegramHarness({ service, interpreter });

  await harness.send("Correct that last sale, it was 30 packs not 40.");
  assert.match(prompts[0], new RegExp(saleEventId));
  assert.match(harness.replies.at(-1), /quantity/i);
  assert.match(harness.replies.at(-1), /confirm/i);

  const beforeConfirmation = await service.getRecentSaleEvents({
    merchantId: MERCHANT_ID,
  });
  assert.equal(beforeConfirmation.events[0].lines[0].quantity, "40");

  await harness.send("confirm");
  const afterConfirmation = await service.getRecentSaleEvents({
    merchantId: MERCHANT_ID,
  });
  assert.equal(afterConfirmation.events[0].lines[0].quantity, "30");
  assert.equal(afterConfirmation.events[0].event_id, saleEventId);
});

test("Telegram asks in the merchant's own language", async () => {
  const service = createService();
  await seedSale(service, { idempotencyKey: "sale-1" });
  const { interpreter } = createModelInterpreter([{
    name: "record_correction",
    input: {
      target_event_id: "evt_sale_999",
      reason: "Merchant corrected the quantity",
      changes: [{
        kind: "decimal",
        field: "quantity",
        corrected_value: "30",
      }],
      reply_language: "ms",
    },
  }]);
  const harness = createTelegramHarness({ service, interpreter });

  await harness.send("Betulkan jualan Selasa lepas, sepatutnya 30 bungkus.");
  assert.match(harness.replies.at(-1), /jualan mana/i);
});

test("Telegram asks which sale to fix when the reference is unresolvable", async () => {
  const service = createService();
  await seedSale(service, { idempotencyKey: "sale-1" });
  const { interpreter } = createModelInterpreter(
    correctionCall("evt_sale_999", "30"),
  );
  const harness = createTelegramHarness({ service, interpreter });

  await harness.send("Correct the sale from last Tuesday, it was 30 packs.");
  assert.match(harness.replies.at(-1), /which sale/i);

  const recent = await service.getRecentSaleEvents({
    merchantId: MERCHANT_ID,
  });
  assert.equal(recent.events[0].lines[0].quantity, "40");
});
