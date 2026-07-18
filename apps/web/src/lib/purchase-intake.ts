"use client";

import type {
  CostsResponse,
  PurchaseIntakeConfirmRequest,
  PurchaseIntakeUpsertRequest,
  PurchaseIntakeUpsertResponse
} from "@pasarai/contracts/v1";

type ErrorPayload = {
  error?: unknown;
  message?: unknown;
};

function errorMessage(payload: ErrorPayload | null, fallback: string) {
  const message =
    typeof payload?.message === "string"
      ? payload.message
      : typeof payload?.error === "string"
        ? payload.error
        : null;
  return message?.trim() || fallback;
}

async function postJson<T>(
  path: string,
  body: PurchaseIntakeUpsertRequest | PurchaseIntakeConfirmRequest,
  idempotencyKey: string,
  fallback: string
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": idempotencyKey
      },
      body: JSON.stringify(body)
    });
  } catch {
    throw new Error(fallback);
  }

  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(errorMessage(payload as ErrorPayload | null, fallback));
  }
  return payload as T;
}

export function postPurchaseIntake(
  request: PurchaseIntakeUpsertRequest,
  idempotencyKey: string
): Promise<PurchaseIntakeUpsertResponse> {
  return postJson(
    "/api/pasarai/purchase-intakes",
    request,
    idempotencyKey,
    "The purchase could not be saved for review."
  );
}

export function confirmPurchaseIntake(
  request: PurchaseIntakeConfirmRequest,
  idempotencyKey: string
): Promise<CostsResponse> {
  return postJson(
    "/api/pasarai/purchase-intakes/confirm",
    request,
    idempotencyKey,
    "The purchase could not be confirmed."
  );
}
