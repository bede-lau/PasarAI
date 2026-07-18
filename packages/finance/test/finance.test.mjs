import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  calculatePurchasedContribution,
  calculatePriceFloor,
  calculatePriceSimulation,
  calculateSaleMetrics,
} from "../src/index.js";

const expected = JSON.parse(
  await readFile(
    new URL("../../../fixtures/synthetic/seed_data/expected_metrics.json", import.meta.url),
    "utf8",
  ),
);

test("golden sale metrics use decimal arithmetic at output boundaries", () => {
  assert.deepEqual(
    calculateSaleMetrics({
      quantity: "40",
      unitPriceRm: "5.00",
      unitCogsRm: "3.18",
    }),
    {
      revenueRm: expected.today.revenue_rm.toFixed(2),
      cogsRm: expected.today.cogs_rm.toFixed(2),
      grossProfitRm: expected.today.gross_profit_rm.toFixed(2),
      grossMarginPct: expected.today.gross_margin_pct.toFixed(2),
    },
  );

  assert.equal(
    calculatePriceFloor({
      unitCogsRm: "3.18",
      targetGrossMarginPct: "40",
    }),
    expected.price_floor_for_40pct_margin_rm.toFixed(2),
  );
});

test("35 packs at RM5.50 matches the contracted read-only scenario", () => {
  assert.deepEqual(
    calculatePriceSimulation({
      quantity: "35",
      proposedUnitPriceRm: "5.50",
      unitCogsRm: "3.18",
      comparisonGrossProfitRm: "72.80",
    }),
    {
      revenue_rm: expected.scenario_35_at_5_50.revenue_rm.toFixed(2),
      cogs_rm: expected.scenario_35_at_5_50.cogs_rm.toFixed(2),
      gross_profit_rm: expected.scenario_35_at_5_50.gross_profit_rm.toFixed(2),
      gross_margin_pct: expected.scenario_35_at_5_50.gross_margin_pct.toFixed(2),
      incremental_gross_profit_vs_today_rm:
        expected.scenario_35_at_5_50.incremental_gross_profit_vs_today_rm.toFixed(2),
      assumption: "constant_demand",
    },
  );
});

test("purchase contribution retains precision until a public output boundary", () => {
  const result = calculatePurchasedContribution({
    purchaseQuantity: "1",
    packSize: "3",
    totalPriceRm: "1.00",
    usagePerProductUnit: "1",
  });

  assert.match(result.contributionRm, /^0\.333333/);
  assert.notEqual(result.contributionRm, "0.33");
});
