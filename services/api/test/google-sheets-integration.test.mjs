import assert from "node:assert/strict";
import { test } from "node:test";

import {
  InMemoryGoogleSheetsStore,
  InMemoryLedgerStore,
  allowMerchantForTests,
  createApiApp,
  createBearerAuthenticator,
  createGoogleSheetsBackgroundWorker,
  createGoogleSheetsIntegration,
  createGoogleTokenCipher,
  createPasarAiService,
} from "../src/backend/index.js";

const merchantId = "m_kak_lina_001";
const redirectUri =
  "https://pasarai.example/api/pasarai/integrations/google-sheets/callback";

function apiUrl(path) {
  return ["http", "://", "pasarai.test", path].join("");
}

function profile() {
  return {
    merchantId,
    productId: "p_nlb_001",
    baselineUnitCogsRm: "2.90",
    currentUnitCogsRm: "3.18",
    targetGrossMarginPct: "40.00",
    timeZone: "Asia/Kuala_Lumpur",
    components: [{
      componentId: "c_egg",
      name: "Eggs",
      baselineCostRm: "3.18",
      currentCostRm: "3.18",
      usagePerProductUnit: "1",
    }],
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function fakeGoogleClient() {
  const spreadsheets = new Map();
  const writes = [];
  const clears = [];
  const watches = [];
  const stoppedChannels = [];
  let refreshes = 0;

  const client = {
    spreadsheets,
    writes,
    clears,
    watches,
    stoppedChannels,
    inputValues: [],
    get refreshes() {
      return refreshes;
    },
    authorizationUrl({ redirectUri: suppliedRedirect, state }) {
      const url = new URL("https://accounts.google.test/oauth");
      url.searchParams.set("redirect_uri", suppliedRedirect);
      url.searchParams.set("state", state);
      return url.toString();
    },
    async exchangeCode({ code, redirectUri: suppliedRedirect }) {
      assert.equal(code, "oauth-code");
      assert.equal(suppliedRedirect, redirectUri);
      return {
        access_token: "access-token",
        refresh_token: "refresh-token",
        expires_in: 3600,
        scope: "sheets drive.file",
      };
    },
    async refreshAccessToken(refreshToken) {
      assert.equal(refreshToken, "refresh-token");
      refreshes += 1;
      return {
        access_token: `refreshed-token-${refreshes}`,
        expires_in: 3600,
      };
    },
    async createSpreadsheet({ title, sheetTitles }) {
      const metadata = {
        spreadsheetId: "sheet-001",
        spreadsheetUrl:
          "https://docs.google.com/spreadsheets/d/sheet-001/edit",
        properties: { title },
        sheets: sheetTitles.map((sheetTitle, index) => ({
          properties: { sheetId: index + 1, title: sheetTitle },
        })),
      };
      spreadsheets.set(metadata.spreadsheetId, structuredClone(metadata));
      return structuredClone(metadata);
    },
    async getSpreadsheet({ spreadsheetId }) {
      const metadata = spreadsheets.get(spreadsheetId);
      if (!metadata) throw new Error(`Unknown spreadsheet: ${spreadsheetId}`);
      return structuredClone(metadata);
    },
    async batchUpdateSpreadsheet({ spreadsheetId, requests }) {
      const metadata = spreadsheets.get(spreadsheetId);
      for (const request of requests) {
        if (request.addSheet) {
          metadata.sheets.push({
            properties: {
              sheetId: metadata.sheets.length + 1,
              title: request.addSheet.properties.title,
            },
          });
        }
      }
      return {};
    },
    async batchClearValues(call) {
      clears.push(structuredClone(call));
      return {};
    },
    async batchUpdateValues(call) {
      writes.push(structuredClone(call));
      return {};
    },
    async getValues() {
      return { values: structuredClone(client.inputValues) };
    },
    async watchFile(call) {
      watches.push(structuredClone(call));
      return {
        id: call.channelId,
        resourceId: `resource-${call.spreadsheetId}`,
        token: call.channelToken,
        expiration: call.expiration,
      };
    },
    async stopChannel(call) {
      stoppedChannels.push(structuredClone(call));
      return {};
    },
  };
  return client;
}

async function createFixture({
  now = () => Date.parse("2026-07-16T12:00:00Z"),
  webhookUrl,
  integrationOptions = {},
} = {}) {
  const ledgerStore = new InMemoryLedgerStore({
    productProfiles: [profile()],
  });
  const businessIds = new Map();
  const businessService = createPasarAiService({
    store: ledgerStore,
    idFactory: (kind) => {
      const next = (businessIds.get(kind) ?? 0) + 1;
      businessIds.set(kind, next);
      return `${kind}_${next}`;
    },
  });
  await businessService.recordSale({
    merchant_id: merchantId,
    occurred_at: "2026-07-16T10:00:00+08:00",
    source: "web_manual",
    source_language: "en",
    lines: [{
      product_id: "p_nlb_001",
      quantity: "10",
      unit_price_rm: "5.00",
    }],
    evidence: {
      source_event_id: "sheet-phase-one-seed",
    },
  }, {
    idempotencyKey: "sheet-phase-one-seed",
  });
  const integrationStore = new InMemoryGoogleSheetsStore();
  const googleClient = fakeGoogleClient();
  const tokenCipher = createGoogleTokenCipher({
    key: Buffer.alloc(32, 7),
  });
  let nextId = 0;
  const integration = createGoogleSheetsIntegration({
    store: integrationStore,
    ledgerStore,
    businessService,
    googleClient,
    tokenCipher,
    webhookUrl,
    now,
    idFactory: (kind) => `${kind}_${++nextId}`,
    ...integrationOptions,
  });
  return {
    ledgerStore,
    businessService,
    integrationStore,
    googleClient,
    tokenCipher,
    integration,
  };
}

async function connect(integration) {
  const started = await integration.startOAuth({
    merchantId,
    redirectUri,
  });
  return integration.completeOAuth({
    merchantId,
    code: "oauth-code",
    state: started.state,
    redirectUri,
  });
}

test("phase 1 connects Google, encrypts tokens and exports deterministic metrics", async () => {
  const fixture = await createFixture();
  assert.deepEqual(await fixture.integration.status({ merchantId }), {
    state: "not_connected",
    spreadsheet_id: null,
    spreadsheet_url: null,
    spreadsheet_title: null,
    sync_mode: "manual",
    last_export_at: null,
    last_import_at: null,
    last_reconciled_at: null,
    watch_expires_at: null,
    last_error: null,
  });

  const connected = await connect(fixture.integration);
  assert.equal(connected.state, "connected");
  assert.equal(connected.spreadsheet_id, "sheet-001");
  const stored = fixture.integrationStore.getConnection(merchantId);
  assert.notEqual(stored.encryptedAccessToken, "access-token");
  assert.notEqual(stored.encryptedRefreshToken, "refresh-token");
  assert.equal(
    fixture.tokenCipher.decrypt(stored.encryptedRefreshToken),
    "refresh-token",
  );

  const exported = await fixture.integration.exportMetrics({ merchantId });
  assert.deepEqual(exported, {
    state: "completed",
    job_id: "google_sheets_export_1",
    operation: "export",
    rows_processed: 1,
    errors: 0,
    spreadsheet_url:
      "https://docs.google.com/spreadsheets/d/sheet-001/edit",
    completed_at: "2026-07-16T12:00:00.000Z",
  });
  assert.equal(fixture.googleClient.clears.length, 1);
  assert.equal(
    fixture.googleClient.writes.some((write) =>
      write.valueInputOption === "USER_ENTERED"
      && write.data[0]?.range === "Dashboard!B3:B7"),
    true,
  );
  const metrics = fixture.googleClient.writes
    .flatMap(({ data }) => data)
    .findLast(({ range }) => range.startsWith("Metrics!"));
  assert.deepEqual(metrics.values[0].slice(0, 5), [
    "Date",
    "Revenue (RM)",
    "COGS (RM)",
    "Gross Profit (RM)",
    "Gross Margin (%)",
  ]);
  assert.deepEqual(metrics.values[1].slice(0, 6), [
    "2026-07-16",
    "50.00",
    "31.80",
    "18.20",
    "36.40",
    "complete",
  ]);
  assert.equal(
    fixture.integrationStore.getSyncJob(exported.job_id).status,
    "completed",
  );
});

test("phase 1 refreshes an expired access token before export", async () => {
  let currentTime = Date.parse("2026-07-16T12:00:00Z");
  const fixture = await createFixture({ now: () => currentTime });
  await connect(fixture.integration);
  currentTime += 3700 * 1000;

  await fixture.integration.exportMetrics({ merchantId });

  assert.equal(fixture.googleClient.refreshes, 1);
  const stored = fixture.integrationStore.getConnection(merchantId);
  assert.equal(
    fixture.tokenCipher.decrypt(stored.encryptedAccessToken),
    "refreshed-token-1",
  );
});

test("phase 1 persists mutation replay and rejects idempotency-key reuse", async () => {
  const fixture = await createFixture();
  await connect(fixture.integration);
  const input = {
    merchantId,
    dates: ["2026-07-16"],
  };
  const first = await fixture.integration.exportMetrics(input, {
    idempotencyKey: "google-sheets-export-replay",
  });
  const writeCount = fixture.googleClient.writes.length;

  const replay = await fixture.integration.exportMetrics(input, {
    idempotencyKey: "google-sheets-export-replay",
  });

  assert.deepEqual(replay, first);
  assert.equal(fixture.googleClient.writes.length, writeCount);
  await assert.rejects(
    fixture.integration.exportMetrics({
      merchantId,
      dates: ["2026-07-15"],
    }, {
      idempotencyKey: "google-sheets-export-replay",
    }),
    (error) => error.code === "idempotency_key_reused",
  );
});

test("phase 1 OAuth state is merchant-bound, single-use and expiring", async () => {
  const fixture = await createFixture();
  const started = await fixture.integration.startOAuth({
    merchantId,
    redirectUri,
  });
  await assert.rejects(
    fixture.integration.completeOAuth({
      merchantId: "m_other",
      code: "oauth-code",
      state: started.state,
      redirectUri,
    }),
    /invalid or expired/,
  );
  assert.equal((await fixture.integration.completeOAuth({
    merchantId,
    code: "oauth-code",
    state: started.state,
    redirectUri,
  })).state, "connected");
  await assert.rejects(fixture.integration.completeOAuth({
    merchantId,
    code: "oauth-code",
    state: started.state,
    redirectUri,
  }), /invalid or expired/);
});

test("phase 1 routes preserve bearer auth and integration availability", async () => {
  const fixture = await createFixture();
  const app = createApiApp({
    service: fixture.businessService,
    authenticate: createBearerAuthenticator({
      apiKey: "api-key",
      merchantId,
    }),
    googleSheetsIntegration: fixture.integration,
  });
  assert.equal(
    (await app.fetch(new Request(apiUrl(
      "/api/v1/integrations/google-sheets",
    )))).status,
    401,
  );
  const authorized = (path, options = {}) => new Request(apiUrl(path), {
    ...options,
    headers: {
      authorization: "Bearer api-key",
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...options.headers,
    },
  });
  const status = await app.fetch(authorized(
    "/api/v1/integrations/google-sheets",
  ));
  assert.equal(status.status, 200);
  assert.equal((await status.json()).state, "not_connected");
  const invalid = await app.fetch(authorized(
    "/api/v1/integrations/google-sheets/oauth/start",
    {
      method: "POST",
      headers: {
        "idempotency-key": "oauth-start-invalid-payload",
      },
      body: JSON.stringify({}),
    },
  ));
  assert.equal(invalid.status, 400);

  const unavailable = createApiApp({
    service: fixture.businessService,
    authenticate: allowMerchantForTests(merchantId),
  });
  assert.equal(
    (await unavailable.fetch(new Request(apiUrl(
      "/api/v1/integrations/google-sheets",
    )))).status,
    503,
  );
});

test("phase 1 disconnect removes durable tokens but leaves an auditable connection", async () => {
  const fixture = await createFixture();
  await connect(fixture.integration);

  assert.deepEqual(await fixture.integration.disconnect({ merchantId }), {
    state: "disconnected",
  });
  assert.equal(
    (await fixture.integration.status({ merchantId })).state,
    "not_connected",
  );
  const stored = fixture.integrationStore.getConnection(merchantId);
  assert.equal(stored.status, "disconnected");
  assert.equal(stored.encryptedAccessToken, null);
  assert.equal(stored.encryptedRefreshToken, null);
});

test("phase 1 disconnect stops an existing watch even from an error state", async () => {
  const fixture = await createFixture({
    webhookUrl: "https://pasarai.example/webhooks/google-drive",
  });
  await connect(fixture.integration);
  await fixture.integration.configureSyncMode({
    merchantId,
    syncMode: "automatic",
  });
  fixture.integrationStore.updateConnection(merchantId, {
    status: "error",
    lastError: "Synthetic sync failure",
  });

  await fixture.integration.disconnect({ merchantId });

  assert.equal(fixture.googleClient.stoppedChannels.length, 1);
  assert.equal(
    fixture.integrationStore.getConnection(merchantId).status,
    "disconnected",
  );
});

test("phase 1 disconnect fences an import after its lease expires", async () => {
  let currentTime = Date.parse("2026-07-16T12:00:00Z");
  const fixture = await createFixture({
    now: () => currentTime,
    integrationOptions: {
      syncLeaseMs: 1_000,
      syncLeaseHeartbeatMs: 400,
      setIntervalImpl() {
        return { unref() {} };
      },
      clearIntervalImpl() {},
    },
  });
  await connect(fixture.integration);
  const started = deferred();
  const release = deferred();
  fixture.googleClient.getValues = async () => {
    started.resolve();
    await release.promise;
    return { values: [] };
  };

  const importing = fixture.integration.importInputs({ merchantId });
  await started.promise;
  currentTime += 1_000;
  assert.deepEqual(await fixture.integration.disconnect({ merchantId }), {
    state: "disconnected",
  });
  release.resolve();

  await assert.rejects(
    importing,
    (error) => error.code === "google_sheets_sync_lease_lost",
  );
  const connection = fixture.integrationStore.getConnection(merchantId);
  assert.equal(connection.status, "disconnected");
  assert.equal(connection.encryptedAccessToken, null);
  assert.equal(connection.encryptedRefreshToken, null);
});

test("phase 1 sync lease heartbeat prevents takeover during a slow import", async () => {
  let currentTime = Date.parse("2026-07-16T12:00:00Z");
  let heartbeat;
  const fixture = await createFixture({
    now: () => currentTime,
    integrationOptions: {
      syncLeaseMs: 1_000,
      syncLeaseHeartbeatMs: 400,
      setIntervalImpl(callback) {
        heartbeat = callback;
        return { unref() {} };
      },
      clearIntervalImpl() {},
    },
  });
  await connect(fixture.integration);
  const started = deferred();
  const release = deferred();
  fixture.googleClient.getValues = async () => {
    started.resolve();
    await release.promise;
    return { values: [] };
  };

  const importing = fixture.integration.importInputs({ merchantId });
  await started.promise;
  currentTime += 500;
  heartbeat();
  await new Promise((resolve) => setImmediate(resolve));
  currentTime += 500;
  await assert.rejects(
    fixture.integration.disconnect({ merchantId }),
    (error) => error.code === "google_sheets_sync_in_progress",
  );
  release.resolve();

  assert.equal((await importing).state, "completed");
  assert.equal(
    fixture.integrationStore.getConnection(merchantId).status,
    "active",
  );
});

test("phase 1 stale watch creation is unpublished after disconnect", async () => {
  let currentTime = Date.parse("2026-07-16T12:00:00Z");
  const fixture = await createFixture({
    now: () => currentTime,
    webhookUrl: "https://pasarai.example/webhooks/google-drive",
    integrationOptions: {
      syncLeaseMs: 1_000,
      syncLeaseHeartbeatMs: 400,
      setIntervalImpl() {
        return { unref() {} };
      },
      clearIntervalImpl() {},
    },
  });
  await connect(fixture.integration);
  const started = deferred();
  const release = deferred();
  fixture.googleClient.watchFile = async (call) => {
    started.resolve();
    await release.promise;
    fixture.googleClient.watches.push(structuredClone(call));
    return {
      id: call.channelId,
      resourceId: `resource-${call.spreadsheetId}`,
      token: call.channelToken,
      expiration: call.expiration,
    };
  };

  const enabling = fixture.integration.configureSyncMode({
    merchantId,
    syncMode: "automatic",
  });
  await started.promise;
  currentTime += 1_000;
  await fixture.integration.disconnect({ merchantId });
  release.resolve();

  await assert.rejects(
    enabling,
    (error) => error.code === "google_sheets_sync_lease_lost",
  );
  assert.equal(
    fixture.integrationStore.getConnection(merchantId).status,
    "disconnected",
  );
  assert.equal(fixture.googleClient.stoppedChannels.length, 1);
  assert.equal(
    fixture.googleClient.stoppedChannels[0].channelId,
    fixture.googleClient.watches[0].channelId,
  );
});

test("phase 2 imports valid input rows and writes row-level errors back", async () => {
  const fixture = await createFixture();
  await connect(fixture.integration);
  fixture.googleClient.inputValues = [
    [
      "CREATE",
      "sale",
      "2026-07-16",
      "p_nlb_001",
      "",
      "2",
      "6.00",
      "",
      "",
      "",
      "",
      "",
      "",
    ],
    [
      "CREATE",
      "cost",
      "2026-07-16",
      "",
      "c_egg",
      "2",
      "",
      "Morning Market",
      "tray",
      "30",
      "24.00",
      "cash",
      "Egg purchase",
    ],
    [
      "CREATE",
      "sale",
      "2026-07-16",
      "p_nlb_001",
      "",
      "0",
      "6.00",
      "",
      "",
      "",
      "",
      "",
      "",
    ],
  ];

  const imported = await fixture.integration.importInputs({ merchantId });

  assert.deepEqual(imported, {
    state: "completed",
    job_id: "google_sheets_import_1",
    operation: "import",
    rows_processed: 2,
    errors: 1,
    spreadsheet_url:
      "https://docs.google.com/spreadsheets/d/sheet-001/edit",
    completed_at: "2026-07-16T12:00:00.000Z",
  });
  assert.equal(
    (await fixture.ledgerStore.listEvents({
      merchantId,
      type: "sale",
    })).length,
    2,
  );
  assert.equal(
    (await fixture.ledgerStore.listEvents({
      merchantId,
      type: "cost",
    })).length,
    1,
  );
  const write = fixture.googleClient.writes.at(-1);
  const inputs = write.data.find(({ range }) => range.startsWith("Inputs!"));
  assert.equal(inputs.values[0][13], "synced");
  assert.equal(inputs.values[0][14], "sale_2");
  assert.equal(inputs.values[0][15], 1);
  assert.equal(inputs.values[1][13], "synced");
  assert.equal(inputs.values[1][14], "cost_1");
  assert.equal(inputs.values[2][13], "error");
  assert.match(inputs.values[2][16], /greater than zero/);
  const errors = write.data.find(({ range }) =>
    range.startsWith("Sync Errors!"));
  assert.equal(errors.values.length, 2);
  assert.match(errors.values[1][2], /greater than zero/);
  assert.equal(fixture.integrationStore.listRowStates({
    merchantId,
    sheetName: "Inputs",
  }).length, 2);
  assert.equal(
    fixture.integrationStore.getSyncJob(imported.job_id).status,
    "completed",
  );
  assert.equal(
    fixture.integrationStore.getConnection(merchantId).lastImportAt,
    "2026-07-16T12:00:00.000Z",
  );
});

test("phase 2 retries the same pending row without duplicating ledger events", async () => {
  const fixture = await createFixture();
  await connect(fixture.integration);
  fixture.googleClient.inputValues = [[
    "CREATE",
    "sale",
    "2026-07-16",
    "p_nlb_001",
    "",
    "2",
    "6.00",
  ]];

  assert.equal(
    (await fixture.integration.importInputs({ merchantId })).rows_processed,
    1,
  );
  assert.equal(
    (await fixture.integration.importInputs({ merchantId })).rows_processed,
    1,
  );
  assert.equal(
    (await fixture.ledgerStore.listEvents({
      merchantId,
      type: "sale",
    })).length,
    2,
  );
});

test("phase 2 rejects formulas, neutralizes them, and accepts Sheets date serials", async () => {
  const fixture = await createFixture();
  await connect(fixture.integration);
  fixture.googleClient.inputValues = [[
    "CREATE",
    "sale",
    46219,
    "p_nlb_001",
    "",
    1,
    5,
    "",
    "",
    "",
    "",
    "",
    "=SUM(1,2)",
  ]];

  const rejected = await fixture.integration.importInputs({ merchantId });

  assert.equal(rejected.rows_processed, 0);
  assert.equal(rejected.errors, 1);
  const rejectedRow = fixture.googleClient.writes.at(-1).data
    .find(({ range }) => range.startsWith("Inputs!"))
    .values[0];
  assert.match(rejectedRow[16], /Formulas are not accepted/);
  assert.equal(
    (await fixture.ledgerStore.listEvents({
      merchantId,
      type: "sale",
    })).length,
    1,
  );

  fixture.googleClient.inputValues = [[
    "CREATE",
    "sale",
    46219,
    "p_nlb_001",
    "",
    1,
    5,
  ]];
  const imported = await fixture.integration.importInputs({ merchantId });

  assert.equal(imported.rows_processed, 1);
  assert.equal(imported.errors, 0);
  const event = (await fixture.ledgerStore.listEvents({
    merchantId,
    type: "sale",
  })).at(-1);
  assert.equal(event.payload.occurred_at, "2026-07-16T12:00:00+08:00");
});

test("phase 2 keeps every unresolved row visible when rebuilding Sync Errors", async () => {
  const fixture = await createFixture();
  await connect(fixture.integration);
  fixture.googleClient.inputValues = [[
    "CREATE",
    "sale",
    "2026-07-16",
    "p_nlb_001",
    "",
    "1",
    "",
  ]];
  await fixture.integration.importInputs({ merchantId });
  const unresolved = structuredClone(
    fixture.googleClient.writes.at(-1).data
      .find(({ range }) => range.startsWith("Inputs!"))
      .values[0],
  );
  fixture.googleClient.inputValues = [unresolved, [
    "CREATE",
    "sale",
    "2026-07-16",
    "p_nlb_001",
    "",
    "1",
    "5.00",
  ]];

  const imported = await fixture.integration.importInputs({ merchantId });

  assert.equal(imported.rows_processed, 1);
  assert.equal(imported.errors, 1);
  const errors = fixture.googleClient.writes.at(-1).data
    .find(({ range }) => range.startsWith("Sync Errors!"))
    .values;
  assert.equal(errors.length, 2);
  assert.equal(errors[1][0], 2);
  assert.match(errors[1][2], /Unit Price/);
});

test("phase 2 requires an explicit update action for synchronized sales", async () => {
  const fixture = await createFixture();
  await connect(fixture.integration);
  fixture.googleClient.inputValues = [[
    "CREATE",
    "sale",
    "2026-07-16",
    "p_nlb_001",
    "",
    "2",
    "6.00",
  ]];
  await fixture.integration.importInputs({ merchantId });
  const firstWrite = fixture.googleClient.writes.at(-1);
  const firstRow = firstWrite.data
    .find(({ range }) => range.startsWith("Inputs!"))
    .values[0];

  fixture.googleClient.inputValues = [[
    "CREATE",
    "sale",
    "2026-07-16",
    "p_nlb_001",
    "",
    "3",
    "6.00",
    "",
    "",
    "",
    "",
    "",
    "",
    "synced",
    firstRow[14],
    firstRow[15],
    "",
    firstRow[17],
  ]];
  const imported = await fixture.integration.importInputs({ merchantId });

  assert.equal(imported.rows_processed, 0);
  assert.equal(imported.errors, 1);
  assert.equal(
    (await fixture.ledgerStore.listEvents({
      merchantId,
      type: "sale",
    })).length,
    2,
  );
  const changed = fixture.googleClient.writes.at(-1).data
    .find(({ range }) => range.startsWith("Inputs!"))
    .values[0];
  assert.equal(changed[13], "error");
  assert.match(changed[16], /Set Action to UPDATE/);
});

test("phase 2 import route preserves bearer auth and calls the integration", async () => {
  const fixture = await createFixture();
  await connect(fixture.integration);
  fixture.googleClient.inputValues = [[
    "CREATE",
    "sale",
    "2026-07-16",
    "p_nlb_001",
    "",
    "1",
    "5.00",
  ]];
  const app = createApiApp({
    service: fixture.businessService,
    authenticate: createBearerAuthenticator({
      apiKey: "api-key",
      merchantId,
    }),
    googleSheetsIntegration: fixture.integration,
  });

  const response = await app.fetch(new Request(apiUrl(
    "/api/v1/integrations/google-sheets/import",
  ), {
    method: "POST",
    headers: {
      authorization: "Bearer api-key",
      "content-type": "application/json",
      "idempotency-key": "google-sheets-import-route",
    },
    body: "{}",
  }));

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.operation, "import");
  assert.equal(body.rows_processed, 1);
});

test("phase 3 enables automatic mode, renews watches and returns to manual mode", async () => {
  let currentTime = Date.parse("2026-07-16T12:00:00Z");
  const fixture = await createFixture({
    now: () => currentTime,
    webhookUrl: "https://pasarai.example/webhooks/google-drive",
  });
  await connect(fixture.integration);

  const automatic = await fixture.integration.configureSyncMode({
    merchantId,
    syncMode: "automatic",
  });

  assert.equal(automatic.sync_mode, "automatic");
  assert.equal(automatic.watch_expires_at, "2026-07-17T11:00:00.000Z");
  assert.equal(fixture.googleClient.watches.length, 1);
  assert.equal(
    fixture.googleClient.watches[0].webhookUrl,
    "https://pasarai.example/webhooks/google-drive",
  );
  const firstConnection = fixture.integrationStore.getConnection(merchantId);
  assert.ok(firstConnection.watchChannelId);
  assert.ok(firstConnection.watchToken);
  assert.equal(
    firstConnection.watchResourceId,
    "resource-sheet-001",
  );

  currentTime += 22.5 * 60 * 60 * 1000;
  const renewed = await fixture.integration.renewAutomaticWatches();
  assert.equal(renewed.length, 1);
  assert.equal(fixture.googleClient.watches.length, 2);
  assert.equal(fixture.googleClient.stoppedChannels.length, 1);

  const manual = await fixture.integration.configureSyncMode({
    merchantId,
    syncMode: "manual",
  });
  assert.equal(manual.sync_mode, "manual");
  assert.equal(manual.watch_expires_at, null);
  assert.equal(fixture.googleClient.stoppedChannels.length, 2);
});

test("phase 3 reauthorization replaces and stops the previous automatic watch", async () => {
  const fixture = await createFixture({
    webhookUrl: "https://pasarai.example/webhooks/google-drive",
  });
  await connect(fixture.integration);
  await fixture.integration.configureSyncMode({
    merchantId,
    syncMode: "automatic",
  });
  const previous = fixture.integrationStore.getConnection(merchantId);
  const started = await fixture.integration.startOAuth({
    merchantId,
    redirectUri,
  });

  await fixture.integration.completeOAuth({
    merchantId,
    code: "oauth-code",
    state: started.state,
    redirectUri,
  });

  const current = fixture.integrationStore.getConnection(merchantId);
  assert.notEqual(current.watchChannelId, previous.watchChannelId);
  assert.equal(fixture.googleClient.watches.length, 2);
  assert.deepEqual(fixture.googleClient.stoppedChannels.at(-1), {
    accessToken: "access-token",
    channelId: previous.watchChannelId,
    resourceId: previous.watchResourceId,
  });
});

test("phase 3 validates Drive notifications and queues one reconciliation", async () => {
  const fixture = await createFixture({
    webhookUrl: "https://pasarai.example/webhooks/google-drive",
  });
  await connect(fixture.integration);
  await fixture.integration.configureSyncMode({
    merchantId,
    syncMode: "automatic",
  });
  const connection = fixture.integrationStore.getConnection(merchantId);
  const headers = {
    "x-goog-channel-id": connection.watchChannelId,
    "x-goog-channel-token": connection.watchToken,
    "x-goog-resource-id": connection.watchResourceId,
    "x-goog-resource-state": "sync",
    "x-goog-message-number": "1",
  };

  assert.equal((await fixture.integration.handleDriveNotification({
    headers,
  })).status, 204);
  assert.equal(fixture.integrationStore.listDueNotifications().length, 0);
  assert.equal((await fixture.integration.handleDriveNotification({
    headers: {
      ...headers,
      "x-goog-resource-state": "update",
      "x-goog-message-number": "2",
    },
  })).status, 202);
  assert.equal(fixture.integrationStore.listDueNotifications().length, 1);
  assert.equal((await fixture.integration.handleDriveNotification({
    headers: {
      ...headers,
      "x-goog-resource-state": "update",
      "x-goog-message-number": "2",
    },
  })).status, 204);
  assert.equal((await fixture.integration.handleDriveNotification({
    headers: {
      ...headers,
      "x-goog-channel-token": "tampered",
      "x-goog-resource-state": "update",
      "x-goog-message-number": "3",
    },
  })).status, 403);

  fixture.googleClient.inputValues = [[
    "CREATE",
    "sale",
    "2026-07-16",
    "p_nlb_001",
    "",
    "1",
    "5.00",
  ]];
  const worker = createGoogleSheetsBackgroundWorker({
    integration: fixture.integration,
    store: fixture.integrationStore,
    processNotification: (notification) =>
      fixture.integration.processDriveNotification(notification),
    onError(error) {
      assert.fail(error);
    },
  });
  const processed = await worker.processDueNotifications();
  assert.equal(processed.length, 1);
  assert.equal(fixture.integrationStore.listDueNotifications().length, 0);
  assert.equal(
    fixture.integrationStore.getConnection(merchantId).lastReconciledAt,
    "2026-07-16T12:00:00.000Z",
  );
  assert.equal(
    (await fixture.ledgerStore.listEvents({
      merchantId,
      type: "sale",
    })).length,
    2,
  );
});

test("phase 3 ignores unchanged managed rows to prevent notification loops", async () => {
  const fixture = await createFixture();
  await connect(fixture.integration);
  fixture.googleClient.inputValues = [[
    "CREATE",
    "sale",
    "2026-07-16",
    "p_nlb_001",
    "",
    "1",
    "5.00",
  ]];
  await fixture.integration.importInputs({ merchantId });
  const syncedRow = fixture.googleClient.writes.at(-1).data
    .find(({ range }) => range.startsWith("Inputs!"))
    .values[0];
  const writeCount = fixture.googleClient.writes.length;
  const clearCount = fixture.googleClient.clears.length;
  fixture.googleClient.inputValues = [syncedRow];

  const repeated = await fixture.integration.importInputs({ merchantId });

  assert.equal(repeated.rows_processed, 0);
  assert.equal(repeated.errors, 0);
  assert.equal(fixture.googleClient.writes.length, writeCount);
  assert.equal(fixture.googleClient.clears.length, clearCount);
});

test("phase 3 serializes imports across integration runtimes per merchant", async () => {
  const fixture = await createFixture();
  await connect(fixture.integration);
  fixture.googleClient.inputValues = [[
    "CREATE",
    "sale",
    "2026-07-16",
    "p_nlb_001",
    "",
    "1",
    "5.00",
  ]];
  const originalGetValues = fixture.googleClient.getValues;
  let releaseRead;
  let markReadStarted;
  const readStarted = new Promise((resolve) => {
    markReadStarted = resolve;
  });
  const readReleased = new Promise((resolve) => {
    releaseRead = resolve;
  });
  let blockNextRead = true;
  fixture.googleClient.getValues = async (...args) => {
    if (blockNextRead) {
      blockNextRead = false;
      markReadStarted();
      await readReleased;
    }
    return originalGetValues(...args);
  };
  const secondRuntime = createGoogleSheetsIntegration({
    store: fixture.integrationStore,
    ledgerStore: fixture.ledgerStore,
    businessService: fixture.businessService,
    googleClient: fixture.googleClient,
    tokenCipher: fixture.tokenCipher,
    now: () => Date.parse("2026-07-16T12:00:00Z"),
    idFactory: (kind) => `${kind}_second_runtime`,
  });

  const first = fixture.integration.importInputs({ merchantId });
  await readStarted;
  await assert.rejects(
    secondRuntime.importInputs({ merchantId }),
    (error) => error.code === "google_sheets_sync_in_progress",
  );
  releaseRead();
  const imported = await first;

  assert.equal(imported.rows_processed, 1);
  assert.equal(imported.errors, 0);
  assert.equal(
    (await fixture.ledgerStore.listEvents({
      merchantId,
      type: "sale",
    })).length,
    2,
  );
});

test("phase 3 reconcile and Drive webhook routes are composed correctly", async () => {
  const fixture = await createFixture({
    webhookUrl: "https://pasarai.example/webhooks/google-drive",
  });
  await connect(fixture.integration);
  await fixture.integration.configureSyncMode({
    merchantId,
    syncMode: "automatic",
  });
  fixture.googleClient.inputValues = [[
    "CREATE",
    "sale",
    "2026-07-16",
    "p_nlb_001",
    "",
    "1",
    "5.00",
  ]];
  const app = createApiApp({
    service: fixture.businessService,
    authenticate: createBearerAuthenticator({
      apiKey: "api-key",
      merchantId,
    }),
    googleSheetsIntegration: fixture.integration,
  });

  const reconciled = await app.fetch(new Request(apiUrl(
    "/api/v1/integrations/google-sheets/reconcile",
  ), {
    method: "POST",
    headers: {
      authorization: "Bearer api-key",
      "content-type": "application/json",
      "idempotency-key": "google-sheets-reconcile-route",
    },
    body: "{}",
  }));
  assert.equal(reconciled.status, 200);
  assert.equal((await reconciled.json()).operation, "reconcile");

  const connection = fixture.integrationStore.getConnection(merchantId);
  const notified = await app.fetch(new Request(apiUrl(
    "/webhooks/google-drive",
  ), {
    method: "POST",
    headers: {
      "x-goog-channel-id": connection.watchChannelId,
      "x-goog-channel-token": connection.watchToken,
      "x-goog-resource-id": connection.watchResourceId,
      "x-goog-resource-state": "update",
      "x-goog-message-number": "1",
    },
  }));
  assert.equal(notified.status, 202);
  assert.equal(fixture.integrationStore.listDueNotifications().length, 1);
});

test("phase 3 background worker renews watches before automatic sync", async () => {
  const calls = [];
  const worker = createGoogleSheetsBackgroundWorker({
    integration: {
      async renewAutomaticWatches() {
        calls.push("renew");
      },
      async runAutomaticSync() {
        calls.push("sync");
        return ["done"];
      },
    },
    onError(error) {
      assert.fail(error);
    },
  });

  assert.deepEqual(await worker.runOnce(), ["done"]);
  assert.deepEqual(calls, ["renew", "sync"]);
  worker.stop();
});

test("phase 4 converts synchronized sale edits into append-only corrections", async () => {
  const fixture = await createFixture();
  await connect(fixture.integration);
  fixture.googleClient.inputValues = [[
    "CREATE",
    "sale",
    "2026-07-16",
    "p_nlb_001",
    "",
    "2",
    "6.00",
  ]];
  await fixture.integration.importInputs({ merchantId });
  const syncedRow = structuredClone(
    fixture.googleClient.writes.at(-1).data
      .find(({ range }) => range.startsWith("Inputs!"))
      .values[0],
  );
  syncedRow[5] = "3";
  fixture.googleClient.inputValues = [syncedRow];

  const imported = await fixture.integration.importInputs({ merchantId });

  assert.equal(imported.rows_processed, 1);
  assert.equal(imported.errors, 0);
  assert.equal(
    (await fixture.ledgerStore.listEvents({
      merchantId,
      type: "sale",
    })).length,
    2,
  );
  const corrections = await fixture.ledgerStore.listEvents({
    merchantId,
    type: "correction",
  });
  assert.equal(corrections.length, 1);
  assert.equal(
    corrections[0].payload.replacement_payload.changes[0].field,
    "quantity",
  );
  const updated = fixture.googleClient.writes.at(-1).data
    .find(({ range }) => range.startsWith("Inputs!"))
    .values[0];
  assert.equal(updated[13], "synced");
  assert.equal(updated[15], 2);
  assert.equal(fixture.integrationStore.getRowState({
    merchantId,
    sheetName: "Inputs",
    recordId: updated[14],
  }).recordVersion, 2);
});

test("phase 4 refreshes an unchanged sale row when the database advances", async () => {
  const fixture = await createFixture();
  await connect(fixture.integration);
  fixture.googleClient.inputValues = [[
    "CREATE",
    "sale",
    "2026-07-16",
    "p_nlb_001",
    "",
    "2",
    "6.00",
  ]];
  await fixture.integration.importInputs({ merchantId });
  const syncedRow = structuredClone(
    fixture.googleClient.writes.at(-1).data
      .find(({ range }) => range.startsWith("Inputs!"))
      .values[0],
  );
  assert.equal((await fixture.businessService.recordCorrection({
    merchant_id: merchantId,
    target_event_id: syncedRow[14],
    occurred_at: "2026-07-16T12:05:00Z",
    reason: "Corrected in PasarAI",
    replacement_payload: {
      changes: [{
        kind: "decimal",
        field: "quantity",
        line_index: 0,
        previous_value: "2",
        corrected_value: "3",
      }],
    },
    evidence: { source_event_id: "app-side-correction" },
  }, {
    idempotencyKey: "app-side-correction",
  })).state, "committed");
  fixture.googleClient.inputValues = [syncedRow];

  const refreshed = await fixture.integration.importInputs({ merchantId });

  assert.equal(refreshed.rows_processed, 1);
  assert.equal(refreshed.errors, 0);
  const updated = fixture.googleClient.writes.at(-1).data
    .find(({ range }) => range.startsWith("Inputs!"))
    .values[0];
  assert.equal(updated[0], "UPDATE");
  assert.equal(updated[5], "3");
  assert.equal(updated[13], "synced");
  assert.equal(updated[15], 2);
});

test("phase 4 surfaces optimistic conflicts and resolves them with REFRESH", async () => {
  const fixture = await createFixture();
  await connect(fixture.integration);
  fixture.googleClient.inputValues = [[
    "CREATE",
    "sale",
    "2026-07-16",
    "p_nlb_001",
    "",
    "2",
    "6.00",
  ]];
  await fixture.integration.importInputs({ merchantId });
  const syncedRow = structuredClone(
    fixture.googleClient.writes.at(-1).data
      .find(({ range }) => range.startsWith("Inputs!"))
      .values[0],
  );
  await fixture.businessService.recordCorrection({
    merchant_id: merchantId,
    target_event_id: syncedRow[14],
    occurred_at: "2026-07-16T12:05:00Z",
    reason: "Corrected in PasarAI",
    replacement_payload: {
      changes: [{
        kind: "decimal",
        field: "quantity",
        line_index: 0,
        previous_value: "2",
        corrected_value: "3",
      }],
    },
    evidence: { source_event_id: "conflicting-app-correction" },
  }, {
    idempotencyKey: "conflicting-app-correction",
  });
  syncedRow[5] = "4";
  fixture.googleClient.inputValues = [syncedRow];

  const conflicted = await fixture.integration.importInputs({ merchantId });

  assert.equal(conflicted.rows_processed, 0);
  assert.equal(conflicted.errors, 1);
  const conflictRow = structuredClone(
    fixture.googleClient.writes.at(-1).data
      .find(({ range }) => range.startsWith("Inputs!"))
      .values[0],
  );
  assert.equal(conflictRow[13], "conflict");
  assert.match(conflictRow[16], /database is at version 2/);
  assert.equal(
    (await fixture.ledgerStore.listEvents({
      merchantId,
      type: "correction",
    })).length,
    1,
  );

  conflictRow[0] = "REFRESH";
  fixture.googleClient.inputValues = [conflictRow];
  const resolved = await fixture.integration.importInputs({ merchantId });

  assert.equal(resolved.rows_processed, 1);
  assert.equal(resolved.errors, 0);
  const refreshedRow = fixture.googleClient.writes.at(-1).data
    .find(({ range }) => range.startsWith("Inputs!"))
    .values[0];
  assert.equal(refreshedRow[5], "3");
  assert.equal(refreshedRow[13], "synced");
  assert.equal(refreshedRow[15], 2);
});

test("phase 4 keeps synchronized costs read-only and supports REFRESH", async () => {
  const fixture = await createFixture();
  await connect(fixture.integration);
  fixture.googleClient.inputValues = [[
    "CREATE",
    "cost",
    "2026-07-16",
    "",
    "c_egg",
    "2",
    "",
    "Morning Market",
    "tray",
    "30",
    "24.00",
    "cash",
    "Egg purchase",
  ]];
  await fixture.integration.importInputs({ merchantId });
  const syncedRow = structuredClone(
    fixture.googleClient.writes.at(-1).data
      .find(({ range }) => range.startsWith("Inputs!"))
      .values[0],
  );
  syncedRow[10] = "30.00";
  fixture.googleClient.inputValues = [syncedRow];

  const rejected = await fixture.integration.importInputs({ merchantId });

  assert.equal(rejected.rows_processed, 0);
  assert.equal(rejected.errors, 1);
  const errorRow = structuredClone(
    fixture.googleClient.writes.at(-1).data
      .find(({ range }) => range.startsWith("Inputs!"))
      .values[0],
  );
  assert.match(errorRow[16], /read-only/);

  errorRow[0] = "REFRESH";
  fixture.googleClient.inputValues = [errorRow];
  const refreshed = await fixture.integration.importInputs({ merchantId });

  assert.equal(refreshed.rows_processed, 1);
  const restored = fixture.googleClient.writes.at(-1).data
    .find(({ range }) => range.startsWith("Inputs!"))
    .values[0];
  assert.equal(restored[10], "24.00");
  assert.equal(restored[13], "synced");
});
