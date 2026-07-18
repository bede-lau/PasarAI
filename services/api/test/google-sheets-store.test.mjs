import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createGoogleSheetsBackgroundWorker,
  InMemoryGoogleSheetsStore,
  LakebaseGoogleSheetsStore,
} from "../src/backend/index.js";

const merchantId = "m_google_store_001";

function connection(overrides = {}) {
  return {
    merchantId,
    spreadsheetId: "sheet-001",
    spreadsheetUrl: "https://docs.google.test/sheet-001",
    spreadsheetTitle: "PasarAI",
    encryptedAccessToken: "access",
    encryptedRefreshToken: "refresh",
    accessTokenExpiresAt: "2026-07-16T13:00:00.000Z",
    grantedScopes: ["sheets", "drive.file"],
    status: "active",
    syncMode: "automatic",
    lastExportAt: null,
    lastImportAt: null,
    lastReconciledAt: null,
    lastError: null,
    watchChannelId: "channel-001",
    watchResourceId: "resource-001",
    watchToken: "token-001",
    watchExpiresAt: "2026-07-17T12:00:00.000Z",
    watchLastMessageNumber: null,
    ...overrides,
  };
}

function fakePool(handleQuery) {
  const client = {
    async query(text, values) {
      return handleQuery(String(text), values);
    },
    release() {},
  };
  return {
    async connect() {
      return client;
    },
    async query(text, values) {
      return handleQuery(String(text), values);
    },
    async end() {},
  };
}

test("in-memory connection patches preserve unrelated fields and CAS once", async () => {
  const store = new InMemoryGoogleSheetsStore();
  store.saveConnection(connection());

  store.updateConnection(merchantId, {
    encryptedAccessToken: "rotated-access",
  });
  assert.equal(store.getConnection(merchantId).watchChannelId, "channel-001");

  const attempts = await Promise.all([
    Promise.resolve().then(() => store.compareAndSetWatchState({
      merchantId,
      expectedChannelId: "channel-001",
      expectedMessageNumber: null,
      changes: { watchLastMessageNumber: "10" },
    })),
    Promise.resolve().then(() => store.compareAndSetWatchState({
      merchantId,
      expectedChannelId: "channel-001",
      expectedMessageNumber: null,
      changes: { watchLastMessageNumber: "11" },
    })),
  ]);

  assert.equal(attempts.filter(({ updated }) => updated).length, 1);
  assert.ok(["10", "11"].includes(
    store.getConnection(merchantId).watchLastMessageNumber,
  ));
});

test("notification enqueue is atomic, ordered, leased and retryable", () => {
  const store = new InMemoryGoogleSheetsStore();
  store.saveConnection(connection());
  const first = store.advanceWatchMessageAndEnqueueNotification({
    merchantId,
    channelId: "channel-001",
    messageNumber: "9007199254740993",
    resourceId: "resource-001",
    resourceState: "update",
    availableAt: "2026-07-16T12:00:00.000Z",
  });
  assert.equal(first.accepted, true);
  assert.equal(
    store.getConnection(merchantId).watchLastMessageNumber,
    "9007199254740993",
  );

  for (const messageNumber of ["9007199254740993", "9007199254740992"]) {
    assert.deepEqual(
      store.advanceWatchMessageAndEnqueueNotification({
        merchantId,
        channelId: "channel-001",
        messageNumber,
        resourceId: "resource-001",
        resourceState: "update",
      }),
      {
        accepted: false,
        reason: "duplicate_or_out_of_order",
        notification: null,
      },
    );
  }
  assert.equal(store.listDueNotifications({
    now: "2026-07-16T12:00:00.000Z",
  }).length, 1);

  const claimed = store.claimNotification({
    workerId: "worker-a",
    now: "2026-07-16T12:00:00.000Z",
    leaseMs: 1_000,
  });
  assert.equal(claimed.attempts, 1);
  assert.ok(claimed.claimToken);
  assert.equal(store.claimNotification({
    workerId: "worker-b",
    now: "2026-07-16T12:00:00.500Z",
  }), null);
  assert.equal(store.failNotification({
    notificationId: claimed.notificationId,
    claimToken: claimed.claimToken,
    error: "temporary",
    failedAt: "2026-07-16T12:00:00.500Z",
    availableAt: "2026-07-16T12:00:02.000Z",
  }).status, "failed");

  const retried = store.claimNotification({
    workerId: "worker-b",
    now: "2026-07-16T12:00:02.000Z",
  });
  assert.equal(retried.attempts, 2);
  assert.notEqual(retried.claimToken, claimed.claimToken);
  assert.equal(store.completeNotification({
    notificationId: retried.notificationId,
    claimToken: retried.claimToken,
    processedAt: "2026-07-16T12:00:03.000Z",
  }).status, "completed");
  assert.equal(store.listDueNotifications({
    now: "2026-07-16T12:00:04.000Z",
  }).length, 0);
});

