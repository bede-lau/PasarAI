import { timingSafeEqual } from "node:crypto";

import {
  receiptDecision,
  validateReceiptImage,
} from "./receipt-ingestion.js";
import { createPersistentKey } from "./persistent-key.js";
import {
  operationWithTrustedVoiceLanguage,
  trustedVoiceLanguage,
} from "./providers/message-interpreter-tooling.js";
import { resolveTelegramOccurredAt } from "./telegram-business-date.js";

export { createElevenLabsScribeTranscriber } from "./providers/elevenlabs-scribe.js";
export { createTelegramBotClient } from "./providers/telegram-bot-client.js";
export { createReceiptUploadIngestion } from "./receipt-ingestion.js";
export { createFileEvidenceStore } from "./storage/file-evidence-store.js";
export {
  resolveTelegramBusinessDate,
  resolveTelegramOccurredAt,
} from "./telegram-business-date.js";
export {
  createLakebaseTelegramEventStore,
} from "./telegram-lakebase-store.js";

function headerValue(headers, name) {
  if (headers instanceof Headers) return headers.get(name);
  const entry = Object.entries(headers ?? {}).find(
    ([key]) => key.toLowerCase() === name.toLowerCase(),
  );
  return entry?.[1] ?? null;
}

function secretsMatch(expected, supplied) {
  if (typeof supplied !== "string") return false;
  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(supplied);
  return expectedBytes.length === suppliedBytes.length
    && timingSafeEqual(expectedBytes, suppliedBytes);
}

function selectLargestPhoto(photoSizes) {
  return photoSizes.reduce((selected, candidate) =>
    (candidate.file_size ?? 0) >= (selected.file_size ?? 0)
      ? candidate
      : selected
  );
}

const DEFAULT_PROCESSING_LEASE_MS = 30_000;

export function isTelegramConfirmationCommand(text) {
  if (typeof text !== "string") return false;
  const command = text
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[‐‑‒–—]/gu, "-");
  return /^(?:(?:yeah|yep|yes|ya|ok|okay|uh|um|erm|hmm|saya|i)[\s,.-]+)*(?:confirm(?:ed)?|sahkan|sah|sakan|s[-\s]+sakan|betul|确认|是|对)(?:[\s,.-]+(?:ya|yes|ok|okay))?[.!?。！]?$/iu
    .test(command);
}

function isRetryableState(event) {
  return event?.processing_state === "retryable";
}

function leaseExpired(event, now) {
  return event?.processing_state === "processing"
    && Date.parse(event.lease_expires_at ?? "") <= now;
}

function processingChanges(now, leaseMs) {
  return {
    state: "processing",
    processing_state: "processing",
    lease_expires_at: new Date(now + leaseMs).toISOString(),
  };
}

function completedChanges(changes) {
  return {
    ...changes,
    processing_state: "completed",
    lease_expires_at: null,
  };
}

function retryableChanges(changes) {
  return {
    ...changes,
    processing_state: "retryable",
    lease_expires_at: null,
  };
}

function telegramOccurredAt(body, now) {
  const timestamp = body.message?.date;
  return Number.isSafeInteger(timestamp)
    ? new Date(timestamp * 1000).toISOString()
    : new Date(now()).toISOString();
}

export function createInMemoryIngestionStore({
  now = () => Date.now(),
  receiptStore = null,
} = {}) {
  const events = [];
  const byUpdateId = new Map();
  const confirmationsByConversation = new Map();
  const confirmationKey = (merchantId, conversationKey) =>
    `${merchantId}\u0000${conversationKey}`;

  return {
    receiptStore,

    claimUpdate({
      updateId,
      event,
      leaseMs = DEFAULT_PROCESSING_LEASE_MS,
    }) {
      const existing = byUpdateId.get(updateId);
      const currentTime = now();
      if (existing) {
        if (!isRetryableState(existing) && !leaseExpired(existing, currentTime)) {
          return { claimed: false, event: structuredClone(existing) };
        }
        Object.assign(existing, processingChanges(currentTime, leaseMs));
        return {
          claimed: true,
          retried: true,
          event: structuredClone(existing),
        };
      }

      const stored = {
        ...structuredClone(event),
        ...processingChanges(currentTime, leaseMs),
      };
      events.push(stored);
      byUpdateId.set(updateId, stored);
      return { claimed: true, event: structuredClone(stored) };
    },

    updateEvent(updateId, changes) {
      const event = byUpdateId.get(updateId);
      if (!event) throw new Error(`Unknown Telegram update: ${updateId}`);
      Object.assign(event, structuredClone(changes));
      return structuredClone(event);
    },

    async appendReceipt({
      updateId,
      merchantId,
      occurredAt,
      fileName,
      contentType,
      evidenceUri,
      extraction,
      response,
    }) {
      if (!receiptStore?.appendEvent) {
        throw new Error("A shared receipt store is required");
      }
      const eventId = `telegram-receipt:${updateId}`;
      const appended = await receiptStore.appendEvent({
        eventId,
        externalId: createPersistentKey(
          merchantId,
          "telegram_receipt",
          updateId,
        ),
        endpointId: "receipt-upload.create",
        idempotencyKey: `telegram:${updateId}:receipt`,
        type: "receipt",
        merchantId,
        occurredAt,
        payload: {
          merchant_id: merchantId,
          file_name: fileName,
          content_type: contentType,
          ...(extraction ? { extraction } : {}),
        },
        evidence: {
          ...(evidenceUri ? { asset_uri: evidenceUri } : {}),
          ...(extraction?.receipt_id
            ? { receipt_id: extraction.receipt_id }
            : {}),
        },
        response,
      });
      return appended.event;
    },

    getPendingConfirmation({ merchantId, conversationKey }) {
      const confirmation = confirmationsByConversation.get(
        confirmationKey(merchantId, conversationKey),
      );
      return confirmation?.state === "pending"
        ? structuredClone(confirmation)
        : null;
    },

    savePendingConfirmation({
      merchantId,
      conversationKey,
      confirmation,
    }) {
      const stored = {
        ...structuredClone(confirmation),
        merchant_id: merchantId,
        conversation_key: conversationKey,
        state: "pending",
      };
      confirmationsByConversation.set(
        confirmationKey(merchantId, conversationKey),
        stored,
      );
      return structuredClone(stored);
    },

    resolvePendingConfirmation({
      merchantId,
      conversationKey,
      confirmationId,
      state,
      resolutionUpdateId,
    }) {
      const key = confirmationKey(merchantId, conversationKey);
      const pending = confirmationsByConversation.get(key);
      if (
        pending?.state !== "pending"
        || pending.confirmation_id !== confirmationId
      ) {
        return null;
      }
      const resolved = {
        ...pending,
        state,
        resolution_update_id: resolutionUpdateId,
      };
      confirmationsByConversation.set(key, resolved);
      return structuredClone(resolved);
    },

    listEvents() {
      return structuredClone(events);
    },
  };
}

export function createInMemoryEvidenceStore() {
  const evidence = [];

  return {
    async put({ key, bytes, contentType }) {
      const uri = `memory://${key}`;
      evidence.push({
        uri,
        key,
        bytes: Buffer.from(bytes),
        content_type: contentType,
      });
      return { uri };
    },

    listEvidence() {
      return structuredClone(evidence);
    },
  };
}

function aggregateOperationState(operations) {
  const states = operations.map(({ result }) => result?.state);
  if (states.includes("rejected")) return "rejected";
  if (states.includes("confirmation_required")) {
    return "confirmation_required";
  }
  if (states.includes("review_required")) return "review_required";
  if (states.includes("clarification_required")) {
    return "clarification_required";
  }
  if (states.every((state) => state === "committed")) return "committed";
  if (states.every((state) => state === "completed")) return "completed";
  return states.find(Boolean) ?? "accepted";
}

