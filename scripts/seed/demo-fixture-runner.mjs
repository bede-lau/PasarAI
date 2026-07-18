import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { validateContract } from "@pasarai/contracts/v1";

import {
  createInMemoryEvidenceStore,
  createReceiptUploadIngestion,
} from "../../services/api/src/index.js";
import {
  InMemoryLedgerStore,
  allowMerchantForTests,
  createApiApp,
  createPasarAiService,
} from "../../services/api/src/backend/index.js";
import { buildConversationTests } from "../../packages/elevenlabs-agent/src/index.mjs";

const rootUrl = new URL("../../", import.meta.url);
const fixtureUrl = new URL("../../fixtures/", import.meta.url);

const [expectedMetrics, receiptTruth, evaluationMatrix] = await Promise.all([
  readFile(new URL("synthetic/seed_data/expected_metrics.json", fixtureUrl), "utf8")
    .then(JSON.parse),
  readFile(new URL("synthetic/seed_data/receipt_ground_truth.json", fixtureUrl), "utf8")
    .then(JSON.parse),
  readFile(new URL("qa/multilingual-evaluation-matrix.json", fixtureUrl), "utf8")
    .then(JSON.parse),
]);

const merchantId = "m_kak_lina_001";
const productId = "p_nlb_001";
const goldenDate = "2026-07-12";

function fixed(value) {
  return Number(value).toFixed(2);
}

function createIdFactory() {
  const counters = new Map();
  return (kind) => {
    const next = (counters.get(kind) ?? 0) + 1;
    counters.set(kind, next);
    return `${kind}-${String(next).padStart(3, "0")}`;
  };
}

function goldenProfile() {
  return {
    merchantId,
    productId,
    baselineUnitCogsRm: fixed(expectedMetrics.baseline_unit_cogs_rm),
    currentUnitCogsRm: fixed(expectedMetrics.baseline_unit_cogs_rm),
    targetGrossMarginPct: "40.00",
    timeZone: "Asia/Kuala_Lumpur",
    effectiveAt: "2026-07-01T00:00:00+08:00",
    components: [
      {
        componentId: "c_rice",
        name: "Beras",
        baselineCostRm: "0.38",
        currentCostRm: "0.38",
        usagePerProductUnit: "0.1000",
      },
      {
        componentId: "c_coconut",
        name: "Santan",
        baselineCostRm: "0.55",
        currentCostRm: "0.55",
        usagePerProductUnit:
          "0.03935483870967741935483870967741935483871",
      },
      {
        componentId: "c_egg",
        name: "Telur",
        baselineCostRm: "0.45",
        currentCostRm: "0.45",
        usagePerProductUnit: "1",
      },
      {
        componentId: "c_anchovy",
        name: "Ikan Bilis",
        baselineCostRm: "0.38",
        currentCostRm: "0.38",
        usagePerProductUnit: "0.0133",
      },
      {
        componentId: "c_peanut",
        name: "Kacang Tanah",
        baselineCostRm: "0.15",
        currentCostRm: "0.15",
        usagePerProductUnit: "0.0125",
      },
      {
        componentId: "c_sambal",
        name: "Sambal + Minyak",
        baselineCostRm: "0.47",
        currentCostRm: "0.47",
        usagePerProductUnit: "0.0859375",
      },
      {
        componentId: "c_cucumber",
        name: "Timun",
        baselineCostRm: "0.11",
        currentCostRm: "0.11",
        usagePerProductUnit: "0.0275",
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
        usagePerProductUnit: "0.0959",
      },
    ],
  };
}

function contractReceipt(receipt) {
  return {
    receipt_id: receipt.receipt_id,
    supplier_name: receipt.supplier_name,
    date: receipt.date,
    currency: receipt.currency,
    line_items: receipt.line_items.map((line) => ({
      raw_name: line.raw_name,
      normalized_component_id: line.normalized_component_id,
      quantity: String(line.quantity),
      uom: line.uom,
      pack_size: line.pack_size === null ? null : String(line.pack_size),
      unit_price_rm: fixed(line.unit_price_rm),
      total_price_rm: fixed(line.total_price_rm),
      confidence: "0.98",
    })),
    total_rm: fixed(receipt.total_rm),
    overall_confidence: "0.98",
    ambiguities: [],
  };
}

