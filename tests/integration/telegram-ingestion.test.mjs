import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  createFileEvidenceStore,
  createInMemoryEvidenceStore,
  createInMemoryIngestionStore,
  createLakebaseTelegramEventStore,
  createTelegramIngestion,
} from "../../services/api/src/index.js";
import {
  InMemoryLedgerStore,
  createPasarAiService,
} from "../../services/api/src/backend/index.js";

const rootUrl = new URL("../../", import.meta.url);
const receiptTruth = JSON.parse(
  await readFile(
    new URL(
      "PasarAI_Handoff_Package/demo_data/seed_data/receipt_ground_truth.json",
      rootUrl,
    ),
    "utf8",
  ),
);
const merchantId = "m_kak_lina_001";

async function resolveMerchant(body) {
  return body.message?.chat?.id === 9001 ? merchantId : null;
}

function contractReceipt(fixture, {
  overallConfidence = "0.98",
  lineConfidence = "0.98",
  ambiguities = [],
} = {}) {
  const decimal = (value) => value === null ? null : String(value);
  const money = (value) => value === null ? null : Number(value).toFixed(2);

  return {
    receipt_id: fixture.receipt_id,
    supplier_name: fixture.supplier_name,
    date: fixture.date,
    currency: fixture.currency,
    line_items: fixture.line_items.map((line) => ({
      raw_name: line.raw_name,
      normalized_component_id: line.normalized_component_id,
      quantity: decimal(line.quantity),
      uom: line.uom,
      pack_size: decimal(line.pack_size),
      unit_price_rm: money(line.unit_price_rm),
      total_price_rm: money(line.total_price_rm),
      confidence: lineConfidence,
    })),
    total_rm: money(fixture.total_rm),
    overall_confidence: overallConfidence,
    ambiguities,
  };
}

function telegramPhotoUpdate(updateId, fileId) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId + 1000,
      chat: { id: 9001 },
      photo: [
        { file_id: `${fileId}-small`, file_unique_id: `${fileId}-u1`, file_size: 50 },
        { file_id: fileId, file_unique_id: `${fileId}-u2`, file_size: 200_000 },
      ],
    },
  };
}

test("Telegram webhook rejects an invalid secret without persisting the update", async () => {
  const eventStore = createInMemoryIngestionStore();
  const evidenceStore = createInMemoryEvidenceStore();
  const ingestion = createTelegramIngestion({
    webhookSecret: "expected-secret",
    eventStore,
    evidenceStore,
    merchantResolver: resolveMerchant,
  });

  const response = await ingestion.handleWebhook({
    headers: { "x-telegram-bot-api-secret-token": "wrong-secret" },
    body: {
      update_id: 101,
      message: {
        message_id: 55,
        chat: { id: 9001 },
        text: "Packaging naik RM2.",
      },
    },
  });

  assert.deepEqual(response, {
    status: 401,
    body: { state: "unauthorized" },
  });
  assert.deepEqual(eventStore.listEvents(), []);
  assert.deepEqual(evidenceStore.listEvidence(), []);
});

test("duplicate Telegram text delivery creates one raw event and one evidence record", async () => {
  const eventStore = createInMemoryIngestionStore();
  const evidenceStore = createInMemoryEvidenceStore();
  const ingestion = createTelegramIngestion({
    webhookSecret: "expected-secret",
    eventStore,
    evidenceStore,
    merchantResolver: resolveMerchant,
  });
  const request = {
    headers: { "X-Telegram-Bot-Api-Secret-Token": "expected-secret" },
    body: {
      update_id: 102,
      message: {
        message_id: 56,
        chat: { id: 9001 },
        text: "Packaging naik RM2.",
      },
    },
  };

  const first = await ingestion.handleWebhook(request);
  const duplicate = await ingestion.handleWebhook(request);

  assert.deepEqual(first, {
    status: 202,
    body: {
      state: "accepted",
      kind: "text",
      update_id: 102,
      event_id: "telegram:102",
      evidence_uri: "memory://telegram/m_kak_lina_001/102/update.json",
      text: "Packaging naik RM2.",
    },
  });
  assert.deepEqual(duplicate, {
    status: 200,
    body: {
      state: "duplicate",
      update_id: 102,
      event_id: "telegram:102",
    },
  });
  assert.equal(eventStore.listEvents().length, 1);
  assert.equal(evidenceStore.listEvidence().length, 1);
});

