"use client";

import type {
  CostsResponse,
  ReceiptConfirmRequest,
  ReceiptReviewsResponse,
  ReceiptReviewUpsertRequest,
  ReceiptReviewUpsertResponse,
  ReceiptUploadRequest,
  ReceiptUploadResponse
} from "@pasarai/contracts/v1";

import type { ReceiptReviewRecord } from "@/lib/dashboard-types";
import { sanitizeReceiptReviewRecord } from "@/lib/receipt-review-storage";

function fileBase64(file: File) {
  return file.arrayBuffer().then((buffer) => {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  });
}

export async function postReceiptUpload({
  file,
  merchantId
}: {
  file: File;
  merchantId: string;
}): Promise<ReceiptUploadResponse> {
  if (!["image/jpeg", "image/png"].includes(file.type)) {
    throw new Error("Receipt must be a JPG or PNG image.");
  }

  const request: ReceiptUploadRequest = {
    merchant_id: merchantId,
    occurred_at: new Date().toISOString(),
    file_name: file.name,
    content_type: file.type as ReceiptUploadRequest["content_type"],
    content_base64: await fileBase64(file)
  };
  const response = await fetch("/api/pasarai/receipts/extract", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": crypto.randomUUID()
    },
    body: JSON.stringify(request)
  });
  const payload = (await response.json()) as
    | ReceiptUploadResponse
    | { error?: string };

  if (!response.ok || !("state" in payload)) {
    throw new Error(
      "error" in payload && payload.error
        ? payload.error
        : "Receipt extraction is unavailable."
    );
  }
  return payload;
}

export async function postReceiptConfirmation({
  merchantId,
  receiptEventId,
  extraction,
  occurredAt,
  idempotencyKey
}: {
  merchantId: string;
  receiptEventId: string;
  extraction: ReceiptConfirmRequest["extraction"];
  occurredAt: string;
  idempotencyKey: string;
}): Promise<CostsResponse> {
  const request: ReceiptConfirmRequest = {
    merchant_id: merchantId,
    receipt_event_id: receiptEventId,
    occurred_at: occurredAt,
    extraction
  };
  const response = await fetch("/api/pasarai/receipts/confirm", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": idempotencyKey
    },
    body: JSON.stringify(request)
  });
  const payload = (await response.json()) as
    | CostsResponse
    | { error?: string };
  if (!response.ok || !("state" in payload)) {
    throw new Error(
      "error" in payload && payload.error
        ? payload.error
        : "Receipt confirmation is unavailable."
    );
  }
  return payload;
}

export function receiptEvidenceUrl(uri: string | null) {
  if (!uri) return "";
  return uri.startsWith("pasarai-evidence:")
    ? `/api/pasarai/evidence?uri=${encodeURIComponent(uri)}`
    : uri;
}

export function receiptReviewRecords(
  response: ReceiptReviewsResponse
): ReceiptReviewRecord[] {
  return response.receipts.map((receipt) =>
    sanitizeReceiptReviewRecord({
      id: receipt.receipt_event_id,
      title: receipt.title,
      imageUrl: receiptEvidenceUrl(receipt.image_uri),
      evidenceUri: receipt.image_uri,
      extraction: receipt.extraction,
      sourceEventId: receipt.receipt_event_id,
      readyToConfirm: !receipt.confirmed,
      confirmed: receipt.confirmed,
      reviewVersion: receipt.version,
      updatedAt: receipt.updated_at,
      costEventId: receipt.cost_event_id,
      verifiedAt: receipt.verified_at,
      materialChanges: receipt.material_changes.map((change) => ({
        componentId: change.component_id,
        componentName: change.component_name,
        productId: change.product_id,
        quantity: change.quantity,
        uom: change.uom,
        packSize: change.pack_size,
        totalPriceRm: change.total_price_rm,
        previousCostRmPerPack: change.previous_cost_rm_per_pack,
        currentCostRmPerPack: change.current_cost_rm_per_pack,
        changeRmPerPack: change.change_rm_per_pack
      }))
    })
  );
}

export async function getReceiptReviews({
  merchantId: _merchantId
}: {
  merchantId: string;
}): Promise<ReceiptReviewsResponse> {
  const response = await fetch("/api/pasarai/receipts/reviews", {
    cache: "no-store",
    headers: { accept: "application/json" }
  });
  const payload = (await response.json()) as
    | ReceiptReviewsResponse
    | { error?: string };
  if (!response.ok || !("receipts" in payload)) {
    throw new Error(
      "error" in payload && payload.error
        ? payload.error
        : "Receipt history is unavailable."
    );
  }
  return payload;
}

export async function postReceiptReview({
  merchantId,
  receiptEventId,
  extraction,
  reviewState
}: {
  merchantId: string;
  receiptEventId: string;
  extraction: ReceiptReviewUpsertRequest["extraction"];
  reviewState: ReceiptReviewUpsertRequest["review_state"];
}): Promise<ReceiptReviewUpsertResponse> {
  const request: ReceiptReviewUpsertRequest = {
    merchant_id: merchantId,
    receipt_event_id: receiptEventId,
    occurred_at: new Date().toISOString(),
    review_state: reviewState,
    extraction
  };
  const response = await fetch("/api/pasarai/receipts/reviews", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": crypto.randomUUID()
    },
    body: JSON.stringify(request)
  });
  const payload = (await response.json()) as
    | ReceiptReviewUpsertResponse
    | { error?: string };
  if (!response.ok || !("review_event_id" in payload)) {
    throw new Error(
      "error" in payload && payload.error
        ? payload.error
        : "Receipt review could not be saved."
    );
  }
  return payload;
}