function expectedDailySummaryProjection() {
  return {
    revenue_rm: fixed(expectedMetrics.today.revenue_rm),
    cogs_rm: fixed(expectedMetrics.today.cogs_rm),
    gross_profit_rm: fixed(expectedMetrics.today.gross_profit_rm),
    gross_margin_pct: fixed(expectedMetrics.today.gross_margin_pct),
    baseline_margin_pct: fixed(expectedMetrics.today.baseline_margin_pct),
    margin_change_percentage_points:
      fixed(expectedMetrics.today.margin_change_percentage_points),
    price_floor_rm: fixed(expectedMetrics.price_floor_for_40pct_margin_rm),
  };
}

function actualDailySummaryProjection(summary) {
  return {
    revenue_rm: summary.revenue_rm,
    cogs_rm: summary.cogs_rm,
    gross_profit_rm: summary.gross_profit_rm,
    gross_margin_pct: summary.gross_margin_pct,
    baseline_margin_pct: summary.baseline_comparison.baseline_margin_pct,
    margin_change_percentage_points:
      summary.baseline_comparison.margin_change_percentage_points,
    price_floor_rm: summary.price_floor?.price_floor_rm,
  };
}

function expectedScenarioProjection() {
  const scenario = expectedMetrics.scenario_35_at_5_50;
  return {
    revenue_rm: fixed(scenario.revenue_rm),
    cogs_rm: fixed(scenario.cogs_rm),
    gross_profit_rm: fixed(scenario.gross_profit_rm),
    gross_margin_pct: fixed(scenario.gross_margin_pct),
    incremental_gross_profit_vs_today_rm:
      fixed(scenario.incremental_gross_profit_vs_today_rm),
    assumption: "constant_demand",
  };
}

function conversationCatalog() {
  const toolIds = Object.fromEntries([
    "record_sales",
    "record_cost",
    "record_cost_change",
    "simulate_price",
    "record_correction",
    "get_daily_summary",
  ].map((name) => [name, `qa-${name}`]));
  return buildConversationTests({ toolIds });
}

