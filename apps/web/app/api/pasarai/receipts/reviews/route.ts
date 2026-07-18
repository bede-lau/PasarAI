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

export async function GET(request: Request) {
  const auth = requireMerchantRequest(request);
  if ("response" in auth) return auth.response;

  const configured = configuration();
  if (!configured) {
    return Response.json(
      { error: "PasarAI API proxy is not configured." },
      { status: 503 }
    );
  }

  const url = new URL("/api/v1/receipts/reviews", configured.apiBaseUrl);
  url.searchParams.set("merchant_id", auth.merchant.id);
  const response = await fetch(url, {
    cache: "no-store",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${configured.apiBearerToken}`
    }
  });
  const body: unknown = await response.json().catch(() => ({
    error: "PasarAI API returned an unreadable response."
  }));
  if (response.ok) {
    const responseErrors = validateContract("receipt-reviews.response", body);
    if (responseErrors.length > 0) {
      return Response.json(
        { error: "PasarAI API returned an invalid receipt history." },
        { status: 502 }
      );
    }
  }
  return Response.json(body, { status: response.status });
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
  const requestErrors = validateContract(
    "receipt-review-upsert.request",
    payload
  );
  if (requestErrors.length > 0) {
    return Response.json(
      { error: "Invalid receipt review.", details: requestErrors },
      { status: 400 }
    );
  }

  const response = await fetch(
    new URL("/api/v1/receipts/reviews", configured.apiBaseUrl),
    {
      method: "POST",
      cache: "no-store",
      headers: {
        authorization: `Bearer ${configured.apiBearerToken}`,
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
    const responseErrors = validateContract(
      "receipt-review-upsert.response",
      body
    );
    if (responseErrors.length > 0) {
      return Response.json(
        { error: "PasarAI API returned an invalid receipt review response." },
        { status: 502 }
      );
    }
  }
  return Response.json(body, { status: response.status });
}
