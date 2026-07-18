import assert from "node:assert/strict";
import { test } from "node:test";

import {
  InMemoryLedgerStore,
  createPasarAiService,
} from "../src/backend/index.js";

function sale({
  merchantId = "m_001",
  productId = "p_001",
  quantity = "40",
  unitPriceRm = "5.00",
  occurredAt = "2026-07-12T10:00:00+08:00",
  sourceEventId = "sale_source_001",
} = {}) {
  return {
    merchant_id: merchantId,
    occurred_at: occurredAt,
    source: "api",
    source_language: "en",
    lines: [{
      product_id: productId,
      quantity,
      unit_price_rm: unitPriceRm,
    }],
    evidence: { source_event_id: sourceEventId },
  };
}

function profile({
  merchantId = "m_001",
  productId = "p_001",
  baseline = "2.90",
  current = "3.18",
  effectiveAt,
  components = [],
} = {}) {
  return {
    merchantId,
    productId,
    baselineUnitCogsRm: baseline,
    currentUnitCogsRm: current,
    effectiveAt,
    components,
  };
}

test("idempotency is atomic, canonical and scoped by merchant and endpoint", async () => {
  let nextId = 1;
  const service = createPasarAiService({
    store: new InMemoryLedgerStore({ productProfiles: [profile()] }),
    idFactory: (kind) => `evt_${kind}_${nextId++}`,
  });
  const request = sale();
  const reordered = {
    evidence: request.evidence,
    lines: request.lines,
    source_language: request.source_language,
    source: request.source,
    occurred_at: request.occurred_at,
    merchant_id: request.merchant_id,
  };

  const [first, concurrent] = await Promise.all([
    service.recordSale(request, { idempotencyKey: "shared-key" }),
    service.recordSale(reordered, { idempotencyKey: "shared-key" }),
  ]);
  assert.deepEqual(concurrent, first);

  const correction = await service.recordCorrection({
    merchant_id: "m_001",
    target_event_id: first.event_id,
    occurred_at: "2026-07-12T11:00:00+08:00",
    reason: "Correct quantity.",
    replacement_payload: {
      changes: [{
        kind: "decimal",
        field: "quantity",
        previous_value: "40",
        corrected_value: "38",
      }],
    },
    evidence: { source_event_id: "correction_source_001" },
  }, { idempotencyKey: "shared-key" });
  assert.equal(correction.state, "committed");

  let scopedId = 1;
  const scopedService = createPasarAiService({
    store: new InMemoryLedgerStore({
      productProfiles: [
        profile(),
        profile({ merchantId: "m_002", productId: "p_002" }),
      ],
    }),
    idFactory: (kind) => `scoped_${kind}_${scopedId++}`,
  });
  const firstMerchant = await scopedService.recordSale(sale({
    sourceEventId: "shared_source",
  }), { idempotencyKey: "merchant-shared-key" });
  const secondMerchant = await scopedService.recordSale(sale({
    merchantId: "m_002",
    productId: "p_002",
    sourceEventId: "shared_source",
  }), { idempotencyKey: "merchant-shared-key" });
  assert.equal(firstMerchant.state, "committed");
  assert.equal(secondMerchant.state, "committed");
  assert.notEqual(firstMerchant.event_id, secondMerchant.event_id);
});

test("merchant calendar dates survive UTC-normalized clarification timestamps", async () => {
  const store = new InMemoryLedgerStore({
    merchantTimeZones: { m_001: "Asia/Kuala_Lumpur" },
  });
  assert.equal(
    await store.getMerchantCalendarDate(
      "m_001",
      "2026-07-11T16:30:00.000Z",
    ),
    "2026-07-12",
  );
});