test("operation idempotency rejects conflicts and persists success", async () => {
  const store = new InMemoryGoogleSheetsStore();
  const identity = {
    merchantId,
    operation: "reconcile",
    idempotencyKey: "request-001",
    requestFingerprint: "fingerprint-a",
    now: "2026-07-16T12:00:00.000Z",
    leaseMs: 1_000,
  };
  const claims = await Promise.all([
    Promise.resolve().then(() => store.claimOperation(identity)),
    Promise.resolve().then(() => store.claimOperation(identity)),
  ]);
  assert.equal(claims.filter(({ claimed }) => claimed).length, 1);
  const activeClaim = claims.find(({ claimed }) => claimed);
  assert.ok(activeClaim.operation.claimToken);

  assert.equal(store.claimOperation({
    ...identity,
    requestFingerprint: "fingerprint-b",
  }).conflict, true);
  store.completeOperation({
    ...identity,
    claimToken: activeClaim.operation.claimToken,
    response: { state: "completed", job_id: "job-001" },
    completedAt: "2026-07-16T12:00:00.500Z",
  });
  assert.deepEqual(store.claimOperation({
    ...identity,
    now: "2026-07-16T12:00:02.000Z",
  }).response, {
    state: "completed",
    job_id: "job-001",
  });
});

test("failed operation claims can be retried after failure", () => {
  const store = new InMemoryGoogleSheetsStore();
  const identity = {
    merchantId,
    operation: "export",
    idempotencyKey: "request-002",
    requestFingerprint: "fingerprint-export",
  };
  const claimed = store.claimOperation({
    ...identity,
    now: "2026-07-16T12:00:00.000Z",
  });
  assert.equal(claimed.claimed, true);
  assert.equal(store.failOperation({
    ...identity,
    claimToken: claimed.operation.claimToken,
    error: "provider unavailable",
    failedAt: "2026-07-16T12:00:01.000Z",
  }).status, "failed");
  const retry = store.claimOperation({
    ...identity,
    now: "2026-07-16T12:00:02.000Z",
  });
  assert.equal(retry.claimed, true);
  assert.equal(retry.retried, true);
  assert.equal(retry.operation.attempts, 2);
});

test("stale notification and operation claimants cannot finalize after takeover", () => {
  const store = new InMemoryGoogleSheetsStore();
  store.saveConnection(connection());
  store.advanceWatchMessageAndEnqueueNotification({
    merchantId,
    channelId: "channel-001",
    messageNumber: "2",
    resourceId: "resource-001",
    resourceState: "update",
    availableAt: "2026-07-16T12:00:00.000Z",
  });
  const firstNotification = store.claimNotification({
    workerId: "worker-a",
    now: "2026-07-16T12:00:00.000Z",
    leaseMs: 1_000,
  });
  const secondNotification = store.claimNotification({
    workerId: "worker-b",
    now: "2026-07-16T12:00:01.000Z",
    leaseMs: 1_000,
  });
  assert.notEqual(
    firstNotification.claimToken,
    secondNotification.claimToken,
  );
  assert.equal(store.completeNotification({
    notificationId: firstNotification.notificationId,
    claimToken: firstNotification.claimToken,
  }), null);
  assert.equal(store.failNotification({
    notificationId: firstNotification.notificationId,
    claimToken: firstNotification.claimToken,
    error: "stale",
  }), null);
  assert.equal(store.completeNotification({
    notificationId: secondNotification.notificationId,
    claimToken: secondNotification.claimToken,
  }).status, "completed");

  const identity = {
    merchantId,
    operation: "reconcile",
    idempotencyKey: "stale-operation",
    requestFingerprint: "fingerprint-stale",
  };
  const firstOperation = store.claimOperation({
    ...identity,
    now: "2026-07-16T12:00:00.000Z",
    leaseMs: 1_000,
  });
  const secondOperation = store.claimOperation({
    ...identity,
    now: "2026-07-16T12:00:01.000Z",
    leaseMs: 1_000,
  });
  assert.notEqual(
    firstOperation.operation.claimToken,
    secondOperation.operation.claimToken,
  );
  assert.equal(store.completeOperation({
    ...identity,
    claimToken: firstOperation.operation.claimToken,
    response: { stale: true },
  }), null);
  assert.equal(store.failOperation({
    ...identity,
    claimToken: firstOperation.operation.claimToken,
    error: "stale",
  }), null);
  assert.equal(store.completeOperation({
    ...identity,
    claimToken: secondOperation.operation.claimToken,
    response: { stale: false },
  }).status, "completed");
});

