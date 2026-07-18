import { requireMerchantRequest } from "@/lib/merchant-auth";

export async function GET(request: Request) {
  const auth = requireMerchantRequest(request);
  if ("response" in auth) return auth.response;

  const apiBaseUrl = process.env.PASARAI_API_BASE_URL;
  const apiBearerToken = process.env.PASARAI_API_BEARER_TOKEN;
  if (!apiBaseUrl || !apiBearerToken) {
    return Response.json(
      { error: "PasarAI API proxy is not configured." },
      { status: 503 }
    );
  }
  const source = new URL(request.url).searchParams.get("uri");
  if (!source?.startsWith("pasarai-evidence:")) {
    return Response.json({ error: "Invalid evidence URI." }, { status: 400 });
  }

  const url = new URL("/api/v1/evidence", apiBaseUrl);
  url.searchParams.set("uri", source);
  const response = await fetch(url, {
    cache: "no-store",
    headers: {
      authorization: `Bearer ${apiBearerToken}`
    }
  });
  if (!response.ok) {
    return Response.json(
      { error: "Evidence could not be loaded." },
      { status: response.status }
    );
  }
  return new Response(await response.arrayBuffer(), {
    headers: {
      "cache-control": "private, no-store",
      "content-type":
        response.headers.get("content-type") ?? "application/octet-stream"
    }
  });
}
