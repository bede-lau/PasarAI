import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET as completeOAuth } from "../app/api/pasarai/integrations/google-sheets/callback/route";
import { POST as disconnectGoogleSheets } from "../app/api/pasarai/integrations/google-sheets/disconnect/route";
import { POST as exportGoogleSheets } from "../app/api/pasarai/integrations/google-sheets/export/route";
import { POST as importGoogleSheets } from "../app/api/pasarai/integrations/google-sheets/import/route";
import { POST as startOAuth } from "../app/api/pasarai/integrations/google-sheets/oauth/start/route";
import { POST as reconcileGoogleSheets } from "../app/api/pasarai/integrations/google-sheets/reconcile/route";
import { GET as readGoogleSheets } from "../app/api/pasarai/integrations/google-sheets/route";
import { POST as updateGoogleSheetsSyncMode } from "../app/api/pasarai/integrations/google-sheets/sync-mode/route";
import { createMerchantSessionCookie } from "../src/lib/merchant-auth";
import { getDeploymentMerchant } from "../src/lib/merchant";

const origin = "http://pasarai.test";
const callbackUrl =
  `${origin}/api/pasarai/integrations/google-sheets/callback`;

const connectedStatus = {
  state: "connected",
  spreadsheet_id: "sheet_001",
  spreadsheet_url: "https://docs.google.com/spreadsheets/d/sheet_001",
  spreadsheet_title: "PasarAI Ledger",
  sync_mode: "manual",
  last_export_at: null,
  last_import_at: null,
  last_reconciled_at: null,
  watch_expires_at: null,
  last_error: null
};

beforeEach(() => {
  process.env.PASARAI_WEB_SESSION_SECRET =
    "test-only-session-secret-with-sufficient-entropy";
  process.env.PASARAI_MERCHANT_ID = "m_production_001";
  process.env.PASARAI_MERCHANT_NAME = "Warung Production";
  process.env.PASARAI_MERCHANT_LOCATION = "Shah Alam";
  process.env.PASARAI_PRODUCT_ID = "p_production_001";
  process.env.PASARAI_PRODUCT_NAME = "Nasi Lemak Production";
  process.env.PASARAI_API_BASE_URL =
    "http://upstream.test";
  process.env.PASARAI_API_BEARER_TOKEN =
    "SERVER_ONLY_TOKEN";
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const name of [
    "PASARAI_WEB_SESSION_SECRET",
    "PASARAI_WEB_AUTH_REQUIRED",
    "PASARAI_MERCHANT_ID",
    "PASARAI_MERCHANT_NAME",
    "PASARAI_MERCHANT_LOCATION",
    "PASARAI_PRODUCT_ID",
    "PASARAI_PRODUCT_NAME",
    "PASARAI_API_BASE_URL",
    "PASARAI_API_BEARER_TOKEN"
  ]) {
    delete process.env[name];
  }
});

function sessionCookie() {
  const merchant = getDeploymentMerchant();
  expect(merchant).not.toBeNull();
  return createMerchantSessionCookie(merchant!).split(";")[0];
}