test("corrections reject cross-merchant, stale and unsupported changes", async () => {
  let nextId = 1;
  const service = createPasarAiService({
    store: new InMemoryLedgerStore({ productProfiles: [profile()] }),
    idFactory: (kind) => `evt_${kind}_${nextId++}`,
  });
  const committed = await service.recordSale(sale(), {
    idempotencyKey: "sale-key",
  });

  const crossMerchant = await service.recordCorrection({
    merchant_id: "m_002",
    target_event_id: committed.event_id,
    occurred_at: "2026-07-12T11:00:00+08:00",
    reason: "Invalid merchant.",
    replacement_payload: {
      changes: [{
        kind: "decimal",
        field: "quantity",
        previous_value: "40",
        corrected_value: "38",
      }],
    },
    evidence: { source_event_id: "correction_cross" },
  }, { idempotencyKey: "correction-cross-key" });
  assert.equal(crossMerchant.state, "rejected");

  const valid = await service.recordCorrection({
    merchant_id: "m_001",
    target_event_id: committed.event_id,
    occurred_at: "2026-07-12T11:01:00+08:00",
    reason: "Correct quantity.",
    replacement_payload: {
      changes: [{
        kind: "decimal",
        field: "quantity",
        previous_value: "40",
        corrected_value: "38",
      }],
    },
    evidence: { source_event_id: "correction_valid" },
  }, { idempotencyKey: "correction-valid-key" });
  assert.equal(valid.state, "committed");

  const stale = await service.recordCorrection({
    merchant_id: "m_001",
    target_event_id: committed.event_id,
    occurred_at: "2026-07-12T11:02:00+08:00",
    reason: "Stale correction.",
    replacement_payload: {
      changes: [{
        kind: "decimal",
        field: "quantity",
        previous_value: "40",
        corrected_value: "35",
      }],
    },
    evidence: { source_event_id: "correction_stale" },
  }, { idempotencyKey: "correction-stale-key" });
  assert.equal(stale.state, "rejected");

  const unsupported = await service.recordCorrection({
    merchant_id: "m_001",
    target_event_id: committed.event_id,
    occurred_at: "2026-07-12T11:03:00+08:00",
    reason: "Unsupported field.",
    replacement_payload: {
      changes: [{
        kind: "decimal",
        field: "pack_size",
        previous_value: null,
        corrected_value: "50",
      }],
    },
    evidence: { source_event_id: "correction_unsupported" },
  }, { idempotencyKey: "correction-unsupported-key" });
  assert.equal(unsupported.state, "rejected");

  const equivalentPrevious = await service.recordCorrection({
    merchant_id: "m_001",
    target_event_id: committed.event_id,
    occurred_at: "2026-07-12T11:04:00+08:00",
    reason: "Equivalent decimal representation.",
    replacement_payload: {
      changes: [{
        kind: "decimal",
        field: "quantity",
        previous_value: "38.0",
        corrected_value: "37",
      }],
    },
    evidence: { source_event_id: "correction_equivalent" },
  }, { idempotencyKey: "correction-equivalent-key" });
  assert.equal(equivalentPrevious.state, "committed");

  const numericNoOp = await service.recordCorrection({
    merchant_id: "m_001",
    target_event_id: committed.event_id,
    occurred_at: "2026-07-12T11:05:00+08:00",
    reason: "Numeric no-op.",
    replacement_payload: {
      changes: [{
        kind: "decimal",
        field: "quantity",
        previous_value: "37",
        corrected_value: "37.0",
      }],
    },
    evidence: { source_event_id: "correction_noop" },
  }, { idempotencyKey: "correction-noop-key" });
  assert.equal(numericNoOp.state, "rejected");
});

test("multi-line corrections require and honor an explicit line index", async () => {
  let nextId = 1;
  const store = new InMemoryLedgerStore({
    productProfiles: [
      profile(),
      profile({ productId: "p_002", baseline: "1.00", current: "1.00" }),
    ],
  });
  const service = createPasarAiService({
    store,
    idFactory: (kind) => `evt_${kind}_${nextId++}`,
  });
  const committed = await service.recordSale({
    ...sale(),
    lines: [
      {
        product_id: "p_001",
        quantity: "40",
        unit_price_rm: "5.00",
      },
      {
        product_id: "p_002",
        quantity: "10",
        unit_price_rm: "2.00",
      },
    ],
  }, { idempotencyKey: "multi-line-sale-key" });

  const correctionRequest = {
    merchant_id: "m_001",
    target_event_id: committed.event_id,
    occurred_at: "2026-07-12T11:00:00+08:00",
    reason: "Correct the second product quantity.",
    replacement_payload: {
      changes: [{
        kind: "decimal",
        field: "quantity",
        previous_value: "10",
        corrected_value: "8",
      }],
    },
    evidence: { source_event_id: "multi_line_correction" },
  };
  const ambiguous = await service.recordCorrection(
    correctionRequest,
    { idempotencyKey: "multi-line-ambiguous-key" },
  );
  assert.equal(ambiguous.state, "rejected");
  assert.match(
    ambiguous.errors[0].message,
    /requires line_index/i,
  );

  const corrected = await service.recordCorrection({
    ...correctionRequest,
    replacement_payload: {
      changes: [{
        ...correctionRequest.replacement_payload.changes[0],
        line_index: 1,
      }],
    },
    evidence: { source_event_id: "multi_line_correction_indexed" },
  }, { idempotencyKey: "multi-line-indexed-key" });
  assert.equal(corrected.state, "committed");
  assert.equal(corrected.changes[0].line_index, 1);
  assert.equal(
    (await service.getDailySummary({
      merchantId: "m_001",
      date: "2026-07-12",
    })).revenue_rm,
    "216.00",
  );
});

