import type { GoogleSheetsReconcileRequest } from "@pasarai/contracts/v1";

import {
  forwardGoogleSheetsRequest,
  parseGoogleSheetsRequest
} from "@/lib/google-sheets-bff";
import {
  requireMerchantRequest,
  requireSameOrigin
} from "@/lib/merchant-auth";

export async function POST(request: Request) {
  const auth = requireMerchantRequest(request);
  if ("response" in auth) return auth.response;
  const originError = requireSameOrigin(request);
  if (originError) return originError;

  const parsed = await parseGoogleSheetsRequest(
    request,
    "google-sheets-reconcile.request"
  );
  if (!parsed.ok) return parsed.response;
  const body = parsed.body as GoogleSheetsReconcileRequest;

  return forwardGoogleSheetsRequest("/reconcile", {
    method: "POST",
    body: {
      ...body,
      product_id: auth.merchant.productId
    } satisfies GoogleSheetsReconcileRequest,
    expectedOperation: "reconcile",
    idempotencyKey: request.headers.get("idempotency-key") ?? undefined
  });
}
