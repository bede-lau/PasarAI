import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createInMemoryEvidenceStore,
  createReceiptUploadIngestion,
} from "../src/index.js";
import {
  InMemoryLedgerStore,
  createPasarAiService,
} from "../src/backend/index.js";

const merchantId = "m_kak_lina_001";

function productProfile({
  profileMerchantId = merchantId,
  productId = "p_nlb_001",
  currentUnitCogsRm = "0.16",
  evidence,
} = {}) {
  return {
    merchantId: profileMerchantId,
    productId,
    baselineUnitCogsRm: "0.16",
    currentUnitCogsRm,
    components: [{
      componentId: "c_packaging",
      name: "Bekas Makanan",
      baselineCostRm: "0.16",
      currentCostRm: currentUnitCogsRm,
      usagePerProductUnit: "1",
      ...(evidence ? { evidence } : {}),
    }],
  };
}

class TrackingStore extends InMemoryLedgerStore {
  idempotencyClaims = [];
  appendEventCalls = [];
  appendEventEndpointIds = [];
  appendCorrectionCalls = [];
  appendCorrectionEndpointIds = [];

  async runIdempotent(options) {
    assert.ok(options.merchantId, "Lakebase requires merchantId");
    this.idempotencyClaims.push({
      merchantId: options.merchantId,
      endpointId: options.endpointId,
      key: options.key,
    });
    return super.runIdempotent(options);
  }

  appendEvent(event) {
    this.appendEventCalls.push(event.type);
    this.appendEventEndpointIds.push(event.endpointId);
    return super.appendEvent(event);
  }

  appendCorrection(event, options) {
    this.appendCorrectionCalls.push(event.type);
    this.appendCorrectionEndpointIds.push(event.endpointId);
    return super.appendCorrection(event, options);
  }
}

class BlockingCostStore extends InMemoryLedgerStore {
  costAppendStarted;
  #resolveCostAppendStarted;
  #releaseCostAppend;
  #costAppendRelease;
  #blocked = false;

  constructor(options) {
    super(options);
    this.costAppendStarted = new Promise((resolve) => {
      this.#resolveCostAppendStarted = resolve;
    });
    this.#costAppendRelease = new Promise((resolve) => {
      this.#releaseCostAppend = resolve;
    });
  }

  releaseCostAppend() {
    this.#releaseCostAppend();
  }

  async appendEvent(event) {
    if (event.type === "cost" && !this.#blocked) {
      this.#blocked = true;
      this.#resolveCostAppendStarted();
      await this.#costAppendRelease;
    }
    return super.appendEvent(event);
  }
}

test("camelCase cost clarification and receipt ingestion pass Lakebase merchant scope", async () => {
  const store = new TrackingStore({ productProfiles: [productProfile()] });
  const service = createPasarAiService({
    store,
    idFactory: () => "clarification-001",
  });

  const pending = await service.recordAmbiguousCostIncrease({
    merchantId,
    occurredAt: "2026-07-12T14:31:00+08:00",
    componentId: "c_packaging",
    increaseRm: "2.00",
    evidence: { external_message_id: "telegram-001" },
  }, { idempotencyKey: "clarification-key" });
  assert.equal(pending.state, "clarification_required");

  const resolved = await service.resolveCostClarification({
    merchantId,
    sourceEventId: "telegram-001",
    packSize: "50",
    evidence: { external_message_id: "telegram-002" },
  }, { idempotencyKey: "resolution-key" });
  assert.equal(resolved.state, "committed");

  const receiptIngestion = createReceiptUploadIngestion({
    store,
    evidenceStore: createInMemoryEvidenceStore(),
    idFactory: () => "receipt-001",
    receiptExtractor: {
      async extract() {
        return {
          receipt_id: "RECEIPT-001",
          supplier_name: "Pack Supplier",
          date: "2026-07-12",
          currency: "MYR",
          line_items: [{
            raw_name: "Food containers",
            normalized_component_id: "c_packaging",
            quantity: "1",
            uom: "bundle",
            pack_size: "50",
            unit_price_rm: "10.00",
            total_price_rm: "10.00",
            confidence: "0.99",
          }],
          total_rm: "10.00",
          overall_confidence: "0.99",
          ambiguities: [],
        };
      },
    },
  });
  const receipt = await receiptIngestion.extract({
    merchant_id: merchantId,
    occurred_at: "2026-07-12T08:10:00+08:00",
    file_name: "receipt.jpg",
    content_type: "image/jpeg",
    content_base64: Buffer.from("ffd8ffd9", "hex").toString("base64"),
  }, { idempotencyKey: "receipt-key" });
  assert.equal(receipt.state, "ready_for_review");

  assert.deepEqual(store.idempotencyClaims, [
    {
      merchantId,
      endpointId: "cost-changes.create",
      key: "clarification-key",
    },
    {
      merchantId,
      endpointId: "cost-changes.create",
      key: "resolution-key",
    },
    {
      merchantId,
      endpointId: "receipt-upload.create",
      key: "receipt-key",
    },
  ]);
  assert.deepEqual(store.appendEventEndpointIds, [
    "cost-changes.create",
    "receipt-upload.create",
  ]);
});

