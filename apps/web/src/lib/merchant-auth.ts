import { createHmac, timingSafeEqual } from "node:crypto";

import {
  getDeploymentMerchant,
  type MerchantContext
} from "@/lib/merchant";

export const merchantSessionCookieName = "pasarai_session";

const sessionMaxAgeSeconds = 60 * 60 * 12;

type SessionPayload = {
  version: 1;
  merchant_id: string;
  expires_at: number;
};

export function webAuthenticationRequired() {
  return process.env.PASARAI_WEB_AUTH_REQUIRED !== "0";
}

function sessionSecret() {
  const secret = process.env.PASARAI_WEB_SESSION_SECRET;
  return secret && secret.length >= 32 ? secret : null;
}

function sign(value: string, secret: string) {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

function equalSecret(left: string, right: string) {
  const leftDigest = createHmac("sha256", "pasarai-access-code")
    .update(left)
    .digest();
  const rightDigest = createHmac("sha256", "pasarai-access-code")
    .update(right)
    .digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

function cookieValue(cookieHeader: string | null, name: string) {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) {
      return part.slice(separator + 1).trim();
    }
  }
  return null;
}

export function authConfiguration() {
  const merchant = getDeploymentMerchant();
  const secret = sessionSecret();
  return merchant && secret ? { merchant, secret } : null;
}

export function accessCodeMatches(candidate: string) {
  const configured = process.env.PASARAI_WEB_ACCESS_CODE;
  return Boolean(configured) && equalSecret(candidate, configured ?? "");
}

export function createMerchantSessionCookie(
  merchant: MerchantContext,
  now = Date.now()
) {
  const configured = authConfiguration();
  if (!configured || configured.merchant.id !== merchant.id) {
    throw new Error("PasarAI merchant authentication is not configured.");
  }

  const payload: SessionPayload = {
    version: 1,
    merchant_id: merchant.id,
    expires_at: Math.floor(now / 1000) + sessionMaxAgeSeconds
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const value = `${encoded}.${sign(encoded, configured.secret)}`;
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${merchantSessionCookieName}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${sessionMaxAgeSeconds}${secure}`;
}

export function clearMerchantSessionCookie() {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${merchantSessionCookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

export function merchantFromCookieHeader(
  cookieHeader: string | null,
  now = Date.now()
): MerchantContext | null {
  if (!webAuthenticationRequired()) return getDeploymentMerchant();

  const configured = authConfiguration();
  if (!configured) return null;

  const value = cookieValue(cookieHeader, merchantSessionCookieName);
  if (!value) return null;
  const separator = value.lastIndexOf(".");
  if (separator < 1) return null;
  const encoded = value.slice(0, separator);
  const providedSignature = value.slice(separator + 1);
  const expectedSignature = sign(encoded, configured.secret);
  const provided = Buffer.from(providedSignature);
  const expected = Buffer.from(expectedSignature);
  if (
    provided.length !== expected.length ||
    !timingSafeEqual(provided, expected)
  ) {
    return null;
  }

  try {
    const payload = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8")
    ) as Partial<SessionPayload>;
    if (
      payload.version !== 1 ||
      payload.merchant_id !== configured.merchant.id ||
      typeof payload.expires_at !== "number" ||
      payload.expires_at <= Math.floor(now / 1000)
    ) {
      return null;
    }
    return configured.merchant;
  } catch {
    return null;
  }
}

export function requireMerchantRequest(request: Request):
  | { merchant: MerchantContext }
  | { response: Response } {
  if (!webAuthenticationRequired()) {
    const merchant = getDeploymentMerchant();
    return merchant
      ? { merchant }
      : {
          response: Response.json(
            { error: "PasarAI deployment merchant is not configured." },
            { status: 503 }
          )
        };
  }

  if (!authConfiguration()) {
    return {
      response: Response.json(
        { error: "PasarAI merchant authentication is not configured." },
        { status: 503 }
      )
    };
  }
  const merchant = merchantFromCookieHeader(request.headers.get("cookie"));
  return merchant
    ? { merchant }
    : {
        response: Response.json(
          { error: "Authentication required." },
          { status: 401 }
        )
      };
}

export function requireSameOrigin(request: Request): Response | null {
  const origin = request.headers.get("origin");
  if (!origin || origin !== new URL(request.url).origin) {
    return Response.json(
      { error: "Request origin is not allowed." },
      { status: 403 }
    );
  }
  return null;
}

export function bindMerchantPayload(
  payload: unknown,
  merchantId: string
): { payload: unknown } | { response: Response } {
  if (
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    return { payload };
  }
  const record = payload as Record<string, unknown>;
  if (
    typeof record.merchant_id === "string" &&
    record.merchant_id !== merchantId
  ) {
    return {
      response: Response.json(
        { error: "Merchant does not match the authenticated session." },
        { status: 403 }
      )
    };
  }
  return { payload: { ...record, merchant_id: merchantId } };
}
