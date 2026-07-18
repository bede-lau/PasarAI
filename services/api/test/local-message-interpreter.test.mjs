import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createMessageInterpreter,
} from "../src/providers/local-message-interpreter.js";

const occurredAt = "2026-07-15T03:30:00.000Z";

function interpreter() {
  return createMessageInterpreter({
    now: () => occurredAt,
  });
}

test("interprets a multi-line Telegram sales update", async () => {
  const operation = await interpreter().interpret({
    text: "Sold 18 nasi lemak ayam at RM8.50 and 12 teh ais at RM2.50.",
    source: "telegram_text",
    sourceLanguage: null,
    occurredAt,
  });

  assert.deepEqual(operation, {
    endpoint_id: "sales.create",
    payload: {
      occurred_at: occurredAt,
      source: "telegram_text",
      source_language: "en",
      lines: [
        {
          product_id: "p_nla_001",
          quantity: "18",
          unit_price_rm: "8.50",
        },
        {
          product_id: "p_tehais_001",
          quantity: "12",
          unit_price_rm: "2.50",
        },
      ],
    },
  });
});

test("interprets a structured component purchase without floating-point money", async () => {
  const operation = await interpreter().interpret({
    text:
      "Telur today RM16.50 per tray of 30. "
      + "Bought 3 trays from Sinar Borong.",
    source: "telegram_text",
    sourceLanguage: null,
    occurredAt,
  });

  assert.deepEqual(operation, {
    endpoint_id: "purchase-intake.upsert",
    payload: {
      occurred_at: occurredAt,
      source_language: "ms-en",
      reply_language: "ms",
      supplier_name: "Sinar Borong",
      metadata: { payment_method: "cash" },
      item: {
        component_id: "c_egg",
        raw_name: "telur",
        quantity: "3",
        uom: "tray",
        pack_size: "30",
        total_price_rm: "49.50",
      },
    },
  });
});

test("returns both operations for the VN-01 mixed Manglish update", async () => {
  const operations = await interpreter().interpret({
    text:
      "Hari ni habis forty bungkus nasi lemak biasa, semua five ringgit. "
      + "Packaging cost naik two ringgit.",
    source: "telegram_voice",
    sourceLanguage: "eng",
    occurredAt,
  });

  assert.deepEqual(operations, [
    {
      endpoint_id: "sales.create",
      payload: {
        occurred_at: occurredAt,
        source: "telegram_voice",
        source_language: "ms-en",
        lines: [
          {
            product_id: "p_nlb_001",
            quantity: "40",
            unit_price_rm: "5.00",
          },
        ],
      },
    },
    {
      endpoint_id: "cost-changes.create",
      payload: {
        occurred_at: occurredAt,
        component_id: "c_packaging",
        increase_rm: "2.00",
      },
    },
  ]);
});

test("captures known purchase fields without inventing missing values", async () => {
  const operation = await interpreter().interpret({
    text: "Today I bought some eggs and sold them to the customer.",
    source: "telegram_voice",
    sourceLanguage: "eng",
    occurredAt,
  });

  assert.deepEqual(operation, {
    endpoint_id: "purchase-intake.upsert",
    payload: {
      occurred_at: occurredAt,
      source_language: "en",
      reply_language: "en",
      metadata: { payment_method: "cash" },
      item: {
        component_id: "c_egg",
        raw_name: "eggs",
      },
    },
  });
});

test("interprets an English expense question as a read-only daily summary", async () => {
  const operation = await interpreter().interpret({
    text: "How are my expenses looking now?",
    source: "telegram_voice",
    sourceLanguage: "eng",
    occurredAt,
  });

  assert.deepEqual(operation, {
    endpoint_id: "daily-summary.get",
    payload: {
      date: "2026-07-15",
      reply_language: "en",
    },
  });
});

test("recovers the latest Scribe expense-intent transcription error", async () => {
  const operation = await interpreter().interpret({
    text: "SSI sekarang macam mana? Ada apa improvement?",
    source: "telegram_voice",
    sourceLanguage: "ms",
    occurredAt,
  });

  assert.deepEqual(operation, {
    endpoint_id: "daily-summary.get",
    payload: {
      date: "2026-07-15",
      reply_language: "ms",
    },
  });
});

test("interprets a Chinese expense question and preserves reply language", async () => {
  const operation = await interpreter().interpret({
    text: "我的expense现在是怎样？",
    source: "telegram_voice",
    sourceLanguage: "zho",
    occurredAt,
  });

  assert.deepEqual(operation, {
    endpoint_id: "daily-summary.get",
    payload: {
      date: "2026-07-15",
      reply_language: "zh",
    },
  });
});

test("an active purchase does not capture an unrelated expense question", async () => {
  const operation = await interpreter().interpret({
    text: "How are my expenses looking now?",
    source: "telegram_text",
    sourceLanguage: "en",
    occurredAt,
    purchaseIntake: {
      state: "ready_for_confirmation",
      version: 1,
      request: {
        source_language: "en",
        item: { component_id: "c_egg" },
      },
    },
  });

  assert.equal(operation.endpoint_id, "daily-summary.get");
});

test("an active purchase keeps ordinary conversation read-only", async () => {
  const operation = await interpreter().interpret({
    text: "Hello there",
    source: "telegram_text",
    sourceLanguage: "en",
    occurredAt,
    purchaseIntake: {
      state: "clarification_required",
      version: 1,
      request: {
        source_language: "en",
        item: { component_id: "c_egg" },
      },
    },
  });

  assert.equal(operation.endpoint_id, "agent.reply");
});

test("an authoritative empty merchant catalog does not use static components", async () => {
  const operation = await interpreter().interpret({
    text: "Bought eggs",
    source: "telegram_text",
    sourceLanguage: "en",
    occurredAt,
    componentCatalog: [],
  });

  assert.equal(operation.endpoint_id, "purchase-intake.upsert");
  assert.deepEqual(operation.payload.item, {});
});