describe("Google Sheets BFF", () => {
  it("requires the merchant session before reading connection status", async () => {
    const response = await readGoogleSheets(
      new Request(`${origin}/api/pasarai/integrations/google-sheets`)
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: "Authentication required."
    });
  });

  it("forwards status with the server bearer token and no cache", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json(connectedStatus));
    vi.stubGlobal("fetch", fetchMock);

    const response = await readGoogleSheets(
      new Request(`${origin}/api/pasarai/integrations/google-sheets`, {
        headers: { cookie: sessionCookie() }
      })
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual(connectedStatus);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url.toString()).toBe(
      "http://upstream.test/api/v1/integrations/google-sheets"
    );
    expect(options.headers.authorization).toBe("Bearer SERVER_ONLY_TOKEN");
    expect(options.method).toBe("GET");
  });

  it("rejects cross-origin OAuth starts before contacting upstream", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await startOAuth(
      new Request(
        `${origin}/api/pasarai/integrations/google-sheets/oauth/start`,
        {
          method: "POST",
          headers: {
            cookie: sessionCookie(),
            origin: "https://attacker.test",
            "content-type": "application/json"
          },
          body: "{}"
        }
      )
    );

    expect(response.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("computes and forwards the OAuth callback URI server-side", async () => {
    const oauthState = "state_001_abcdefghijklmnopqrstuvwxyz";
    const oauthResponse = {
      authorization_url:
        `https://accounts.google.com/o/oauth2/v2/auth?state=${oauthState}`,
      state: oauthState,
      expires_at: "2026-07-16T14:00:00Z"
    };
    const fetchMock = vi.fn().mockResolvedValue(Response.json(oauthResponse));
    vi.stubGlobal("fetch", fetchMock);

    const response = await startOAuth(
      new Request(
        `${origin}/api/pasarai/integrations/google-sheets/oauth/start`,
        {
          method: "POST",
          headers: {
            cookie: sessionCookie(),
            origin,
            "content-type": "application/json",
            "idempotency-key": "web-oauth-start-001"
          },
          body: JSON.stringify({ spreadsheet_id: "  sheet_001  " })
        }
      )
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(oauthResponse);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url.toString()).toBe(
      "http://upstream.test/api/v1/integrations/google-sheets/oauth/start"
    );
    expect(JSON.parse(options.body)).toEqual({
      redirect_uri: callbackUrl,
      spreadsheet_id: "sheet_001"
    });
    expect(options.headers["idempotency-key"]).toBe("web-oauth-start-001");
  });

  it("completes OAuth with the signed session and redirects to success", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json(connectedStatus)
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await completeOAuth(
      new Request(`${callbackUrl}?code=code_001&state=state_001`, {
        headers: { cookie: sessionCookie() }
      })
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      `${origin}/settings/integrations?google_sheets=connected`
    );
    const [url, options] = fetchMock.mock.calls[0];
    expect(url.toString()).toBe(
      "http://upstream.test/api/v1/integrations/google-sheets/oauth/complete"
    );
    expect(JSON.parse(options.body)).toEqual({
      code: "code_001",
      state: "state_001",
      redirect_uri: callbackUrl
    });
    expect(options.headers["idempotency-key"]).toBe(
      "google-sheets-oauth-complete:state_001"
    );
  });

  it("rejects a malformed successful upstream response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      Response.json({ state: "connected" })
    ));

    const response = await readGoogleSheets(
      new Request(`${origin}/api/pasarai/integrations/google-sheets`, {
        headers: { cookie: sessionCookie() }
      })
    );

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: "PasarAI API returned an invalid Google Sheets response."
    });
  });

  it("forwards import with an empty body and validates the import operation", async () => {
    const importResponse = {
      state: "completed",
      job_id: "job_import_001",
      operation: "import",
      rows_processed: 9,
      errors: 0,
      spreadsheet_url:
        "https://docs.google.com/spreadsheets/d/sheet_001",
      completed_at: "2026-07-16T13:30:00Z"
    };
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json(importResponse)
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await importGoogleSheets(
      new Request(
        `${origin}/api/pasarai/integrations/google-sheets/import`,
        {
          method: "POST",
          headers: {
            cookie: sessionCookie(),
            origin,
            "idempotency-key": "web-import-001"
          }
        }
      )
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(importResponse);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url.toString()).toBe(
      "http://upstream.test/api/v1/integrations/google-sheets/import"
    );
    expect(options.body).toBe("{}");
    expect(options.headers.authorization).toBe("Bearer SERVER_ONLY_TOKEN");
    expect(options.headers["idempotency-key"]).toBe("web-import-001");
  });

  it("rejects a schema-valid sync response for the wrong operation", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      Response.json({
        state: "completed",
        job_id: "job_export_001",
        operation: "export",
        rows_processed: 9,
        errors: 0,
        spreadsheet_url:
          "https://docs.google.com/spreadsheets/d/sheet_001",
        completed_at: "2026-07-16T13:30:00Z"
      })
    ));

    const response = await importGoogleSheets(
      new Request(
        `${origin}/api/pasarai/integrations/google-sheets/import`,
        {
          method: "POST",
          headers: { cookie: sessionCookie(), origin }
        }
      )
    );

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: "PasarAI API returned the wrong Google Sheets operation."
    });
  });

  it("forwards reconcile with an empty body and validates its operation", async () => {
    const reconcileResponse = {
      state: "completed",
      job_id: "job_reconcile_001",
      operation: "reconcile",
      rows_processed: 14,
      errors: 0,
      spreadsheet_url:
        "https://docs.google.com/spreadsheets/d/sheet_001",
      completed_at: "2026-07-16T13:45:00Z"
    };
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json(reconcileResponse)
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await reconcileGoogleSheets(
      new Request(
        `${origin}/api/pasarai/integrations/google-sheets/reconcile`,
        {
          method: "POST",
          headers: { cookie: sessionCookie(), origin }
        }
      )
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(reconcileResponse);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url.toString()).toBe(
      "http://upstream.test/api/v1/integrations/google-sheets/reconcile"
    );
    expect(options.body).toBe("{}");
    expect(options.headers.authorization).toBe("Bearer SERVER_ONLY_TOKEN");
    expect(options.headers["idempotency-key"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
  });

  it("rejects a reconcile response for a different sync operation", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      Response.json({
        state: "completed",
        job_id: "job_export_002",
        operation: "export",
        rows_processed: 14,
        errors: 0,
        spreadsheet_url:
          "https://docs.google.com/spreadsheets/d/sheet_001",
        completed_at: "2026-07-16T13:45:00Z"
      })
    ));

    const response = await reconcileGoogleSheets(
      new Request(
        `${origin}/api/pasarai/integrations/google-sheets/reconcile`,
        {
          method: "POST",
          headers: { cookie: sessionCookie(), origin }
        }
      )
    );

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: "PasarAI API returned the wrong Google Sheets operation."
    });
  });

  it("forwards a validated sync mode and returns the updated status", async () => {
    const automaticStatus = {
      ...connectedStatus,
      sync_mode: "automatic",
      watch_expires_at: "2026-07-23T13:45:00Z"
    };
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json(automaticStatus)
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await updateGoogleSheetsSyncMode(
      new Request(
        `${origin}/api/pasarai/integrations/google-sheets/sync-mode`,
        {
          method: "POST",
          headers: {
            cookie: sessionCookie(),
            origin,
            "content-type": "application/json"
          },
          body: JSON.stringify({ sync_mode: "automatic" })
        }
      )
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(automaticStatus);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url.toString()).toBe(
      "http://upstream.test/api/v1/integrations/google-sheets/sync-mode"
    );
    expect(JSON.parse(options.body)).toEqual({
      sync_mode: "automatic"
    });
    expect(options.headers["idempotency-key"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
  });

  it("rejects an invalid sync mode before contacting upstream", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await updateGoogleSheetsSyncMode(
      new Request(
        `${origin}/api/pasarai/integrations/google-sheets/sync-mode`,
        {
          method: "POST",
          headers: {
            cookie: sessionCookie(),
            origin,
            "content-type": "application/json"
          },
          body: JSON.stringify({ sync_mode: "scheduled" })
        }
      )
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "Invalid Google Sheets request."
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [
      "reconcile",
      reconcileGoogleSheets,
      undefined
    ],
    [
      "sync-mode",
      updateGoogleSheetsSyncMode,
      JSON.stringify({ sync_mode: "automatic" })
    ]
  ])("rejects a cross-origin %s action before contacting upstream", async (
    path,
    handler,
    body
  ) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await handler(
      new Request(
        `${origin}/api/pasarai/integrations/google-sheets/${path}`,
        {
          method: "POST",
          headers: {
            cookie: sessionCookie(),
            origin: "https://attacker.test",
            ...(body ? { "content-type": "application/json" } : {})
          },
          body
        }
      )
    );

    expect(response.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["export", exportGoogleSheets],
    ["disconnect", disconnectGoogleSheets]
  ])("forwards an authenticated same-origin %s action with an empty body", async (
    path,
    handler
  ) => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json(
        path === "export"
          ? {
              state: "completed",
              job_id: "job_001",
              operation: "export",
              rows_processed: 12,
              errors: 0,
              spreadsheet_url:
                "https://docs.google.com/spreadsheets/d/sheet_001",
              completed_at: "2026-07-16T13:00:00Z"
            }
          : { state: "disconnected" }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await handler(
      new Request(
        `${origin}/api/pasarai/integrations/google-sheets/${path}`,
        {
          method: "POST",
          headers: { cookie: sessionCookie(), origin }
        }
      )
    );

    expect(response.status).toBe(200);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url.toString()).toBe(
      `http://upstream.test/api/v1/integrations/google-sheets/${path}`
    );
    expect(options.body).toBe("{}");
    expect(options.headers.authorization).toBe("Bearer SERVER_ONLY_TOKEN");
    expect(options.headers["idempotency-key"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
  });

  it.each([
    ["oauth-start", startOAuth],
    ["export", exportGoogleSheets],
    ["import", importGoogleSheets],
    ["reconcile", reconcileGoogleSheets],
    ["sync-mode", updateGoogleSheetsSyncMode],
    ["disconnect", disconnectGoogleSheets]
  ])("rejects malformed JSON for %s before contacting upstream", async (
    path,
    handler
  ) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await handler(new Request(
      `${origin}/api/pasarai/integrations/google-sheets/${path}`,
      {
        method: "POST",
        headers: {
          cookie: sessionCookie(),
          origin,
          "content-type": "application/json"
        },
        body: "{"
      }
    ));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Request body must be valid JSON."
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["oauth-start", startOAuth],
    ["export", exportGoogleSheets],
    ["import", importGoogleSheets],
    ["reconcile", reconcileGoogleSheets],
    ["sync-mode", updateGoogleSheetsSyncMode],
    ["disconnect", disconnectGoogleSheets]
  ])("rejects additional properties for %s before contacting upstream", async (
    path,
    handler
  ) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await handler(new Request(
      `${origin}/api/pasarai/integrations/google-sheets/${path}`,
      {
        method: "POST",
        headers: {
          cookie: sessionCookie(),
          origin,
          "content-type": "application/json"
        },
        body: JSON.stringify({ unexpected: true })
      }
    ));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "Invalid Google Sheets request."
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