test("known revenue survives missing cost profiles", async () => {
  const service = createPasarAiService({
    store: new InMemoryLedgerStore(),
    idFactory: () => "evt_sale_001",
  });
  await service.recordSale(sale({
    quantity: "10",
    sourceEventId: "missing_profile_sale",
  }), { idempotencyKey: "missing-profile-key" });

  const summary = await service.getDailySummary({
    merchantId: "m_001",
    date: "2026-07-12",
  });
  assert.equal(summary.revenue_rm, "50.00");
  assert.equal(summary.gross_profit_rm, "0.00");
  assert.equal(summary.data_completeness.state, "partial");
});

test("cost snapshots preserve historical summaries and deduplicate receipt IDs", async () => {
  let nextId = 1;
  const store = new InMemoryLedgerStore({
    productProfiles: [profile({
      current: "2.90",
      effectiveAt: "2026-07-01T00:00:00+08:00",
      components: [
        {
          componentId: "c_other",
          name: "Other",
          baselineCostRm: "2.80",
          currentCostRm: "2.80",
        },
        {
          componentId: "c_packaging",
          name: "Packaging",
          baselineCostRm: "0.10",
          currentCostRm: "0.10",
          usagePerProductUnit: "1",
        },
      ],
    })],
  });
  const service = createPasarAiService({
    store,
    idFactory: (kind) => `evt_${kind}_${nextId++}`,
  });
  await service.recordSale(sale({
    quantity: "10",
    occurredAt: "2026-07-11T10:00:00+08:00",
    sourceEventId: "historical_sale",
  }), { idempotencyKey: "historical-sale-key" });

  const costRequest = {
    merchant_id: "m_001",
    occurred_at: "2026-07-12T08:00:00+08:00",
    supplier_name: "Pack Supplier",
    lines: [{
      component_id: "c_packaging",
      quantity: "1",
      uom: "bundle",
      pack_size: "10",
      total_price_rm: "2.00",
      confidence: "0.99",
    }],
    evidence: { receipt_id: "receipt_001" },
  };
  const first = await service.recordCost(costRequest, {
    idempotencyKey: "receipt-key-1",
  });
  const duplicate = await service.recordCost(costRequest, {
    idempotencyKey: "receipt-key-2",
  });
  assert.deepEqual(duplicate, first);

  const historical = await service.getDailySummary({
    merchantId: "m_001",
    date: "2026-07-11",
  });
  assert.equal(historical.cogs_rm, "29.00");
});

test("daily summaries compare selected-day costs with the previous calendar day", async () => {
  const store = new InMemoryLedgerStore({
    productProfiles: [profile({
      current: "2.90",
      effectiveAt: "2026-07-11T00:00:00+08:00",
      components: [
        {
          componentId: "c_other",
          name: "Other",
          baselineCostRm: "2.80",
          currentCostRm: "2.80",
        },
        {
          componentId: "c_packaging",
          name: "Packaging",
          baselineCostRm: "0.10",
          currentCostRm: "0.10",
        },
      ],
    })],
  });
  const currentProfile = store.getProductProfile("p_001", {
    asOfDate: "2026-07-11",
    merchantId: "m_001",
  });
  currentProfile.currentUnitCogsRm = "3.00";
  currentProfile.components.find(
    (component) => component.componentId === "c_packaging",
  ).currentCostRm = "0.20";
  store.saveProductProfile(currentProfile, {
    effectiveAt: "2026-07-12T08:00:00+08:00",
    changedComponentIds: ["c_packaging"],
  });

  const service = createPasarAiService({
    store,
    idFactory: () => "evt_day_over_day_sale",
  });
  await service.recordSale(sale({
    quantity: "10",
    occurredAt: "2026-07-12T10:00:00+08:00",
    sourceEventId: "day_over_day_sale",
  }), { idempotencyKey: "day-over-day-sale-key" });

  const summary = await service.getDailySummary({
    merchantId: "m_001",
    date: "2026-07-12",
  });

  assert.equal(summary.cost_stack.baseline_comparison_date, "2026-07-11");
  assert.equal(summary.cost_stack.baseline_unit_cogs_rm, "2.90");
  assert.equal(summary.cost_stack.current_unit_cogs_rm, "3.00");
  assert.equal(
    summary.cost_stack.components.find(
      (component) => component.component_id === "c_packaging",
    ).change_rm_per_pack,
    "0.10",
  );
  assert.deepEqual(summary.baseline_comparison, {
    baseline_margin_pct: "42.00",
    margin_change_percentage_points: "-2.00",
  });
});