test("Telegram retry resumes after evidence is stored before its URI is persisted", async () => {
  const rootDirectory = await mkdtemp(join(tmpdir(), "pasarai-evidence-"));
  const evidenceStore = createFileEvidenceStore({ rootDirectory });
  const eventStore = createInMemoryIngestionStore();
  const body = {
    update_id: 103,
    message: {
      message_id: 57,
      chat: { id: 9001 },
      text: "Packaging naik RM2.",
    },
  };

  try {
    await evidenceStore.put({
      key: `telegram/${merchantId}/103/update.json`,
      bytes: Buffer.from(JSON.stringify(body)),
      contentType: "application/json",
    });
    await eventStore.claimUpdate({
      updateId: 103,
      merchantId,
      event: {
        event_id: "telegram:103",
        update_id: 103,
        source: "telegram",
        state: "received",
        merchant_id: merchantId,
      },
    });
    await eventStore.updateEvent(103, {
      state: "retryable_failure",
      processing_state: "retryable",
      reason: "processing_failed",
      lease_expires_at: null,
    });

    const ingestion = createTelegramIngestion({
      webhookSecret: "expected-secret",
      eventStore,
      evidenceStore,
      merchantResolver: resolveMerchant,
    });
    const response = await ingestion.handleWebhook({
      headers: { "x-telegram-bot-api-secret-token": "expected-secret" },
      body,
    });

    assert.equal(response.status, 202);
    assert.equal(response.body.state, "accepted");
    assert.equal(response.body.kind, "text");
    assert.equal(eventStore.listEvents().length, 1);
    assert.equal(eventStore.listEvents()[0].processing_state, "completed");
    assert.match(eventStore.listEvents()[0].raw_evidence_uri, /^file:/);
  } finally {
    await rm(rootDirectory, { recursive: true, force: true });
  }
});

test("receipt 001 is stored, contract-validated, and marked ready for commit", async () => {
  const image = await readFile(
    new URL(
      "PasarAI_Handoff_Package/demo_data/receipts/receipt_001_sinar_borong.jpg",
      rootUrl,
    ),
  );
  const extraction = contractReceipt(receiptTruth["receipt_001_sinar_borong.jpg"]);
  const receiptStore = new InMemoryLedgerStore();
  const eventStore = createInMemoryIngestionStore({ receiptStore });
  const evidenceStore = createInMemoryEvidenceStore();
  const ingestion = createTelegramIngestion({
    webhookSecret: "expected-secret",
    eventStore,
    evidenceStore,
    merchantResolver: resolveMerchant,
    telegramClient: {
      async downloadFile(fileId) {
        assert.equal(fileId, "receipt-001");
        return { bytes: image, contentType: "image/jpeg" };
      },
    },
    receiptExtractor: {
      async extract({ bytes, contentType }) {
        assert.equal(contentType, "image/jpeg");
        assert.equal(Buffer.from(bytes).subarray(0, 2).toString("hex"), "ffd8");
        assert.equal(evidenceStore.listEvidence().length, 2);
        return extraction;
      },
    },
  });

  const response = await ingestion.handleWebhook({
    headers: { "x-telegram-bot-api-secret-token": "expected-secret" },
    body: telegramPhotoUpdate(201, "receipt-001"),
  });
  const duplicate = await ingestion.handleWebhook({
    headers: { "x-telegram-bot-api-secret-token": "expected-secret" },
    body: telegramPhotoUpdate(201, "receipt-001"),
  });

  assert.equal(response.status, 202);
  assert.equal(response.body.state, "ready_for_review");
  assert.equal(response.body.kind, "receipt");
  assert.equal(response.body.receipt_event_id, "telegram-receipt:201");
  assert.equal(response.body.extraction.receipt_id, "SBR-120726-184");
  assert.equal(response.body.extraction.total_rm, "143.50");
  assert.deepEqual(response.body.extraction, extraction);
  assert.equal(duplicate.body.state, "duplicate");
  assert.equal(duplicate.body.receipt_event_id, "telegram-receipt:201");
  assert.equal(eventStore.listEvents().length, 1);
  assert.equal(evidenceStore.listEvidence().length, 2);
  assert.equal(receiptStore.listEvents({ type: "receipt" }).length, 1);
});

