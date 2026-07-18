import { readFileSync } from "node:fs";

const metrics = JSON.parse(
  readFileSync(
    new URL("../../../fixtures/synthetic/seed_data/expected_metrics.json", import.meta.url),
    "utf8",
  ),
);

function turn(role, message, timeInCallSecs) {
  return { role, message, timeInCallSecs };
}

function toolExchange({ userMessage, toolName, params, result }) {
  const requestId = `req-${toolName}`;
  return [
    turn("user", userMessage, 1),
    {
      role: "agent",
      timeInCallSecs: 2,
      toolCalls: [{
        type: "webhook",
        requestId,
        toolName,
        paramsAsJson: JSON.stringify(params),
        toolHasBeenCalled: true,
      }],
    },
    {
      role: "agent",
      timeInCallSecs: 3,
      toolResults: [{
        type: "webhook",
        requestId,
        toolName,
        resultValue: JSON.stringify(result),
        isError: false,
        toolHasBeenCalled: true,
      }],
    },
  ];
}

function responseTest(fixtureId, name, chatHistory, successCondition, successExamples = []) {
  return {
    fixtureId,
    request: {
      type: "llm",
      name: `${fixtureId} ${name}`,
      chatHistory,
      successCondition,
      ...(successExamples.length
        ? { successExamples: successExamples.map((response) => ({ type: "success", response })) }
        : {}),
    },
  };
}

function toolTest(fixtureId, name, chatHistory, toolId, parameters) {
  return {
    fixtureId,
    request: {
      type: "tool",
      name: `${fixtureId} ${name}`,
      chatHistory,
      checkAnyToolMatches: false,
      toolCallParameters: {
        referencedTool: {
          id: toolId,
          type: "webhook",
        },
        parameters,
      },
    },
  };
}

function exact(path, expectedValue) {
  return {
    path,
    eval: {
      type: "exact",
      expectedValue,
    },
  };
}

const dailySummary = {
  merchant_id: "m_kak_lina_001",
  date: "2026-07-12",
  revenue_rm: metrics.today.revenue_rm.toFixed(2),
  cogs_rm: metrics.today.cogs_rm.toFixed(2),
  gross_profit_rm: metrics.today.gross_profit_rm.toFixed(2),
  gross_margin_pct: metrics.today.gross_margin_pct.toFixed(2),
  data_completeness: {
    state: "complete",
    missing_inputs: [],
  },
  top_cost_drivers: Object.entries(metrics.cost_driver_contributions_rm_per_pack).map(
    ([name, contribution]) => ({
      name,
      contribution_rm_per_pack: contribution.toFixed(2),
    }),
  ),
  baseline_comparison: {
    baseline_margin_pct: metrics.today.baseline_margin_pct.toFixed(2),
    margin_change_percentage_points: metrics.today.margin_change_percentage_points.toFixed(2),
  },
  price_floor: {
    target_gross_margin_pct: "40.00",
    price_floor_rm: metrics.price_floor_for_40pct_margin_rm.toFixed(2),
    assumption: "current_unit_cogs",
  },
  cost_stack: null,
  evidence: [],
  assumptions: ["Gross profit excludes wages and other overheads."],
};

const priceScenario = {
  revenue_rm: metrics.scenario_35_at_5_50.revenue_rm.toFixed(2),
  cogs_rm: metrics.scenario_35_at_5_50.cogs_rm.toFixed(2),
  gross_profit_rm: metrics.scenario_35_at_5_50.gross_profit_rm.toFixed(2),
  gross_margin_pct: metrics.scenario_35_at_5_50.gross_margin_pct.toFixed(2),
  incremental_gross_profit_vs_today_rm:
    metrics.scenario_35_at_5_50.incremental_gross_profit_vs_today_rm.toFixed(2),
  assumption: "constant_demand",
};