test("zero and missing denominators create persisted clarification responses", async () => {
  let nextId = 1;
  const service = createPasarAiService({
    store: new InMemoryLedgerStore({
      productProfiles: [profile({
        current: "2.90",
        components: [{
          componentId: "c_packaging",
          name: "Packaging",
          baselineCostRm: "2.90",
          currentCostRm: "2.90",
        }],
      })],
    }),
    idFactory: (kind) => `evt_${kind}_${nextId++}`,
  });

  for (const [index, packSize] of [undefined, "0.00"].entries()) {
    const line = {
      component_id: "c_packaging",
      quantity: "1",
      uom: "bundle",
      total_price_rm: "2.00",
      confidence: "0.99",
    };
    if (packSize !== undefined) line.pack_size = packSize;
    const response = await service.recordCost({
      merchant_id: "m_001",
      occurred_at: "2026-07-12T08:00:00+08:00",
      supplier_name: "Pack Supplier",
      lines: [line],
      evidence: { external_message_id: `ambiguous_${index}` },
    }, { idempotencyKey: `ambiguous-key-${index}` });
    assert.equal(response.state, "clarification_required");
  }

  const confirmedRequest = {
    merchant_id: "m_001",
    occurred_at: "2026-07-12T08:01:00+08:00",
    supplier_name: "Pack Supplier",
    lines: [{
      component_id: "c_packaging",
      quantity: "1",
      uom: "bundle",
      pack_size: "10",
      total_price_rm: "2.00",
      confidence: "0.99",
    }],
    evidence: {
      external_message_id: "confirmed_0",
      source_event_id: "ambiguous_0",
    },
  };
  const resolved = await service.recordCost(confirmedRequest, {
    idempotencyKey: "confirmed-key-1",
  });
  const replay = await service.recordCost(confirmedRequest, {
    idempotencyKey: "confirmed-key-2",
  });
  assert.equal(resolved.state, "committed");
  assert.deepEqual(replay, resolved);

  const zeroQuantity = await service.recordCost({
    merchant_id: "m_001",
    occurred_at: "2026-07-12T08:02:00+08:00",
    supplier_name: "Pack Supplier",
    lines: [{
      component_id: "c_packaging",
      quantity: "0.00",
      uom: "bundle",
      pack_size: "10",
      total_price_rm: "2.00",
      confidence: "0.99",
    }],
    evidence: { external_message_id: "zero_quantity" },
  }, { idempotencyKey: "zero-quantity-key" });
  assert.equal(zeroQuantity.clarifications[0].field, "lines[0].quantity");

  const identityMissing = await service.recordCost({
    merchant_id: "m_001",
    occurred_at: "2026-07-12T08:03:00+08:00",
    supplier_name: "Pack Supplier",
    lines: [{
      component_id: "c_packaging",
      quantity: "1",
      uom: "bundle",
      pack_size: "0",
      total_price_rm: "2.00",
      confidence: "0.99",
    }],
    evidence: { transcript: "Pack size unclear." },
  }, { idempotencyKey: "identity-missing-key" });
  assert.equal(identityMissing.state, "rejected");
});

