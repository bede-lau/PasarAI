import assert from "node:assert/strict";
import { test } from "node:test";
import {
  allowMerchantForTests,
  createApiApp,
} from "../src/backend/index.js";

const merchantId = "m_google_http_contract";
const apiRoot = "https://api.pasarai.test";

const mutations = [
  {
    id: "google-sheets.oauth-start",
    path: "/oauth/start",
    method: "startOAuth",
    payload: {
      redirect_uri: "https://pasarai.test/google-sheets/callback",
      spreadsheet_id: "sheet_001",
    },
    input: {
      merchantId,
      redirectUri: "https://pasarai.test/google-sheets/callback",
      spreadsheetId: "sheet_001",
    },
  },
  {
    id: "google-sheets.oauth-complete",
    path: "/oauth/complete",
    method: "completeOAuth",
    payload: {
      code: "oauth-code",
      state: "state_001_abcdefghijklmnopqrstuvwxyz",
      redirect_uri: "https://pasarai.test/google-sheets/callback",
    },
    input: {
      merchantId,
      code: "oauth-code",
      state: "state_001_abcdefghijklmnopqrstuvwxyz",
      redirectUri: "https://pasarai.test/google-sheets/callback",
    },
  },
  {
    id: "google-sheets.export",
    path: "/export",
    method: "exportMetrics",
    payload: { dates: ["2026-07-16"] },
    input: { merchantId, dates: ["2026-07-16"] },
  },
  {
    id: "google-sheets.import",
    path: "/import",
    method: "importInputs",
    payload: {},
    input: { merchantId },
  },
  {
    id: "google-sheets.reconcile",
    path: "/reconcile",
    method: "reconcile",
    payload: {},
    input: { merchantId },
  },
  {
    id: "google-sheets.sync-mode",
    path: "/sync-mode",
    method: "configureSyncMode",
    payload: { sync_mode: "automatic" },
    input: { merchantId, syncMode: "automatic" },
  },
  {
    id: "google-sheets.disconnect",
    path: "/disconnect",
    method: "disconnect",
    payload: {},
    input: { merchantId },
  },
];

function fixture() {
  const calls = new Map();
  const googleSheetsIntegration = {
    handleDriveNotification: async () => ({ status: 204 }),
  };
  for (const { method } of mutations) {
    googleSheetsIntegration[method] = async (...args) => {
      calls.set(method, args);
      return {};
    };
  }
  return {
    calls,
    app: createApiApp({
      service: {},
      authenticate: allowMerchantForTests(merchantId),
      googleSheetsIntegration,
    }),
  };
}

function request(path, body, idempotencyKey) {
  return new Request(
    `${apiRoot}/api/v1/integrations/google-sheets${path}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(idempotencyKey
          ? { "idempotency-key": idempotencyKey }
          : {}),
      },
      body,
    },
  );
}

test("Google Sheets mutations enforce idempotency and strict request contracts", async (t) => {
  for (const mutation of mutations) {
    await t.test(mutation.id, async () => {
      const { app, calls } = fixture();
      const validBody = JSON.stringify(mutation.payload);

      const missingKey = await app.fetch(request(
        mutation.path,
        validBody,
      ));
      assert.equal(missingKey.status, 400);
      assert.match((await missingKey.json()).message, /Idempotency-Key/);

      const malformed = await app.fetch(request(
        mutation.path,
        "{",
        "operation-malformed",
      ));
      assert.equal(malformed.status, 400);
      assert.match((await malformed.json()).message, /valid JSON/);

      const additionalProperty = await app.fetch(request(
        mutation.path,
        JSON.stringify({ ...mutation.payload, unexpected: true }),
        "operation-additional-property",
      ));
      assert.equal(additionalProperty.status, 400);
      assert.match(
        (await additionalProperty.json()).message,
        /additional properties/,
      );

      const idempotencyKey = `operation-${mutation.method}`;
      const valid = await app.fetch(request(
        mutation.path,
        validBody,
        idempotencyKey,
      ));
      assert.equal(valid.status, 200);
      assert.deepEqual(calls.get(mutation.method), [
        mutation.input,
        { idempotencyKey },
      ]);
    });
  }
});

test("the public Google Drive webhook remains exempt from Idempotency-Key", async () => {
  const { app } = fixture();
  const response = await app.fetch(new Request(
    `${apiRoot}/webhooks/google-drive`,
    { method: "POST" },
  ));
  assert.equal(response.status, 204);
});