function dailySummaryReplyLines(summary, language) {
  if (!summary) return [];
  const incomplete = summary.data_completeness?.state === "partial";
  const drivers = (summary.top_cost_drivers ?? []).slice(0, 3);

  if (language === "zh") {
    return [
      `${summary.date} 的生意情况：营业额 RM${summary.revenue_rm}，`
        + `毛利 RM${summary.gross_profit_rm}`
        + `（${summary.gross_margin_pct}%）。`,
      `已记录的产品成本是 RM${summary.cogs_rm}。`,
      ...(drivers.length
        ? [
            `最大的产品成本来自：${
              drivers.map(({ name, contribution_rm_per_pack: amount }) =>
                `${name}（每份 RM${amount}）`
              ).join("、")
            }。`,
          ]
        : []),
      ...(incomplete
        ? ["提醒一下：还有一些成本资料未录入。"]
        : []),
      "这是毛利，还没有扣除营运开支。",
    ];
  }

  if (language === "ms") {
    return [
      `Setakat ${summary.date}, jualan ialah RM${summary.revenue_rm} dan `
        + `untung kasar RM${summary.gross_profit_rm} `
        + `(${summary.gross_margin_pct}%).`,
      `Kos produk yang direkodkan ialah RM${summary.cogs_rm}.`,
      ...(drivers.length
        ? [
            `Kos produk terbesar datang daripada ${
              drivers.map(({ name, contribution_rm_per_pack: amount }) =>
                `${name} (RM${amount} setiap pek)`
              ).join(", ")
            }.`,
          ]
        : []),
      ...(incomplete
        ? ["Cuma satu nota: masih ada input kos yang belum lengkap."]
        : []),
      "Ini untung kasar, jadi perbelanjaan operasi belum ditolak.",
    ];
  }

  return [
    `For ${summary.date}, sales are RM${summary.revenue_rm} and gross profit `
      + `is RM${summary.gross_profit_rm} `
      + `(${summary.gross_margin_pct}% margin).`,
    `Recorded product costs are RM${summary.cogs_rm}.`,
    ...(drivers.length
      ? [
          `The biggest product costs are ${
            drivers.map(({ name, contribution_rm_per_pack: amount }) =>
              `${name} (RM${amount} per pack)`
            ).join(", ")
          }.`,
        ]
      : []),
    ...(incomplete
      ? ["One caveat: some cost inputs are still missing."]
      : []),
    "This is gross profit, so operating expenses are not included yet.",
  ];
}

function simulationReplyLines(simulation, language) {
  if (!simulation) return [];
  const financialLine =
    `RM${simulation.revenue_rm} revenue, RM${simulation.cogs_rm} COGS, `
    + `RM${simulation.gross_profit_rm} gross profit `
    + `(${simulation.gross_margin_pct}% gross margin).`;
  const incremental = simulation.incremental_gross_profit_vs_today_rm;

  if (language === "ms") {
    return [
      "Simulasi harga sahaja; rekod tidak diubah.",
      `Hasil RM${simulation.revenue_rm}, COGS RM${simulation.cogs_rm}, `
        + `untung kasar RM${simulation.gross_profit_rm} `
        + `(margin kasar ${simulation.gross_margin_pct}%).`,
      ...(incremental === undefined
        ? []
        : [`Perubahan untung kasar berbanding hari ini: RM${incremental}.`]),
      "Andaian: permintaan kekal sama.",
    ];
  }

  if (language === "zh") {
    return [
      "这是只读价格模拟；账本记录没有更改。",
      `营业额 RM${simulation.revenue_rm}，COGS RM${simulation.cogs_rm}，`
        + `毛利 RM${simulation.gross_profit_rm}`
        + `（毛利率 ${simulation.gross_margin_pct}%）。`,
      ...(incremental === undefined
        ? []
        : [`与今天相比的毛利变化：RM${incremental}。`]),
      "假设：需求保持不变。",
    ];
  }

  return [
    "Price simulation only; no ledger record was changed.",
    financialLine,
    ...(incremental === undefined
      ? []
      : [`Gross profit change versus today: RM${incremental}.`]),
    "Assumption: demand stays constant.",
  ];
}

const DATABASE_MUTATION_ENDPOINTS = new Set([
  "sales.create",
  "costs.create",
  "cost-changes.create",
  "corrections.create",
]);

const TELEGRAM_PRODUCT_NAMES = {
  p_nla_001: "Nasi Lemak Ayam",
  p_nlb_001: "Nasi Lemak Biasa",
  p_tehais_001: "Teh Ais",
};

const TELEGRAM_COMPONENT_NAMES = {
  c_anchovy: "Ikan Bilis",
  c_coconut: "Santan",
  c_cucumber: "Timun",
  c_egg: "Telur",
  c_fuel: "Gas + Condiments",
  c_other: "Other",
  c_packaging: "Bekas Makanan",
  c_peanut: "Kacang Tanah",
  c_rice: "Beras",
  c_sambal: "Sambal + Minyak",
};

function telegramReplyLanguage(value) {
  const normalized = String(value ?? "").toLowerCase();
  if (
    normalized === "zh"
    || normalized.startsWith("zh-")
    || normalized === "zho"
    || normalized === "chi"
  ) {
    return "zh";
  }
  if (
    normalized === "ms"
    || normalized.startsWith("ms-")
    || normalized === "may"
    || normalized === "msa"
  ) {
    return "ms";
  }
  return "en";
}

