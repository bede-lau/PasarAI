"use client";

import type { ReceiptReviewRecord } from "@/lib/dashboard-types";

const STORAGE_VERSION = 1;
const STORAGE_PREFIX = "pasarai.receipt-reviews";

type StoredReceiptReviews = {
  version: typeof STORAGE_VERSION;
  receipts: ReceiptReviewRecord[];
};

function isNullableString(value: unknown) {
  return value === null || typeof value === "string";
}

function isOptionalString(value: unknown) {
  return value === undefined || typeof value === "string";
}

function isOptionalNullableString(value: unknown) {
  return value === undefined || isNullableString(value);
}

function isDateTimeString(value: unknown) {
  return typeof value === "string"
    && Number.isFinite(Date.parse(value));
}

function isOptionalDateTimeString(value: unknown) {
  return value === undefined || isDateTimeString(value);
}

function isOptionalNullableDateTimeString(value: unknown) {
  return value === undefined
    || value === null
    || isDateTimeString(value);
}

function isOptionalBoolean(value: unknown) {
  return value === undefined || typeof value === "boolean";
}

function isOptionalInteger(value: unknown) {
  return value === undefined
    || (typeof value === "number" && Number.isInteger(value) && value >= 0);
}

function isReceiptLine(value: unknown) {
  if (!value || typeof value !== "object") return false;
  const line = value as Record<string, unknown>;
  return typeof line.raw_name === "string"
    && isNullableString(line.normalized_component_id)
    && isNullableString(line.quantity)
    && isNullableString(line.uom)
    && isNullableString(line.pack_size)
    && isNullableString(line.unit_price_rm)
    && isNullableString(line.total_price_rm)
    && typeof line.confidence === "string";
}

function isMaterialChange(value: unknown) {
  if (!value || typeof value !== "object") return false;
  const change = value as Record<string, unknown>;
  return typeof change.componentId === "string"
    && typeof change.componentName === "string"
    && isNullableString(change.productId)
    && typeof change.quantity === "string"
    && typeof change.uom === "string"
    && typeof change.packSize === "string"
    && typeof change.totalPriceRm === "string"
    && isNullableString(change.previousCostRmPerPack)
    && typeof change.currentCostRmPerPack === "string"
    && isNullableString(change.changeRmPerPack);
}

export function sanitizeReceiptReviewRecord(
  receipt: ReceiptReviewRecord
) {
  const imageUrl = receipt.imageUrl.startsWith("data:")
    ? ""
    : receipt.imageUrl;
  const evidenceUri = receipt.evidenceUri?.startsWith("data:")
    ? null
    : receipt.evidenceUri;
  if (
    imageUrl === receipt.imageUrl
    && evidenceUri === receipt.evidenceUri
  ) {
    return receipt;
  }
  return {
    ...receipt,
    imageUrl,
    evidenceUri
  };
}

function isReceiptReviewRecord(value: unknown): value is ReceiptReviewRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<ReceiptReviewRecord>;
  const extraction = record.extraction as
    | Partial<ReceiptReviewRecord["extraction"]>
    | undefined;
  if (
    !extraction
    || typeof extraction !== "object"
    || !Array.isArray(extraction.line_items)
    || !Array.isArray(extraction.ambiguities)
  ) {
    return false;
  }
  return typeof record.id === "string"
    && typeof record.title === "string"
    && typeof record.imageUrl === "string"
    && isOptionalNullableString(record.evidenceUri)
    && isOptionalString(record.sourceEventId)
    && isOptionalBoolean(record.readyToConfirm)
    && isOptionalBoolean(record.confirmed)
    && isOptionalBoolean(record.pendingSync)
    && isOptionalInteger(record.localRevision)
    && isOptionalInteger(record.reviewVersion)
    && isOptionalString(record.confirmationIdempotencyKey)
    && isOptionalDateTimeString(record.confirmationOccurredAt)
    && isOptionalInteger(record.confirmationRevision)
    && isOptionalDateTimeString(record.updatedAt)
    && isOptionalNullableString(record.costEventId)
    && isOptionalNullableDateTimeString(record.verifiedAt)
    && (
      record.materialChanges === undefined
      || (
        Array.isArray(record.materialChanges)
        && record.materialChanges.every(isMaterialChange)
      )
    )
    && isNullableString(extraction.receipt_id)
    && isNullableString(extraction.supplier_name)
    && isNullableString(extraction.date)
    && extraction.currency === "MYR"
    && isNullableString(extraction.total_rm)
    && typeof extraction.overall_confidence === "string"
    && extraction.line_items.every(isReceiptLine)
    && extraction.ambiguities.every(
      (ambiguity) => Boolean(
        ambiguity
        && typeof ambiguity === "object"
        && typeof ambiguity.field === "string"
        && typeof ambiguity.question === "string"
        && Array.isArray(ambiguity.options)
        && ambiguity.options.every(
          (option: unknown) => typeof option === "string"
        )
      )
    );
}

