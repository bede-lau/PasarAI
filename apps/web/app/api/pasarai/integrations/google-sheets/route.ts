import { forwardGoogleSheetsRequest } from "@/lib/google-sheets-bff";
import { requireMerchantRequest } from "@/lib/merchant-auth";

export async function GET(request: Request) {
  const auth = requireMerchantRequest(request);
  if ("response" in auth) return auth.response;

  return forwardGoogleSheetsRequest("");
}