export async function runGoldenScenario({ runId = "golden-1" } = {}) {
  const store = new InMemoryLedgerStore({
    productProfiles: [goldenProfile()],
  });
  const service = createPasarAiService({
    store,
    idFactory: createIdFactory(),
  });
  const evidenceStore = createInMemoryEvidenceStore();
  const receipt = receiptTruth["receipt_001_sinar_borong.jpg"];
  const extraction = contractReceipt(receipt);
  const receiptImage = await readFile(new URL(
    "PasarAI_Handoff_Package/demo_data/receipts/receipt_001_sinar_borong.jpg",
    rootUrl,
  ));
  const receiptIngestion = createReceiptUploadIngestion({
    store,
    evidenceStore,
    idFactory: () => "receipt-upload-001",
    receiptExtractor: {
      async extract({ evidenceUri }) {
        assert.equal(
          evidenceUri,
          "memory://web/m_kak_lina_001/receipt-upload-001/receipt.jpg",
        );
        return extraction;
      },
    },
  });
  const uploadRequest = {
    merchant_id: merchantId,
    occurred_at: "2026-07-12T08:10:00+08:00",
    file_name: "receipt_001_sinar_borong.jpg",
    content_type: "image/jpeg",
    content_base64: receiptImage.toString("base64"),
  };

  const receiptUpload = await receiptIngestion.extract(uploadRequest, {
    idempotencyKey: `${runId}:receipt-upload`,
  });
  const duplicateReceiptUpload = await receiptIngestion.extract(uploadRequest, {
    idempotencyKey: `${runId}:receipt-upload`,
  });
  assert.equal(receiptUpload.state, "ready_for_review");
  assert.deepEqual(duplicateReceiptUpload, receiptUpload);

  const receiptConfirmationRequest = {
    merchant_id: merchantId,
    receipt_event_id: receiptUpload.event_id,
    occurred_at: "2026-07-12T08:12:00+08:00",
    extraction,
  };
  const receiptConfirmation = await service.confirmReceipt(
    receiptConfirmationRequest,
    { idempotencyKey: `${runId}:receipt-confirm-1` },
  );
  const duplicateReceiptConfirmation = await service.confirmReceipt(
    receiptConfirmationRequest,
    { idempotencyKey: `${runId}:receipt-confirm-2` },
  );
  assert.equal(receiptConfirmation.state, "committed");
  assert.deepEqual(duplicateReceiptConfirmation, receiptConfirmation);

  const saleRequest = {
    merchant_id: merchantId,
    occurred_at: "2026-07-12T14:30:00+08:00",
    source: "voice_agent",
    source_language: "ms-en",
    lines: [{
      product_id: productId,
      quantity: String(expectedMetrics.today.quantity),
      unit_price_rm: fixed(expectedMetrics.today.unit_price_rm),
    }],
    evidence: {
      transcript:
        "Hari ni habis forty bungkus nasi lemak biasa, semua five ringgit. Packaging cost naik two ringgit.",
      external_message_id: "evt_voice_001",
    },
  };
  const sale = await service.recordSale(saleRequest, {
    idempotencyKey: `${runId}:sale-1`,
  });
  const duplicateSale = await service.recordSale(saleRequest, {
    idempotencyKey: `${runId}:sale-2`,
  });
  assert.equal(sale.state, "committed");
  assert.deepEqual(duplicateSale, sale);
  assert.equal(store.listEvents({ type: "sale" }).length, 1);

  const eventsBeforeClarification = store.listEvents().length;
  const ambiguous = await service.recordAmbiguousCostIncrease({
    merchantId,
    occurredAt: "2026-07-12T14:30:00+08:00",
    componentId: "c_packaging",
    increaseRm: "2.00",
    evidence: saleRequest.evidence,
  }, {
    idempotencyKey: `${runId}:vn-01-ambiguous`,
  });
  assert.equal(ambiguous.state, "clarification_required");
  assert.equal(store.listEvents().length, eventsBeforeClarification);

  const beforeResolution = await service.getDailySummary({
    merchantId,
    date: goldenDate,
  });
  assert.equal(beforeResolution.cogs_rm, "125.60");

  const resolutionRequest = {
    merchantId,
    sourceEventId: ambiguous.clarification_source,
    packSize: "50",
    evidence: {
      transcript: "RM2 naik untuk satu pek 50 bekas, bukan setiap bekas.",
      external_message_id: "evt_clarify_001",
    },
  };
  const resolution = await service.resolveCostClarification(
    resolutionRequest,
    { idempotencyKey: `${runId}:vn-02-1` },
  );
  const duplicateResolution = await service.resolveCostClarification(
    resolutionRequest,
    { idempotencyKey: `${runId}:vn-02-2` },
  );
  assert.equal(resolution.state, "committed");
  assert.deepEqual(duplicateResolution, resolution);
  assert.equal(store.listEvents({ type: "cost" }).length, 2);

  const summary = await service.getDailySummary({
    merchantId,
    date: goldenDate,
  });
  assert.deepEqual(validateContract("daily-summary.response", summary), []);
  assert.deepEqual(
    actualDailySummaryProjection(summary),
    expectedDailySummaryProjection(),
  );
  assert.deepEqual(
    Object.fromEntries(summary.top_cost_drivers.map((driver) => [
      driver.name,
      driver.contribution_rm_per_pack,
    ])),
    Object.fromEntries(Object.entries(
      expectedMetrics.cost_driver_contributions_rm_per_pack,
    ).map(([name, value]) => [name, fixed(value)])),
  );
  assert.equal(
    summary.cost_stack?.baseline_unit_cogs_rm,
    fixed(expectedMetrics.baseline_unit_cogs_rm),
  );
  assert.equal(
    summary.cost_stack?.current_unit_cogs_rm,
    fixed(expectedMetrics.current_unit_cogs_rm),
  );

  const simulation = await service.simulatePrice({
    merchant_id: merchantId,
    product_id: productId,
    quantity: "35",
    proposed_unit_price_rm: "5.50",
    as_of: goldenDate,
  });
  assert.deepEqual(validateContract("price-simulation.response", simulation), []);
  assert.deepEqual(simulation, expectedScenarioProjection());

  const matrixCase = evaluationMatrix.cases.find(
    ({ fixture_id: fixtureId }) => fixtureId === "VN-04",
  );
  const conversationTest = conversationCatalog().find(
    ({ request }) => /VN-04 Mandarin response/i.test(request.name),
  );
  assert.ok(matrixCase);
  assert.ok(conversationTest);
  for (const token of ["RM192.50", "RM81.20", "42.18%"]) {
    assert.match(conversationTest.request.successCondition, new RegExp(
      token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    ));
  }
  assert.match(
    conversationTest.request.successCondition,
    /current-unit-cost assumption/i,
  );
  assert.ok(matrixCase.required_tokens.includes(
    `RM${summary.cost_stack.current_unit_cogs_rm}`,
  ));

  return {
    run_id: runId,
    status: "pass",
    synthetic: true,
    live_provider_used: false,
    contracts: {
      daily_summary: "pass",
      price_simulation: "pass",
    },
    flow: [
      "receipt_upload",
      "receipt_confirmation",
      "voice_sale",
      "clarification_required",
      "clarification_resolved",
      "dashboard_summary",
      "mandarin_simulation",
    ],
    duplicate_delivery: {
      receipt_upload_events: store.listEvents({ type: "receipt" }).length,
      sale_events: store.listEvents({ type: "sale" }).length,
      cost_events: store.listEvents({ type: "cost" }).length,
    },
    ambiguity: {
      events_before: eventsBeforeClarification,
      events_after: eventsBeforeClarification,
      cogs_before_resolution_rm: beforeResolution.cogs_rm,
    },
    dashboard: actualDailySummaryProjection(summary),
    mandarin_simulation: simulation,
    evidence_ids: summary.evidence.map(({ evidence_id: evidenceId }) => evidenceId),
  };
}