function operationBusinessDate(
  operation,
  fallbackOccurredAt,
  timeZone = "Asia/Kuala_Lumpur",
) {
  const occurredAt =
    operation.payload?.occurred_at ?? fallbackOccurredAt ?? "";
  const parsed = new Date(occurredAt);
  if (Number.isNaN(parsed.valueOf())) return occurredAt.slice(0, 10);
  const parts = new Intl.DateTimeFormat("en", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(parsed);
  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  return `${values.year}-${values.month}-${values.day}`;
}

function operationConfirmationDetails(operation, language = "en") {
  const payload = operation.payload ?? {};

  if (operation.endpoint_id === "sales.create") {
    return (payload.lines ?? []).map((line) => {
      const name = TELEGRAM_PRODUCT_NAMES[line.product_id]
        ?? line.product_id
        ?? "Unknown product";
      if (language === "ms") {
        return `${line.quantity ?? "?"} ${name} pada RM`
          + `${line.unit_price_rm ?? "?"} setiap satu`;
      }
      if (language === "zh") {
        return `${line.quantity ?? "?"} ${name}，每份 RM`
          + `${line.unit_price_rm ?? "?"}`;
      }
      return `${line.quantity ?? "?"} ${name} at RM`
        + `${line.unit_price_rm ?? "?"} each`;
    });
  }

  if (operation.endpoint_id === "costs.create") {
    return (payload.lines ?? []).map((line) => {
      const name = TELEGRAM_COMPONENT_NAMES[line.component_id]
        ?? line.component_id
        ?? "Unknown component";
      const packSize = line.pack_size
        ? `, pack size ${line.pack_size}`
        : ", pack size not specified";
      const supplier = payload.supplier_name
        ? `, supplier ${payload.supplier_name}`
        : "";
      if (language === "ms") {
        return `${line.quantity ?? "?"} ${line.uom ?? "unit"} ${name}, `
          + `jumlah RM${line.total_price_rm ?? "?"}`;
      }
      if (language === "zh") {
        return `${line.quantity ?? "?"} ${line.uom ?? "unit"} ${name}，`
          + `总额 RM${line.total_price_rm ?? "?"}`;
      }
      return `${line.quantity ?? "?"} ${line.uom ?? "unit"} ${name}`
        + `${packSize}, total RM${line.total_price_rm ?? "?"}${supplier}`;
    });
  }

  if (operation.endpoint_id === "cost-changes.create") {
    const name = TELEGRAM_COMPONENT_NAMES[payload.component_id]
      ?? payload.component_id
      ?? "Unknown component";
    if (language === "ms") {
      const pack = payload.pack_size
        ? ` untuk ${payload.pack_size} unit asas`
        : " (saiz pek belum diberi)";
      return [`Kos ${name} naik RM${payload.increase_rm ?? "?"}${pack}.`];
    }
    if (language === "zh") {
      const pack = payload.pack_size
        ? `，适用于 ${payload.pack_size} 个基础单位`
        : "（尚未提供包装数量）";
      return [`${name} 成本增加 RM${payload.increase_rm ?? "?"}${pack}。`];
    }
    const pack = payload.pack_size
      ? ` for ${payload.pack_size} base units`
      : " (pack size not provided)";
    return [
      `${name} cost increased by RM${payload.increase_rm ?? "?"}${pack}.`,
    ];
  }

  if (operation.endpoint_id === "corrections.create") {
    const changes = payload.replacement_payload?.changes ?? [];
    const changeText = changes.length
      ? changes.map((change) =>
          `${change.field}: ${change.previous_value ?? "?"} -> `
            + `${change.corrected_value ?? "?"}`
        ).join("; ")
      : "replacement details supplied";
    if (language === "ms") {
      return [
        `Betulkan ${payload.target_event_id ?? "rekod"}: ${changeText}`,
      ];
    }
    if (language === "zh") {
      return [
        `更正 ${payload.target_event_id ?? "记录"}：${changeText}`,
      ];
    }
    return [
      `Correct ${payload.target_event_id ?? "the record"}: ${changeText}`,
    ];
  }

  return ["Save this update"];
}

function databaseConfirmationReplyLines(result) {
  const language = result.reply_language ?? "en";
  if (result.state === "cancelled") {
    if (language === "ms") return ["Baik, kemas kini itu telah dibuang."];
    if (language === "zh") {
      return ["好的，我已放弃那项更新。"];
    }
    return ["Okay, I discarded that update."];
  }
  if (
    result.state === "clarification_required"
    && result.clarification_fields?.length
  ) {
    const labels = {
      en: {
        component: "item",
        product: "product",
        quantity: "quantity",
        unit_price: "unit price",
        increase_amount: "cost increase amount",
        pack_size: "pack size",
        total_price: "total price",
        target_event: "record to correct",
        corrected_value: "corrected value",
        update_details: "update details",
      },
      ms: {
        component: "item",
        product: "produk",
        quantity: "kuantiti",
        unit_price: "harga seunit",
        increase_amount: "jumlah kenaikan kos",
        pack_size: "saiz pek",
        total_price: "jumlah harga",
        target_event: "rekod yang hendak dibetulkan",
        corrected_value: "nilai pembetulan",
        update_details: "butiran kemas kini",
      },
      zh: {
        component: "\u9879\u76ee",
        product: "\u4ea7\u54c1",
        quantity: "\u6570\u91cf",
        unit_price: "\u5355\u4ef7",
        increase_amount: "\u6210\u672c\u589e\u52a0\u91d1\u989d",
        pack_size: "\u5305\u88c5\u6570\u91cf",
        total_price: "\u603b\u4ef7",
        target_event: "\u9700\u66f4\u6b63\u7684\u8bb0\u5f55",
        corrected_value: "\u66f4\u6b63\u503c",
        update_details: "\u66f4\u65b0\u8be6\u60c5",
      },
    };
    const languageLabels = labels[language] ?? labels.en;
    const fieldLabels = result.clarification_fields
      .map((field) => languageLabels[field] ?? field)
    const fields = fieldLabels.join(", ");
    if (language === "ms") {
      return [
        `Saya belum dapat menyimpan kemas kini itu kerana ${fields} perlu dijelaskan.`,
        "Sila nyatakan semula kemas kini dengan butiran yang betul.",
      ];
    }
    if (language === "zh") {
      return [
        `\u6211\u8fd8\u65e0\u6cd5\u4fdd\u5b58\u8fd9\u9879\u66f4\u65b0\uff0c\u56e0\u4e3a${fields}\u9700\u8981\u786e\u8ba4\u3002`,
        "\u8bf7\u7528\u6b63\u786e\u7684\u8be6\u60c5\u91cd\u65b0\u8bf4\u660e\u8fd9\u9879\u66f4\u65b0\u3002",
      ];
    }
    return [
      fieldLabels.length === 1
        ? `I couldn't save that update yet because the ${fields} needs clarification.`
        : `I couldn't save that update yet because ${fields} need clarification.`,
      "Please restate the update with the correct details.",
    ];
  }

  const dateSuffix = result.date ? ` for ${result.date}` : "";
  const details = (result.details ?? []).map((detail) => `- ${detail}`);
  if (language === "ms") {
    return [
      result.reminder
        ? "Saya masih menunggu pengesahan anda untuk ini:"
        : result.supersedes_confirmation_id
          ? "Saya telah menggantikan kemas kini lama yang belum disimpan "
            + `dengan ini${dateSuffix}:`
          : `Saya faham begini${dateSuffix}:`,
      ...details,
      'Balas "sahkan" untuk simpan atau "batal" untuk buang.',
    ];
  }
  if (language === "zh") {
    return [
      result.reminder
        ? "这项更新还在等待您确认："
        : result.supersedes_confirmation_id
          ? "\u6211\u5df2\u7528\u8fd9\u9879\u66f4\u65b0\u66ff\u6362"
            + `\u4e86\u4e4b\u524d\u672a\u4fdd\u5b58\u7684\u66f4\u65b0${dateSuffix}\uff1a`
          : `我的理解是${dateSuffix}：`,
      ...details,
      '\u56de\u590d\u201c\u786e\u8ba4\u201d\u4fdd\u5b58\uff0c\u6216\u201c\u53d6\u6d88\u201d\u653e\u5f03\u3002',
    ];
  }
  return [
    result.reminder
      ? "I still have this waiting for your confirmation:"
      : result.supersedes_confirmation_id
        ? `I've replaced the earlier unsaved update with this${dateSuffix}:`
        : `I understood this${dateSuffix}:`,
    ...details,
    'Reply "confirm" to save it or "cancel" to discard it.',
  ];
}

function committedConfirmationReplyLines(result) {
  const language = result.reply_language ?? "en";
  const details = (result.confirmed_details ?? [])
    .map((detail) => `- ${detail}`);
  const dateSuffix = result.confirmed_date
    ? ` for ${result.confirmed_date}`
    : "";
  if (language === "ms") {
    return [
      `Baik, saya sudah simpan ini${dateSuffix}:`,
      ...details,
    ];
  }
  if (language === "zh") {
    return [
      `\u597d\u7684\uff0c\u6211\u5df2\u4fdd\u5b58\u8fd9\u9879\u66f4\u65b0${dateSuffix}\uff1a`,
      ...details,
    ];
  }
  return [
    `Done, I've saved this${dateSuffix}:`,
    ...details,
  ];
}

function committedReply(endpointId, language) {
  const replies = {
    "sales.create": {
      en: "Done, I've saved those sales.",
      ms: "Baik, jualan itu sudah disimpan.",
      zh: "好的，销售记录已经保存。",
    },
    "costs.create": {
      en: "Done, I've saved that cost.",
      ms: "Baik, kos itu sudah disimpan.",
      zh: "好的，成本记录已经保存。",
    },
    "cost-changes.create": {
      en: "Done, I've saved that cost change.",
      ms: "Baik, perubahan kos itu sudah disimpan.",
      zh: "好的，成本变更已经保存。",
    },
  };
  return replies[endpointId]?.[language]
    ?? replies[endpointId]?.en
    ?? "Done, I've saved that update.";
}

function correctionReplyLines(result) {
  const changes = result.changes ?? [];
  const changeText = changes.map((change) =>
    `${change.field}: ${change.before_value} -> ${change.after_value}`
  ).join("; ");
  if (!changeText) return ["Done, I've saved the correction."];
  if (result.reply_language === "ms") {
    return [`Baik, pembetulan sudah disimpan: ${changeText}.`];
  }
  if (result.reply_language === "zh") {
    return [`好的，更正已经保存：${changeText}。`];
  }
  return [`Done, I've saved the correction: ${changeText}.`];
}

function rejectedReply(language) {
  const replies = {
    en:
      "I could not record that update. "
      + "Please check the item, quantity, and price and try again.",
    ms:
      "Saya tidak dapat merekod kemas kini itu. "
      + "Sila semak item, kuantiti dan harga, kemudian cuba lagi.",
    zh:
      "\u6211\u65e0\u6cd5\u8bb0\u5f55\u8fd9\u9879\u66f4\u65b0\u3002"
      + "\u8bf7\u68c0\u67e5\u5546\u54c1\u3001\u6570\u91cf\u548c"
      + "\u4ef7\u683c\u540e\u518d\u8bd5\u3002",
  };
  return replies[language] ?? replies.en;
}

function confirmationClarificationFields(result, confirmation) {
  const errorText = [
    ...(result.errors ?? []).map(({ message }) => message),
    ...(result.operations ?? []).flatMap(({ result: operationResult }) =>
      (operationResult?.errors ?? []).map(({ message }) => message)
    ),
  ].join(" ").toLowerCase();
  const fields = [];
  const add = (field, pattern) => {
    if (pattern.test(errorText) && !fields.includes(field)) fields.push(field);
  };
  add("component", /component_id|item/);
  add("product", /product_id|product/);
  add("quantity", /quantity/);
  add("unit_price", /unit_price_rm|unit price/);
  add("increase_amount", /increase_rm|increase amount/);
  add("pack_size", /pack_size|pack size/);
  add("total_price", /total_price_rm|total price/);
  add("target_event", /target_event_id|target event/);
  add("corrected_value", /corrected_value|corrected value/);
  if (/clarification_source/.test(errorText)) {
    return ["component", "increase_amount", "pack_size"];
  }
  if (fields.length) return fields;

  const endpointIds = (confirmation.operations ?? [])
    .map(({ endpoint_id: endpointId }) => endpointId);
  if (endpointIds.includes("sales.create")) {
    return ["product", "quantity", "unit_price"];
  }
  if (endpointIds.includes("cost-changes.create")) {
    return ["component", "increase_amount", "pack_size"];
  }
  if (
    endpointIds.includes("costs.create")
    || endpointIds.includes("purchase-intake.upsert")
  ) {
    return ["component", "quantity", "pack_size", "total_price"];
  }
  if (endpointIds.includes("corrections.create")) {
    return ["target_event", "corrected_value"];
  }
  return ["update_details"];
}

function purchaseIntakeLanguage(purchaseIntake) {
  const sourceLanguage = purchaseIntake?.request?.source_language;
  if (sourceLanguage === "zh") return "zh";
  if (sourceLanguage?.startsWith("ms")) return "ms";
  return "en";
}

function activePurchaseReply(language) {
  const replies = {
    en:
      "Your cash purchase is still waiting for a missing detail, "
      + "confirmation, or cancellation.",
    ms:
      "Pembelian tunai anda masih menunggu butiran yang belum lengkap, "
      + "pengesahan atau pembatalan.",
    zh:
      "\u60a8\u7684\u73b0\u91d1\u8d2d\u4e70\u4ecd\u5728\u7b49\u5f85"
      + "\u8865\u5145\u8d44\u6599\u3001\u786e\u8ba4\u6216\u53d6\u6d88\u3002",
  };
  return replies[language] ?? replies.en;
}

function stalePurchaseReply(language) {
  const replies = {
    en:
      "This cash purchase changed before the action completed. "
      + "Please review the latest details and try again.",
    ms:
      "Pembelian tunai ini berubah sebelum tindakan selesai. "
      + "Sila semak butiran terkini dan cuba lagi.",
    zh:
      "\u8fd9\u7b14\u73b0\u91d1\u8d2d\u4e70\u5728\u64cd\u4f5c\u5b8c\u6210"
      + "\u524d\u5df2\u66f4\u6539\u3002\u8bf7\u67e5\u770b\u6700\u65b0"
      + "\u8d44\u6599\u540e\u91cd\u8bd5\u3002",
  };
  return replies[language] ?? replies.en;
}

function hasPurchaseIntakeUpdate(payload) {
  const item = payload?.item ?? {};
  const metadata = payload?.metadata ?? {};
  return Boolean(
    payload?.supplier_name
      || Object.values(item).some((value) =>
        value !== undefined && value !== null && value !== ""
      )
      || metadata.purchase_location
      || metadata.note
      || metadata.external_reference
      || metadata.tags?.length,
  );
}

const ACTIVE_PURCHASE_ALLOWED_ENDPOINTS = new Set([
  "agent.reply",
  "daily-summary.get",
  "price-simulation.create",
  "purchase-intake.upsert",
]);

const PENDING_CONFIRMATION_ALLOWED_ENDPOINTS = new Set([
  "agent.reply",
  "daily-summary.get",
  "price-simulation.create",
]);

const PURCHASE_FIELD_LABELS = {
  en: {
    supplier_name: "supplier",
    "item.component_id": "item",
    "item.quantity": "quantity bought",
    "item.uom": "purchase unit",
    "item.pack_size": "how many base units one purchase unit contains",
    "item.total_price_rm": "total price paid",
  },
  ms: {
    supplier_name: "pembekal",
    "item.component_id": "item",
    "item.quantity": "kuantiti dibeli",
    "item.uom": "unit pembelian",
    "item.pack_size": "berapa unit asas dalam satu unit pembelian",
    "item.total_price_rm": "jumlah harga dibayar",
  },
  zh: {
    supplier_name: "\u4f9b\u5e94\u5546",
    "item.component_id": "\u5546\u54c1",
    "item.quantity": "\u8d2d\u4e70\u6570\u91cf",
    "item.uom": "\u8d2d\u4e70\u5355\u4f4d",
    "item.pack_size": "\u6bcf\u4e2a\u8d2d\u4e70\u5355\u4f4d\u5305\u542b\u7684\u57fa\u7840\u6570\u91cf",
    "item.total_price_rm": "\u652f\u4ed8\u603b\u4ef7",
  },
};

function purchaseIntakeReplyLines(result) {
  const language = result.reply_language ?? "en";
  if (result.state === "clarification_required") {
    const labels = PURCHASE_FIELD_LABELS[language]
      ?? PURCHASE_FIELD_LABELS.en;
    const missing = (result.missing_fields ?? [])
      .map((field) => labels[field] ?? field)
      .join(", ");
    if (language === "ms") {
      return [`Sila berikan: ${missing}.`];
    }
    if (language === "zh") {
      return [`\u8bf7\u63d0\u4f9b\uff1a${missing}\u3002`];
    }
    return [`Please provide: ${missing}.`];
  }
  if (result.state === "ready_for_confirmation") {
    const summary = result.summary;
    if (language === "ms") {
      return [
        "Sila sahkan pembelian tunai ini:",
        `${summary.item_name ?? summary.component_id}: ${summary.quantity} ${summary.uom}`,
        `Setiap ${summary.uom} mengandungi ${summary.pack_size}; jumlah RM${summary.total_price_rm}.`,
        `Pembekal: ${summary.supplier_name}.`,
        'Balas "sahkan" untuk simpan atau "batal" untuk batalkan.',
      ];
    }
    if (language === "zh") {
      return [
        "\u8bf7\u786e\u8ba4\u8fd9\u7b14\u73b0\u91d1\u8d2d\u4e70\uff1a",
        `${summary.item_name ?? summary.component_id}\uff1a${summary.quantity} ${summary.uom}`,
        `\u6bcf ${summary.uom} \u5305\u542b ${summary.pack_size}\uff1b\u603b\u989d RM${summary.total_price_rm}\u3002`,
        `\u4f9b\u5e94\u5546\uff1a${summary.supplier_name}\u3002`,
        '\u56de\u590d\u201c\u786e\u8ba4\u201d\u4fdd\u5b58\uff0c\u6216\u201c\u53d6\u6d88\u201d\u653e\u5f03\u3002',
      ];
    }
    return [
      "Please confirm this cash purchase:",
      `${summary.item_name ?? summary.component_id}: ${summary.quantity} ${summary.uom}`,
      `Each ${summary.uom} contains ${summary.pack_size}; total RM${summary.total_price_rm}.`,
      `Supplier: ${summary.supplier_name}.`,
      'Reply "confirm" to save or "cancel" to discard.',
    ];
  }
  if (result.state === "cancelled") {
    if (language === "ms") return ["Pembelian tunai dibatalkan."];
    if (language === "zh") return ["\u73b0\u91d1\u8d2d\u4e70\u5df2\u53d6\u6d88\u3002"];
    return ["Cash purchase cancelled."];
  }
  if (result.state === "rejected") {
    return [stalePurchaseReply(language)];
  }
  return [];
}

function replyLinesForOperation(endpointId, result) {
  if (!result) return [];
  if (endpointId === "telegram.confirmation") {
    return databaseConfirmationReplyLines(result);
  }
  if (endpointId === "agent.reply") {
    return result.text ? [result.text] : [];
  }
  if (endpointId === "daily-summary.get") {
    return dailySummaryReplyLines(result.summary, result.reply_language);
  }
  if (endpointId === "price-simulation.create") {
    return simulationReplyLines(result.simulation, result.reply_language);
  }
  if (endpointId === "purchase-intake.upsert") {
    return purchaseIntakeReplyLines(result);
  }
  if (
    endpointId === "corrections.create"
    && result.state === "committed"
  ) {
    return correctionReplyLines(result);
  }
  if (
    result.state === "committed"
    && result.confirmed_details?.length
  ) {
    return committedConfirmationReplyLines(result);
  }
  if (result.state === "committed") {
    return [committedReply(endpointId, result.reply_language ?? "en")];
  }
  if (result.state === "clarification_required") {
    return (result.clarifications ?? []).map(({ question }) => question);
  }
  if (result.state === "review_required") {
    if (result.reason === "transcription_provider_unavailable") {
      return ["I could not transcribe that voice note. Please retry or send text."];
    }
    return [
      "I could not identify a complete update. Include the item, quantity, and price.",
    ];
  }
  if (result.state === "rejected") {
    return [rejectedReply(result.reply_language ?? "en")];
  }
  return [];
}

function telegramReplyText(businessResult) {
  if (!businessResult) return null;
  if (Array.isArray(businessResult.operations)) {
    const lines = businessResult.operations.flatMap(({ endpoint_id, result }) =>
      replyLinesForOperation(endpoint_id, result)
    );
    return [...new Set(lines)].join("\n") || null;
  }
  if (businessResult.endpoint_id) {
    return replyLinesForOperation(
      businessResult.endpoint_id,
      businessResult,
    ).join("\n") || null;
  }
  return replyLinesForOperation(null, businessResult).join("\n") || null;
}

export function createTelegramIngestion({
  webhookSecret,
  eventStore,
  evidenceStore,
  telegramClient,
  receiptExtractor,
  transcriber,
  messageInterpreter,
  service,
  merchantResolver,
  receiptStore,
  processingLeaseMs = DEFAULT_PROCESSING_LEASE_MS,
  now = () => Date.now(),
  defaultBusinessDate = "2026-07-16",
  timeZone = "Asia/Kuala_Lumpur",
}) {
  if (!webhookSecret) throw new Error("webhookSecret is required");
  if (!eventStore) throw new Error("eventStore is required");
  if (!evidenceStore) throw new Error("evidenceStore is required");
  if (!merchantResolver) throw new Error("merchantResolver is required");
  if (messageInterpreter && !service) {
    throw new Error(
      "messageInterpreter requires service",
    );
  }
  const canonicalReceiptStore = receiptStore ?? eventStore.receiptStore;
  const appendReceipt = eventStore.appendReceipt
    ? eventStore.appendReceipt.bind(eventStore)
    : null;

  function confirmationResult(
    confirmation,
    { reminder = false, replyLanguage } = {},
  ) {
    return {
      state: "confirmation_required",
      endpoint_id: "telegram.confirmation",
      confirmation_id: confirmation.confirmation_id,
      reply_language:
        replyLanguage ?? confirmation.reply_language ?? "en",
      ...(confirmation.date ? { date: confirmation.date } : {}),
      details: structuredClone(confirmation.details ?? []),
      ...(confirmation.supersedes_confirmation_id
        ? {
            supersedes_confirmation_id:
              confirmation.supersedes_confirmation_id,
          }
        : {}),
      ...(reminder ? { reminder: true } : {}),
    };
  }

  async function applyOperations({
    merchantId,
    conversationKey,
    purchaseIntake,
    updateId,
    text,
    source,
    evidenceUri,
    occurredAt,
    operations,
  }) {
    const applied = [];
    for (const [index, operation] of operations.entries()) {
      const operationIdentity = operations.length === 1
        ? operation.endpoint_id
        : `${operation.endpoint_id}:${index + 1}`;
      const {
        reply_language: replyLanguage = "en",
        ...operationPayload
      } = operation.payload ?? {};
      let result;
      if (
        purchaseIntake
        && !ACTIVE_PURCHASE_ALLOWED_ENDPOINTS.has(operation.endpoint_id)
      ) {
        result = {
          state: "completed",
          endpoint_id: "agent.reply",
          read_only: true,
          reply_language: replyLanguage,
          text: activePurchaseReply(replyLanguage),
        };
      } else if (
        operation.endpoint_id === "purchase-intake.upsert"
        && purchaseIntake
        && !hasPurchaseIntakeUpdate(operationPayload)
      ) {
        result = {
          state: "completed",
          endpoint_id: "agent.reply",
          read_only: true,
          reply_language: replyLanguage,
          text: activePurchaseReply(replyLanguage),
        };
      } else if (operation.endpoint_id === "agent.reply") {
        result = {
          state: "completed",
          endpoint_id: operation.endpoint_id,
          read_only: true,
          reply_language: replyLanguage,
          text: operationPayload.text,
        };
      } else if (operation.endpoint_id === "daily-summary.get") {
        result = {
          state: "completed",
          endpoint_id: operation.endpoint_id,
          read_only: true,
          reply_language: replyLanguage,
          summary: await service.getDailySummary({
            merchantId,
            date: operationPayload.date,
          }),
        };
      } else if (operation.endpoint_id === "price-simulation.create") {
        result = {
          state: "completed",
          endpoint_id: operation.endpoint_id,
          read_only: true,
          reply_language: replyLanguage,
          simulation: await service.simulatePrice({
            merchant_id: merchantId,
            ...operationPayload,
          }),
        };
      } else if (operation.endpoint_id === "purchase-intake.upsert") {
        const evidence = {
          ...(operationPayload.evidence ?? {}),
          transcript: text,
          external_message_id:
            `telegram:${updateId}:purchase-intake`,
          ...(evidenceUri ? { asset_uri: evidenceUri } : {}),
        };
        result = await service.upsertPurchaseIntake({
          ...operationPayload,
          ...(purchaseIntake
            ? {
                intake_id: purchaseIntake.intake_id,
                expected_version: purchaseIntake.version,
              }
            : {}),
          merchant_id: merchantId,
          occurred_at:
            purchaseIntake?.request?.occurred_at
              ?? operationPayload.occurred_at
              ?? occurredAt,
          source: operationPayload.source ?? source,
          metadata: {
            ...(operationPayload.metadata ?? {}),
            payment_method: "cash",
          },
          item: operationPayload.item ?? {},
          evidence,
        }, {
          idempotencyKey:
            `telegram:${updateId}:purchase-intake-upsert`,
          conversationKey,
        });
        result = {
          ...result,
          endpoint_id: operation.endpoint_id,
          reply_language: replyLanguage,
        };
      } else {
        const evidence = {
          ...(operationPayload.evidence ?? {}),
          transcript: text,
          external_message_id: `telegram:${updateId}:${operationIdentity}`,
          asset_uri: evidenceUri,
        };
        const payload = {
          ...operationPayload,
          merchant_id: merchantId,
          occurred_at: operationPayload.occurred_at ?? occurredAt,
          evidence,
        };
        const idempotencyKey = `telegram:${updateId}:${operationIdentity}`;
        if (operation.endpoint_id === "sales.create") {
          result = await service.recordSale(payload, { idempotencyKey });
        } else if (operation.endpoint_id === "costs.create") {
          result = await service.recordCost(payload, { idempotencyKey });
        } else if (operation.endpoint_id === "cost-changes.create") {
          result = await service.recordCostChange(payload, { idempotencyKey });
        } else if (operation.endpoint_id === "corrections.create") {
          result = await service.recordCorrection(payload, { idempotencyKey });
        } else {
          result = {
            state: "rejected",
            errors: [{
              code: "unsupported_operation",
              message:
                `Unsupported interpreted endpoint: ${operation.endpoint_id}`,
            }],
          };
        }
        result = {
          ...result,
          endpoint_id: operation.endpoint_id,
          reply_language: replyLanguage,
        };
      }
      applied.push({
        endpoint_id: result.endpoint_id ?? operation.endpoint_id,
        result,
      });
    }

    if (applied.length === 1) return applied[0].result;
    return {
      state: aggregateOperationState(applied),
      operations: applied,
    };
  }

  async function interpretAndApply({
    merchantId,
    chatId,
    updateId,
    text,
    source,
    sourceLanguage,
    evidenceUri,
    occurredAt,
  }) {
    if (!messageInterpreter) return null;
    const conversationKey = `telegram:${chatId}`;
    const purchaseIntake =
      "getActivePurchaseIntake" in service
      && typeof service.getActivePurchaseIntake === "function"
        ? await service.getActivePurchaseIntake({
            merchantId,
            conversationKey,
          })
        : null;
    const normalizedCommand = text.trim().toLowerCase();
    const isConfirm = isTelegramConfirmationCommand(text);
    const isCancel =
      /^(?:cancel|no|batal|tidak|\u53d6\u6d88|\u4e0d\u8981)[.!]?$/iu
        .test(normalizedCommand);
    const pendingConfirmation =
      typeof eventStore.getPendingConfirmation === "function"
        ? await eventStore.getPendingConfirmation({
            merchantId,
            conversationKey,
          })
        : null;
    if (pendingConfirmation && isCancel) {
      const commandLanguage = trustedVoiceLanguage({
        source,
        sourceLanguage,
      })?.replyLanguage;
      const pendingLanguage = trustedVoiceLanguage({
        source: pendingConfirmation.source,
        sourceLanguage: pendingConfirmation.source_language,
      })?.replyLanguage;
      await eventStore.resolvePendingConfirmation({
        merchantId,
        conversationKey,
        confirmationId: pendingConfirmation.confirmation_id,
        state: "cancelled",
        resolutionUpdateId: updateId,
      });
      return {
        state: "cancelled",
        endpoint_id: "telegram.confirmation",
        confirmation_id: pendingConfirmation.confirmation_id,
        reply_language:
          commandLanguage
          ?? pendingLanguage
          ?? pendingConfirmation.reply_language
          ?? "en",
      };
    }
    if (pendingConfirmation && isConfirm) {
      const pendingLanguage = trustedVoiceLanguage({
        source: pendingConfirmation.source,
        sourceLanguage: pendingConfirmation.source_language,
      })?.replyLanguage;
      const confirmationOperations = pendingConfirmation.operations.map(
        (operation) => operationWithTrustedVoiceLanguage(operation, {
          source: pendingConfirmation.source,
          sourceLanguage: pendingConfirmation.source_language,
        }),
      );
      const result = await applyOperations({
        merchantId,
        conversationKey,
        purchaseIntake,
        updateId: pendingConfirmation.original_update_id,
        text: pendingConfirmation.text,
        source: pendingConfirmation.source,
        evidenceUri: pendingConfirmation.evidence_uri,
        occurredAt: pendingConfirmation.occurred_at,
        operations: confirmationOperations,
      });
      if (
        result?.state === "rejected"
        || result?.state === "review_required"
      ) {
        return {
          state: "clarification_required",
          endpoint_id: "telegram.confirmation",
          confirmation_id: pendingConfirmation.confirmation_id,
          reply_language:
            pendingLanguage
            ?? result.reply_language
            ?? pendingConfirmation.reply_language
            ?? "en",
          ...(pendingConfirmation.date
            ? { date: pendingConfirmation.date }
            : {}),
          details: structuredClone(pendingConfirmation.details ?? []),
          clarification_fields: confirmationClarificationFields(
            result,
            pendingConfirmation,
          ),
        };
      }
      await eventStore.resolvePendingConfirmation({
        merchantId,
        conversationKey,
        confirmationId: pendingConfirmation.confirmation_id,
        state: "confirmed",
        resolutionUpdateId: updateId,
      });
      if (Array.isArray(result.operations)) return result;
      return {
        ...result,
        reply_language:
          pendingLanguage
          ?? result.reply_language
          ?? pendingConfirmation.reply_language
          ?? "en",
        confirmation_id: pendingConfirmation.confirmation_id,
        ...(pendingConfirmation.date
          ? { confirmed_date: pendingConfirmation.date }
          : {}),
        confirmed_details:
          structuredClone(pendingConfirmation.details ?? []),
      };
    }
    if (purchaseIntake && isCancel) {
      const replyLanguage = purchaseIntakeLanguage(purchaseIntake);
      const cancelled = await service.cancelPurchaseIntake({
        merchantId,
        intakeId: purchaseIntake.intake_id,
        expectedVersion: purchaseIntake.version,
      });
      if (!cancelled) {
        return {
          state: "completed",
          endpoint_id: "agent.reply",
          read_only: true,
          reply_language: replyLanguage,
          text: stalePurchaseReply(replyLanguage),
        };
      }
      return {
        state: "cancelled",
        endpoint_id: "purchase-intake.upsert",
        reply_language: replyLanguage,
      };
    }
    if (
      purchaseIntake?.state === "ready_for_confirmation"
      && isConfirm
    ) {
      const result = await service.confirmPurchaseIntake({
        merchant_id: merchantId,
        intake_id: purchaseIntake.intake_id,
        expected_version: purchaseIntake.version,
        confirmation_token: purchaseIntake.confirmation_token,
      }, {
        idempotencyKey:
          `telegram:${updateId}:purchase-intake-confirm`,
      });
      return {
        ...result,
        endpoint_id: "costs.create",
        reply_language: purchaseIntakeLanguage(purchaseIntake),
      };
    }
    const componentCatalog =
      "getComponentCatalog" in service
      && typeof service.getComponentCatalog === "function"
        ? (
            await service.getComponentCatalog({
              merchantId,
              asOfDate: occurredAt.slice(0, 10),
            })
          ).components.map((component) => ({
            id: component.component_id,
            name: component.name,
          }))
        : undefined;

    let interpreted;
    try {
      interpreted = await messageInterpreter.interpret({
        merchantId,
        text,
        source,
        sourceLanguage,
        evidenceUri,
        occurredAt,
        purchaseIntake,
        componentCatalog,
      });
    } catch {
      return {
        state: "review_required",
        reason: "interpretation_provider_unavailable",
      };
    }
    const operations = (Array.isArray(interpreted)
      ? interpreted.filter(Boolean)
      : interpreted
        ? [interpreted]
        : []).map((operation) =>
          operationWithTrustedVoiceLanguage(operation, {
            source,
            sourceLanguage,
          })
        );
    if (!operations.length) {
      return {
        state: "review_required",
        reason: "interpretation_required",
      };
    }

    const mutationOperations = operations.filter((operation) =>
      DATABASE_MUTATION_ENDPOINTS.has(operation.endpoint_id)
    );
    let supersededConfirmationId = null;
    if (
      pendingConfirmation
      && !purchaseIntake
      && mutationOperations.length
    ) {
      await eventStore.resolvePendingConfirmation({
        merchantId,
        conversationKey,
        confirmationId: pendingConfirmation.confirmation_id,
        state: "superseded",
        resolutionUpdateId: updateId,
      });
      supersededConfirmationId = pendingConfirmation.confirmation_id;
    } else if (
      pendingConfirmation
      && operations.some((operation) =>
        !PENDING_CONFIRMATION_ALLOWED_ENDPOINTS.has(operation.endpoint_id)
      )
    ) {
      const replyLanguage = operations
        .map((operation) =>
          operation.payload?.reply_language
            ?? operation.payload?.source_language
        )
        .find(Boolean);
      return confirmationResult(pendingConfirmation, {
        reminder: true,
        ...(replyLanguage
          ? { replyLanguage: telegramReplyLanguage(replyLanguage) }
          : {}),
      });
    }

    if (!purchaseIntake && mutationOperations.length) {
      const dates = [
        ...new Set(
          mutationOperations
            .map((operation) =>
              operationBusinessDate(operation, occurredAt, timeZone)
            )
            .filter(Boolean),
        ),
      ];
      const languageValue = mutationOperations
        .map((operation) =>
          operation.payload?.reply_language
            ?? operation.payload?.source_language
        )
        .find(Boolean) ?? sourceLanguage;
      const replyLanguage = telegramReplyLanguage(languageValue);
      const confirmation = {
        confirmation_id: `telegram:${updateId}:database-confirmation`,
        original_update_id: updateId,
        occurred_at: occurredAt,
        text,
        source,
        source_language: sourceLanguage,
        evidence_uri: evidenceUri,
        operations: structuredClone(mutationOperations),
        reply_language: replyLanguage,
        ...(supersededConfirmationId
          ? { supersedes_confirmation_id: supersededConfirmationId }
          : {}),
        ...(dates.length === 1 ? { date: dates[0] } : {}),
        details: mutationOperations.flatMap((operation) =>
          operationConfirmationDetails(operation, replyLanguage)
        ),
      };
      const stored = await eventStore.savePendingConfirmation({
        merchantId,
        conversationKey,
        confirmation,
      });
      return confirmationResult(stored);
    }

    return applyOperations({
      merchantId,
      conversationKey,
      purchaseIntake,
      updateId,
      text,
      source,
      evidenceUri,
      occurredAt,
      operations,
    });
  }

  async function sendBusinessReply(body, businessResult) {
    const text = telegramReplyText(businessResult);
    const chatId = body.message?.chat?.id;
    if (!text || chatId === undefined || !telegramClient?.sendMessage) {
      return "unavailable";
    }
    try {
      await telegramClient.sendMessage({
        chatId,
        text,
        replyToMessageId: body.message?.message_id,
      });
      return "sent";
    } catch {
      return "failed";
    }
  }

  return {
    async handleWebhook({ headers, body }) {
      const suppliedSecret = headerValue(
        headers,
        "x-telegram-bot-api-secret-token",
      );
      if (!secretsMatch(webhookSecret, suppliedSecret)) {
        return {
          status: 401,
          body: { state: "unauthorized" },
        };
      }

      if (!Number.isSafeInteger(body?.update_id)) {
        return {
          status: 400,
          body: { state: "rejected", reason: "invalid_update_id" },
        };
      }

      const updateId = body.update_id;
      const eventId = `telegram:${updateId}`;
      let merchantId;
      try {
        merchantId = await merchantResolver(body);
      } catch {
        return {
          status: 503,
          body: {
            state: "unavailable",
            reason: "merchant_mapping_unavailable",
          },
        };
      }
      if (!merchantId) {
        return {
          status: 403,
          body: {
            state: "unauthorized",
            reason: "merchant_mapping_required",
          },
        };
      }

      const claim = await eventStore.claimUpdate({
        updateId,
        merchantId,
        leaseMs: processingLeaseMs,
        event: {
          event_id: eventId,
          update_id: updateId,
          source: "telegram",
          state: "received",
          merchant_id: merchantId,
        },
      });
      if (!claim.claimed) {
        return {
          status: 200,
          body: {
            state: "duplicate",
            update_id: updateId,
            event_id: claim.event.event_id,
            ...(claim.event.receipt_event_id
              ? { receipt_event_id: claim.event.receipt_event_id }
              : {}),
          },
        };
      }

      try {
        const evidence = claim.event.raw_evidence_uri
          ? { uri: claim.event.raw_evidence_uri }
          : await evidenceStore.put({
              key: `telegram/${merchantId}/${updateId}/update.json`,
              bytes: Buffer.from(JSON.stringify(body)),
              contentType: "application/json",
            });
        if (!claim.event.raw_evidence_uri) {
          await eventStore.updateEvent(updateId, {
            ...processingChanges(now(), processingLeaseMs),
            raw_evidence_uri: evidence.uri,
          });
        }
      const incomingOccurredAt = telegramOccurredAt(body, now);
      const text = body.message?.text;
      if (typeof text === "string" && text.trim()) {
        const businessResult = await interpretAndApply({
          merchantId,
          chatId: body.message?.chat?.id,
          updateId,
          text,
          source: "telegram_text",
          sourceLanguage: null,
          evidenceUri: evidence.uri,
          occurredAt: resolveTelegramOccurredAt({
            text,
            occurredAt: incomingOccurredAt,
            defaultBusinessDate,
            timeZone,
          }),
        });
        const replyDelivery = await sendBusinessReply(body, businessResult);
        const changes = {
          state: businessResult?.state ?? "accepted",
          kind: "text",
          evidence_uri: evidence.uri,
          raw_evidence_uri: evidence.uri,
          business_result: businessResult,
          ...(replyDelivery === "unavailable"
            ? {}
            : { reply_delivery: replyDelivery }),
        };
        await eventStore.updateEvent(
          updateId,
          businessResult?.reason === "interpretation_provider_unavailable"
            ? retryableChanges(changes)
            : completedChanges(changes),
        );
        return {
          status: 202,
          body: {
            state: businessResult?.state ?? "accepted",
            kind: "text",
            update_id: updateId,
            event_id: eventId,
            evidence_uri: evidence.uri,
            text,
            ...(replyDelivery === "unavailable"
              ? {}
              : { reply_delivery: replyDelivery }),
            ...(businessResult ? { business_result: businessResult } : {}),
          },
        };
      }

      const voice = body.message?.voice;
      if (voice?.file_id) {
        if (!telegramClient?.downloadFile) {
          throw new Error("telegramClient.downloadFile is required for voice notes");
        }
        if (!transcriber?.transcribe) {
          throw new Error("transcriber.transcribe is required for voice notes");
        }

        const downloaded = await telegramClient.downloadFile(voice.file_id);
        const contentType = downloaded.contentType
          ?? voice.mime_type
          ?? "application/octet-stream";
        const extension = contentType === "audio/ogg" ? "ogg" : "audio";
        const voiceEvidence = claim.event.voice_evidence_uri
          ? { uri: claim.event.voice_evidence_uri }
          : await evidenceStore.put({
              key: `telegram/${merchantId}/${updateId}/voice.${extension}`,
              bytes: downloaded.bytes,
              contentType,
            });

        let transcript;
        try {
          transcript = await transcriber.transcribe({
            bytes: downloaded.bytes,
            contentType,
            evidenceUri: voiceEvidence.uri,
          });
        } catch {
          const replyDelivery = await sendBusinessReply(body, {
            state: "review_required",
            reason: "transcription_provider_unavailable",
          });
          await eventStore.updateEvent(updateId, retryableChanges({
            state: "review_required",
            kind: "voice",
            evidence_uri: voiceEvidence.uri,
            raw_evidence_uri: evidence.uri,
            voice_evidence_uri: voiceEvidence.uri,
            reason: "transcription_provider_unavailable",
            ...(replyDelivery === "unavailable"
              ? {}
              : { reply_delivery: replyDelivery }),
          }));
          return {
            status: 202,
            body: {
              state: "review_required",
              kind: "voice",
              update_id: updateId,
              event_id: eventId,
              evidence_uri: voiceEvidence.uri,
              reason: "transcription_provider_unavailable",
              ...(replyDelivery === "unavailable"
                ? {}
                : { reply_delivery: replyDelivery }),
            },
          };
        }

        const businessResult = await interpretAndApply({
          merchantId,
          chatId: body.message?.chat?.id,
          updateId,
          text: transcript.text,
          source: "telegram_voice",
          sourceLanguage: transcript.languageCode ?? null,
          evidenceUri: voiceEvidence.uri,
          occurredAt: resolveTelegramOccurredAt({
            text: transcript.text,
            occurredAt: incomingOccurredAt,
            defaultBusinessDate,
            timeZone,
          }),
        });
        const replyDelivery = await sendBusinessReply(body, businessResult);
        const changes = {
          state: businessResult?.state ?? "accepted",
          kind: "voice",
          evidence_uri: voiceEvidence.uri,
          raw_evidence_uri: evidence.uri,
          voice_evidence_uri: voiceEvidence.uri,
          transcript: transcript.text,
          source_language: transcript.languageCode ?? null,
          business_result: businessResult,
          ...(replyDelivery === "unavailable"
            ? {}
            : { reply_delivery: replyDelivery }),
        };
        await eventStore.updateEvent(
          updateId,
          businessResult?.reason === "interpretation_provider_unavailable"
            ? retryableChanges(changes)
            : completedChanges(changes),
        );
        return {
          status: 202,
          body: {
            state: businessResult?.state ?? "accepted",
            kind: "voice",
            update_id: updateId,
            event_id: eventId,
            evidence_uri: voiceEvidence.uri,
            transcript_preview: transcript.text,
            source_language: transcript.languageCode ?? null,
            ...(replyDelivery === "unavailable"
              ? {}
              : { reply_delivery: replyDelivery }),
            ...(businessResult ? { business_result: businessResult } : {}),
          },
        };
      }

      const photoSizes = body.message?.photo;
      if (Array.isArray(photoSizes) && photoSizes.length) {
        if (!telegramClient?.downloadFile) {
          throw new Error("telegramClient.downloadFile is required for photos");
        }
        if (!canonicalReceiptStore || !appendReceipt) {
          throw new Error(
            "A shared receipt store is required for Telegram photos",
          );
        }

        const photo = selectLargestPhoto(photoSizes);
        const downloaded = await telegramClient.downloadFile(photo.file_id);
        const extension = downloaded.contentType === "image/png" ? "png" : "jpg";
        const fileName = `telegram-${updateId}.${extension}`;
        const imageError = validateReceiptImage(downloaded);
        if (imageError) {
          const receiptResult = {
            state: "rejected",
            event_id: `telegram-receipt:${updateId}`,
            reason: imageError,
          };
          await appendReceipt({
            updateId,
            merchantId,
            occurredAt: resolveTelegramOccurredAt({
              text: body.message?.caption ?? "",
              occurredAt: incomingOccurredAt,
              defaultBusinessDate,
              timeZone,
            }),
            fileName,
            contentType: downloaded.contentType,
            evidenceUri: null,
            extraction: null,
            response: receiptResult,
          });
          await eventStore.updateEvent(updateId, completedChanges({
            state: receiptResult.state,
            kind: "receipt",
            raw_evidence_uri: evidence.uri,
            receipt_event_id: receiptResult.event_id,
            reason: imageError,
          }));
          return {
            status: 422,
            body: {
              ...receiptResult,
              kind: "receipt",
              update_id: updateId,
              event_id: eventId,
              receipt_event_id: receiptResult.event_id,
            },
          };
        }

        const receiptEvidence = claim.event.receipt_evidence_uri
          ? { uri: claim.event.receipt_evidence_uri }
          : await evidenceStore.put({
              key: `telegram/${merchantId}/${updateId}/receipt.${extension}`,
              bytes: downloaded.bytes,
              contentType: downloaded.contentType,
            });
        let extraction;
        try {
          extraction = await receiptExtractor.extract({
            bytes: downloaded.bytes,
            contentType: downloaded.contentType,
            evidenceUri: receiptEvidence.uri,
          });
        } catch {
          await eventStore.updateEvent(updateId, retryableChanges({
            state: "review_required",
            kind: "receipt",
            evidence_uri: receiptEvidence.uri,
            raw_evidence_uri: evidence.uri,
            receipt_evidence_uri: receiptEvidence.uri,
            reason: "receipt_provider_unavailable",
          }));
          return {
            status: 202,
            body: {
              state: "review_required",
              kind: "receipt",
              update_id: updateId,
              event_id: eventId,
              evidence_uri: receiptEvidence.uri,
              reason: "receipt_provider_unavailable",
            },
          };
        }

        const decision = receiptDecision(extraction);
        const receiptResult = {
          ...decision,
          state: decision.state === "ready_for_commit"
            ? "ready_for_review"
            : decision.state,
          event_id: `telegram-receipt:${updateId}`,
          evidence_uri: receiptEvidence.uri,
          extraction,
        };
        await appendReceipt({
          updateId,
          merchantId,
          occurredAt: resolveTelegramOccurredAt({
            text: [
              body.message?.caption,
              extraction?.date,
            ].filter(Boolean).join(" "),
            occurredAt: incomingOccurredAt,
            defaultBusinessDate,
            timeZone,
          }),
          fileName,
          contentType: downloaded.contentType,
          evidenceUri: receiptEvidence.uri,
          extraction,
          response: receiptResult,
        });
        const statusChanges = {
          state: receiptResult.state,
          kind: "receipt",
          evidence_uri: receiptResult.evidence_uri,
          raw_evidence_uri: evidence.uri,
          receipt_evidence_uri: receiptResult.evidence_uri,
          receipt_event_id: receiptResult.event_id,
          receipt_id: receiptResult.extraction?.receipt_id,
          reason: receiptResult.reason,
        };
        await eventStore.updateEvent(updateId, completedChanges(statusChanges));

        return {
          status: receiptResult.state === "rejected" ? 422 : 202,
          body: {
            ...receiptResult,
            kind: "receipt",
            update_id: updateId,
            event_id: eventId,
            receipt_event_id: receiptResult.event_id,
          },
        };
      }

      await eventStore.updateEvent(updateId, completedChanges({
        state: "rejected",
        raw_evidence_uri: evidence.uri,
        reason: "unsupported_update",
      }));
      return {
        status: 400,
        body: { state: "rejected", reason: "unsupported_update" },
      };
      } catch (error) {
        try {
          await eventStore.updateEvent(updateId, retryableChanges({
            state: "retryable_failure",
            reason: "processing_failed",
          }));
        } catch {
          // Preserve the original processing error.
        }
        throw error;
      }
    },
  };
}