export function buildConversationTests({ toolIds }) {
  for (const name of [
    "record_sales",
    "record_cost",
    "record_cost_change",
    "simulate_price",
    "record_correction",
    "get_daily_summary",
  ]) {
    if (!toolIds[name]) throw new Error(`Missing ElevenLabs tool ID for ${name}`);
  }

  return [
    toolTest(
      "VN-01",
      "sales tool call",
      [turn(
        "user",
        "Hari ni habis forty bungkus nasi lemak biasa, semua five ringgit. Packaging cost naik two ringgit.",
        1,
      )],
      toolIds.record_sales,
      [
        exact("/source_language", "ms-en"),
        exact("/lines/0/product_id", "p_nlb_001"),
        exact("/lines/0/quantity", "40"),
        exact("/lines/0/unit_price_rm", "5.00"),
      ],
    ),
    toolTest(
      "VN-01",
      "persist packaging denominator clarification",
      [turn(
        "user",
        "Hari ni habis forty bungkus nasi lemak biasa, semua five ringgit. Packaging cost naik two ringgit.",
        1,
      )],
      toolIds.record_cost_change,
      [
        exact("/component_id", "c_packaging"),
        exact("/increase_rm", "2.00"),
      ],
    ),
    responseTest(
      "VN-01",
      "denominator response",
      [turn(
        "user",
        "Hari ni habis forty bungkus nasi lemak biasa, semua five ringgit. Packaging cost naik two ringgit.",
        1,
      )],
      "The response is concise natural Manglish, confirms the understood 40 packs at RM5, asks whether the RM2 packaging increase is per item, per pack or bundle of 50, or total, and clearly does not claim that the packaging cost was recorded.",
      ["Okay, jualan 40 bungkus pada RM5 saya dah faham. Packaging naik RM2 itu untuk satu pek 50 bekas, setiap bekas, atau jumlah hari ini?"],
    ),
    toolTest(
      "VN-02",
      "Malay denominator clarification",
      [
        ...toolExchange({
          userMessage:
            "Hari ni habis forty bungkus nasi lemak biasa, semua five ringgit. Packaging cost naik two ringgit.",
          toolName: "record_cost_change",
          params: {
            merchant_id: "m_kak_lina_001",
            component_id: "c_packaging",
            increase_rm: "2.00",
          },
          result: {
            state: "clarification_required",
            clarification_source: "message:evt_voice_001",
            clarifications: [{
              field: "pack_size",
              question:
                "Bekas Makanan increase RM2.00 applies to how many base units?",
              options: ["50", "100", "other"],
            }],
          },
        }),
        turn(
          "agent",
          "Packaging naik RM2 itu untuk satu pek 50 bekas, setiap bekas, atau jumlah hari ini?",
          4,
        ),
        turn("user", "RM2 naik untuk satu pek 50 bekas, bukan setiap bekas.", 5),
      ],
      toolIds.record_cost_change,
      [
        exact("/component_id", "c_packaging"),
        exact("/increase_rm", "2.00"),
        exact("/pack_size", "50"),
        exact("/clarification_source", "message:evt_voice_001"),
      ],
    ),
    toolTest(
      "VN-03",
      "summary tool call",
      [turn(
        "user",
        "Which cost hurt my margin the most this week, and how much did it add to one pack?",
        1,
      )],
      toolIds.get_daily_summary,
      [],
    ),
    responseTest(
      "VN-03",
      "explanation response",
      toolExchange({
        userMessage: "Which cost hurt my margin the most this week, and how much did it add to one pack?",
        toolName: "get_daily_summary",
        params: {},
        result: dailySummary,
      }),
      "The response is in English and names eggs as the largest driver at +RM0.10 per pack, followed by oil/sambal +RM0.08, coconut milk +RM0.06, and packaging +RM0.04. It does not calculate or introduce any other merchant-specific number.",
    ),
    toolTest(
      "VN-04",
      "simulation tool call",
      [turn("user", "如果我明天卖五块五，但是只卖三十五包，我的毛利还有多少？", 1)],
      toolIds.simulate_price,
      [
        exact("/product_id", "p_nlb_001"),
        exact("/quantity", "35"),
        exact("/proposed_unit_price_rm", "5.50"),
      ],
    ),
    responseTest(
      "VN-04",
      "Mandarin response",
      toolExchange({
        userMessage: "如果我明天卖五块五，但是只卖三十五包，我的毛利还有多少？",
        toolName: "simulate_price",
        params: {
          merchant_id: "m_kak_lina_001",
          product_id: "p_nlb_001",
          quantity: "35",
          proposed_unit_price_rm: "5.50",
          as_of: "2026-07-13",
        },
        result: priceScenario,
      }),
      "The response is concise Simplified Mandarin and states RM192.50 revenue, RM81.20 gross profit, and 42.18% gross margin. It states the constant-demand/current-unit-cost assumption and does not claim a ledger mutation.",
    ),
    toolTest(
      "VN-05",
      "Malay append-only sales correction",
      [
        turn("agent", "Jualan 40 bungkus pada RM5 sudah direkod sebagai evt-sales-vn01.", 1),
        turn(
          "user",
          "Yang tadi saya tersalah cakap. Bukan empat puluh bungkus, sebenarnya tiga puluh lapan.",
          2,
        ),
      ],
      toolIds.record_correction,
      [
        exact("/target_event_id", "evt-sales-vn01"),
        exact("/replacement_payload/changes/0/kind", "decimal"),
        exact("/replacement_payload/changes/0/field", "quantity"),
        exact("/replacement_payload/changes/0/corrected_value", "38"),
      ],
    ),
    toolTest(
      "VN-06",
      "summary tool call",
      [turn("user", "现在请用中文回答。今天为什么利润率下降？", 1)],
      toolIds.get_daily_summary,
      [],
    ),
    responseTest(
      "VN-06",
      "Mandarin response with retained merchant context",
      toolExchange({
        userMessage: "现在请用中文回答。今天为什么利润率下降？",
        toolName: "get_daily_summary",
        params: {},
        result: dailySummary,
      }),
      "The agent calls the configured language_detection system tool for zh before answering. The response is in Simplified Chinese or Mandarin, explains the gross-margin decline using only the supplied summary and cost drivers, and retains the same merchant context after the language switch.",
    ),
    toolTest(
      "VN-07",
      "summary tool call",
      [turn("user", "Switch back to English. What price keeps a forty percent gross margin?", 1)],
      toolIds.get_daily_summary,
      [],
    ),
    responseTest(
      "VN-07",
      "English response and price floor",
      toolExchange({
        userMessage: "Switch back to English. What price keeps a forty percent gross margin?",
        toolName: "get_daily_summary",
        params: {},
        result: {
          ...dailySummary,
        },
      }),
      "The agent calls the configured language_detection system tool for en before answering. The response switches back to English, states RM5.30 as the mathematical price that preserves a 40% gross margin, and clearly states the current-cost and demand assumptions without presenting it as a certain recommendation.",
    ),
    responseTest(
      "VN-08",
      "Malay incomplete-overhead guardrail",
      [turn(
        "user",
        "Hari ni helper saya datang kerja, tapi saya lupa berapa upah dia. Boleh kira untung bersih?",
        1,
      )],
      "The response is in Malay and says gross profit may be calculated but net profit cannot be calculated without the helper wage and other overheads. It must not invent wages, net profit, or take-home earnings.",
    ),
  ];
}

export { dailySummary, priceScenario };