test("receipt 002 reconciles to RM50.30 and remains ready for commit", async () => {
  const image = await readFile(
    new URL(
      "PasarAI_Handoff_Package/demo_data/receipts/receipt_002_packpro.jpg",
      rootUrl,
    ),
  );
  const extraction = contractReceipt(receiptTruth["receipt_002_packpro.jpg"]);
  const ingestion = createTelegramIngestion({
    webhookSecret: "expected-secret",
    eventStore: createInMemoryIngestionStore({
      receiptStore: new InMemoryLedgerStore(),
    }),
    evidenceStore: createInMemoryEvidenceStore(),
    merchantResolver: resolveMerchant,
    telegramClient: {
      async downloadFile() {
        return { bytes: image, contentType: "image/jpeg" };
      },
    },
    receiptExtractor: {
      async extract() {
        return extraction;
      },
    },
  });

  const response = await ingestion.handleWebhook({
    headers: { "x-telegram-bot-api-secret-token": "expected-secret" },
    body: telegramPhotoUpdate(202, "receipt-002"),
  });

  assert.equal(response.status, 202);
  assert.equal(response.body.state, "ready_for_review");
  assert.equal(response.body.extraction.receipt_id, "PPT-260712-077");
  assert.equal(response.body.extraction.total_rm, "50.30");
  assert.equal(response.body.extraction.line_items[0].pack_size, "50");
  assert.deepEqual(response.body.extraction, extraction);
});

test("receipt 003 is retained but routed to confirmation for low-confidence fields", async () => {
  const image = await readFile(
    new URL(
      "PasarAI_Handoff_Package/demo_data/receipts/receipt_003_pasar_pagi.jpg",
      rootUrl,
    ),
  );
  const extraction = contractReceipt(
    receiptTruth["receipt_003_pasar_pagi.jpg"],
    {
      overallConfidence: "0.72",
      lineConfidence: "0.78",
      ambiguities: [{
        field: "line_items[2].quantity",
        question: "Please confirm the ikan bilis quantity.",
        options: ["1 kg", "7 kg"],
      }],
    },
  );
  const evidenceStore = createInMemoryEvidenceStore();
  const ingestion = createTelegramIngestion({
    webhookSecret: "expected-secret",
    eventStore: createInMemoryIngestionStore({
      receiptStore: new InMemoryLedgerStore(),
    }),
    evidenceStore,
    merchantResolver: resolveMerchant,
    telegramClient: {
      async downloadFile() {
        return { bytes: image, contentType: "image/jpeg" };
      },
    },
    receiptExtractor: {
      async extract() {
        return extraction;
      },
    },
  });

  const response = await ingestion.handleWebhook({
    headers: { "x-telegram-bot-api-secret-token": "expected-secret" },
    body: telegramPhotoUpdate(203, "receipt-003"),
  });

  assert.equal(response.status, 202);
  assert.equal(response.body.state, "review_required");
  assert.equal(response.body.reason, "low_overall_confidence");
  assert.deepEqual(response.body.clarifications, extraction.ambiguities);
  assert.equal(response.body.extraction.receipt_id, "PPSS2-1207");
  assert.deepEqual(response.body.extraction, extraction);
  assert.equal(evidenceStore.listEvidence().length, 2);
});

