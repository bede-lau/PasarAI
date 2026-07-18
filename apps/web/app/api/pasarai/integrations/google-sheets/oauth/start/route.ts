import {
  forwardGoogleSheetsRequest,
  googleSheetsCallbackUrl,
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

  const redirectUri = googleSheetsCallbackUrl(request);
  const parsed = await parseGoogleSheetsRequest(
    request,
    "google-sheets-oauth-start.request",
    { redirect_uri: redirectUri }
  );
  if (!parsed.ok) return parsed.response;

  const input = parsed.body as {
    redirect_uri: string;
    spreadsheet_id?: string;
  };
  const spreadsheetId = input.spreadsheet_id;

  const normalizedSpreadsheetId = spreadsheetId?.trim();
  return forwardGoogleSheetsRequest("/oauth/start", {
    method: "POST",
    body: {
      redirect_uri: redirectUri,
      ...(normalizedSpreadsheetId
        ? { spreadsheet_id: normalizedSpreadsheetId }
        : {})
    },
    idempotencyKey: request.headers.get("idempotency-key") ?? undefined
  });
}
