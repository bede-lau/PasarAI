import { validateContract } from "@pasarai/contracts/v1";

import {
  bindMerchantPayload,
  requireMerchantRequest,
  requireSameOrigin
} from "@/lib/merchant-auth";

function configuration() {
  const apiBaseUrl = process.env.PASARAI_API_BASE_URL;
  const apiBearerToken = process.env.PASARAI_API_BEARER_TOKEN;
  return apiBaseUrl && apiBearerToken
    ? { apiBaseUrl, apiBearerToken }
    : null;
}

export async function POST(request: Request) {
  const auth = requireMerchantRequest(request);
  if ("response" in auth) return auth.response;
  const originError = requireSameOrigin(request);
  if (originError) return originError;

  const configured = configuration();
  if (!configured) {
    return Response.json(
      { error: "PasarAI API proxy is not configured." },
      { status: 503 }
    );
  }

  const input: unknown = await request.json().catch(() => null);
  const bound = bindMerchantPayload(input, auth.merchant.id);
  if ("response" in bound) return bound.response;
  const payload = bound.payload;
  const requestErrors = validateContract("receipt-upload.request", payload);
  if (requestErrors.length > 0) {
    return Response.json(
      { error: "Invalid receipt upload request.", details: requestErrors },
      { status: 400 }
    );
  }

  const idempotencyKey =
    request.headers.get("idempotency-key") ?? crypto.randomUUID();
  const url = new URL("/api/v1/receipts/extract", configured.apiBaseUrl);
  const response = await fetch(url, {
    method: "POST",
    cache: "no-store",
    headers: {
      authorization: `Bearer ${configured.apiBearerToken}`,
      "content-type": "application/json",
      "idempotency-key": idempotencyKey
    },
    body: JSON.stringify(payload)
  });
  const body: unknown = await response.json().catch(() => ({
    error: "PasarAI API returned an unreadable response."
  }));

  if (response.ok) {
    const responseErrors = validateContract("receipt-upload.response", body);
    if (responseErrors.length > 0) {
      return Response.json(
        { error: "PasarAI API returned an invalid receipt response." },
        { status: 502 }
      );
    }
  }

  return Response.json(body, { status: response.status });
}