test("receipt provider timeout retries without duplicating raw or image evidence", async () => {
  const image = await readFile(
    new URL(
      "PasarAI_Handoff_Package/demo_data/receipts/receipt_002_packpro.jpg",
      rootUrl,
    ),
  );
  const receiptStore = new InMemoryLedgerStore();
  const eventStore = createInMemoryIngestionStore({ receiptStore });
  const evidenceStore = createInMemoryEvidenceStore();
  const extraction = contractReceipt(receiptTruth["receipt_002_packpro.jpg"]);
  let attempts = 0;
  const ingestion = createTelegramIngestion({
    webhookSecret: "expected-secret",
    eventStore,
    evidenceStore,
    merchantResolver: resolveMerchant,
    telegramClient: {
      async downloadFile() {
        return { bytes: image, contentType: "image/jpeg" };
      },
    },
    receiptExtractor: {
      async extract() {
        attempts += 1;
        if (attempts === 1) {
          const error = new Error("provider timed out");
          error.name = "TimeoutError";
          throw error;
        }
        return extraction;
      },
    },
  });

  const request = {
    headers: { "x-telegram-bot-api-secret-token": "expected-secret" },
    body: telegramPhotoUpdate(204, "receipt-timeout"),
  };
  const response = await ingestion.handleWebhook(request);
  const retried = await ingestion.handleWebhook(request);

  assert.deepEqual(response, {
    status: 202,
    body: {
      state: "review_required",
      kind: "receipt",
      update_id: 204,
      event_id: "telegram:204",
      evidence_uri: "memory://telegram/m_kak_lina_001/204/receipt.jpg",
      reason: "receipt_provider_unavailable",
    },
  });
  assert.equal(retried.body.state, "ready_for_review");
  assert.equal(retried.body.receipt_event_id, "telegram-receipt:204");
  assert.equal(attempts, 2);
  assert.equal(eventStore.listEvents().length, 1);
  assert.equal(evidenceStore.listEvidence().length, 2);
  assert.equal(receiptStore.listEvents({ type: "receipt" }).length, 1);
});

test("Telegram voice note is stored before Scribe transcription and returns a preview", async () => {
  const voiceBytes = Buffer.from("OggS synthetic voice note");
  const evidenceStore = createInMemoryEvidenceStore();
  const ingestion = createTelegramIngestion({
    webhookSecret: "expected-secret",
    eventStore: createInMemoryIngestionStore(),
    evidenceStore,
    merchantResolver: resolveMerchant,
    telegramClient: {
      async downloadFile(fileId) {
        assert.equal(fileId, "voice-001");
        return { bytes: voiceBytes, contentType: "audio/ogg" };
      },
    },
    transcriber: {
      async transcribe({ bytes, contentType, evidenceUri }) {
        assert.deepEqual(Buffer.from(bytes), voiceBytes);
        assert.equal(contentType, "audio/ogg");
        assert.equal(
          evidenceUri,
          "memory://telegram/m_kak_lina_001/301/voice.ogg",
        );
        assert.equal(evidenceStore.listEvidence().length, 2);
        return {
          text: "Hari ni habis forty bungkus nasi lemak biasa.",
          languageCode: "ms",
          languageProbability: "0.97",
        };
      },
    },
  });

  const response = await ingestion.handleWebhook({
    headers: { "x-telegram-bot-api-secret-token": "expected-secret" },
    body: {
      update_id: 301,
      message: {
        message_id: 1301,
        chat: { id: 9001 },
        voice: {
          file_id: "voice-001",
          file_unique_id: "voice-u1",
          file_size: voiceBytes.length,
          mime_type: "audio/ogg",
          duration: 4,
        },
      },
    },
  });

  assert.deepEqual(response, {
    status: 202,
    body: {
      state: "accepted",
      kind: "voice",
      update_id: 301,
      event_id: "telegram:301",
      evidence_uri: "memory://telegram/m_kak_lina_001/301/voice.ogg",
      transcript_preview: "Hari ni habis forty bungkus nasi lemak biasa.",
      source_language: "ms",
    },
  });
});

