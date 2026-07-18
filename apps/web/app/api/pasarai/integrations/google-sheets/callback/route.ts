import {
  forwardGoogleSheetsRequest,
  googleSheetsCallbackUrl,
  googleSheetsSettingsRedirect
} from "@/lib/google-sheets-bff";
import { requireMerchantRequest } from "@/lib/merchant-auth";

export async function GET(request: Request) {
  const auth = requireMerchantRequest(request);
  if ("response" in auth) {
    return googleSheetsSettingsRedirect(request, "error");
  }

  const params = new URL(request.url).searchParams;
  const code = params.get("code");
  const state = params.get("state");
  if (!code || !state) {
    return googleSheetsSettingsRedirect(request, "error");
  }

  const response = await forwardGoogleSheetsRequest("/oauth/complete", {
    method: "POST",
    body: {
      code,
      state,
      redirect_uri: googleSheetsCallbackUrl(request)
    },
    idempotencyKey:
      request.headers.get("idempotency-key")
      ?? `google-sheets-oauth-complete:${state}`
  });

  return googleSheetsSettingsRedirect(
    request,
    response.ok ? "connected" : "error"
  );
}
