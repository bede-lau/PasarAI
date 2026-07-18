import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createMessageInterpreter,
} from "../src/providers/qwen-message-interpreter.js";

const occurredAt = "2026-07-15T03:30:00.000Z";

function qwenResponse(toolCalls) {
  return new Response(JSON.stringify({
    id: "chatcmpl_test",
    model: "qwen3.7-plus",
    choices: [{
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        content: "",
        tool_calls: toolCalls.map(({
          id,
          name,
          input,
        }, index) => ({
          id,
          index,
          type: "function",
          function: {
            name,
            arguments: JSON.stringify(input),
          },
        })),
      },
    }],
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function interpreterWithResponse(toolCalls, inspectRequest = () => {}) {
  return createMessageInterpreter({
    environment: {
      DASHSCOPE_API_KEY: "test-dashscope-key",
      DASHSCOPE_BASE_URL:
        "https://dashscope.example/compatible-mode/v1",
      DASHSCOPE_ORCHESTRATOR_MODEL: "test-qwen-model",
      DASHSCOPE_ORCHESTRATOR_FALLBACK_MODEL: "test-qwen-fallback",
      PASARAI_TIME_ZONE: "Asia/Kuala_Lumpur",
    },
    fetchImpl: async (url, options) => {
      inspectRequest(url, options);
      return qwenResponse(toolCalls);
    },
  });
}

test("uses the local interpreter when DashScope is not configured", async () => {
  let fetchCount = 0;
  const interpreter = createMessageInterpreter({
    environment: {
      PASARAI_TIME_ZONE: "Asia/Kuala_Lumpur",
    },
    fetchImpl: async () => {
      fetchCount += 1;
      throw new Error("fetch should not run");
    },
  });

  assert.deepEqual(await interpreter.interpret({
    merchantId: "m_kak_lina_001",
    text: "SSI sekarang macam mana? Ada apa improvement?",
    source: "telegram_voice",
    sourceLanguage: "ms",
    occurredAt,
  }), {
    endpoint_id: "daily-summary.get",
    payload: {
      date: "2026-07-15",
      reply_language: "ms",
    },
  });
  assert.equal(fetchCount, 0);
});

test("sends required allowlisted Qwen tools without merchant credentials or IDs", async () => {
  let requestBody;
  const interpreter = interpreterWithResponse([{
    id: "call_summary",
    name: "get_daily_summary",
    input: {
      date: "2026-07-15",
      reply_language: "en",
    },
  }], (url, options) => {
    assert.equal(
      url,
      "https://dashscope.example/compatible-mode/v1/chat/completions",
    );
    assert.equal(options.method, "POST");
    assert.equal(
      options.headers.authorization,
      "Bearer test-dashscope-key",
    );
    requestBody = JSON.parse(options.body);
  });

  const operation = await interpreter.interpret({
    merchantId: "merchant-id-must-not-leave-runtime",
    text: "How are my expenses looking today?",
    source: "telegram_voice",
    sourceLanguage: "en",
    occurredAt,
  });

  assert.deepEqual(operation, {
    endpoint_id: "daily-summary.get",
    payload: {
      date: "2026-07-15",
      reply_language: "en",
    },
  });
  assert.equal(requestBody.model, "test-qwen-model");
  assert.equal(requestBody.tool_choice, "required");
  assert.equal(requestBody.parallel_tool_calls, true);
  assert.equal(requestBody.enable_thinking, false);
  assert.equal(requestBody.temperature, 0);
  assert.match(
    requestBody.messages[0].content,
    /Sound like a capable, friendly shop assistant/,
  );
  assert.match(
    requestBody.messages[0].content,
    /Never mention internal terms such as tools, endpoints, payloads, ledgers, or databases/,
  );
  assert.deepEqual(
    requestBody.tools.map(({ function: definition }) => definition.name),
    [
      "record_sales",
      "capture_purchase",
      "record_cost",
      "record_cost_change",
      "simulate_price",
      "record_correction",
      "get_daily_summary",
      "respond_to_merchant",
    ],
  );
  assert.ok(requestBody.tools.every(({ function: definition }) =>
    definition.parameters.additionalProperties === false
  ));
  assert.doesNotMatch(
    JSON.stringify(requestBody),
    /merchant-id-must-not-leave-runtime/,
  );
  assert.doesNotMatch(JSON.stringify(requestBody), /test-dashscope-key/);
});

test("trusted Scribe English overrides contradictory Qwen language fields", async () => {
  const interpreter = interpreterWithResponse([{
    id: "call_sales",
    name: "record_sales",
    input: {
      source_language: "zh",
      reply_language: "zh",
      lines: [{
        product_id: "p_nla_001",
        quantity: "5",
        unit_price_rm: "5.00",
      }],
    },
  }]);

  assert.deepEqual(await interpreter.interpret({
    text: "Today I sold five chicken nasi lemak at five ringgit each.",
    source: "telegram_voice",
    sourceLanguage: "eng",
    occurredAt,
  }), {
    endpoint_id: "sales.create",
    payload: {
      occurred_at: occurredAt,
      source: "telegram_voice",
      source_language: "en",
      reply_language: "en",
      lines: [{
        product_id: "p_nla_001",
        quantity: "5",
        unit_price_rm: "5.00",
      }],
    },
  });
});

test("maps parallel Qwen tool calls into deterministic business operations", async () => {
  const interpreter = interpreterWithResponse([
    {
      id: "call_sales",
      name: "record_sales",
      input: {
        source_language: "ms-en",
        reply_language: "ms",
        lines: [{
          product_id: "p_nlb_001",
          quantity: "40",
          unit_price_rm: "5.00",
        }],
      },
    },
    {
      id: "call_cost_change",
      name: "record_cost_change",
      input: {
        component_id: "c_packaging",
        increase_rm: "2.00",
        pack_size: "50",
        reply_language: "ms",
      },
    },
  ]);

  assert.deepEqual(await interpreter.interpret({
    text:
      "I sold 40 regular nasi lemak at RM5 each. "
      + "Packaging increased by RM2 for a pack of 50.",
    source: "telegram_voice",
    sourceLanguage: null,
    occurredAt,
  }), [
    {
      endpoint_id: "sales.create",
      payload: {
        occurred_at: occurredAt,
        source: "telegram_voice",
        source_language: "ms-en",
        reply_language: "ms",
        lines: [{
          product_id: "p_nlb_001",
          quantity: "40",
          unit_price_rm: "5.00",
        }],
      },
    },
    {
      endpoint_id: "cost-changes.create",
      payload: {
        occurred_at: occurredAt,
        component_id: "c_packaging",
        increase_rm: "2.00",
        pack_size: "50",
        reply_language: "ms",
      },
    },
  ]);
});

test("normalizes whole-ringgit Qwen sales prices before contract validation", async () => {
  const interpreter = interpreterWithResponse([{
    id: "call_sales",
    name: "record_sales",
    input: {
      source_language: "en",
      reply_language: "en",
      lines: [{
        product_id: "p_nlb_001",
        quantity: "40",
        unit_price_rm: "5",
      }],
    },
  }]);

  assert.deepEqual(await interpreter.interpret({
    text: "Today I sold 40 regular nasi lemak at five ringgit each.",
    source: "telegram_voice",
    sourceLanguage: "en",
    occurredAt,
  }), {
    endpoint_id: "sales.create",
    payload: {
      occurred_at: occurredAt,
      source: "telegram_voice",
      source_language: "en",
      reply_language: "en",
      lines: [{
        product_id: "p_nlb_001",
        quantity: "40",
        unit_price_rm: "5.00",
      }],
    },
  });
});

test("maps complete costs, simulations, and corrections without calculating", async () => {
  const interpreter = interpreterWithResponse([
    {
      id: "call_cost",
      name: "record_cost",
      input: {
        supplier_name: "Sinar Borong",
        reply_language: "en",
        lines: [{
          component_id: "c_egg",
          raw_name: "eggs",
          quantity: "3",
          uom: "tray",
          pack_size: "30",
          total_price_rm: "49.50",
        }],
      },
    },
    {
      id: "call_simulation",
      name: "simulate_price",
      input: {
        product_id: "p_nlb_001",
        quantity: "35",
        proposed_unit_price_rm: "5.50",
        as_of: "2026-07-15",
        reply_language: "en",
      },
    },
    {
      id: "call_correction",
      name: "record_correction",
      input: {
        target_event_id: "sale-001",
        reason: "Quantity should be 38.",
        changes: [{
          kind: "decimal",
          field: "quantity",
          previous_value: "40",
          corrected_value: "38",
        }],
        reply_language: "en",
      },
    },
  ]);

  const operations = await interpreter.interpret({
    text: "Structured test transcript.",
    source: "telegram_text",
    sourceLanguage: "en",
    occurredAt,
  });

  assert.equal(operations[0].endpoint_id, "purchase-intake.upsert");
  assert.deepEqual(operations[0].payload.item, {
    component_id: "c_egg",
    raw_name: "eggs",
    quantity: "3",
    uom: "tray",
    pack_size: "30",
    total_price_rm: "49.50",
  });
  assert.equal(operations[1].endpoint_id, "price-simulation.create");
  assert.equal(operations[2].endpoint_id, "corrections.create");
  assert.equal(
    operations[2].payload.replacement_payload.changes[0].corrected_value,
    "38",
  );
});

test("allows safe clarification replies and rejects financial free-form claims", async () => {
  const safe = interpreterWithResponse([{
    id: "call_reply",
    name: "respond_to_merchant",
    input: {
      text: "Which product did you sell, and what were the quantity and price?",
      reply_language: "en",
    },
  }]);
  assert.equal(
    (await safe.interpret({
      text: "I sold some food.",
      source: "telegram_text",
      sourceLanguage: "en",
      occurredAt,
    })).endpoint_id,
    "agent.reply",
  );

  const unsafe = interpreterWithResponse([{
    id: "call_unsafe_reply",
    name: "respond_to_merchant",
    input: {
      text: "Your profit is RM99.00.",
      reply_language: "en",
    },
  }]);
  assert.equal(await unsafe.interpret({
    text: "Tell me something.",
    source: "telegram_text",
    sourceLanguage: "en",
    occurredAt,
  }), null);
});

test("rejects tool arguments that do not match the local schema", async () => {
  const interpreter = interpreterWithResponse([{
    id: "call_invalid_summary",
    name: "get_daily_summary",
    input: {
      date: "today",
      reply_language: "en",
      invented_field: "unsafe",
    },
  }]);

  assert.deepEqual(await interpreter.interpret({
    text: "How are my expenses looking today?",
    source: "telegram_voice",
    sourceLanguage: "en",
    occurredAt,
  }), {
    endpoint_id: "daily-summary.get",
    payload: {
      date: "2026-07-15",
      reply_language: "en",
    },
  });
});

test("drops a descriptive clarification source from a complete cost change", async () => {
  let requestBody;
  const interpreter = interpreterWithResponse([{
    id: "call_cost_change",
    name: "record_cost_change",
    input: {
      component_id: "c_packaging",
      increase_rm: "2.00",
      pack_size: "50",
      clarification_source:
        "Merchant stated RM2 extra for one bundle of 50 packaging containers",
      reply_language: "ms",
    },
  }], (_url, options) => {
    requestBody = JSON.parse(options.body);
  });

  assert.deepEqual(await interpreter.interpret({
    text:
      "Packaging naik dua ringgit. "
      + "Dua ringgit ekstra untuk satu bando 50 bekas makanan.",
    source: "telegram_voice",
    sourceLanguage: "ind",
    occurredAt,
  }), {
    endpoint_id: "cost-changes.create",
    payload: {
      occurred_at: occurredAt,
      component_id: "c_packaging",
      increase_rm: "2.00",
      pack_size: "50",
      reply_language: "ms",
    },
  });

  const tool = requestBody.tools.find(
    ({ function: definition }) =>
      definition.name === "record_cost_change",
  );
  assert.equal(
    tool.function.parameters.properties.clarification_source.pattern,
    "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
  );
});

test("uses qwen-plus when the selected Qwen snapshot is unavailable", async () => {
  const models = [];
  const interpreter = createMessageInterpreter({
    environment: {
      DASHSCOPE_API_KEY: "test-dashscope-key",
      DASHSCOPE_BASE_URL:
        "https://dashscope.example/compatible-mode/v1",
      DASHSCOPE_ORCHESTRATOR_MODEL: "qwen3.7-plus",
      DASHSCOPE_ORCHESTRATOR_FALLBACK_MODEL: "qwen-plus",
    },
    fetchImpl: async (_url, options) => {
      const model = JSON.parse(options.body).model;
      models.push(model);
      if (model === "qwen3.7-plus") {
        return new Response("unavailable", { status: 404 });
      }
      return qwenResponse([{
        id: "call_summary",
        name: "get_daily_summary",
        input: {
          date: "2026-07-15",
          reply_language: "en",
        },
      }]);
    },
  });

  assert.equal(
    (await interpreter.interpret({
      text: "How are my expenses looking now?",
      source: "telegram_voice",
      sourceLanguage: "en",
      occurredAt,
    })).endpoint_id,
    "daily-summary.get",
  );
  assert.deepEqual(models, ["qwen3.7-plus", "qwen-plus"]);
});

test("an empty merchant component catalog never falls back to static IDs", async () => {
  let requestBody;
  const interpreter = interpreterWithResponse([{
    id: "call_reply",
    name: "respond_to_merchant",
    input: {
      text: "No purchase items are configured yet.",
      reply_language: "en",
    },
  }], (_url, options) => {
    requestBody = JSON.parse(options.body);
  });

  const operation = await interpreter.interpret({
    text: "I bought eggs",
    source: "telegram_text",
    sourceLanguage: "en",
    occurredAt,
    componentCatalog: [],
  });

  assert.equal(operation.endpoint_id, "agent.reply");
  const capturePurchase = requestBody.tools.find(
    ({ function: definition }) => definition.name === "capture_purchase",
  );
  assert.equal(
    capturePurchase.function.parameters.properties.component_id.pattern,
    "a^",
  );
  assert.doesNotMatch(
    requestBody.messages[0].content,
    /c_egg|c_packaging/,
  );
});