test("sync leases are per merchant, reclaimable, and token-fenced", () => {
  const store = new InMemoryGoogleSheetsStore();
  const first = store.claimSyncLease({
    merchantId,
    operation: "reconcile",
    ownerId: "owner-a",
    now: "2026-07-16T12:00:00.000Z",
    leaseMs: 1_000,
  });
  assert.equal(first.claimed, true);
  const renewed = store.renewSyncLease({
    merchantId,
    claimToken: first.lease.claimToken,
    renewedAt: "2026-07-16T12:00:00.500Z",
    leaseMs: 1_000,
  });
  assert.equal(renewed.leaseExpiresAt, "2026-07-16T12:00:01.500Z");
  assert.equal(store.claimSyncLease({
    merchantId,
    operation: "export",
    ownerId: "owner-b",
    now: "2026-07-16T12:00:01.000Z",
  }).claimed, false);

  const reclaimed = store.claimSyncLease({
    merchantId,
    operation: "export",
    ownerId: "owner-b",
    now: "2026-07-16T12:00:01.500Z",
    leaseMs: 1_000,
  });
  assert.equal(reclaimed.claimed, true);
  assert.notEqual(reclaimed.lease.claimToken, first.lease.claimToken);
  assert.equal(store.renewSyncLease({
    merchantId,
    claimToken: first.lease.claimToken,
    renewedAt: "2026-07-16T12:00:01.600Z",
    leaseMs: 1_000,
  }), null);
  assert.equal(store.releaseSyncLease({
    merchantId,
    claimToken: first.lease.claimToken,
    releasedAt: "2026-07-16T12:00:01.600Z",
  }), null);
  assert.equal(store.releaseSyncLease({
    merchantId,
    claimToken: reclaimed.lease.claimToken,
    releasedAt: "2026-07-16T12:00:01.600Z",
  }).releasedAt, "2026-07-16T12:00:01.600Z");
  assert.equal(store.claimSyncLease({
    merchantId,
    operation: "import",
    ownerId: "owner-c",
    now: "2026-07-16T12:00:01.600Z",
  }).claimed, true);
});

test("Lakebase connection updates patch only supplied columns", async () => {
  const queries = [];
  const store = new LakebaseGoogleSheetsStore({
    pool: fakePool(async (text, values) => {
      queries.push({ text, values });
      return {
        rows: [{
          merchant_id: merchantId,
          spreadsheet_id: "sheet-001",
          spreadsheet_url: "url",
          spreadsheet_title: "title",
          status: "active",
          sync_mode: "automatic",
          encrypted_access_token: "rotated",
          watch_channel_id: "channel-001",
        }],
      };
    }),
  });

  await store.updateConnection(merchantId, {
    encryptedAccessToken: "rotated",
    accessTokenExpiresAt: "2026-07-16T14:00:00.000Z",
  });

  assert.equal(queries.length, 1);
  assert.match(queries[0].text, /UPDATE google_sheet_connections/);
  assert.match(queries[0].text, /encrypted_access_token = \$2/);
  assert.match(queries[0].text, /access_token_expires_at = \$3/);
  assert.doesNotMatch(queries[0].text, /watch_channel_id =/);
  assert.deepEqual(queries[0].values, [
    merchantId,
    "rotated",
    "2026-07-16T14:00:00.000Z",
  ]);
});