test("cost increases append raw events while corrections use appendCorrection", async () => {
  const store = new TrackingStore({ productProfiles: [productProfile()] });
  const ids = ["cost-001", "sale-001", "correction-001"];
  const service = createPasarAiService({
    store,
    idFactory: () => ids.shift(),
  });

  const cost = await service.recordCostChange({
    merchant_id: merchantId,
    occurred_at: "2026-07-12T14:31:00+08:00",
    component_id: "c_packaging",
    increase_rm: "2.00",
    pack_size: "50",
    evidence: { source_event_id: "cost-source-001" },
  }, { idempotencyKey: "cost-key" });
  assert.equal(cost.state, "committed");
  assert.deepEqual(store.appendCorrectionCalls, []);
  assert.deepEqual(store.appendEventEndpointIds, ["cost-changes.create"]);

  await service.recordSale({
    merchant_id: merchantId,
    occurred_at: "2026-07-12T14:30:00+08:00",
    source: "voice_agent",
    source_language: "ms-en",
    lines: [{
      product_id: "p_nlb_001",
      quantity: "40",
      unit_price_rm: "5.00",
    }],
    evidence: { source_event_id: "sale-source-001" },
  }, { idempotencyKey: "sale-key" });
  const correction = await service.recordCorrection({
    merchant_id: merchantId,
    target_event_id: "sale-001",
    occurred_at: "2026-07-12T14:35:00+08:00",
    reason: "Correct quantity.",
    replacement_payload: {
      changes: [{
        kind: "decimal",
        field: "quantity",
        previous_value: "40",
        corrected_value: "38",
      }],
    },
    evidence: { source_event_id: "correction-source-001" },
  }, { idempotencyKey: "correction-key" });

  assert.equal(correction.state, "committed");
  assert.deepEqual(store.appendCorrectionCalls, ["correction"]);
  assert.deepEqual(store.appendCorrectionEndpointIds, ["corrections.create"]);
  assert.deepEqual(store.appendEventCalls, ["cost", "sale", "correction"]);
  assert.deepEqual(store.appendEventEndpointIds, [
    "cost-changes.create",
    "sales.create",
    "corrections.create",
  ]);
});

