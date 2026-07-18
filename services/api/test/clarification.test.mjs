import assert from "node:assert/strict";
import { test } from "node:test";

import {
  InMemoryLedgerStore,
  createPasarAiService,
} from "../src/backend/index.js";

function productProfile() {
  return {
    merchantId: "m_kak_lina_001",
    productId: "p_nlb_001",
    baselineUnitCogsRm: "2.90",
    currentUnitCogsRm: "3.14",
    components: [
      { componentId: "c_rice", name: "Beras", baselineCostRm: "0.38", currentCostRm: "0.38" },
      { componentId: "c_coconut", name: "Santan", baselineCostRm: "0.55", currentCostRm: "0.61" },
      { componentId: "c_egg", name: "Telur", baselineCostRm: "0.45", currentCostRm: "0.55" },
      {
        componentId: "c_anchovy",
        name: "Ikan Bilis",
        baselineCostRm: "0.38",
        currentCostRm: "0.38",
      },
      {
        componentId: "c_peanut",
        name: "Kacang Tanah",
        baselineCostRm: "0.15",
        currentCostRm: "0.15",
      },
      {
        componentId: "c_sambal",
        name: "Sambal + Minyak",
        baselineCostRm: "0.47",
        currentCostRm: "0.55",
      },
      {
        componentId: "c_cucumber",
        name: "Timun",
        baselineCostRm: "0.11",
        currentCostRm: "0.11",
      },
      {
        componentId: "c_packaging",
        name: "Bekas Makanan",
        baselineCostRm: "0.16",
        currentCostRm: "0.16",
        usagePerProductUnit: "1",
      },
      {
        componentId: "c_fuel",
        name: "Gas + Condiments",
        baselineCostRm: "0.25",
        currentCostRm: "0.25",
      },
    ],
  };
}

test("TM-03 mutates no ledger facts and TM-04 resolves the packaging increase once", async () => {
  const ids = ["evt_sales_001", "clarification_001", "evt_cost_001"];
  const service = createPasarAiService({
    store: new InMemoryLedgerStore({ productProfiles: [productProfile()] }),
    idFactory: () => ids.shift(),
  });
  await service.recordSale(
    {
      merchant_id: "m_kak_lina_001",
      occurred_at: "2026-07-12T14:30:00+08:00",
      source: "telegram_text",
      source_language: "ms",
      lines: [
        {
          product_id: "p_nlb_001",
          quantity: "40",
          unit_price_rm: "5.00",
        },
      ],
      evidence: { external_message_id: "tm_sales_001" },
    },
    { idempotencyKey: "sales-key-001" },
  );

  const pending = await service.recordAmbiguousCostIncrease(
    {
      merchantId: "m_kak_lina_001",
      occurredAt: "2026-07-12T14:31:00+08:00",
      componentId: "c_packaging",
      increaseRm: "2.00",
      evidence: {
        transcript: "Packaging naik RM2.",
        external_message_id: "tm_03",
      },
    },
    { idempotencyKey: "tm-03-key" },
  );
  assert.deepEqual(pending, {
    state: "clarification_required",
    clarification_source: "message:tm_03",
    clarifications: [
      {
        field: "pack_size",
        question: "Bekas Makanan increase RM2.00 applies to how many base units?",
        options: ["50", "100", "other"],
      },
    ],
  });
  assert.equal(
    (await service.getDailySummary({
      merchantId: "m_kak_lina_001",
      date: "2026-07-12",
    })).cogs_rm,
    "125.60",
  );

  const resolved = await service.resolveCostClarification(
    {
      sourceEventId: "tm_03",
      packSize: "50",
      evidence: {
        transcript: "RM2 extra per bundle of 50 containers.",
        external_message_id: "tm_04",
      },
    },
    { idempotencyKey: "tm-04-key" },
  );
  const replay = await service.resolveCostClarification(
    {
      sourceEventId: "tm_03",
      packSize: "50",
      evidence: {
        transcript: "RM2 extra per bundle of 50 containers.",
        external_message_id: "tm_04",
      },
    },
    { idempotencyKey: "tm-04-key" },
  );

  assert.deepEqual(resolved, {
    state: "committed",
    event_id: "evt_cost_001",
    before_value_rm: "0.16",
    after_value_rm: "0.20",
  });
  assert.deepEqual(replay, resolved);
  assert.equal(
    (await service.getDailySummary({
      merchantId: "m_kak_lina_001",
      date: "2026-07-12",
    })).cogs_rm,
    "127.20",
  );
});
