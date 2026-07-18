"use client";

import type { PurchaseIntakeUpsertResponse } from "@pasarai/contracts/v1";

export type CashPurchaseDraft = {
  componentId: string;
  supplier: string;
  quantity: string;
  uom: string;
  packSize: string;
  totalPaid: string;
  date: string;
  note: string;
};

export type CashPurchaseRecovery = {
  draft: CashPurchaseDraft;
  reviewedDraft: CashPurchaseDraft | null;
  review: PurchaseIntakeUpsertResponse | null;
  upsertKey: string;
  confirmKey: string;
  phase: "entry" | "review";
  rotateUpsertKeyOnEdit: boolean;
};

const STORAGE_VERSION = 1;
const STORAGE_PREFIX = "pasarai.cash-purchase";

type StoredCashPurchaseRecovery = CashPurchaseRecovery & {
  version: typeof STORAGE_VERSION;
};

function isDraft(value: unknown): value is CashPurchaseDraft {
  if (!value || typeof value !== "object") return false;
  const draft = value as Partial<CashPurchaseDraft>;
  return [
    "componentId",
    "supplier",
    "quantity",
    "uom",
    "packSize",
    "totalPaid",
    "date",
    "note"
  ].every((field) => typeof draft[field as keyof CashPurchaseDraft] === "string");
}

function isReview(value: unknown): value is PurchaseIntakeUpsertResponse {
  if (!value || typeof value !== "object") return false;
  const review = value as Partial<PurchaseIntakeUpsertResponse>;
  return typeof review.intake_id === "string"
    && typeof review.version === "number"
    && typeof review.state === "string"
    && Boolean(review.summary && typeof review.summary === "object");
}

export function cashPurchaseStorageKey(merchantId: string) {
  return `${STORAGE_PREFIX}:${merchantId}`;
}

export function loadCashPurchaseRecovery(
  storage: Storage,
  merchantId: string
): CashPurchaseRecovery | null {
  try {
    const raw = storage.getItem(cashPurchaseStorageKey(merchantId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredCashPurchaseRecovery>;
    if (
      parsed.version !== STORAGE_VERSION
      || !isDraft(parsed.draft)
      || (
        parsed.reviewedDraft !== null
        && !isDraft(parsed.reviewedDraft)
      )
      || (parsed.review !== null && !isReview(parsed.review))
      || typeof parsed.upsertKey !== "string"
      || !parsed.upsertKey
      || typeof parsed.confirmKey !== "string"
      || !parsed.confirmKey
      || (parsed.phase !== "entry" && parsed.phase !== "review")
      || typeof parsed.rotateUpsertKeyOnEdit !== "boolean"
    ) {
      return null;
    }
    if (parsed.phase === "review" && !parsed.review?.confirmation_token) {
      return null;
    }
    return parsed as CashPurchaseRecovery;
  } catch {
    return null;
  }
}

export function saveCashPurchaseRecovery(
  storage: Storage,
  merchantId: string,
  recovery: CashPurchaseRecovery
) {
  try {
    const payload: StoredCashPurchaseRecovery = {
      version: STORAGE_VERSION,
      ...recovery
    };
    storage.setItem(
      cashPurchaseStorageKey(merchantId),
      JSON.stringify(payload)
    );
    return true;
  } catch {
    return false;
  }
}

export function clearCashPurchaseRecovery(
  storage: Storage,
  merchantId: string
) {
  try {
    storage.removeItem(cashPurchaseStorageKey(merchantId));
    return true;
  } catch {
    return false;
  }
}