test("Telegram voice notes resolve transcript dates before interpretation", async () => {
  let interpretedOccurredAt;
  const ingestion = createTelegramIngestion({
    webhookSecret: "expected-secret",
    eventStore: createInMemoryIngestionStore(),
    evidenceStore: createInMemoryEvidenceStore(),
    merchantResolver: resolveMerchant,
    defaultBusinessDate: "2026-07-16",
    telegramClient: {
      async downloadFile() {
        return {
          bytes: Buffer.from("OggS dated voice"),
          contentType: "audio/ogg",
        };
      },
      async sendMessage() {},
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
        interpretedOccurredAt = occurredAt;
        return {
          endpoint_id: "agent.reply",
          payload: {
            text: "Date resolved.",
            reply_language: "en",
          },
        };
      },
    },
    service: {},
  });

  const response = await ingestion.handleWebhook({
    headers: { "x-telegram-bot-api-secret-token": "expected-secret" },
    body: {
      update_id: 302,
      message: {
        message_id: 1302,
        date: Math.floor(
          Date.parse("2026-07-16T18:12:00.000Z") / 1000,
        ),
        chat: { id: 9001 },
        voice: {
          file_id: "voice-dated",
          mime_type: "audio/ogg",
        },
      },
    },
  });

  assert.equal(response.body.state, "completed");
  assert.equal(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Kuala_Lumpur",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(interpretedOccurredAt)),
    "2026-07-16",
  );
});

test("missing required pack size produces clarification and never becomes commit-ready", async () => {
  const image = await readFile(
    new URL(
      "PasarAI_Handoff_Package/demo_data/receipts/receipt_002_packpro.jpg",
      rootUrl,
    ),
  );
  const extraction = contractReceipt(receiptTruth["receipt_002_packpro.jpg"]);
  extraction.line_items[0] = {
    ...extraction.line_items[0],
    pack_size: null,
  };
  const ingestion = createTelegramIngestion({
    webhookSecret: "expected-secret",
    eventStore: createInMemoryIngestionStore({
      receiptStore: new InMemoryLedgerStore(),
    }),
    evidenceStore: createInMemoryEvidenceStore(),
    merchantResolver: resolveMerchant,
    telegramClient: {
      async downloadFile() {
        return { bytes: image, contentType: "image/jpeg" };
      },
    },
    receiptExtractor: {
      async extract() {
        return extraction;
      },
    },
  });

  const response = await ingestion.handleWebhook({
    headers: { "x-telegram-bot-api-secret-token": "expected-secret" },
    body: telegramPhotoUpdate(205, "receipt-missing-pack-size"),
  });

  assert.equal(response.body.state, "clarification_required");
  assert.match(
    response.body.clarifications[0].field,
    /line_items\[0\]\.pack_size/,
  );
});

test("financial fields below 0.90 confidence require confirmation", async () => {
  const image = await readFile(
    new URL(
      "PasarAI_Handoff_Package/demo_data/receipts/receipt_002_packpro.jpg",
      rootUrl,
    ),
  );
  const extraction = contractReceipt(
    receiptTruth["receipt_002_packpro.jpg"],
    { lineConfidence: "0.89" },
  );
  const ingestion = createTelegramIngestion({
    webhookSecret: "expected-secret",
    eventStore: createInMemoryIngestionStore({
      receiptStore: new InMemoryLedgerStore(),
    }),
    evidenceStore: createInMemoryEvidenceStore(),
    merchantResolver: resolveMerchant,
    telegramClient: {
      async downloadFile() {
        return { bytes: image, contentType: "image/jpeg" };
      },
    },
    receiptExtractor: {
      async extract() {
        return extraction;
      },
    },
  });

  const response = await ingestion.handleWebhook({
    headers: { "x-telegram-bot-api-secret-token": "expected-secret" },
    body: telegramPhotoUpdate(206, "receipt-low-field-confidence"),
  });

  assert.equal(response.body.state, "clarification_required");
  assert.equal(response.body.clarifications.length, 3);
});

