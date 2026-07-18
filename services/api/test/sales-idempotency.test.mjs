import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  InMemoryLedgerStore,
  createPasarAiService,
} from "../src/backend/index.js";

const salesFixture = JSON.parse(
  await readFile(
    new URL("../../../fixtures/contracts/v1/valid/sales-request.json", import.meta.url),
    "utf8",
  ),
).payload;

test("duplicate sales idempotency returns the original result without double-counting", async () => {
  const store = new InMemoryLedgerStore({
    productProfiles: [
      {
        merchantId: "m_kak_lina_001",
        productId: "p_nlb_001",
        baselineUnitCogsRm: "2.90",
        currentUnitCogsRm: "3.18",
        components: [
          { componentId: "c_egg", name: "Telur", baselineCostRm: "0.45", currentCostRm: "0.55" },
          {
            componentId: "c_sambal",
            name: "Sambal + Minyak",
            baselineCostRm: "0.47",
            currentCostRm: "0.55",
          },
          {
            componentId: "c_coconut",
            name: "Santan",
            baselineCostRm: "0.55",
            currentCostRm: "0.61",
          },
          {
            componentId: "c_packaging",
            name: "Bekas Makanan",
            baselineCostRm: "0.16",
            currentCostRm: "0.20",
          },
        ],
      },
    ],
  });
  const service = createPasarAiService({
    store,
    idFactory: () => "evt_sales_001",
  });

  const first = await service.recordSale(salesFixture, {
    idempotencyKey: "sales-key-001",
  });
  const duplicate = await service.recordSale(salesFixture, {
    idempotencyKey: "sales-key-001",
  });

  assert.deepEqual(first, { state: "committed", event_id: "evt_sales_001" });
  assert.deepEqual(duplicate, first);
  assert.deepEqual(
    await service.getDailySummary({
      merchantId: "m_kak_lina_001",
      date: "2026-07-12",
    }),
    {
      merchant_id: "m_kak_lina_001",
      date: "2026-07-12",
      revenue_rm: "200.00",
      cogs_rm: "127.20",
      gross_profit_rm: "72.80",
      gross_margin_pct: "36.40",
      data_completeness: {
        state: "complete",
        missing_inputs: [],
      },
      top_cost_drivers: [],
      baseline_comparison: {
        baseline_margin_pct: "36.40",
        margin_change_percentage_points: "0.00",
      },
      price_floor: {
        target_gross_margin_pct: "40.00",
        price_floor_rm: "5.30",
        assumption: "current_unit_cogs",
      },
      cost_stack: {
        baseline_comparison_date: "2026-07-11",
        baseline_effective_date: "2026-07-11",
        baseline_unit_cogs_rm: "3.18",
        current_unit_cogs_rm: "3.18",
        components: [
          {
            component_id: "c_egg",
            name: "Telur",
            baseline_cost_rm_per_pack: "0.55",
            current_cost_rm_per_pack: "0.55",
            change_rm_per_pack: "0.00",
            evidence_id: null,
          },
          {
            component_id: "c_sambal",
            name: "Sambal + Minyak",
            baseline_cost_rm_per_pack: "0.55",
            current_cost_rm_per_pack: "0.55",
            change_rm_per_pack: "0.00",
            evidence_id: null,
          },
          {
            component_id: "c_coconut",
            name: "Santan",
            baseline_cost_rm_per_pack: "0.61",
            current_cost_rm_per_pack: "0.61",
            change_rm_per_pack: "0.00",
            evidence_id: null,
          },
          {
            component_id: "c_packaging",
            name: "Bekas Makanan",
            baseline_cost_rm_per_pack: "0.20",
            current_cost_rm_per_pack: "0.20",
            change_rm_per_pack: "0.00",
            evidence_id: null,
          },
        ],
      },
      evidence: [],
      assumptions: [
        "Costs compare the latest known recipe state on the selected date with the previous calendar day.",
        "Gross profit excludes operating expenses.",
      ],
    },
  );
});