test("competing corrections from one target version append only once", async () => {
  class CompetingCorrectionStore extends InMemoryLedgerStore {
    #waiting = [];

    async appendCorrection(event, options) {
      await new Promise((resolve) => {
        this.#waiting.push(resolve);
        if (this.#waiting.length === 2) {
          for (const release of this.#waiting.splice(0)) release();
        }
      });
      return super.appendCorrection(event, options);
    }
  }

  const store = new CompetingCorrectionStore({
    productProfiles: [productProfile()],
  });
  const ids = ["sale-001", "correction-001", "correction-002"];
  const service = createPasarAiService({
    store,
    idFactory: () => ids.shift(),
  });
  await service.recordSale({
    merchant_id: merchantId,
    occurred_at: "2026-07-12T14:30:00+08:00",
    source: "voice_agent",
    source_language: "ms-en",
    lines: [{
      product_id: "p_nlb_001",
      quantity: "40",
      unit_price_rm: "5.00",
    }],
    evidence: { source_event_id: "sale-source-001" },
  }, { idempotencyKey: "sale-key" });

  const request = {
    merchant_id: merchantId,
    target_event_id: "sale-001",
    occurred_at: "2026-07-12T14:35:00+08:00",
    reason: "Correct quantity.",
    replacement_payload: {
      changes: [{
        kind: "decimal",
        field: "quantity",
        previous_value: "40",
        corrected_value: "38",
      }],
    },
  };
  const results = await Promise.all([
    service.recordCorrection({
      ...request,
      evidence: { source_event_id: "correction-source-001" },
    }, {
      idempotencyKey: "correction-key-001",
      expectedTargetVersion: 1,
    }),
    service.recordCorrection({
      ...request,
      replacement_payload: {
        changes: [{
          ...request.replacement_payload.changes[0],
          corrected_value: "35",
        }],
      },
      evidence: { source_event_id: "correction-source-002" },
    }, {
      idempotencyKey: "correction-key-002",
      expectedTargetVersion: 1,
    }),
  ]);

  assert.equal(
    results.filter(({ state }) => state === "committed").length,
    1,
  );
  const stale = results.find(({ state }) => state === "rejected");
  assert.equal(stale.errors[0].code, "invalid_request");
  assert.equal(
    stale.errors[0].message,
    "Correction target changed; expected version 1, current version is 2",
  );
  assert.equal(store.listEvents({ type: "correction" }).length, 1);
});

test("receipt confirmation owns its endpoint idempotency and total boundary", async () => {
  const store = new TrackingStore({ productProfiles: [productProfile()] });
  await store.appendEvent({
    eventId: "receipt-001",
    type: "receipt",
    merchantId,
    occurredAt: "2026-07-12T08:10:00+08:00",
    payload: {},
    evidence: {},
    response: { state: "ready_for_review" },
  });
  store.appendEventCalls.length = 0;
  store.appendEventEndpointIds.length = 0;

  const service = createPasarAiService({ store });
  const result = await service.confirmReceipt({
    merchant_id: merchantId,
    receipt_event_id: "receipt-001",
    occurred_at: "2026-07-12T08:15:00+08:00",
    extraction: {
      receipt_id: "RECEIPT-001",
      supplier_name: "Pack Supplier",
      date: "2026-07-12",
      currency: "MYR",
      line_items: [{
        raw_name: "Food containers",
        normalized_component_id: "c_packaging",
        quantity: "1",
        uom: "bundle",
        pack_size: "50",
        unit_price_rm: "10.00",
        total_price_rm: "10.00",
        confidence: "0.99",
      }],
      total_rm: "10.06",
      overall_confidence: "0.99",
      ambiguities: [],
    },
  }, { idempotencyKey: "receipt-confirm-key" });

  assert.equal(result.state, "rejected");
  assert.match(result.errors[0].message, /RM0\.06$/);
  assert.deepEqual(store.appendEventCalls, []);

  const acceptedRequest = {
    merchant_id: merchantId,
    receipt_event_id: "receipt-001",
    occurred_at: "2026-07-12T08:15:00+08:00",
    extraction: {
      receipt_id: "RECEIPT-002",
      supplier_name: "Pack Supplier",
      date: "2026-07-12",
      currency: "MYR",
      line_items: [{
        raw_name: "Food containers",
        normalized_component_id: "c_packaging",
        quantity: "1",
        uom: "bundle",
        pack_size: "50",
        unit_price_rm: "10.00",
        total_price_rm: "10.00",
        confidence: "0.99",
      }],
      total_rm: "10.05",
      overall_confidence: "0.99",
      ambiguities: [],
    },
  };
  const accepted = await service.confirmReceipt(
    acceptedRequest,
    { idempotencyKey: "receipt-confirm-boundary-key" },
  );
  assert.equal(accepted.state, "committed");
  assert.deepEqual(store.idempotencyClaims.at(-1), {
    merchantId,
    endpointId: "receipt-confirm.create",
    key: "receipt-confirm-boundary-key",
  });
  assert.deepEqual(store.appendEventEndpointIds, [
    "receipt-confirm.create",
    "receipt-confirm.create",
  ]);

  const replay = await service.confirmReceipt(
    acceptedRequest,
    { idempotencyKey: "receipt-confirm-boundary-key" },
  );
  assert.deepEqual(replay, accepted);

  const conflict = await service.confirmReceipt({
    ...acceptedRequest,
    extraction: {
      ...acceptedRequest.extraction,
      total_rm: "10.04",
    },
  }, { idempotencyKey: "receipt-confirm-boundary-key" });
  assert.equal(conflict.state, "rejected");
  assert.match(
    conflict.errors[0].message,
    /Idempotency-Key was already used with a different request payload/,
  );
});

test("receipt review history persists drafts and verified material changes", async () => {
  const ids = ["receipt-review-draft-001", "cost-receipt-001", "receipt-review-archive-001"];
  const store = new InMemoryLedgerStore({
    productProfiles: [productProfile()],
  });
  const originalExtraction = {
    receipt_id: "RECEIPT-HISTORY-001",
    supplier_name: "Pack Supplier",
    date: "2026-07-16",
    currency: "MYR",
    line_items: [{
      raw_name: "Food containers",
      normalized_component_id: "c_packaging",
      quantity: "1",
      uom: "bundle",
      pack_size: "40",
      unit_price_rm: "10.00",
      total_price_rm: "10.00",
      confidence: "0.99",
    }],
    total_rm: "10.00",
    overall_confidence: "0.99",
    ambiguities: [],
  };
  await store.appendEvent({
    eventId: "receipt-history-001",
    endpointId: "receipt-upload.create",
    type: "receipt",
    merchantId,
    occurredAt: "2026-07-16T08:10:00+08:00",
    payload: {
      file_name: "receipt-history.jpg",
      extraction: originalExtraction,
    },
    evidence: { asset_uri: "memory://receipt-history-001" },
    response: {
      state: "ready_for_review",
      event_id: "receipt-history-001",
      evidence_uri: "memory://receipt-history-001",
      extraction: originalExtraction,
    },
  });
  const service = createPasarAiService({
    store,
    idFactory: () => ids.shift(),
  });
  const reviewedExtraction = {
    ...originalExtraction,
    line_items: [{
      ...originalExtraction.line_items[0],
      pack_size: "50",
    }],
  };

  const saved = await service.saveReceiptReview({
    merchant_id: merchantId,
    receipt_event_id: "receipt-history-001",
    occurred_at: "2026-07-16T08:12:00+08:00",
    review_state: "draft",
    extraction: reviewedExtraction,
  }, { idempotencyKey: "receipt-review-save-001" });
  assert.deepEqual(saved, {
    state: "saved",
    receipt_event_id: "receipt-history-001",
    review_event_id: "receipt-review-draft-001",
    version: 1,
  });

  const draftHistory = await service.getReceiptReviews({ merchantId });
  assert.equal(draftHistory.receipts.length, 1);
  assert.equal(draftHistory.receipts[0].review_state, "draft");
  assert.equal(
    draftHistory.receipts[0].extraction.line_items[0].pack_size,
    "50",
  );
  assert.equal(draftHistory.receipts[0].image_uri, "memory://receipt-history-001");

  const confirmed = await service.confirmReceipt({
    merchant_id: merchantId,
    receipt_event_id: "receipt-history-001",
    occurred_at: "2026-07-16T08:15:00+08:00",
    extraction: reviewedExtraction,
  }, { idempotencyKey: "receipt-review-confirm-001" });
  assert.deepEqual(confirmed, {
    state: "committed",
    event_id: "cost-receipt-001",
  });

  const verifiedHistory = await service.getReceiptReviews({ merchantId });
  assert.equal(verifiedHistory.receipts.length, 1);
  assert.equal(verifiedHistory.receipts[0].review_state, "verified");
  assert.equal(verifiedHistory.receipts[0].confirmed, true);
  assert.equal(verifiedHistory.receipts[0].cost_event_id, "cost-receipt-001");
  assert.deepEqual(verifiedHistory.receipts[0].material_changes, [{
    component_id: "c_packaging",
    component_name: "Bekas Makanan",
    product_id: "p_nlb_001",
    quantity: "1",
    uom: "bundle",
    pack_size: "50",
    total_price_rm: "10.00",
    previous_cost_rm_per_pack: "0.16",
    current_cost_rm_per_pack: "0.20",
    change_rm_per_pack: "0.04",
  }]);

  const rejectedEdit = await service.saveReceiptReview({
    merchant_id: merchantId,
    receipt_event_id: "receipt-history-001",
    occurred_at: "2026-07-16T08:16:00+08:00",
    review_state: "archived",
    extraction: reviewedExtraction,
  }, { idempotencyKey: "receipt-review-archive-verified" });
  assert.equal(rejectedEdit.state, "rejected");
  assert.match(rejectedEdit.errors[0].message, /cannot be changed/);
});

test("receipt verification and archive remain terminal across stale requests", async () => {
  const store = new BlockingCostStore({
    productProfiles: [productProfile()],
  });
  const extraction = {
    receipt_id: "RECEIPT-TERMINAL-001",
    supplier_name: "Pack Supplier",
    date: "2026-07-16",
    currency: "MYR",
    line_items: [{
      raw_name: "Food containers",
      normalized_component_id: "c_packaging",
      quantity: "1",
      uom: "bundle",
      pack_size: "50",
      unit_price_rm: "10.00",
      total_price_rm: "10.00",
      confidence: "0.99",
    }],
    total_rm: "10.00",
    overall_confidence: "0.99",
    ambiguities: [],
  };
  for (const eventId of [
    "receipt-terminal-confirm",
    "receipt-terminal-archive",
  ]) {
    await store.appendEvent({
      eventId,
      endpointId: "receipt-upload.create",
      type: "receipt",
      merchantId,
      occurredAt: "2026-07-16T08:10:00+08:00",
      payload: {
        file_name: `${eventId}.jpg`,
        extraction,
      },
      evidence: { asset_uri: `memory://${eventId}` },
      response: {
        state: "ready_for_review",
        event_id: eventId,
        evidence_uri: `memory://${eventId}`,
        extraction,
      },
    });
  }
  const ids = ["cost-terminal-confirm", "receipt-review-terminal-archive"];
  const service = createPasarAiService({
    store,
    idFactory: () => ids.shift(),
  });

  const confirmation = service.confirmReceipt({
    merchant_id: merchantId,
    receipt_event_id: "receipt-terminal-confirm",
    occurred_at: "2026-07-16T08:15:00+08:00",
    extraction,
  }, { idempotencyKey: "confirm-terminal" });
  await store.costAppendStarted;
  const staleDraft = service.saveReceiptReview({
    merchant_id: merchantId,
    receipt_event_id: "receipt-terminal-confirm",
    occurred_at: "2026-07-16T08:14:00+08:00",
    review_state: "draft",
    extraction: {
      ...extraction,
      supplier_name: "Stale Supplier",
    },
  }, { idempotencyKey: "stale-after-confirm" });
  store.releaseCostAppend();

  assert.equal((await confirmation).state, "committed");
  const staleDraftResult = await staleDraft;
  assert.equal(staleDraftResult.state, "rejected");
  assert.match(staleDraftResult.errors[0].message, /cannot be changed/);
  const verifiedHistory = await service.getReceiptReviews({ merchantId });
  assert.equal(
    verifiedHistory.receipts.find(
      (receipt) => receipt.receipt_event_id === "receipt-terminal-confirm",
    ).extraction.supplier_name,
    "Pack Supplier",
  );

  const archived = await service.saveReceiptReview({
    merchant_id: merchantId,
    receipt_event_id: "receipt-terminal-archive",
    occurred_at: "2026-07-16T08:20:00+08:00",
    review_state: "archived",
    extraction,
  }, { idempotencyKey: "archive-terminal" });
  assert.equal(archived.state, "archived");
  const staleAfterArchive = await service.saveReceiptReview({
    merchant_id: merchantId,
    receipt_event_id: "receipt-terminal-archive",
    occurred_at: "2026-07-16T08:19:00+08:00",
    review_state: "draft",
    extraction: {
      ...extraction,
      supplier_name: "Resurrected Supplier",
    },
  }, { idempotencyKey: "stale-after-archive" });
  assert.equal(staleAfterArchive.state, "rejected");
  assert.match(staleAfterArchive.errors[0].message, /cannot be changed/);
  const finalHistory = await service.getReceiptReviews({ merchantId });
  assert.equal(
    finalHistory.receipts.some(
      (receipt) => receipt.receipt_event_id === "receipt-terminal-archive",
    ),
    false,
  );
});

test("foreign product IDs cannot cross merchant sales, summaries, or corrections", async () => {
  const otherMerchantId = "m_other_001";
  const otherProductId = "p_other_001";
  const store = new TrackingStore({
    productProfiles: [
      productProfile(),
      productProfile({
        profileMerchantId: otherMerchantId,
        productId: otherProductId,
        currentUnitCogsRm: "9.00",
        evidence: {
          evidenceId: "private-receipt",
          title: "Private receipt",
          receiptId: "PRIVATE-001",
          supplierName: "Private Supplier",
          lineItems: [],
        },
      }),
    ],
  });
  const ids = ["sale-local-001", "correction-local-001"];
  const service = createPasarAiService({
    store,
    idFactory: () => ids.shift(),
  });

  const foreignSale = await service.recordSale({
    merchant_id: merchantId,
    occurred_at: "2026-07-12T14:30:00+08:00",
    source: "voice_agent",
    source_language: "en",
    lines: [{
      product_id: otherProductId,
      quantity: "1",
      unit_price_rm: "5.00",
    }],
    evidence: { source_event_id: "foreign-sale-attempt" },
  }, { idempotencyKey: "foreign-sale-key" });
  assert.equal(foreignSale.state, "rejected");
  assert.match(foreignSale.errors[0].message, /Unknown product for merchant/);

  await store.appendEvent({
    eventId: "legacy-foreign-sale",
    endpointId: "sales.create",
    type: "sale",
    merchantId,
    occurredAt: "2026-07-12T14:30:00+08:00",
    payload: {
      merchant_id: merchantId,
      occurred_at: "2026-07-12T14:30:00+08:00",
      source: "voice_agent",
      source_language: "en",
      lines: [{
        product_id: otherProductId,
        quantity: "1",
        unit_price_rm: "5.00",
      }],
      evidence: { source_event_id: "legacy-foreign-sale" },
    },
    evidence: { source_event_id: "legacy-foreign-sale" },
    response: { state: "committed", event_id: "legacy-foreign-sale" },
  });
  const summary = await service.getDailySummary({
    merchantId,
    date: "2026-07-12",
  });
  assert.equal(summary.data_completeness.state, "partial");
  assert.deepEqual(summary.evidence, []);
  assert.equal(summary.cogs_rm, "0.00");

  const localSale = await service.recordSale({
    merchant_id: merchantId,
    occurred_at: "2026-07-13T14:30:00+08:00",
    source: "voice_agent",
    source_language: "en",
    lines: [{
      product_id: "p_nlb_001",
      quantity: "1",
      unit_price_rm: "5.00",
    }],
    evidence: { source_event_id: "local-sale" },
  }, { idempotencyKey: "local-sale-key" });
  assert.equal(localSale.state, "committed");

  const foreignCorrection = await service.recordCorrection({
    merchant_id: merchantId,
    target_event_id: "sale-local-001",
    occurred_at: "2026-07-13T14:35:00+08:00",
    reason: "Wrong product.",
    replacement_payload: {
      changes: [{
        kind: "identifier",
        field: "product_id",
        previous_value: "p_nlb_001",
        corrected_value: otherProductId,
      }],
    },
    evidence: { source_event_id: "foreign-correction-attempt" },
  }, { idempotencyKey: "foreign-correction-key" });
  assert.equal(foreignCorrection.state, "rejected");
  assert.match(
    foreignCorrection.errors[0].message,
    /Unknown product for merchant/,
  );
  assert.equal(store.listEvents({ type: "correction" }).length, 0);
});

test("daily summaries merge every component line that shares a receipt", async () => {
  const receipt = {
    evidenceId: "PPSS2-1207",
    title: "Pasar Pagi SS2 receipt",
    assetUri: "/evidence/receipt_003_pasar_pagi.jpg",
    receiptId: "PPSS2-1207",
    supplierName: "Pasar Pagi SS2",
    transcript: null,
  };
  const store = new InMemoryLedgerStore({
    productProfiles: [{
      merchantId,
      productId: "p_nlb_001",
      baselineUnitCogsRm: "0.64",
      currentUnitCogsRm: "0.64",
      components: [
        {
          componentId: "c_anchovy",
          name: "Ikan Bilis",
          baselineCostRm: "0.38",
          currentCostRm: "0.38",
          evidence: {
            ...receipt,
            lineItems: [{
              rawName: "Ikan bilis 1kg",
              componentId: "c_anchovy",
              totalPriceRm: "28.50",
              confidence: "1.00",
            }],
          },
        },
        {
          componentId: "c_peanut",
          name: "Kacang Tanah",
          baselineCostRm: "0.15",
          currentCostRm: "0.15",
          evidence: {
            ...receipt,
            lineItems: [{
              rawName: "Kacang 2kg",
              componentId: "c_peanut",
              totalPriceRm: "24.00",
              confidence: "1.00",
            }],
          },
        },
        {
          componentId: "c_cucumber",
          name: "Timun",
          baselineCostRm: "0.11",
          currentCostRm: "0.11",
          evidence: {
            ...receipt,
            lineItems: [{
              rawName: "Timun 3kg",
              componentId: "c_cucumber",
              totalPriceRm: "12.00",
              confidence: "1.00",
            }],
          },
        },
      ],
    }],
  });
  const service = createPasarAiService({ store });
  await service.recordSale({
    merchant_id: merchantId,
    occurred_at: "2026-07-12T14:30:00+08:00",
    source: "voice_agent",
    source_language: "en",
    lines: [{
      product_id: "p_nlb_001",
      quantity: "1",
      unit_price_rm: "5.00",
    }],
    evidence: { source_event_id: "shared-receipt-summary-sale" },
  }, { idempotencyKey: "shared-receipt-summary-sale" });

  const summary = await service.getDailySummary({
    merchantId,
    date: "2026-07-12",
  });

  assert.equal(summary.evidence.length, 1);
  assert.equal(summary.evidence[0].evidence_id, "PPSS2-1207");
  assert.deepEqual(
    summary.evidence[0].line_items.map((line) => ({
      component_id: line.component_id,
      raw_name: line.raw_name,
    })),
    [
      { component_id: "c_anchovy", raw_name: "Ikan bilis 1kg" },
      { component_id: "c_peanut", raw_name: "Kacang 2kg" },
      { component_id: "c_cucumber", raw_name: "Timun 3kg" },
    ],
  );
});
