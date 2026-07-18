import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  createInMemoryEvidenceStore,
  createInMemoryIngestionStore,
  createReceiptUploadIngestion,
  createTelegramIngestion,
  isTelegramConfirmationCommand,
} from "../src/index.js";
import {
  InMemoryLedgerStore,
  LakebaseLedgerStore,
  createApiApp,
  createBearerAuthenticator,
  createPasarAiService,
} from "../src/backend/index.js";
import {
  createProductionDependencyMap,
  createProductionRuntime,
  resolveConfiguredModulePath,
} from "../src/runtime.js";
import {
  createMessageInterpreter,
} from "../src/providers/local-message-interpreter.js";

const rootUrl = new URL("../../../", import.meta.url);
const receiptTruth = JSON.parse(
  await readFile(
    new URL(
      "PasarAI_Handoff_Package/demo_data/seed_data/receipt_ground_truth.json",
      rootUrl,
    ),
    "utf8",
  ),
);
const receiptImage = await readFile(
  new URL(
    "PasarAI_Handoff_Package/demo_data/receipts/receipt_001_sinar_borong.jpg",
    rootUrl,
  ),
);

function apiUrl(path) {
  return ["http", "://", "pasarai.test", path].join("");
}

function profile() {
  return {
    merchantId: "m_kak_lina_001",
    productId: "p_nlb_001",
    baselineUnitCogsRm: "2.90",
    currentUnitCogsRm: "3.14",
    targetGrossMarginPct: "40.00",
    timeZone: "Asia/Kuala_Lumpur",
    components: [
      {
        componentId: "c_other",
        name: "Other",
        baselineCostRm: "1.27",
        currentCostRm: "1.51",
      },
      {
        componentId: "c_egg",
        name: "Telur",
        baselineCostRm: "0.45",
        currentCostRm: "0.45",
        usagePerProductUnit: "1",
      },
      {
        componentId: "c_sambal",
        name: "Sambal + Minyak",
        baselineCostRm: "0.47",
        currentCostRm: "0.47",
        usagePerProductUnit: "1",
      },
      {
        componentId: "c_coconut",
        name: "Santan",
        baselineCostRm: "0.55",
        currentCostRm: "0.55",
        usagePerProductUnit: "1",
      },
      {
        componentId: "c_packaging",
        name: "Bekas Makanan",
        baselineCostRm: "0.16",
        currentCostRm: "0.16",
        usagePerProductUnit: "1",
      },
    ],
  };
}