export async function runAmbiguityChecks() {
  const cases = evaluationMatrix.cases.filter(
    ({ mutation_expectation: expectation }) => expectation === "clarification_only",
  );
  const store = new InMemoryLedgerStore({
    productProfiles: [goldenProfile()],
  });
  const service = createPasarAiService({
    store,
    idFactory: createIdFactory(),
  });
  const responses = [];

  for (const fixture of cases) {
    const response = await service.recordAmbiguousCostIncrease({
      merchantId,
      occurredAt: "2026-07-12T14:30:00+08:00",
      componentId: "c_packaging",
      increaseRm: "2.00",
      evidence: {
        transcript: fixture.transcript,
        external_message_id: fixture.fixture_id.toLowerCase(),
      },
    }, {
      idempotencyKey: `ambiguity:${fixture.fixture_id}`,
    });
    assert.equal(response.state, "clarification_required");
    responses.push({
      fixture_id: fixture.fixture_id,
      state: response.state,
    });
  }

  const receipt = receiptTruth["receipt_003_pasar_pagi.jpg"];
  const extraction = {
    ...contractReceipt(receipt),
    overall_confidence: "0.72",
    line_items: contractReceipt(receipt).line_items.map((line) => ({
      ...line,
      confidence: "0.78",
    })),
    ambiguities: [{
      field: "line_items[2].quantity",
      question: "Please confirm the ikan bilis quantity and total.",
      options: ["1 kg, RM28.50", "Needs correction"],
    }],
  };
  const receiptIngestion = createReceiptUploadIngestion({
    store,
    evidenceStore: createInMemoryEvidenceStore(),
    idFactory: () => "receipt-ambiguous-003",
    receiptExtractor: {
      async extract() {
        return extraction;
      },
    },
  });
  const receiptImage = await readFile(new URL(
    "PasarAI_Handoff_Package/demo_data/receipts/receipt_003_pasar_pagi.jpg",
    rootUrl,
  ));
  const receiptReview = await receiptIngestion.extract({
    merchant_id: merchantId,
    occurred_at: "2026-07-12T09:00:00+08:00",
    file_name: "receipt_003_pasar_pagi.jpg",
    content_type: "image/jpeg",
    content_base64: receiptImage.toString("base64"),
  }, {
    idempotencyKey: "ambiguity:receipt-003",
  });
  assert.equal(receiptReview.state, "review_required");
  assert.equal(receiptReview.reason, "low_overall_confidence");
  responses.push({
    fixture_id: "receipt_003_pasar_pagi.jpg",
    state: receiptReview.state,
  });

  assert.equal(store.listEvents({ type: "cost" }).length, 0);
  assert.equal(
    (await store.getProductProfile(productId, { merchantId })).currentUnitCogsRm,
    fixed(expectedMetrics.baseline_unit_cogs_rm),
  );
  return {
    status: "pass",
    checked_fixtures: responses,
    mutation_events: 0,
    retained_evidence_events: store.listEvents({ type: "receipt" }).length,
  };
}

