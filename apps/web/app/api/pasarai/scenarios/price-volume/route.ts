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
  const errors = validateContract(
    "price-volume-scenario.request",
    bound.payload
  );
  if (errors.length) {
    return Response.json(
      { error: "Invalid price-volume scenario.", details: errors },
      { status: 400 }
    );
  }
  const url = new URL(
    "/api/v1/scenarios/price-volume",
    configured.apiBaseUrl
  );
  try {
    const response = await fetch(url, {
      method: "POST",
      cache: "no-store",
      headers: {
        authorization: `Bearer ${configured.apiBearerToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(bound.payload)
    });
    const body: unknown = await response.json().catch(() => null);
    if (
      response.ok
      && validateContract("price-volume-scenario.response", body).length
    ) {
      return Response.json(
        { error: "PasarAI API returned an invalid scenario matrix." },
        { status: 502 }
      );
    }
    return Response.json(body, { status: response.status });
  } catch {
    return Response.json(
      { error: "Scenario service is temporarily unreachable." },
      { status: 503 }
    );
  }
}