test("receipt total mismatch over RM0.05 rejects automatic commit", async () => {
  const image = await readFile(
    new URL(
      "PasarAI_Handoff_Package/demo_data/receipts/receipt_002_packpro.jpg",
      rootUrl,
    ),
  );
  const extraction = {
    ...contractReceipt(receiptTruth["receipt_002_packpro.jpg"]),
    total_rm: "50.40",
  };
  const ingestion = createTelegramIngestion({
    webhookSecret: "expected-secret",
    eventStore: createInMemoryIngestionStore({
      receiptStore: new InMemoryLedgerStore(),
    }),
    evidenceStore: createInMemoryEvidenceStore(),
    merchantResolver: resolveMerchant,
    telegramClient: {
      async downloadFile() {
        return { bytes: image, contentType: "image/jpeg" };
      },
    },
    receiptExtractor: {
      async extract() {
        return extraction;
      },
    },
  });

  const response = await ingestion.handleWebhook({
    headers: { "x-telegram-bot-api-secret-token": "expected-secret" },
    body: telegramPhotoUpdate(207, "receipt-total-mismatch"),
  });

  assert.equal(response.status, 422);
  assert.equal(response.body.state, "rejected");
  assert.equal(response.body.reason, "receipt_total_mismatch");
  assert.equal(response.body.mismatch_rm, "0.10");
});

test("unmapped Telegram chats create no raw event or evidence", async () => {
  const eventStore = createInMemoryIngestionStore();
  const evidenceStore = createInMemoryEvidenceStore();
  const ingestion = createTelegramIngestion({
    webhookSecret: "expected-secret",
    eventStore,
    evidenceStore,
    merchantResolver: resolveMerchant,
  });

  const messages = [
    { text: "This chat is not mapped." },
    { voice: { file_id: "unmapped-voice" } },
    { photo: [{ file_id: "unmapped-photo", file_size: 100 }] },
  ];
  for (const [index, message] of messages.entries()) {
    const response = await ingestion.handleWebhook({
      headers: { "x-telegram-bot-api-secret-token": "expected-secret" },
      body: {
        update_id: 401 + index,
        message: {
          message_id: 1401 + index,
          chat: { id: 9999 },
          ...message,
        },
      },
    });
    assert.equal(response.status, 403);
    assert.equal(response.body.reason, "merchant_mapping_required");
  }
  assert.deepEqual(eventStore.listEvents(), []);
  assert.deepEqual(evidenceStore.listEvidence(), []);
});

test("transient Telegram failure retries one raw event and terminal success deduplicates", async () => {
  const eventStore = createInMemoryIngestionStore();
  const evidenceStore = createInMemoryEvidenceStore();
  let attempts = 0;
  const ingestion = createTelegramIngestion({
    webhookSecret: "expected-secret",
    eventStore,
    evidenceStore,
    merchantResolver: resolveMerchant,
    messageInterpreter: {
      async interpret() {
        attempts += 1;
        if (attempts === 1) throw new Error("temporary outage");
        return null;
      },
    },
    service: {},
  });
  const request = {
    headers: { "x-telegram-bot-api-secret-token": "expected-secret" },
    body: {
      update_id: 402,
      message: {
        message_id: 1402,
        chat: { id: 9001 },
        text: "Forty packets sold.",
      },
    },
  };

  const transient = await ingestion.handleWebhook(request);
  const retried = await ingestion.handleWebhook(request);
  const duplicate = await ingestion.handleWebhook(request);

  assert.equal(
    transient.body.business_result.reason,
    "interpretation_provider_unavailable",
  );
  assert.equal(retried.body.business_result.reason, "interpretation_required");
  assert.equal(duplicate.body.state, "duplicate");
  assert.equal(attempts, 2);
  assert.equal(eventStore.listEvents().length, 1);
  assert.equal(evidenceStore.listEvidence().length, 1);
});

