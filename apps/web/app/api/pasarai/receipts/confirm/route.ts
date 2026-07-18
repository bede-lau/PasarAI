import { validateContract } from "@pasarai/contracts/v1";

import {
  bindMerchantPayload,
  requireMerchantRequest,
  requireSameOrigin
} from "@/lib/merchant-auth";

export async function POST(request: Request) {
  const auth = requireMerchantRequest(request);
  if ("response" in auth) return auth.response;
  const originError = requireSameOrigin(request);
  if (originError) return originError;

  const apiBaseUrl = process.env.PASARAI_API_BASE_URL;
  const apiBearerToken = process.env.PASARAI_API_BEARER_TOKEN;
  if (!apiBaseUrl || !apiBearerToken) {
    return Response.json(
      { error: "PasarAI API proxy is not configured." },
      { status: 503 }
    );
  }

  const input: unknown = await request.json().catch(() => null);
  const bound = bindMerchantPayload(input, auth.merchant.id);
  if ("response" in bound) return bound.response;
  const payload = bound.payload;
  const requestErrors = validateContract("receipt-confirm.request", payload);
  if (requestErrors.length > 0) {
    return Response.json(
      { error: "Invalid receipt confirmation.", details: requestErrors },
      { status: 400 }
    );
  }

  const response = await fetch(
    new URL("/api/v1/receipts/confirm", apiBaseUrl),
    {
      method: "POST",
      cache: "no-store",
      headers: {
        authorization: `Bearer ${apiBearerToken}`,
        "content-type": "application/json",
        "idempotency-key":
          request.headers.get("idempotency-key") ?? crypto.randomUUID()
      },
      body: JSON.stringify(payload)
    }
  );
  const body: unknown = await response.json().catch(() => ({
    error: "PasarAI API returned an unreadable response."
  }));
  if (response.ok) {
    const responseErrors = validateContract("costs.response", body);
    if (responseErrors.length > 0) {
      return Response.json(
        { error: "PasarAI API returned an invalid costs response." },
        { status: 502 }
      );
    }
  }
  return Response.json(body, { status: response.status });
}
