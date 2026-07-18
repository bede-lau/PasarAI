import {
  accessCodeMatches,
  authConfiguration,
  clearMerchantSessionCookie,
  createMerchantSessionCookie,
  merchantFromCookieHeader,
  requireSameOrigin
} from "@/lib/merchant-auth";
import { safeInternalPath } from "@/lib/safe-redirect";

export async function GET(request: Request) {
  const merchant = merchantFromCookieHeader(request.headers.get("cookie"));
  return merchant
    ? Response.json({ merchant })
    : Response.json({ error: "Authentication required." }, { status: 401 });
}

export async function POST(request: Request) {
  const originError = requireSameOrigin(request);
  if (originError) return originError;

  const configured = authConfiguration();
  if (!configured || !process.env.PASARAI_WEB_ACCESS_CODE) {
    return Response.json(
      { error: "PasarAI merchant authentication is not configured." },
      { status: 503 }
    );
  }

  const contentType = request.headers.get("content-type") ?? "";
  const input = contentType.includes("application/json")
    ? ((await request.json().catch(() => null)) as Record<string, unknown> | null)
    : Object.fromEntries(await request.formData());
  const accessCode =
    typeof input?.access_code === "string" ? input.access_code : "";
  const next = safeInternalPath(input?.next, request.url);

  if (!accessCodeMatches(accessCode)) {
    if (!contentType.includes("application/json")) {
      return Response.redirect(
        new URL(
          `/login?error=invalid&next=${encodeURIComponent(next)}`,
          request.url
        ),
        303
      );
    }
    return Response.json({ error: "Invalid access code." }, { status: 401 });
  }

  const headers = new Headers({
    "set-cookie": createMerchantSessionCookie(configured.merchant)
  });
  if (!contentType.includes("application/json")) {
    headers.set("location", new URL(next, request.url).toString());
    return new Response(null, { status: 303, headers });
  }
  return Response.json({ merchant: configured.merchant }, { headers });
}

export async function DELETE(request: Request) {
  const originError = requireSameOrigin(request);
  if (originError) return originError;
  return Response.json(
    { ok: true },
    { headers: { "set-cookie": clearMerchantSessionCookie() } }
  );
}