test("transient Telegram voice interpretation retries delivery before terminal success", async () => {
  const eventStore = createInMemoryIngestionStore();
  const evidenceStore = createInMemoryEvidenceStore();
  let attempts = 0;
  const ingestion = createTelegramIngestion({
    webhookSecret: "expected-secret",
    eventStore,
    evidenceStore,
    merchantResolver: resolveMerchant,
    telegramClient: {
      async downloadFile() {
        return {
          bytes: Buffer.from("voice"),
          contentType: "audio/ogg",
        };
      },
    },
    transcriber: {
      async transcribe() {
        return {
          text: "Forty packets sold.",
          languageCode: "en",
        };
      },
    },
    messageInterpreter: {
      async interpret() {
        attempts += 1;
        if (attempts === 1) throw new Error("interpretation timeout");
        return null;
      },
    },
    service: {},
  });
  const request = {
    headers: { "x-telegram-bot-api-secret-token": "expected-secret" },
    body: {
      update_id: 403,
      message: {
        message_id: 1403,
        chat: { id: 9001 },
        voice: {
          file_id: "voice-retry",
          mime_type: "audio/ogg",
        },
      },
    },
  };

  const transient = await ingestion.handleWebhook(request);
  const retried = await ingestion.handleWebhook(request);
  const duplicate = await ingestion.handleWebhook(request);

  assert.equal(
    transient.body.business_result.reason,
    "interpretation_provider_unavailable",
  );
  assert.equal(retried.body.business_result.reason, "interpretation_required");
  assert.equal(duplicate.body.state, "duplicate");
  assert.equal(attempts, 2);
  assert.equal(eventStore.listEvents().length, 1);
  assert.equal(evidenceStore.listEvidence().length, 2);
});

test("Telegram photo returns a receipt event accepted by confirmReceipt", async () => {
  const image = await readFile(
    new URL(
      "PasarAI_Handoff_Package/demo_data/receipts/receipt_001_sinar_borong.jpg",
      rootUrl,
    ),
  );
  const extraction = contractReceipt(receiptTruth["receipt_001_sinar_borong.jpg"]);
  const receiptStore = new InMemoryLedgerStore({
    productProfiles: [{
      merchantId,
      productId: "p_nlb_001",
      baselineUnitCogsRm: "1.47",
      currentUnitCogsRm: "1.47",
      components: [
        {
          componentId: "c_egg",
          name: "Telur",
          baselineCostRm: "0.45",
          currentCostRm: "0.45",
          usagePerProductUnit: "1",
        },
        {
          componentId: "c_sambal",
          name: "Sambal",
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
      ],
    }],
  });
  const service = createPasarAiService({ store: receiptStore });
  const ingestion = createTelegramIngestion({
    webhookSecret: "expected-secret",
    eventStore: createLakebaseTelegramEventStore({
      ledgerStore: receiptStore,
      merchantId,
    }),
    evidenceStore: createInMemoryEvidenceStore(),
    merchantResolver: resolveMerchant,
    telegramClient: {
      async downloadFile() {
        return { bytes: image, contentType: "image/jpeg" };
      },
    },
    receiptExtractor: {
      async extract() {
        return extraction;
      },
    },
  });

  const response = await ingestion.handleWebhook({
    headers: { "x-telegram-bot-api-secret-token": "expected-secret" },
    body: telegramPhotoUpdate(403, "receipt-confirmable"),
  });
  const confirmation = await service.confirmReceipt({
    merchant_id: merchantId,
    receipt_event_id: response.body.receipt_event_id,
    occurred_at: "2026-07-12T08:10:00+08:00",
    extraction,
  }, {
    idempotencyKey: "telegram-receipt-confirmation",
  });

  assert.equal(confirmation.state, "committed");
  assert.equal(
    receiptStore.getEvent(response.body.receipt_event_id).type,
    "receipt",
  );
});
