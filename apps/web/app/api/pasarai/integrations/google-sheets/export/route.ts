import type { GoogleSheetsExportRequest } from "@pasarai/contracts/v1";

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
    "google-sheets-export.request"
  );
  if (!parsed.ok) return parsed.response;

  return forwardGoogleSheetsRequest("/export", {
    method: "POST",
    body: parsed.body as GoogleSheetsExportRequest,
    expectedOperation: "export",
    idempotencyKey: request.headers.get("idempotency-key") ?? undefined
  });
}
