import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createGoogleWorkspaceClient,
  GoogleWorkspaceApiError,
} from "../src/backend/index.js";

function successfulJson(value = {}) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("Google Sheets values are written literally and read with explicit render modes", async () => {
  const requests = [];
  const client = createGoogleWorkspaceClient({
    clientId: "client-id",
    clientSecret: "client-secret",
    fetchImpl: async (url, init = {}) => {
      requests.push({ url: new URL(url), init });
      return successfulJson({ values: [] });
    },
  });

  await client.batchUpdateValues({
    accessToken: "access-token",
    spreadsheetId: "sheet-id",
    data: [{
      range: "Inputs!A2:R2",
      values: [["=SUM(1,2)"]],
    }],
  });
  await client.batchUpdateValues({
    accessToken: "access-token",
    spreadsheetId: "sheet-id",
    valueInputOption: "USER_ENTERED",
    data: [{
      range: "Dashboard!B3:B3",
      values: [['=IFERROR(Metrics!A2,"")']],
    }],
  });
  await client.getValues({
    accessToken: "access-token",
    spreadsheetId: "sheet-id",
    range: "Inputs!A2:R10000",
  });

  assert.equal(
    JSON.parse(requests[0].init.body).valueInputOption,
    "RAW",
  );
  assert.equal(
    JSON.parse(requests[1].init.body).valueInputOption,
    "USER_ENTERED",
  );
  assert.equal(
    requests[2].url.searchParams.get("valueRenderOption"),
    "FORMULA",
  );
  assert.equal(
    requests[2].url.searchParams.get("dateTimeRenderOption"),
    "SERIAL_NUMBER",
  );
  for (const request of requests) {
    assert.ok(request.init.signal instanceof AbortSignal);
  }
});

test("Google Workspace requests fail with a bounded timeout", async () => {
  const client = createGoogleWorkspaceClient({
    clientId: "client-id",
    clientSecret: "client-secret",
    timeoutMs: 5,
    fetchImpl: async (_url, init = {}) =>
      new Promise((resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          reject(init.signal.reason);
        }, { once: true });
      }),
  });

  await assert.rejects(
    client.getSpreadsheet({
      accessToken: "access-token",
      spreadsheetId: "sheet-id",
    }),
    (error) =>
      error instanceof GoogleWorkspaceApiError
      && error.message === "Google API request timed out",
  );
});
