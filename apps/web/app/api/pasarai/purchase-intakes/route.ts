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
  const requestErrors = validateContract(
    "purchase-intake-upsert.request",
    payload
  );
  if (requestErrors.length > 0) {
    return Response.json(
      { error: "Invalid purchase intake.", details: requestErrors },
      { status: 400 }
    );
  }

  let response: Response;
  try {
    response = await fetch(
      new URL("/api/v1/purchase-intakes", apiBaseUrl),
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
  } catch {
    return Response.json(
      { error: "The purchase service is temporarily unreachable." },
      { status: 503 }
    );
  }

  const body: unknown = await response.json().catch(() => ({
    error: "PasarAI API returned an unreadable response."
  }));
  if (
    response.ok
    && validateContract("purchase-intake-upsert.response", body).length > 0
  ) {
    return Response.json(
      { error: "PasarAI API returned an invalid purchase intake response." },
      { status: 502 }
    );
  }
  return Response.json(body, { status: response.status });
}