test("Lakebase CAS and notification claims use atomic SQL primitives", async () => {
  const queries = [];
  const store = new LakebaseGoogleSheetsStore({
    pool: fakePool(async (text, values) => {
      queries.push({ text, values });
      return { rows: [] };
    }),
  });

  await store.compareAndSetWatchState({
    merchantId,
    expectedChannelId: "channel-001",
    expectedMessageNumber: "4",
    changes: { watchLastMessageNumber: "5" },
  });
  await store.claimNotification({
    workerId: "worker-a",
    now: "2026-07-16T12:00:00.000Z",
    leaseMs: 1_000,
  });

  const cas = queries.find(({ text }) =>
    text.includes("UPDATE google_sheet_connections"));
  assert.match(cas.text, /watch_channel_id IS NOT DISTINCT FROM \$3/);
  assert.match(
    cas.text,
    /watch_last_message_number IS NOT DISTINCT FROM \$4/,
  );
  const claim = queries.find(({ text }) => text.includes("SKIP LOCKED"));
  assert.ok(claim);
  assert.equal(claim.values[0], "2026-07-16T12:00:00.000Z");
  assert.equal(claim.values[1], "worker-a");
  assert.match(claim.values[2], /^[0-9a-f-]{36}$/);
  assert.equal(claim.values[3], "2026-07-16T12:00:01.000Z");
  assert.match(claim.text, /claim_token = \$3/);
});

test("Lakebase finalization and sync lease SQL use claim-token CAS", async () => {
  const queries = [];
  const store = new LakebaseGoogleSheetsStore({
    pool: fakePool(async (text, values) => {
      queries.push({ text, values });
      if (text.includes("INSERT INTO google_sheet_sync_leases")) {
        return {
          rows: [{
            merchant_id: merchantId,
            operation: "reconcile",
            owner_id: "owner-a",
            claim_token: values[3],
            claimed_at: values[4],
            lease_expires_at: values[5],
          }],
        };
      }
      if (text.includes("SET lease_expires_at = $4")) {
        return {
          rows: [{
            merchant_id: merchantId,
            operation: "reconcile",
            owner_id: "owner-a",
            claim_token: values[1],
            claimed_at: "2026-07-16T12:00:00.000Z",
            lease_expires_at: values[3],
          }],
        };
      }
      return { rows: [] };
    }),
  });

  await store.completeNotification({
    notificationId: 1,
    claimToken: "notification-token",
  });
  await store.failOperation({
    merchantId,
    operation: "export",
    idempotencyKey: "request-003",
    requestFingerprint: "fingerprint",
    claimToken: "operation-token",
    error: "failed",
  });
  const claimed = await store.claimSyncLease({
    merchantId,
    operation: "reconcile",
    ownerId: "owner-a",
    now: "2026-07-16T12:00:00.000Z",
    leaseMs: 1_000,
  });
  await store.renewSyncLease({
    merchantId,
    claimToken: claimed.lease.claimToken,
    renewedAt: "2026-07-16T12:00:00.250Z",
    leaseMs: 1_000,
  });
  await store.releaseSyncLease({
    merchantId,
    claimToken: claimed.lease.claimToken,
    releasedAt: "2026-07-16T12:00:00.500Z",
  });

  assert.match(
    queries.find(({ text }) =>
      text.includes("UPDATE google_sheet_notification_queue")).text,
    /AND claim_token = \$2/,
  );
  assert.match(
    queries.find(({ text }) =>
      text.includes("UPDATE google_sheet_operation_idempotency")).text,
    /AND claim_token = \$6/,
  );
  const syncClaim = queries.find(({ text }) =>
    text.includes("INSERT INTO google_sheet_sync_leases"));
  assert.match(syncClaim.text, /ON CONFLICT \(merchant_id\) DO UPDATE/);
  assert.match(syncClaim.text, /lease_expires_at <= EXCLUDED.claimed_at/);
  const syncRenew = queries.find(({ text }) =>
    text.includes("SET lease_expires_at = $4"));
  assert.match(syncRenew.text, /AND claim_token = \$2/);
  assert.match(syncRenew.text, /AND lease_expires_at > \$3/);
  const syncRelease = queries.find(({ text }) =>
    text.includes("SET released_at = $3"));
  assert.match(syncRelease.text, /AND claim_token = \$2/);
});

