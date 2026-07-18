import assert from "node:assert/strict";
import { test } from "node:test";

import {
  InMemoryLedgerStore,
  createPasarAiService,
} from "../src/backend/index.js";

const profile = {
  merchantId: "m_kak_lina_001",
  productId: "p_nlb_001",
  baselineUnitCogsRm: "2.90",
  currentUnitCogsRm: "3.18",
  components: [],
};

test("simulation is read-only and quantity correction preserves the source event", async () => {
  const ids = ["evt_sales_001", "evt_correction_001"];
  const service = createPasarAiService({
    store: new InMemoryLedgerStore({ productProfiles: [profile] }),
    idFactory: () => ids.shift(),
  });
  await service.recordSale(
    {
      merchant_id: "m_kak_lina_001",
      occurred_at: "2026-07-12T14:30:00+08:00",
      source: "voice_agent",
      source_language: "ms-en",
      lines: [
        {
          product_id: "p_nlb_001",
          quantity: "40",
          unit_price_rm: "5.00",
        },
      ],
      evidence: {
        transcript: "Hari ni habis forty bungkus nasi lemak biasa.",
        source_event_id: "evt_voice_001",
      },
    },
    { idempotencyKey: "sales-key-001" },
  );
  const beforeSimulation = await service.getDailySummary({
    merchantId: "m_kak_lina_001",
    date: "2026-07-12",
  });

  assert.deepEqual(
    await service.simulatePrice({
      merchant_id: "m_kak_lina_001",
      product_id: "p_nlb_001",
      quantity: "35",
      proposed_unit_price_rm: "5.50",
      as_of: "2026-07-12",
    }),
    {
      revenue_rm: "192.50",
      cogs_rm: "111.30",
      gross_profit_rm: "81.20",
      gross_margin_pct: "42.18",
      incremental_gross_profit_vs_today_rm: "8.40",
      assumption: "constant_demand",
    },
  );
  assert.deepEqual(
    await service.getDailySummary({
      merchantId: "m_kak_lina_001",
      date: "2026-07-12",
    }),
    beforeSimulation,
  );

  const correction = await service.recordCorrection(
    {
      merchant_id: "m_kak_lina_001",
      target_event_id: "evt_sales_001",
      occurred_at: "2026-07-12T14:35:00+08:00",
      reason: "The earlier quantity was 38, not 40.",
      replacement_payload: {
        changes: [
          {
            kind: "decimal",
            field: "quantity",
            previous_value: "40",
            corrected_value: "38",
          },
        ],
      },
      evidence: {
        transcript: "Bukan empat puluh bungkus, sebenarnya tiga puluh lapan.",
        source_event_id: "evt_voice_005",
      },
    },
    { idempotencyKey: "correction-key-001" },
  );
  const duplicate = await service.recordCorrection(
    {
      merchant_id: "m_kak_lina_001",
      target_event_id: "evt_sales_001",
      occurred_at: "2026-07-12T14:35:00+08:00",
      reason: "The earlier quantity was 38, not 40.",
      replacement_payload: {
        changes: [
          {
            kind: "decimal",
            field: "quantity",
            previous_value: "40",
            corrected_value: "38",
          },
        ],
      },
      evidence: {
        transcript: "Bukan empat puluh bungkus, sebenarnya tiga puluh lapan.",
        source_event_id: "evt_voice_005",
      },
    },
    { idempotencyKey: "correction-key-001" },
  );

  assert.deepEqual(correction, {
    state: "committed",
    correction_event_id: "evt_correction_001",
    target_event_id: "evt_sales_001",
    changes: [{
      field: "quantity",
      before_value: "40",
      after_value: "38",
    }],
  });
  assert.deepEqual(duplicate, correction);
  assert.equal(
    (await service.getEvent("evt_sales_001")).payload.lines[0].quantity,
    "40",
  );
  assert.deepEqual(
    await service.getDailySummary({
      merchantId: "m_kak_lina_001",
      date: "2026-07-12",
    }),
    {
      ...beforeSimulation,
      revenue_rm: "190.00",
      cogs_rm: "120.84",
      gross_profit_rm: "69.16",
      gross_margin_pct: "36.40",
    },
  );
});
