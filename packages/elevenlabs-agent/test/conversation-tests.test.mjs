import assert from "node:assert/strict";
import { test } from "node:test";

import { buildConversationTests } from "../src/index.mjs";

test("conversation test catalog covers VN-01 through VN-08 and critical outcomes", () => {
  const toolIds = {
    record_sales: "tool-record-sales",
    record_cost: "tool-record-cost",
    record_cost_change: "tool-record-cost-change",
    simulate_price: "tool-simulate-price",
    record_correction: "tool-record-correction",
    get_daily_summary: "tool-get-daily-summary",
  };
  const tests = buildConversationTests({ toolIds });
  const byName = (pattern) => tests.find(({ request }) => pattern.test(request.name));

  assert.deepEqual(
    [...new Set(tests.map(({ fixtureId }) => fixtureId))],
    ["VN-01", "VN-02", "VN-03", "VN-04", "VN-05", "VN-06", "VN-07", "VN-08"],
  );
  assert.equal(tests.length, 14);
  assert.equal(byName(/VN-01 sales tool/i).request.toolCallParameters.referencedTool.id, toolIds.record_sales);
  assert.match(byName(/VN-01 denominator response/i).request.successCondition, /pack|bundle|50|denominator/i);
  assert.match(byName(/VN-01 denominator response/i).request.successCondition, /not.*cost|does not.*cost/i);
  assert.equal(
    byName(/VN-01 persist packaging/i).request.toolCallParameters.referencedTool.id,
    toolIds.record_cost_change,
  );
  assert.equal(byName(/VN-02/i).request.type, "tool");
  assert.equal(
    byName(/VN-02/i).request.toolCallParameters.referencedTool.id,
    toolIds.record_cost_change,
  );
  assert.match(
    JSON.stringify(byName(/VN-02/i).request.chatHistory),
    /clarification_source.*message:evt_voice_001/,
  );
  assert.equal(byName(/VN-03 summary tool/i).request.toolCallParameters.referencedTool.id, toolIds.get_daily_summary);
  assert.match(byName(/VN-03 explanation/i).request.successCondition, /RM0\.10/);
  assert.equal(byName(/VN-04 simulation tool/i).request.toolCallParameters.referencedTool.id, toolIds.simulate_price);
  assert.match(byName(/VN-04 Mandarin response/i).request.successCondition, /RM81\.20/);
  assert.match(byName(/VN-04 Mandarin response/i).request.successCondition, /42\.18%/);
  assert.equal(
    byName(/VN-05/i).request.toolCallParameters.referencedTool.id,
    toolIds.record_correction,
  );
  assert.equal(byName(/VN-06 summary tool/i).request.toolCallParameters.referencedTool.id, toolIds.get_daily_summary);
  assert.match(byName(/VN-06 Mandarin response/i).request.successCondition, /Mandarin|Chinese/i);
  assert.match(
    byName(/VN-06 Mandarin response/i).request.successCondition,
    /language_detection.*zh/i,
  );
  assert.equal(byName(/VN-07 summary tool/i).request.toolCallParameters.referencedTool.id, toolIds.get_daily_summary);
  assert.match(byName(/VN-07 English response/i).request.successCondition, /RM5\.30/);
  assert.match(
    byName(/VN-07 English response/i).request.successCondition,
    /language_detection.*en/i,
  );
  assert.match(byName(/VN-08/i).request.successCondition, /cannot.*net profit|net profit.*cannot/i);
  assert.doesNotMatch(JSON.stringify(tests), /net profit[^"]*(?:is|=)\s*RM/i);
});