test("simulation compares against the selected product rather than the portfolio", async () => {
  let nextId = 1;
  const service = createPasarAiService({
    store: new InMemoryLedgerStore({
      productProfiles: [
        profile(),
        profile({
          productId: "p_002",
          baseline: "1.00",
          current: "1.00",
        }),
      ],
    }),
    idFactory: (kind) => `evt_${kind}_${nextId++}`,
  });
  await service.recordSale({
    ...sale(),
    lines: [
      {
        product_id: "p_001",
        quantity: "40",
        unit_price_rm: "5.00",
      },
      {
        product_id: "p_002",
        quantity: "100",
        unit_price_rm: "2.00",
      },
    ],
  }, { idempotencyKey: "portfolio-sale-key" });

  const simulation = await service.simulatePrice({
    merchant_id: "m_001",
    product_id: "p_001",
    quantity: "35",
    proposed_unit_price_rm: "5.50",
    as_of: "2026-07-12",
  });
  assert.equal(simulation.incremental_gross_profit_vs_today_rm, "8.40");
});

test("competing clarification answers commit once and enforce merchant ownership", async () => {
  let nextId = 1;
  const store = new InMemoryLedgerStore({
    productProfiles: [
      profile({
        merchantId: "m_001",
        components: [{
          componentId: "c_packaging",
          name: "Packaging",
          baselineCostRm: "3.18",
          currentCostRm: "3.18",
        }],
      }),
      profile({
        merchantId: "m_002",
        productId: "p_002",
        components: [{
          componentId: "c_packaging",
          name: "Packaging",
          baselineCostRm: "3.18",
          currentCostRm: "3.18",
        }],
      }),
    ],
  });
  const service = createPasarAiService({
    store,
    idFactory: (kind) => `evt_${kind}_${nextId++}`,
  });
  await service.recordCost({
    merchant_id: "m_001",
    occurred_at: "2026-07-12T08:00:00+08:00",
    supplier_name: "Pack Supplier",
    lines: [{
      component_id: "c_packaging",
      quantity: "1",
      uom: "bundle",
      pack_size: "0",
      total_price_rm: "2.00",
      confidence: "0.99",
    }],
    evidence: { external_message_id: "pending_answer" },
  }, { idempotencyKey: "pending-answer-key" });

  const answer = (merchantId, externalId, totalPriceRm) => ({
    merchant_id: merchantId,
    occurred_at: "2026-07-12T08:01:00+08:00",
    supplier_name: "Pack Supplier",
    lines: [{
      component_id: "c_packaging",
      quantity: "1",
      uom: "bundle",
      pack_size: "10",
      total_price_rm: totalPriceRm,
      confidence: "0.99",
    }],
    evidence: {
      external_message_id: externalId,
      source_event_id: "pending_answer",
    },
  });

  const wrongMerchant = await service.recordCost(
    answer("m_002", "wrong_merchant_answer", "2.00"),
    { idempotencyKey: "wrong-merchant-answer-key" },
  );
  assert.equal(wrongMerchant.state, "rejected");

  const results = await Promise.all([
    service.recordCost(
      answer("m_001", "answer_a", "2.00"),
      { idempotencyKey: "answer-a-key" },
    ),
    service.recordCost(
      answer("m_001", "answer_b", "3.00"),
      { idempotencyKey: "answer-b-key" },
    ),
  ]);
  assert.deepEqual(
    results.map((result) => result.state).sort(),
    ["committed", "rejected"],
  );
});

test("evidence deduplication is merchant-scoped", async () => {
  let nextId = 1;
  const service = createPasarAiService({
    store: new InMemoryLedgerStore({
      productProfiles: [
        profile({
          merchantId: "m_001",
          components: [{
            componentId: "c_packaging",
            name: "Packaging",
            baselineCostRm: "3.18",
            currentCostRm: "3.18",
          }],
        }),
        profile({
          merchantId: "m_002",
          productId: "p_002",
          components: [{
            componentId: "c_packaging",
            name: "Packaging",
            baselineCostRm: "3.18",
            currentCostRm: "3.18",
          }],
        }),
      ],
    }),
    idFactory: (kind) => `evt_${kind}_${nextId++}`,
  });
  const request = (merchantId) => ({
    merchant_id: merchantId,
    occurred_at: "2026-07-12T08:00:00+08:00",
    supplier_name: "Pack Supplier",
    lines: [{
      component_id: "c_packaging",
      quantity: "1",
      uom: "bundle",
      pack_size: "10",
      total_price_rm: "2.00",
      confidence: "0.99",
    }],
    evidence: { receipt_id: "shared_receipt_number" },
  });
  assert.equal(
    (await service.recordCost(request("m_001"), {
      idempotencyKey: "merchant-1-receipt",
    })).state,
    "committed",
  );
  assert.equal(
    (await service.recordCost(request("m_002"), {
      idempotencyKey: "merchant-2-receipt",
    })).state,
    "committed",
  );
});