test("background worker processes durable notifications through callback", async () => {
  let currentTime = Date.parse("2026-07-16T12:00:00.000Z");
  const store = new InMemoryGoogleSheetsStore();
  store.saveConnection(connection());
  store.advanceWatchMessageAndEnqueueNotification({
    merchantId,
    channelId: "channel-001",
    messageNumber: "1",
    resourceId: "resource-001",
    resourceState: "update",
    availableAt: new Date(currentTime).toISOString(),
  });
  let attempts = 0;
  const errors = [];
  const worker = createGoogleSheetsBackgroundWorker({
    store,
    workerId: "worker-a",
    now: () => currentTime,
    retryDelayMs: () => 1_000,
    async processNotification(notification) {
      attempts += 1;
      assert.equal(notification.messageNumber, "1");
      if (attempts === 1) throw new Error("temporary");
      return "processed";
    },
    onError(error) {
      errors.push(error.message);
    },
  });

  assert.deepEqual(await worker.runOnce(), []);
  assert.deepEqual(errors, ["temporary"]);
  currentTime += 1_000;
  assert.equal((await worker.runOnce()).length, 1);
  assert.equal(attempts, 2);
  assert.equal(store.listDueNotifications({
    now: new Date(currentTime + 1_000).toISOString(),
  }).length, 0);
});

test("background worker isolates failed stages and reports each one", async () => {
  const stages = [];
  let syncCalls = 0;
  const worker = createGoogleSheetsBackgroundWorker({
    integration: {
      async renewAutomaticWatches() {
        throw new Error("watch failed");
      },
      async runAutomaticSync() {
        syncCalls += 1;
        throw new Error("sync failed");
      },
    },
    store: {
      async claimNotification() {
        throw new Error("notification claim failed");
      },
    },
    async processNotification() {},
    onError(error, context) {
      stages.push([error.message, context.stage]);
    },
  });

  assert.deepEqual(await worker.runOnce(), []);
  assert.equal(syncCalls, 1);
  assert.deepEqual(stages, [
    ["watch failed", "watch-renewal"],
    ["notification claim failed", "durable-notifications"],
    ["sync failed", "periodic-sync"],
  ]);
});

test("background worker deadlines let later stages run without overlap", async () => {
  const stages = [];
  let renewCalls = 0;
  let syncCalls = 0;
  const worker = createGoogleSheetsBackgroundWorker({
    integration: {
      async renewAutomaticWatches() {
        renewCalls += 1;
        return new Promise(() => {});
      },
      async runAutomaticSync() {
        syncCalls += 1;
        return ["done"];
      },
    },
    stageTimeoutMs: 5,
    onError(error, context) {
      stages.push([error.message, context.stage]);
    },
  });

  assert.deepEqual(await worker.runOnce(), ["done"]);
  assert.deepEqual(await worker.runOnce(), ["done"]);
  assert.equal(renewCalls, 1);
  assert.equal(syncCalls, 2);
  assert.deepEqual(stages, [[
    "Google Sheets background stage timed out: watch-renewal",
    "watch-renewal",
  ]]);
});

test("default background worker identities are globally unique", async () => {
  const workerIds = [];
  const store = {
    async claimNotification({ workerId }) {
      workerIds.push(workerId);
      return null;
    },
  };
  const first = createGoogleSheetsBackgroundWorker({
    store,
    async processNotification() {},
  });
  const second = createGoogleSheetsBackgroundWorker({
    store,
    async processNotification() {},
  });

  await first.processDueNotifications();
  await second.processDueNotifications();
  assert.notEqual(workerIds[0], workerIds[1]);
  for (const workerId of workerIds) {
    assert.match(
      workerId,
      new RegExp(`^google-sheets-.+-${process.pid}-[0-9a-f-]{36}$`),
    );
  }
});