function authenticatedRequest(path, {
  method = "GET",
  idempotencyKey,
  body,
  token = "test-api-key",
} = {}) {
  return new Request(apiUrl(path), {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

function createSecuredApp({ receiptIngestion, telegramIngestion } = {}) {
  const ids = [
    "clarification-001",
    "cost-change-001",
    "receipt-upload-001",
  ];
  const store = new InMemoryLedgerStore({ productProfiles: [profile()] });
  const service = createPasarAiService({
    store,
    idFactory: () => ids.shift() ?? "event-fallback",
  });
  return {
    app: createApiApp({
      service,
      authenticate: createBearerAuthenticator({
        apiKey: "test-api-key",
        merchantId: "m_kak_lina_001",
      }),
      dependencies: { ledger: store },
      receiptIngestion,
      telegramIngestion,
    }),
    service,
    store,
  };
}

test("Telegram recognizes conservative Scribe variants of sahkan", () => {
  for (const transcript of [
    "sahkan",
    "Sakan",
    "Yeah, uh, s-sakan",
    "Saya sahkan",
    "sahkan ya",
  ]) {
    assert.equal(
      isTelegramConfirmationCommand(transcript),
      true,
      transcript,
    );
  }

  for (const transcript of [
    "tidak sahkan",
    "sakan ayam",
    "Packaging naik dua ringgit",
  ]) {
    assert.equal(
      isTelegramConfirmationCommand(transcript),
      false,
      transcript,
    );
  }
});

test("financial routes require bearer authentication and enforce merchant ownership", async () => {
  const { app } = createSecuredApp();
  const path =
    "/api/v1/summary/daily?merchant_id=m_kak_lina_001&date=2026-07-12";

  assert.equal((await app.fetch(new Request(apiUrl(path)))).status, 401);
  assert.equal(
    (await app.fetch(authenticatedRequest(path, { token: "wrong" }))).status,
    401,
  );
  assert.equal(
    (await app.fetch(authenticatedRequest(
      "/api/v1/summary/daily?merchant_id=m_other&date=2026-07-12",
    ))).status,
    403,
  );
  assert.equal((await app.fetch(authenticatedRequest(path))).status, 200);
});

test("evidence bytes stay behind the same merchant bearer boundary", async () => {
  const store = new InMemoryLedgerStore({ productProfiles: [profile()] });
  const app = createApiApp({
    service: createPasarAiService({ store }),
    authenticate: createBearerAuthenticator({
      apiKey: "test-api-key",
      merchantId: "m_kak_lina_001",
    }),
    evidenceStore: {
      async get({ uri, merchantId }) {
        assert.equal(uri, "pasarai-evidence:test");
        assert.equal(merchantId, "m_kak_lina_001");
        return {
          bytes: Buffer.from("receipt-bytes"),
          contentType: "image/jpeg",
        };
      },
    },
  });
  const path = "/api/v1/evidence?uri=pasarai-evidence%3Atest";
  assert.equal((await app.fetch(new Request(apiUrl(path)))).status, 401);
  const response = await app.fetch(authenticatedRequest(path));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/jpeg");
  assert.equal(Buffer.from(await response.arrayBuffer()).toString(), "receipt-bytes");
});

test("production composition requires explicit Lakebase, merchant and bearer configuration", async () => {
  assert.throws(() => new LakebaseLedgerStore(), /databaseUrl or pool/);
  const calls = [];
  const store = new LakebaseLedgerStore({
    pool: {
      async query(text) {
        calls.push(text);
        return { rows: [] };
      },
      async end() {
        calls.push("END");
      },
    },
  });
  assert.deepEqual(await store.healthCheck(), { status: "ok" });
  await store.close();
  assert.deepEqual(calls, ["SELECT 1", "END"]);
  await assert.rejects(
    createProductionRuntime({ environment: {} }),
    /PASARAI_MERCHANT_ID is required/,
  );
});

test("production adapters resolve repository-relative paths from the API package", () => {
  const apiDirectory = fileURLToPath(new URL("../", import.meta.url));
  const expectedPath = fileURLToPath(
    new URL("../src/providers/qwen-receipt-extractor.js", import.meta.url),
  );

  assert.equal(
    resolveConfiguredModulePath(
      "services/api/src/providers/qwen-receipt-extractor.js",
      { workingDirectory: apiDirectory },
    ),
    expectedPath,
  );
});

test("production dependency health covers every configured integration without secrets", async () => {
  const dependencies = createProductionDependencyMap({
    store: { async healthCheck() { return { status: "ok" }; } },
    evidenceStore: { async healthCheck() { return { status: "ok" }; } },
    receiptExtractor: {},
    messageInterpreter: null,
    telegramConfigured: true,
    scribeConfigured: false,
    googleSheetsIntegration: null,
  });
  assert.deepEqual(Object.keys(dependencies), [
    "lakebase",
    "evidence_store",
    "receipt_extractor",
    "message_interpreter",
    "telegram",
    "scribe",
    "google_sheets",
  ]);
  assert.deepEqual(await dependencies.lakebase.healthCheck(), { status: "ok" });
  assert.deepEqual(await dependencies.evidence_store.healthCheck(), {
    status: "ok",
  });
  assert.deepEqual(await dependencies.receipt_extractor.healthCheck(), {
    status: "ok",
  });
  assert.deepEqual(await dependencies.message_interpreter.healthCheck(), {
    status: "unavailable",
  });
  assert.deepEqual(await dependencies.telegram.healthCheck(), { status: "ok" });
  assert.deepEqual(await dependencies.scribe.healthCheck(), {
    status: "unavailable",
  });
  assert.deepEqual(await dependencies.google_sheets.healthCheck(), {
    status: "unavailable",
  });
  assert.doesNotMatch(JSON.stringify(dependencies), /token|secret|key/i);
});

test("public cost-change contract persists and resolves VN-01/VN-02 exactly once", async () => {
  const { app, store } = createSecuredApp();
  const pendingRequest = {
    merchant_id: "m_kak_lina_001",
    occurred_at: "2026-07-12T14:30:00+08:00",
    component_id: "c_packaging",
    increase_rm: "2.00",
    evidence: {
      transcript: "Packaging cost naik two ringgit.",
      external_message_id: "vn01-cost-change",
    },
  };
  const pending = await app.fetch(authenticatedRequest(
    "/api/v1/cost-changes",
    {
      method: "POST",
      idempotencyKey: "vn01-cost-change",
      body: pendingRequest,
    },
  ));
  assert.equal(pending.status, 200);
  const pendingBody = await pending.json();
  assert.equal(pendingBody.state, "clarification_required");
  assert.equal(pendingBody.clarification_source, "message:vn01-cost-change");
  assert.equal(store.listEvents().length, 0);

  const resolvedRequest = {
    ...pendingRequest,
    pack_size: "50",
    clarification_source: pendingBody.clarification_source,
    evidence: {
      transcript: "RM2 naik untuk satu pek 50 bekas.",
      external_message_id: "vn02-cost-change",
    },
  };
  const resolveRequest = () => authenticatedRequest(
    "/api/v1/cost-changes",
    {
      method: "POST",
      idempotencyKey: "vn02-cost-change",
      body: resolvedRequest,
    },
  );
  const first = await app.fetch(resolveRequest());
  const replay = await app.fetch(resolveRequest());
  assert.deepEqual(await first.json(), {
    state: "committed",
    event_id: "cost-change-001",
    before_value_rm: "0.16",
    after_value_rm: "0.20",
  });
  assert.deepEqual(await replay.json(), {
    state: "committed",
    event_id: "cost-change-001",
    before_value_rm: "0.16",
    after_value_rm: "0.20",
  });
  assert.equal(store.listEvents({ type: "cost" }).length, 1);
});

test("UTC voice timestamps are grouped by the merchant Kuala Lumpur date", async () => {
  const store = new InMemoryLedgerStore({ productProfiles: [profile()] });
  const service = createPasarAiService({
    store,
    idFactory: () => "timezone-sale-001",
  });
  const result = await service.recordSale({
    merchant_id: "m_kak_lina_001",
    occurred_at: "2026-07-11T16:30:00Z",
    source: "voice_agent",
    source_language: "en",
    lines: [{
      product_id: "p_nlb_001",
      quantity: "1",
      unit_price_rm: "5.00",
    }],
    evidence: { external_message_id: "timezone-sale-001" },
  }, { idempotencyKey: "timezone-sale-001" });
  assert.equal(result.state, "committed");
  assert.equal(
    (await service.getDailySummary({
      merchantId: "m_kak_lina_001",
      date: "2026-07-12",
    })).revenue_rm,
    "5.00",
  );
});

test("receipt upload route stores evidence before extraction and returns review data", async () => {
  const evidenceStore = createInMemoryEvidenceStore();
  const store = new InMemoryLedgerStore({ productProfiles: [profile()] });
  const truth = receiptTruth["receipt_001_sinar_borong.jpg"];
  const extraction = {
    receipt_id: truth.receipt_id,
    supplier_name: truth.supplier_name,
    date: truth.date,
    currency: truth.currency,
    line_items: truth.line_items.map((line) => ({
      raw_name: line.raw_name,
      normalized_component_id: line.normalized_component_id,
      quantity: String(line.quantity),
      uom: line.uom,
      pack_size: String(line.pack_size),
      unit_price_rm: Number(line.unit_price_rm).toFixed(2),
      total_price_rm: Number(line.total_price_rm).toFixed(2),
      confidence: "0.98",
    })),
    total_rm: Number(truth.total_rm).toFixed(2),
    overall_confidence: "0.98",
    ambiguities: [],
  };
  const receiptIngestion = createReceiptUploadIngestion({
    store,
    evidenceStore,
    idFactory: () => "receipt-upload-001",
    receiptExtractor: {
      async extract({ evidenceUri }) {
        assert.equal(evidenceStore.listEvidence().length, 1);
        assert.equal(
          evidenceUri,
          "memory://web/m_kak_lina_001/receipt-upload-001/receipt.jpg",
        );
        return extraction;
      },
    },
  });
  const service = createPasarAiService({ store });
  const app = createApiApp({
    service,
    authenticate: createBearerAuthenticator({
      apiKey: "test-api-key",
      merchantId: "m_kak_lina_001",
    }),
    receiptIngestion,
  });
  const requestBody = {
    merchant_id: "m_kak_lina_001",
    occurred_at: "2026-07-12T08:10:00+08:00",
    file_name: "receipt_001_sinar_borong.jpg",
    content_type: "image/jpeg",
    content_base64: receiptImage.toString("base64"),
  };
  const response = await app.fetch(authenticatedRequest(
    "/api/v1/receipts/extract",
    {
      method: "POST",
      idempotencyKey: "receipt-upload-key",
      body: requestBody,
    },
  ));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.state, "ready_for_review");
  assert.equal(body.event_id, "receipt-upload-001");
  assert.deepEqual(body.extraction, extraction);
  assert.equal(store.listEvents({ type: "receipt" }).length, 1);

  const review = await app.fetch(authenticatedRequest(
    "/api/v1/receipts/reviews",
    {
      method: "POST",
      idempotencyKey: "receipt-review-key",
      body: {
        merchant_id: "m_kak_lina_001",
        receipt_event_id: body.event_id,
        occurred_at: "2026-07-12T08:12:00+08:00",
        review_state: "draft",
        extraction,
      },
    },
  ));
  assert.equal(review.status, 200);
  assert.equal((await review.json()).state, "saved");

  const draftHistory = await app.fetch(authenticatedRequest(
    "/api/v1/receipts/reviews?merchant_id=m_kak_lina_001",
  ));
  assert.equal(draftHistory.status, 200);
  assert.equal((await draftHistory.json()).receipts[0].review_state, "draft");

  const confirmation = await app.fetch(authenticatedRequest(
    "/api/v1/receipts/confirm",
    {
      method: "POST",
      idempotencyKey: "receipt-confirm-key",
      body: {
        merchant_id: "m_kak_lina_001",
        receipt_event_id: body.event_id,
        occurred_at: "2026-07-12T08:10:00+08:00",
        extraction,
      },
    },
  ));
  assert.equal(confirmation.status, 200);
  assert.equal((await confirmation.json()).state, "committed");
  assert.equal(store.listEvents({ type: "cost" }).length, 1);
  const verifiedHistory = await app.fetch(authenticatedRequest(
    "/api/v1/receipts/reviews?merchant_id=m_kak_lina_001",
  ));
  const verifiedBody = await verifiedHistory.json();
  assert.equal(verifiedBody.receipts[0].review_state, "verified");
  assert.equal(
    verifiedBody.receipts[0].material_changes.length,
    extraction.line_items.filter(
      (line) => line.normalized_component_id !== null,
    ).length,
  );
});

test("explicit receipt confirmation promotes merchant-reviewed confidence", async () => {
  const store = new InMemoryLedgerStore({ productProfiles: [profile()] });
  await store.appendEvent({
    eventId: "receipt-review-001",
    type: "receipt",
    merchantId: "m_kak_lina_001",
    occurredAt: "2026-07-12T08:10:00+08:00",
    payload: {},
    evidence: { asset_uri: "memory://reviewed-receipt" },
    response: { state: "clarification_required" },
  });
  const service = createPasarAiService({
    store,
    idFactory: () => "cost-reviewed-001",
  });
  const result = await service.confirmReceipt({
    merchant_id: "m_kak_lina_001",
    receipt_event_id: "receipt-review-001",
    occurred_at: "2026-07-12T08:15:00+08:00",
    extraction: {
      receipt_id: "REVIEW-001",
      supplier_name: "Reviewed Supplier",
      date: "2026-07-12",
      currency: "MYR",
      line_items: [{
        raw_name: "Egg tray",
        normalized_component_id: "c_egg",
        quantity: "1",
        uom: "tray",
        pack_size: "30",
        unit_price_rm: "16.50",
        total_price_rm: "16.50",
        confidence: "0.72",
      }],
      total_rm: "16.50",
      overall_confidence: "0.72",
      ambiguities: [],
    },
  }, { idempotencyKey: "confirm-reviewed-001" });

  assert.equal(result.state, "committed");
  assert.equal(store.listEvents({ type: "cost" }).length, 1);
});

test("Telegram webhook is composed on one public route with Telegram secret auth", async () => {
  const telegramIngestion = createTelegramIngestion({
    webhookSecret: "telegram-secret",
    eventStore: createInMemoryIngestionStore(),
    evidenceStore: createInMemoryEvidenceStore(),
    merchantResolver: async (body) =>
      body.message?.chat?.id === 9001 ? "m_kak_lina_001" : null,
  });
  const { app } = createSecuredApp({ telegramIngestion });
  const response = await app.fetch(new Request(apiUrl("/webhooks/telegram"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": "telegram-secret",
    },
    body: JSON.stringify({
      update_id: 501,
      message: {
        message_id: 1501,
        chat: { id: 9001 },
        text: "Hari ni habis forty bungkus.",
      },
    }),
  }));
  assert.equal(response.status, 202);
  assert.equal((await response.json()).event_id, "telegram:501");
});

test("Telegram text interpretation requires confirmation before commit", async () => {
  const store = new InMemoryLedgerStore({ productProfiles: [profile()] });
  const service = createPasarAiService({
    store,
    idFactory: () => "telegram-sale-001",
  });
  const replies = [];
  const ingestion = createTelegramIngestion({
    webhookSecret: "telegram-secret",
    eventStore: createInMemoryIngestionStore(),
    evidenceStore: createInMemoryEvidenceStore(),
    telegramClient: {
      async sendMessage(message) {
        replies.push(message);
      },
    },
    service,
    merchantResolver: async (body) =>
      body.message?.chat?.id === 9001 ? "m_kak_lina_001" : null,
    messageInterpreter: {
      async interpret({ merchantId, text, source }) {
        assert.equal(merchantId, "m_kak_lina_001");
        assert.equal(text, "40 nasi lemak biasa at RM5.");
        assert.equal(source, "telegram_text");
        return {
          endpoint_id: "sales.create",
          payload: {
            occurred_at: "2026-07-12T14:30:00+08:00",
            source: "telegram_text",
            source_language: "en",
            lines: [{
              product_id: "p_nlb_001",
              quantity: "40",
              unit_price_rm: "5.00",
            }],
          },
        };
      },
    },
  });
  const response = await ingestion.handleWebhook({
    headers: {
      "x-telegram-bot-api-secret-token": "telegram-secret",
    },
    body: {
      update_id: 502,
      message: {
        message_id: 1502,
        chat: { id: 9001 },
        text: "40 nasi lemak biasa at RM5.",
      },
    },
  });

  assert.equal(response.body.state, "confirmation_required");
  assert.deepEqual(response.body.business_result, {
    state: "confirmation_required",
    endpoint_id: "telegram.confirmation",
    confirmation_id: "telegram:502:database-confirmation",
    reply_language: "en",
    date: "2026-07-12",
    details: [
      "40 Nasi Lemak Biasa at RM5.00 each",
    ],
  });
  assert.equal(store.listEvents({ type: "sale" }).length, 0);
  assert.match(replies[0].text, /I understood this for 2026-07-12/);
  assert.match(replies[0].text, /40 Nasi Lemak Biasa/);
  assert.doesNotMatch(replies[0].text, /database|p_nlb_001/i);

  const confirmed = await ingestion.handleWebhook({
    headers: {
      "x-telegram-bot-api-secret-token": "telegram-secret",
    },
    body: {
      update_id: 512,
      message: {
        message_id: 1512,
        chat: { id: 9001 },
        text: "confirm",
      },
    },
  });

  assert.equal(confirmed.body.state, "committed");
  assert.deepEqual(confirmed.body.business_result, {
    state: "committed",
    event_id: "telegram-sale-001",
    endpoint_id: "sales.create",
    reply_language: "en",
    confirmation_id: "telegram:502:database-confirmation",
    confirmed_date: "2026-07-12",
    confirmed_details: [
      "40 Nasi Lemak Biasa at RM5.00 each",
    ],
  });
  assert.equal(store.listEvents({ type: "sale" }).length, 1);
  assert.equal(
    replies[1].text,
    "Done, I've saved this for 2026-07-12:\n"
      + "- 40 Nasi Lemak Biasa at RM5.00 each",
  );
});

test("Telegram voice sales use the resolved date and wait for confirmation", async () => {
  const store = new InMemoryLedgerStore({ productProfiles: [profile()] });
  const service = createPasarAiService({
    store,
    idFactory: () => "telegram-voice-sale-001",
  });
  const replies = [];
  const ingestion = createTelegramIngestion({
    webhookSecret: "telegram-secret",
    eventStore: createInMemoryIngestionStore(),
    evidenceStore: createInMemoryEvidenceStore(),
    defaultBusinessDate: "2026-07-16",
    telegramClient: {
      async downloadFile() {
        return {
          bytes: Buffer.from("voice"),
          contentType: "audio/ogg",
        };
      },
      async sendMessage(message) {
        replies.push(message);
      },
    },
    transcriber: {
      async transcribe() {
        return {
          text:
            "Okey, for July 16, I ada buat sales lima kali "
            + "nasi lemak biasa untuk RM5 each.",
          languageCode: "ind",
        };
      },
    },
    messageInterpreter: {
      async interpret({ occurredAt }) {
        const businessDate = new Intl.DateTimeFormat("en-CA", {
          timeZone: "Asia/Kuala_Lumpur",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).format(new Date(occurredAt));
        assert.equal(businessDate, "2026-07-16");
        return {
          endpoint_id: "sales.create",
          payload: {
            occurred_at: occurredAt,
            source: "telegram_voice",
            source_language: "ms-en",
            lines: [{
              product_id: "p_nlb_001",
              quantity: "5",
              unit_price_rm: "5.00",
            }],
          },
        };
      },
    },
    service,
    merchantResolver: async () => "m_kak_lina_001",
  });

  const staged = await ingestion.handleWebhook({
    headers: {
      "x-telegram-bot-api-secret-token": "telegram-secret",
    },
    body: {
      update_id: 514,
      message: {
        message_id: 1514,
        date: Math.floor(
          Date.parse("2026-07-16T18:12:00.000Z") / 1_000,
        ),
        chat: { id: 9001 },
        voice: {
          file_id: "voice-514",
          mime_type: "audio/ogg",
        },
      },
    },
  });

  assert.equal(staged.body.state, "confirmation_required");
  assert.equal(staged.body.business_result.date, "2026-07-16");
  assert.match(
    staged.body.business_result.details[0],
    /5 Nasi Lemak Biasa pada RM5.00 setiap satu/,
  );
  assert.equal(store.listEvents({ type: "sale" }).length, 0);
  assert.match(replies[0].text, /Saya faham begini/);

  const confirmed = await ingestion.handleWebhook({
    headers: {
      "x-telegram-bot-api-secret-token": "telegram-secret",
    },
    body: {
      update_id: 515,
      message: {
        message_id: 1515,
        chat: { id: 9001 },
        text: "confirm",
      },
    },
  });

  assert.equal(confirmed.body.state, "committed");
  assert.equal(store.listEvents({
    type: "sale",
    date: "2026-07-16",
  }).length, 1);
  assert.equal(store.listEvents({
    type: "sale",
    date: "2026-07-17",
  }).length, 0);
});

test("Telegram mixed interpretation previews all mutations before applying them", async () => {
  const ids = ["telegram-sale-001", "telegram-clarification-001"];
  const store = new InMemoryLedgerStore({ productProfiles: [profile()] });
  const service = createPasarAiService({
    store,
    idFactory: () => ids.shift() ?? "telegram-event-fallback",
  });
  const replies = [];
  const ingestion = createTelegramIngestion({
    webhookSecret: "telegram-secret",
    eventStore: createInMemoryIngestionStore(),
    evidenceStore: createInMemoryEvidenceStore(),
    telegramClient: {
      async sendMessage(message) {
        replies.push(message);
      },
    },
    service,
    merchantResolver: async (body) =>
      body.message?.chat?.id === 9001 ? "m_kak_lina_001" : null,
    messageInterpreter: createMessageInterpreter(),
  });
  const response = await ingestion.handleWebhook({
    headers: {
      "x-telegram-bot-api-secret-token": "telegram-secret",
    },
    body: {
      update_id: 503,
      message: {
        message_id: 1503,
        date: 1784071800,
        chat: { id: 9001 },
        text:
          "Hari ni habis forty bungkus nasi lemak biasa, semua five ringgit. "
          + "Packaging cost naik two ringgit.",
      },
    },
  });

  assert.equal(response.body.state, "confirmation_required");
  assert.deepEqual(response.body.business_result, {
    state: "confirmation_required",
    endpoint_id: "telegram.confirmation",
    confirmation_id: "telegram:503:database-confirmation",
    reply_language: "ms",
    date: "2026-07-16",
    details: [
      "40 Nasi Lemak Biasa pada RM5.00 setiap satu",
      "Kos Bekas Makanan naik RM2.00 (saiz pek belum diberi).",
    ],
  });
  assert.equal(store.listEvents({ type: "sale" }).length, 0);
  assert.equal(store.listEvents({ type: "cost" }).length, 0);
  assert.match(replies[0].text, /Saya faham begini/);
  assert.match(replies[0].text, /saiz pek belum diberi/);

  const confirmed = await ingestion.handleWebhook({
    headers: {
      "x-telegram-bot-api-secret-token": "telegram-secret",
    },
    body: {
      update_id: 513,
      message: {
        message_id: 1513,
        chat: { id: 9001 },
        text: "confirm",
      },
    },
  });

  assert.equal(confirmed.body.state, "clarification_required");
  assert.deepEqual(confirmed.body.business_result, {
    state: "clarification_required",
    operations: [
      {
        endpoint_id: "sales.create",
        result: {
          state: "committed",
          event_id: "telegram-sale-001",
          endpoint_id: "sales.create",
          reply_language: "en",
        },
      },
      {
        endpoint_id: "cost-changes.create",
        result: {
          state: "clarification_required",
          clarification_source: "message:telegram:503:cost-changes.create:2",
          clarifications: [{
            field: "pack_size",
            question:
              "Bekas Makanan increase RM2.00 applies to how many base units?",
            options: ["50", "100", "other"],
          }],
          endpoint_id: "cost-changes.create",
          reply_language: "en",
        },
      },
    ],
  });
  assert.equal(store.listEvents({ type: "sale" }).length, 1);
  assert.equal(store.listEvents({ type: "cost" }).length, 0);
  assert.equal(
    replies[1].text,
    "Done, I've saved those sales.\n"
      + "Bekas Makanan increase RM2.00 applies to how many base units?",
  );
});

test("Telegram voice purchases persist a draft and require text confirmation before commit", async () => {
  const store = new InMemoryLedgerStore({ productProfiles: [profile()] });
  const counts = new Map();
  const service = createPasarAiService({
    store,
    idFactory: (kind) => {
      const next = (counts.get(kind) ?? 0) + 1;
      counts.set(kind, next);
      return `${kind}_${next}`;
    },
  });
  const replies = [];
  const ingestion = createTelegramIngestion({
    webhookSecret: "telegram-secret",
    eventStore: createInMemoryIngestionStore(),
    evidenceStore: createInMemoryEvidenceStore(),
    telegramClient: {
      async downloadFile() {
        return {
          bytes: Buffer.from("voice"),
          contentType: "audio/ogg",
        };
      },
      async sendMessage(message) {
        replies.push(message);
      },
    },
    transcriber: {
      async transcribe() {
        return {
          text:
            "Bought 2 trays telur at RM12 per tray of 30 from Sinar Borong.",
          languageCode: "en",
        };
      },
    },
    service,
    merchantResolver: async () => "m_kak_lina_001",
    messageInterpreter: createMessageInterpreter(),
  });

  const captured = await ingestion.handleWebhook({
    headers: {
      "x-telegram-bot-api-secret-token": "telegram-secret",
    },
    body: {
      update_id: 504,
      message: {
        message_id: 1504,
        date: 1784174400,
        chat: { id: 9001 },
        voice: {
          file_id: "voice-504",
          mime_type: "audio/ogg",
        },
      },
    },
  });
  assert.equal(
    captured.body.business_result.state,
    "ready_for_confirmation",
  );
  assert.equal(store.listEvents({ type: "cost" }).length, 0);
  assert.match(replies[0].text, /Please confirm this cash purchase/);

  const confirmed = await ingestion.handleWebhook({
    headers: {
      "x-telegram-bot-api-secret-token": "telegram-secret",
    },
    body: {
      update_id: 505,
      message: {
        message_id: 1505,
        date: 1784174460,
        chat: { id: 9001 },
        text: "confirm",
      },
    },
  });
  assert.equal(confirmed.body.business_result.state, "committed");
  assert.equal(store.listEvents({ type: "cost" }).length, 1);
  assert.equal(replies[1].text, "Done, I've saved that cost.");
});

test("Telegram purchase follow-ups preserve the original purchase date and cash metadata", async () => {
  const store = new InMemoryLedgerStore({ productProfiles: [profile()] });
  const counts = new Map();
  const service = createPasarAiService({
    store,
    idFactory: (kind) => {
      const next = (counts.get(kind) ?? 0) + 1;
      counts.set(kind, next);
      return `${kind}_${next}`;
    },
  });
  const ingestion = createTelegramIngestion({
    webhookSecret: "telegram-secret",
    eventStore: createInMemoryIngestionStore(),
    evidenceStore: createInMemoryEvidenceStore(),
    service,
    merchantResolver: async () => "m_kak_lina_001",
    messageInterpreter: {
      async interpret({ text, occurredAt }) {
        if (text === "Bought eggs") {
          return {
            endpoint_id: "purchase-intake.upsert",
            payload: {
              occurred_at: occurredAt,
              source_language: "en",
              reply_language: "en",
              metadata: { payment_method: "cash" },
              item: {
                component_id: "c_egg",
                raw_name: "Eggs",
              },
            },
          };
        }
        return {
          endpoint_id: "purchase-intake.upsert",
          payload: {
            occurred_at: occurredAt,
            source_language: "en",
            reply_language: "en",
            supplier_name: "Night Market",
            metadata: { payment_method: "card" },
            item: {
              quantity: "2",
              uom: "tray",
              pack_size: "30",
              total_price_rm: "24.00",
            },
          },
        };
      },
    },
  });
  const firstDeliveredAt = "2026-07-15T15:59:00.000Z";
  const followUpDeliveredAt = "2026-07-15T16:01:00.000Z";
  const resolvedOccurredAt = "2026-07-16T15:59:00.000Z";

  const first = await ingestion.handleWebhook({
    headers: {
      "x-telegram-bot-api-secret-token": "telegram-secret",
    },
    body: {
      update_id: 506,
      message: {
        message_id: 1506,
        date: Math.floor(Date.parse(firstDeliveredAt) / 1_000),
        chat: { id: 9001 },
        text: "Bought eggs",
      },
    },
  });
  assert.equal(
    first.body.business_result.state,
    "clarification_required",
  );

  const followUp = await ingestion.handleWebhook({
    headers: {
      "x-telegram-bot-api-secret-token": "telegram-secret",
    },
    body: {
      update_id: 507,
      message: {
        message_id: 1507,
        date: Math.floor(Date.parse(followUpDeliveredAt) / 1_000),
        chat: { id: 9001 },
        text: "2 trays, 30 each, RM24 from Night Market",
      },
    },
  });
  assert.equal(
    followUp.body.business_result.state,
    "ready_for_confirmation",
  );
  const active = await service.getActivePurchaseIntake({
    merchantId: "m_kak_lina_001",
    conversationKey: "telegram:9001",
  });
  assert.equal(active.request.occurred_at, resolvedOccurredAt);
  assert.equal(active.request.metadata.payment_method, "cash");

  const confirmed = await ingestion.handleWebhook({
    headers: {
      "x-telegram-bot-api-secret-token": "telegram-secret",
    },
    body: {
      update_id: 508,
      message: {
        message_id: 1508,
        date: Math.floor(Date.parse(followUpDeliveredAt) / 1_000),
        chat: { id: 9001 },
        text: "confirm",
      },
    },
  });
  assert.equal(confirmed.body.business_result.state, "committed");
  const costEvent = store.listEvents({
    merchantId: "m_kak_lina_001",
    type: "cost",
  })[0];
  assert.equal(costEvent.occurredAt, resolvedOccurredAt);
  assert.equal(costEvent.payload.metadata.payment_method, "cash");
});

test("Telegram voice expense queries return read-only English and Chinese summaries", async () => {
  const cases = [
    {
      updateId: 504,
      messageId: 1504,
      transcript: "How are my expenses looking now?",
      languageCode: "eng",
      expectedReply:
        "For 2026-07-15, sales are RM10.00 and gross profit "
        + "is RM3.64 (36.40% margin).\n"
        + "Recorded product costs are RM6.36.\n"
        + "The biggest product costs are Telur (RM0.55 per pack).\n"
        + "This is gross profit, so operating expenses are not included yet.",
    },
    {
      updateId: 505,
      messageId: 1505,
      transcript: "我的expense现在是怎样？",
      languageCode: "zho",
      expectedReply:
        "2026-07-15 的生意情况：营业额 RM10.00，毛利 RM3.64"
        + "（36.40%）。\n"
        + "已记录的产品成本是 RM6.36。\n"
        + "最大的产品成本来自：Telur（每份 RM0.55）。\n"
        + "这是毛利，还没有扣除营运开支。",
    },
  ];
  let readCount = 0;
  let mutationCount = 0;

  for (const scenario of cases) {
    const replies = [];
    const ingestion = createTelegramIngestion({
      webhookSecret: "telegram-secret",
      eventStore: createInMemoryIngestionStore(),
      evidenceStore: createInMemoryEvidenceStore(),
      telegramClient: {
        async downloadFile() {
          return {
            bytes: Buffer.from("voice"),
            contentType: "audio/ogg",
          };
        },
        async sendMessage(message) {
          replies.push(message);
        },
      },
      transcriber: {
        async transcribe() {
          return {
            text: scenario.transcript,
            languageCode: scenario.languageCode,
          };
        },
      },
      messageInterpreter: createMessageInterpreter(),
      service: {
        async getDailySummary({ merchantId, date }) {
          readCount += 1;
          assert.equal(merchantId, "m_kak_lina_001");
          assert.equal(date, "2026-07-16");
          return {
            merchant_id: merchantId,
            date,
            revenue_rm: "10.00",
            cogs_rm: "6.36",
            gross_profit_rm: "3.64",
            gross_margin_pct: "36.40",
            data_completeness: {
              state: "complete",
              missing_inputs: [],
            },
            top_cost_drivers: [{
              name: "Telur",
              contribution_rm_per_pack: "0.55",
            }],
          };
        },
        async recordSale() {
          mutationCount += 1;
        },
        async recordCost() {
          mutationCount += 1;
        },
        async recordCostChange() {
          mutationCount += 1;
        },
      },
      merchantResolver: async (body) =>
        body.message?.chat?.id === 9001 ? "m_kak_lina_001" : null,
    });

    const response = await ingestion.handleWebhook({
      headers: {
        "x-telegram-bot-api-secret-token": "telegram-secret",
      },
      body: {
        update_id: scenario.updateId,
        message: {
          message_id: scenario.messageId,
          date: Math.floor(Date.parse("2026-07-15T09:50:00Z") / 1000),
          chat: { id: 9001 },
          voice: {
            file_id: `voice-${scenario.updateId}`,
            mime_type: "audio/ogg",
          },
        },
      },
    });

    assert.equal(response.body.state, "completed");
    assert.equal(response.body.business_result.read_only, true);
    assert.deepEqual(replies, [{
      chatId: 9001,
      replyToMessageId: scenario.messageId,
      text: scenario.expectedReply.replace("2026-07-15", "2026-07-16"),
    }]);
  }

  assert.equal(readCount, 2);
  assert.equal(mutationCount, 0);
});
