import { validateContract } from "@pasarai/contracts/v1";

import { requireMerchantRequest } from "@/lib/merchant-auth";

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
  const incoming = new URL(request.url);
  const from = incoming.searchParams.get("from");
  const to = incoming.searchParams.get("to");
  if (!from || !to) {
    return Response.json(
      { error: "from and to query parameters are required." },
      { status: 400 }
    );
  }
  const url = new URL("/api/v1/analytics/activity", configured.apiBaseUrl);
  url.searchParams.set("merchant_id", auth.merchant.id);
  url.searchParams.set("product_id", auth.merchant.productId);
  url.searchParams.set("from", from);
  url.searchParams.set("to", to);

  try {
    const response = await fetch(url, {
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
      headers: {
        accept: "application/json",
        authorization: `Bearer ${configured.apiBearerToken}`
      }
    });
    const body: unknown = await response.json().catch(() => null);
    if (
      response.ok
      && validateContract("analytics-activity.response", body).length
    ) {
      return Response.json(
        { error: "PasarAI API returned an invalid activity timeline." },
        { status: 502 }
      );
    }
    return Response.json(body, { status: response.status });
  } catch {
    return Response.json(
      { error: "Activity timeline is temporarily unreachable." },
      { status: 503 }
    );
  }
}
