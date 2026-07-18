import { timingSafeEqual } from "node:crypto";

function secretMatches(expected, supplied) {
  if (typeof expected !== "string" || !expected) return false;
  if (typeof supplied !== "string") return false;
  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(supplied);
  return expectedBytes.length === suppliedBytes.length
    && timingSafeEqual(expectedBytes, suppliedBytes);
}

function bearerToken(request) {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return null;
  return authorization.slice("Bearer ".length);
}

export function createBearerAuthenticator({
  apiKey,
  merchantId,
}) {
  if (!apiKey) throw new Error("apiKey is required");
  if (!merchantId) throw new Error("merchantId is required");

  return async (request) => {
    const token = bearerToken(request);
    return secretMatches(apiKey, token)
      ? { authenticated: true, merchantId }
      : { authenticated: false };
  };
}

export function allowMerchantForTests(merchantId) {
  return async () => ({ authenticated: true, merchantId });
}