test("backdated component changes propagate through unrelated later snapshots", async () => {
  let nextId = 1;
  const service = createPasarAiService({
    store: new InMemoryLedgerStore({
      productProfiles: [profile({
        baseline: "2.00",
        current: "2.00",
        effectiveAt: "2026-07-01T00:00:00+08:00",
        components: [
          {
            componentId: "c_a",
            name: "A",
            baselineCostRm: "1.00",
            currentCostRm: "1.00",
          },
          {
            componentId: "c_b",
            name: "B",
            baselineCostRm: "1.00",
            currentCostRm: "1.00",
          },
        ],
      })],
    }),
    idFactory: (kind) => `evt_${kind}_${nextId++}`,
  });
  const cost = (componentId, totalPriceRm, occurredAt, receiptId) => ({
    merchant_id: "m_001",
    occurred_at: occurredAt,
    supplier_name: "Supplier",
    lines: [{
      component_id: componentId,
      quantity: "1",
      uom: "unit",
      pack_size: "1",
      total_price_rm: totalPriceRm,
      confidence: "0.99",
    }],
    evidence: { receipt_id: receiptId },
  });
  await service.recordCost(
    cost("c_b", "2.00", "2026-07-12T08:00:00+08:00", "future_b"),
    { idempotencyKey: "future-b-key" },
  );
  await service.recordCost(
    cost("c_a", "2.00", "2026-07-11T08:00:00+08:00", "backdated_a"),
    { idempotencyKey: "backdated-a-key" },
  );
  await service.recordSale(sale({
    quantity: "1",
    occurredAt: "2026-07-12T12:00:00+08:00",
    sourceEventId: "snapshot_sale",
  }), { idempotencyKey: "snapshot-sale-key" });

  assert.equal(
    (await service.getDailySummary({
      merchantId: "m_001",
      date: "2026-07-12",
    })).cogs_rm,
    "4.00",
  );
});

test("clarifications are namespaced by evidence kind", async () => {
  let nextId = 1;
  const service = createPasarAiService({
    store: new InMemoryLedgerStore({
      productProfiles: [profile({
        components: [{
          componentId: "c_packaging",
          name: "Packaging",
          baselineCostRm: "3.18",
          currentCostRm: "3.18",
        }],
      })],
    }),
    idFactory: (kind) => `evt_${kind}_${nextId++}`,
  });
  const ambiguous = (evidence) => ({
    merchant_id: "m_001",
    occurred_at: "2026-07-12T08:00:00+08:00",
    supplier_name: "Pack Supplier",
    lines: [{
      component_id: "c_packaging",
      quantity: "1",
      uom: "bundle",
      pack_size: "0",
      total_price_rm: "2.00",
      confidence: "0.99",
    }],
    evidence,
  });
  assert.equal(
    (await service.recordCost(
      ambiguous({ external_message_id: "shared_id" }),
      { idempotencyKey: "message-pending-key" },
    )).state,
    "clarification_required",
  );
  assert.equal(
    (await service.recordCost(
      ambiguous({ receipt_id: "shared_id" }),
      { idempotencyKey: "receipt-pending-key" },
    )).state,
    "clarification_required",
  );

  const confirmed = (sourceEventId, externalMessageId) => ({
    merchant_id: "m_001",
    occurred_at: "2026-07-12T08:01:00+08:00",
    supplier_name: "Pack Supplier",
    lines: [{
      component_id: "c_packaging",
      quantity: "1",
      uom: "bundle",
      pack_size: "10",
      total_price_rm: "2.00",
      confidence: "0.99",
    }],
    evidence: {
      external_message_id: externalMessageId,
      source_event_id: sourceEventId,
    },
  });
  assert.equal(
    (await service.recordCost(
      confirmed("shared_id", "ambiguous_answer"),
      { idempotencyKey: "ambiguous-answer-key" },
    )).state,
    "rejected",
  );
  assert.equal(
    (await service.recordCost(
      confirmed("message:shared_id", "message_answer"),
      { idempotencyKey: "message-answer-key" },
    )).state,
    "committed",
  );
});
