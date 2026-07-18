import { validateContract } from "@pasarai/contracts/v1";

const integrationPath = "/api/v1/integrations/google-sheets";

type GoogleSheetsUpstreamPath =
  | ""
  | "/oauth/start"
  | "/oauth/complete"
  | "/export"
  | "/import"
  | "/reconcile"
  | "/sync-mode"
  | "/disconnect";

const responseSchemas: Record<GoogleSheetsUpstreamPath, string> = {
  "": "google-sheets-status.response",
  "/oauth/start": "google-sheets-oauth-start.response",
  "/oauth/complete": "google-sheets-status.response",
  "/export": "google-sheets-sync.response",
  "/import": "google-sheets-sync.response",
  "/reconcile": "google-sheets-sync.response",
  "/sync-mode": "google-sheets-status.response",
  "/disconnect": "google-sheets-disconnect.response"
};

function configuration() {
  const apiBaseUrl = process.env.PASARAI_API_BASE_URL;
  const apiBearerToken = process.env.PASARAI_API_BEARER_TOKEN;
  return apiBaseUrl && apiBearerToken
    ? { apiBaseUrl, apiBearerToken }
    : null;
}

export function googleSheetsCallbackUrl(request: Request) {
  return new URL(
    "/api/pasarai/integrations/google-sheets/callback",
    request.url
  ).toString();
}

export function googleSheetsSettingsRedirect(
  request: Request,
  result: "connected" | "error"
) {
  const url = new URL("/settings/integrations", request.url);
  url.searchParams.set("google_sheets", result);
  return Response.redirect(url, 303);
}

type ParsedGoogleSheetsRequest =
  | { ok: true; body: unknown }
  | { ok: false; response: Response };

export async function parseGoogleSheetsRequest(
  request: Request,
  schemaId: string,
  defaults?: Record<string, unknown>
): Promise<ParsedGoogleSheetsRequest> {
  const text = await request.text();
  let body: unknown = {};
  if (text.trim()) {
    try {
      body = JSON.parse(text);
    } catch {
      return {
        ok: false,
        response: Response.json(
          { error: "Request body must be valid JSON." },
          { status: 400 }
        )
      };
    }
  }

  const validationBody = defaults
    && body
    && typeof body === "object"
    && !Array.isArray(body)
    ? { ...defaults, ...body }
    : body;
  const errors = validateContract(schemaId, validationBody);
  if (errors.length) {
    return {
      ok: false,
      response: Response.json(
        { error: "Invalid Google Sheets request.", details: errors },
        { status: 400 }
      )
    };
  }
  return { ok: true, body: validationBody };
}

export async function forwardGoogleSheetsRequest(
  path: GoogleSheetsUpstreamPath,
  init?: {
    method?: "GET" | "POST";
    body?: unknown;
    expectedOperation?: "export" | "import" | "reconcile";
    idempotencyKey?: string;
  }
) {
  const configured = configuration();
  if (!configured) {
    return Response.json(
      { error: "PasarAI API proxy is not configured." },
      { status: 503 }
    );
  }

  const method = init?.method ?? "GET";
  const headers: Record<string, string> = {
    authorization: `Bearer ${configured.apiBearerToken}`
  };
  if (method === "POST") {
    headers["content-type"] = "application/json";
    headers["idempotency-key"] =
      init?.idempotencyKey?.trim() || crypto.randomUUID();
  }

  let response: Response;
  try {
    response = await fetch(
      new URL(`${integrationPath}${path}`, configured.apiBaseUrl),
      {
        method,
        cache: "no-store",
        headers,
        body: method === "POST" ? JSON.stringify(init?.body ?? {}) : undefined
      }
    );
  } catch {
    return Response.json(
      { error: "The Google Sheets service is temporarily unreachable." },
      { status: 503 }
    );
  }

  const body: unknown = await response.json().catch(() => ({
    error: "PasarAI API returned an unreadable response."
  }));
  if (response.ok) {
    const errors = validateContract(responseSchemas[path], body);
    if (errors.length) {
      return Response.json(
        { error: "PasarAI API returned an invalid Google Sheets response." },
        { status: 502 }
      );
    }
    if (
      init?.expectedOperation
      && (
        !body
        || typeof body !== "object"
        || Array.isArray(body)
        || (body as Record<string, unknown>).operation
          !== init.expectedOperation
      )
    ) {
      return Response.json(
        { error: "PasarAI API returned the wrong Google Sheets operation." },
        { status: 502 }
      );
    }
  }
  return Response.json(body, {
    status: response.status,
    headers: { "cache-control": "private, no-store" }
  });
}