export async function runFailureModeChecks() {
  const store = new InMemoryLedgerStore({
    productProfiles: [goldenProfile()],
  });
  const evidenceStore = createInMemoryEvidenceStore();
  const receiptImage = await readFile(new URL(
    "PasarAI_Handoff_Package/demo_data/receipts/receipt_001_sinar_borong.jpg",
    rootUrl,
  ));
  const receiptIngestion = createReceiptUploadIngestion({
    store,
    evidenceStore,
    idFactory: () => "receipt-provider-failure",
    receiptExtractor: {
      async extract() {
        const error = new Error("provider timed out");
        error.name = "TimeoutError";
        throw error;
      },
    },
  });
  const providerFailure = await receiptIngestion.extract({
    merchant_id: merchantId,
    occurred_at: "2026-07-12T08:10:00+08:00",
    file_name: "receipt_001_sinar_borong.jpg",
    content_type: "image/jpeg",
    content_base64: receiptImage.toString("base64"),
  }, {
    idempotencyKey: "provider-failure",
  });
  assert.deepEqual(providerFailure, {
    state: "review_required",
    event_id: "receipt-provider-failure",
    evidence_uri:
      "memory://web/m_kak_lina_001/receipt-provider-failure/receipt.jpg",
    reason: "receipt_provider_unavailable",
  });
  assert.equal(evidenceStore.listEvidence().length, 1);

  const app = createApiApp({
    service: {},
    dependencies: {
      receipt_extractor: {
        async healthCheck() {
          return { status: "unavailable" };
        },
      },
      model_endpoint: {
        async healthCheck() {
          throw new Error("model unavailable");
        },
      },
    },
  });
  const health = await app.fetch(new Request("http://pasarai.test/healthz"));
  assert.equal(health.status, 503);
  const healthBody = await health.json();
  assert.deepEqual(healthBody, {
    status: "degraded",
    dependencies: {
      receipt_extractor: "unavailable",
      model_endpoint: "unavailable",
    },
  });

  return {
    status: "pass",
    provider_failure: providerFailure,
    health: healthBody,
  };
}

export async function runDuplicateDeliveryChecks() {
  const store = new InMemoryLedgerStore({
    productProfiles: [goldenProfile()],
  });
  const app = createApiApp({
    service: createPasarAiService({
      store,
      idFactory: () => "sale-conversation-001",
    }),
    authenticate: allowMerchantForTests(merchantId),
  });
  const payload = {
    merchant_id: merchantId,
    occurred_at: "2026-07-12T14:30:00+08:00",
    source: "voice_agent",
    source_language: "ms-en",
    lines: [{
      product_id: productId,
      quantity: "40",
      unit_price_rm: "5.00",
    }],
    evidence: {
      transcript:
        "Hari ni habis forty bungkus nasi lemak biasa, semua five ringgit.",
      external_message_id: "conversation-001:turn-001",
    },
  };
  const request = (idempotencyKey) => new Request(
    "http://pasarai.test/api/v1/sales",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify(payload),
    },
  );

  const [first, concurrentReplay] = await Promise.all([
    app.fetch(request("conversation-001:turn-001")),
    app.fetch(request("conversation-001:turn-001")),
  ]);
  const externalReplay = await app.fetch(
    request("conversation-001:turn-001:delivery-2"),
  );
  const bodies = await Promise.all([
    first.json(),
    concurrentReplay.json(),
    externalReplay.json(),
  ]);
  assert.deepEqual(bodies, [
    { state: "committed", event_id: "sale-conversation-001" },
    { state: "committed", event_id: "sale-conversation-001" },
    { state: "committed", event_id: "sale-conversation-001" },
  ]);
  assert.equal(store.listEvents({ type: "sale" }).length, 1);

  return {
    status: "pass",
    delivery_count: 3,
    sale_events: 1,
    response: bodies[0],
  };
}

export { evaluationMatrix, expectedMetrics };