export function receiptReviewStorageKey(merchantId: string) {
  return `${STORAGE_PREFIX}:${merchantId}`;
}

export function loadReceiptReviews(storage: Storage, merchantId: string) {
  try {
    const raw = storage.getItem(receiptReviewStorageKey(merchantId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Partial<StoredReceiptReviews>;
    if (parsed.version !== STORAGE_VERSION || !Array.isArray(parsed.receipts)) {
      return [];
    }
    return parsed.receipts
      .filter(isReceiptReviewRecord)
      .map(sanitizeReceiptReviewRecord);
  } catch {
    return [];
  }
}

export function saveReceiptReviews(
  storage: Storage,
  merchantId: string,
  receipts: readonly ReceiptReviewRecord[]
) {
  try {
    const key = receiptReviewStorageKey(merchantId);
    if (!receipts.length) {
      storage.removeItem(key);
      return true;
    }
    const payload: StoredReceiptReviews = {
      version: STORAGE_VERSION,
      receipts: receipts.map(sanitizeReceiptReviewRecord)
    };
    storage.setItem(key, JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

export function mergeReceiptReviewHistory(
  serverReceipts: readonly ReceiptReviewRecord[],
  localReceipts: readonly ReceiptReviewRecord[],
  {
    preserveUnmatchedLocal = false
  }: {
    preserveUnmatchedLocal?: boolean;
  } = {}
) {
  const localById = new Map(
    localReceipts.map((receipt) => [receipt.id, receipt])
  );
  const mergedServer = serverReceipts.map((serverReceipt) => {
    const localReceipt = localById.get(serverReceipt.id);
    if (!localReceipt) return serverReceipt;
    localById.delete(serverReceipt.id);
    if (serverReceipt.confirmed) return serverReceipt;
    const localVersion = localReceipt.reviewVersion ?? -1;
    const serverVersion = serverReceipt.reviewVersion ?? -1;
    if (
      !localReceipt.confirmed
      && !localReceipt.pendingSync
      && localVersion <= serverVersion
    ) {
      if (
        localVersion === serverVersion
        && localReceipt.confirmationIdempotencyKey
        && localReceipt.confirmationOccurredAt
        && localReceipt.confirmationRevision !== undefined
        && localReceipt.confirmationRevision === localReceipt.localRevision
      ) {
        return {
          ...serverReceipt,
          localRevision: localReceipt.localRevision,
          confirmationIdempotencyKey:
            localReceipt.confirmationIdempotencyKey,
          confirmationOccurredAt: localReceipt.confirmationOccurredAt,
          confirmationRevision: localReceipt.confirmationRevision
        };
      }
      return serverReceipt;
    }
    return {
      ...serverReceipt,
      ...localReceipt,
      materialChanges:
        localReceipt.materialChanges ?? serverReceipt.materialChanges
    };
  });
  const unmatchedLocal = [...localById.values()].filter(
    (receipt) => preserveUnmatchedLocal || receipt.pendingSync
  );

  return [...unmatchedLocal, ...mergedServer];
}
