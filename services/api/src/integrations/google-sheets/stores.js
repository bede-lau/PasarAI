import { randomUUID } from "node:crypto";

import pg from "pg";

const { Pool } = pg;

const CONNECTION_COLUMNS = new Map([
  ["spreadsheetId", "spreadsheet_id"],
  ["spreadsheetUrl", "spreadsheet_url"],
  ["spreadsheetTitle", "spreadsheet_title"],
  ["encryptedAccessToken", "encrypted_access_token"],
  ["encryptedRefreshToken", "encrypted_refresh_token"],
  ["accessTokenExpiresAt", "access_token_expires_at"],
  ["grantedScopes", "granted_scopes"],
  ["status", "status"],
  ["syncMode", "sync_mode"],
  ["lastExportAt", "last_export_at"],
  ["lastImportAt", "last_import_at"],
  ["lastReconciledAt", "last_reconciled_at"],
  ["lastError", "last_error"],
  ["watchChannelId", "watch_channel_id"],
  ["watchResourceId", "watch_resource_id"],
  ["watchToken", "watch_token"],
  ["watchExpiresAt", "watch_expires_at"],
  ["watchLastMessageNumber", "watch_last_message_number"],
]);

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function isoTimestamp(value) {
  return value ? new Date(value).toISOString() : null;
}

function assertMessageNumber(messageNumber) {
  if (!/^\d+$/.test(messageNumber ?? "")) {
    throw new Error("messageNumber must be an unsigned integer string");
  }
}

function isNewMessageNumber(previous, next) {
  assertMessageNumber(next);
  return previous === null
    || previous === undefined
    || BigInt(next) > BigInt(previous);
}

function connectionPatch(changes, offset = 1) {
  const entries = Object.entries(changes ?? {});
  if (entries.length === 0) return { assignments: [], values: [] };
  const values = [];
  const assignments = entries.map(([field, value], index) => {
    const column = CONNECTION_COLUMNS.get(field);
    if (!column) {
      throw new Error(`Unsupported Google Sheets connection field: ${field}`);
    }
    values.push(value);
    return `${column} = $${offset + index}`;
  });
  return { assignments, values };
}

function connectionFromRow(row) {
  if (!row) return null;
  return {
    merchantId: row.merchant_id,
    spreadsheetId: row.spreadsheet_id,
    spreadsheetUrl: row.spreadsheet_url,
    spreadsheetTitle: row.spreadsheet_title,
    encryptedAccessToken: row.encrypted_access_token,
    encryptedRefreshToken: row.encrypted_refresh_token,
    accessTokenExpiresAt: row.access_token_expires_at
      ? new Date(row.access_token_expires_at).toISOString()
      : null,
    grantedScopes: row.granted_scopes ?? [],
    status: row.status,
    syncMode: row.sync_mode,
    lastExportAt: row.last_export_at
      ? new Date(row.last_export_at).toISOString()
      : null,
    lastImportAt: row.last_import_at
      ? new Date(row.last_import_at).toISOString()
      : null,
    lastReconciledAt: row.last_reconciled_at
      ? new Date(row.last_reconciled_at).toISOString()
      : null,
    lastError: row.last_error,
    watchChannelId: row.watch_channel_id,
    watchResourceId: row.watch_resource_id,
    watchToken: row.watch_token,
    watchExpiresAt: row.watch_expires_at
      ? new Date(row.watch_expires_at).toISOString()
      : null,
    watchLastMessageNumber: row.watch_last_message_number,
  };
}

function rowStateFromRow(row) {
  if (!row) return null;
  return {
    merchantId: row.merchant_id,
    sheetName: row.sheet_name,
    recordId: row.record_id,
    rowNumber: row.row_number,
    recordVersion: row.record_version,
    checksum: row.checksum,
    lastSyncedAt: row.last_synced_at
      ? new Date(row.last_synced_at).toISOString()
      : null,
  };
}

function notificationFromRow(row) {
  if (!row) return null;
  return {
    notificationId: row.notification_id,
    merchantId: row.merchant_id,
    channelId: row.channel_id,
    messageNumber: row.message_number,
    resourceId: row.resource_id,
    resourceState: row.resource_state,
    status: row.status,
    attempts: row.attempts,
    lastError: row.last_error,
    availableAt: isoTimestamp(row.available_at),
    claimedAt: isoTimestamp(row.claimed_at),
    claimedBy: row.claimed_by,
    claimToken: row.claim_token,
    leaseExpiresAt: isoTimestamp(row.lease_expires_at),
    processedAt: isoTimestamp(row.processed_at),
    createdAt: isoTimestamp(row.created_at),
    updatedAt: isoTimestamp(row.updated_at),
  };
}

function operationFromRow(row) {
  if (!row) return null;
  return {
    merchantId: row.merchant_id,
    operation: row.operation,
    idempotencyKey: row.idempotency_key,
    requestFingerprint: row.request_fingerprint,
    status: row.status,
    attempts: row.attempts,
    response: clone(row.response),
    lastError: row.last_error,
    claimedAt: isoTimestamp(row.claimed_at),
    claimToken: row.claim_token,
    leaseExpiresAt: isoTimestamp(row.lease_expires_at),
    completedAt: isoTimestamp(row.completed_at),
    failedAt: isoTimestamp(row.failed_at),
    createdAt: isoTimestamp(row.created_at),
    updatedAt: isoTimestamp(row.updated_at),
  };
}

function syncLeaseFromRow(row) {
  if (!row) return null;
  return {
    merchantId: row.merchant_id,
    operation: row.operation,
    ownerId: row.owner_id,
    claimToken: row.claim_token,
    claimedAt: isoTimestamp(row.claimed_at),
    leaseExpiresAt: isoTimestamp(row.lease_expires_at),
    releasedAt: isoTimestamp(row.released_at),
    createdAt: isoTimestamp(row.created_at),
    updatedAt: isoTimestamp(row.updated_at),
  };
}

function operationKey({ merchantId, operation, idempotencyKey }) {
  return [merchantId, operation, idempotencyKey].join("\0");
}

export class InMemoryGoogleSheetsStore {
  #oauthStates = new Map();
  #connections = new Map();
  #jobs = new Map();
  #rowStates = new Map();
  #notifications = new Map();
  #notificationIdentity = new Map();
  #operations = new Map();
  #syncLeases = new Map();
  #nextNotificationId = 1;

  saveOAuthState(state) {
    this.#oauthStates.set(state.stateHash, clone(state));
  }

  consumeOAuthState({ stateHash, merchantId, now }) {
    const state = this.#oauthStates.get(stateHash);
    if (!state || state.merchantId !== merchantId) return null;
    this.#oauthStates.delete(stateHash);
    if (Date.parse(state.expiresAt) <= now) return null;
    return clone(state);
  }

  getConnection(merchantId) {
    return clone(this.#connections.get(merchantId) ?? null);
  }

  listConnections() {
    return [...this.#connections.values()].map(clone);
  }

  saveConnection(connection) {
    this.#connections.set(connection.merchantId, clone(connection));
    return this.getConnection(connection.merchantId);
  }

  updateConnection(merchantId, changes) {
    const connection = this.#connections.get(merchantId);
    if (!connection) return null;
    connectionPatch(changes);
    Object.assign(connection, clone(changes));
    return clone(connection);
  }

  compareAndSetConnection(merchantId, { expected = {}, changes = {} } = {}) {
    const connection = this.#connections.get(merchantId);
    if (!connection) return { updated: false, connection: null };
    const matches = Object.entries(expected).every(
      ([field, value]) => connection[field] === value,
    );
    if (!matches) {
      return { updated: false, connection: clone(connection) };
    }
    connectionPatch(changes);
    Object.assign(connection, clone(changes));
    return { updated: true, connection: clone(connection) };
  }

  compareAndSetWatchState({
    merchantId,
    expectedChannelId,
    expectedMessageNumber,
    changes,
  }) {
    return this.compareAndSetConnection(merchantId, {
      expected: {
        watchChannelId: expectedChannelId,
        watchLastMessageNumber: expectedMessageNumber,
      },
      changes,
    });
  }

  advanceWatchMessageAndEnqueueNotification({
    merchantId,
    channelId,
    messageNumber,
    resourceId,
    resourceState,
    availableAt = new Date().toISOString(),
  }) {
    const connection = this.#connections.get(merchantId);
    if (!connection || connection.watchChannelId !== channelId) {
      return { accepted: false, reason: "watch_mismatch", notification: null };
    }
    if (!isNewMessageNumber(
      connection.watchLastMessageNumber,
      messageNumber,
    )) {
      return {
        accepted: false,
        reason: "duplicate_or_out_of_order",
        notification: null,
      };
    }
    const identity = `${channelId}\0${messageNumber}`;
    if (this.#notificationIdentity.has(identity)) {
      return {
        accepted: false,
        reason: "duplicate_or_out_of_order",
        notification: null,
      };
    }

    connection.watchLastMessageNumber = messageNumber;
    const timestamp = new Date(availableAt).toISOString();
    const notification = {
      notificationId: this.#nextNotificationId++,
      merchantId,
      channelId,
      messageNumber,
      resourceId,
      resourceState,
      status: "queued",
      attempts: 0,
      lastError: null,
      availableAt: timestamp,
      claimedAt: null,
      claimedBy: null,
      claimToken: null,
      leaseExpiresAt: null,
      processedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.#notifications.set(notification.notificationId, notification);
    this.#notificationIdentity.set(identity, notification.notificationId);
    return {
      accepted: true,
      reason: null,
      notification: clone(notification),
    };
  }

  listDueNotifications({
    now = new Date().toISOString(),
    limit = 100,
  } = {}) {
    const currentTime = Date.parse(now);
    return [...this.#notifications.values()]
      .filter((notification) =>
        !notification.processedAt
        && Date.parse(notification.availableAt) <= currentTime
        && (
          notification.status !== "processing"
          || Date.parse(notification.leaseExpiresAt ?? "") <= currentTime
        ))
      .sort((left, right) =>
        Date.parse(left.availableAt) - Date.parse(right.availableAt)
        || left.notificationId - right.notificationId)
      .slice(0, limit)
      .map(clone);
  }

  claimNotification({
    workerId,
    now = new Date().toISOString(),
    leaseMs = 60_000,
  }) {
    if (!workerId) throw new Error("workerId is required");
    const notification = this.listDueNotifications({ now, limit: 1 })[0];
    if (!notification) return null;
    const stored = this.#notifications.get(notification.notificationId);
    stored.status = "processing";
    stored.attempts += 1;
    stored.lastError = null;
    stored.claimedAt = new Date(now).toISOString();
    stored.claimedBy = workerId;
    stored.claimToken = randomUUID();
    stored.leaseExpiresAt = new Date(
      Date.parse(now) + leaseMs,
    ).toISOString();
    stored.updatedAt = stored.claimedAt;
    return clone(stored);
  }

  completeNotification({
    notificationId,
    claimToken,
    processedAt = new Date().toISOString(),
  }) {
    if (!claimToken) throw new Error("claimToken is required");
    const notification = this.#notifications.get(notificationId);
    if (
      !notification
      || notification.status !== "processing"
      || notification.claimToken !== claimToken
    ) {
      return null;
    }
    notification.status = "completed";
    notification.processedAt = new Date(processedAt).toISOString();
    notification.leaseExpiresAt = null;
    notification.updatedAt = notification.processedAt;
    return clone(notification);
  }

  failNotification({
    notificationId,
    claimToken,
    error,
    availableAt,
    failedAt = new Date().toISOString(),
  }) {
    if (!claimToken) throw new Error("claimToken is required");
    const notification = this.#notifications.get(notificationId);
    if (
      !notification
      || notification.status !== "processing"
      || notification.claimToken !== claimToken
    ) {
      return null;
    }
    notification.status = "failed";
    notification.lastError = String(error);
    notification.availableAt = new Date(availableAt ?? failedAt).toISOString();
    notification.leaseExpiresAt = null;
    notification.updatedAt = new Date(failedAt).toISOString();
    return clone(notification);
  }

  getOperation(identity) {
    return clone(this.#operations.get(operationKey(identity)) ?? null);
  }

  claimOperation({
    merchantId,
    operation,
    idempotencyKey,
    requestFingerprint,
    now = new Date().toISOString(),
    leaseMs = 60_000,
  }) {
    const key = operationKey({ merchantId, operation, idempotencyKey });
    const existing = this.#operations.get(key);
    const timestamp = new Date(now).toISOString();
    if (existing) {
      if (existing.requestFingerprint !== requestFingerprint) {
        return {
          claimed: false,
          conflict: true,
          operation: clone(existing),
        };
      }
      if (existing.status === "completed") {
        return {
          claimed: false,
          conflict: false,
          response: clone(existing.response),
          operation: clone(existing),
        };
      }
      const leaseActive = existing.status === "processing"
        && Date.parse(existing.leaseExpiresAt ?? "") > Date.parse(timestamp);
      if (leaseActive) {
        return {
          claimed: false,
          conflict: false,
          operation: clone(existing),
        };
      }
      existing.status = "processing";
      existing.attempts += 1;
      existing.lastError = null;
      existing.claimedAt = timestamp;
      existing.claimToken = randomUUID();
      existing.leaseExpiresAt = new Date(
        Date.parse(timestamp) + leaseMs,
      ).toISOString();
      existing.failedAt = null;
      existing.updatedAt = timestamp;
      return {
        claimed: true,
        conflict: false,
        retried: true,
        operation: clone(existing),
      };
    }

    const record = {
      merchantId,
      operation,
      idempotencyKey,
      requestFingerprint,
      status: "processing",
      attempts: 1,
      response: null,
      lastError: null,
      claimedAt: timestamp,
      claimToken: randomUUID(),
      leaseExpiresAt: new Date(
        Date.parse(timestamp) + leaseMs,
      ).toISOString(),
      completedAt: null,
      failedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.#operations.set(key, record);
    return {
      claimed: true,
      conflict: false,
      retried: false,
      operation: clone(record),
    };
  }

  completeOperation({
    merchantId,
    operation,
    idempotencyKey,
    requestFingerprint,
    claimToken,
    response,
    completedAt = new Date().toISOString(),
  }) {
    if (!claimToken) throw new Error("claimToken is required");
    const record = this.#operations.get(operationKey({
      merchantId,
      operation,
      idempotencyKey,
    }));
    if (
      !record
      || record.status !== "processing"
      || record.claimToken !== claimToken
      || (
        requestFingerprint
        && record.requestFingerprint !== requestFingerprint
      )
    ) {
      return null;
    }
    const timestamp = new Date(completedAt).toISOString();
    record.status = "completed";
    record.response = clone(response);
    record.lastError = null;
    record.leaseExpiresAt = null;
    record.completedAt = timestamp;
    record.failedAt = null;
    record.updatedAt = timestamp;
    return clone(record);
  }

  failOperation({
    merchantId,
    operation,
    idempotencyKey,
    requestFingerprint,
    claimToken,
    error,
    failedAt = new Date().toISOString(),
  }) {
    if (!claimToken) throw new Error("claimToken is required");
    const record = this.#operations.get(operationKey({
      merchantId,
      operation,
      idempotencyKey,
    }));
    if (
      !record
      || record.status !== "processing"
      || record.claimToken !== claimToken
      || (
        requestFingerprint
        && record.requestFingerprint !== requestFingerprint
      )
    ) {
      return null;
    }
    const timestamp = new Date(failedAt).toISOString();
    record.status = "failed";
    record.lastError = String(error);
    record.leaseExpiresAt = null;
    record.failedAt = timestamp;
    record.updatedAt = timestamp;
    return clone(record);
  }

  claimSyncLease({
    merchantId,
    operation,
    ownerId,
    now = new Date().toISOString(),
    leaseMs = 60_000,
  }) {
    if (!merchantId) throw new Error("merchantId is required");
    if (!operation) throw new Error("operation is required");
    if (!ownerId) throw new Error("ownerId is required");
    const timestamp = new Date(now).toISOString();
    const existing = this.#syncLeases.get(merchantId);
    if (
      existing
      && !existing.releasedAt
      && Date.parse(existing.leaseExpiresAt) > Date.parse(timestamp)
    ) {
      return { claimed: false, lease: clone(existing) };
    }
    const lease = {
      merchantId,
      operation,
      ownerId,
      claimToken: randomUUID(),
      claimedAt: timestamp,
      leaseExpiresAt: new Date(
        Date.parse(timestamp) + leaseMs,
      ).toISOString(),
      releasedAt: null,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    this.#syncLeases.set(merchantId, lease);
    return { claimed: true, lease: clone(lease) };
  }

  renewSyncLease({
    merchantId,
    claimToken,
    renewedAt = new Date().toISOString(),
    leaseMs = 60_000,
  }) {
    if (!claimToken) throw new Error("claimToken is required");
    const lease = this.#syncLeases.get(merchantId);
    const timestamp = new Date(renewedAt).toISOString();
    if (
      !lease
      || lease.releasedAt
      || lease.claimToken !== claimToken
      || Date.parse(lease.leaseExpiresAt) <= Date.parse(timestamp)
    ) {
      return null;
    }
    lease.leaseExpiresAt = new Date(
      Date.parse(timestamp) + leaseMs,
    ).toISOString();
    lease.updatedAt = timestamp;
    return clone(lease);
  }

  releaseSyncLease({
    merchantId,
    claimToken,
    releasedAt = new Date().toISOString(),
  }) {
    if (!claimToken) throw new Error("claimToken is required");
    const lease = this.#syncLeases.get(merchantId);
    if (!lease || lease.releasedAt || lease.claimToken !== claimToken) {
      return null;
    }
    lease.releasedAt = new Date(releasedAt).toISOString();
    lease.leaseExpiresAt = lease.releasedAt;
    lease.updatedAt = lease.releasedAt;
    return clone(lease);
  }

  disconnectConnection(merchantId) {
    return this.updateConnection(merchantId, {
      status: "disconnected",
      encryptedAccessToken: null,
      encryptedRefreshToken: null,
      accessTokenExpiresAt: null,
      watchChannelId: null,
      watchResourceId: null,
      watchToken: null,
      watchExpiresAt: null,
      watchLastMessageNumber: null,
    });
  }

  startSyncJob(job) {
    this.#jobs.set(job.jobId, clone({
      ...job,
      status: "running",
    }));
  }

  completeSyncJob(jobId, changes) {
    const job = this.#jobs.get(jobId);
    if (!job) throw new Error(`Unknown Google Sheets sync job: ${jobId}`);
    Object.assign(job, clone(changes));
    return clone(job);
  }

  getSyncJob(jobId) {
    return clone(this.#jobs.get(jobId) ?? null);
  }

  saveRowState(state) {
    const key = [
      state.merchantId,
      state.sheetName,
      state.recordId,
    ].join("\0");
    this.#rowStates.set(key, clone(state));
    return clone(state);
  }

  getRowState({ merchantId, sheetName, recordId }) {
    return clone(this.#rowStates.get([
      merchantId,
      sheetName,
      recordId,
    ].join("\0")) ?? null);
  }

  listRowStates({ merchantId, sheetName } = {}) {
    return [...this.#rowStates.values()]
      .filter((state) =>
        (!merchantId || state.merchantId === merchantId)
        && (!sheetName || state.sheetName === sheetName))
      .map(clone);
  }

  healthCheck() {
    return { status: "ok" };
  }
}

export class LakebaseGoogleSheetsStore {
  #pool;

  constructor({ databaseUrl, pool, ssl } = {}) {
    if (!pool && !databaseUrl) {
      throw new Error("databaseUrl or pool is required");
    }
    this.#pool = pool ?? new Pool({
      connectionString: databaseUrl,
      ...(ssl === undefined ? {} : { ssl }),
      max: 3,
    });
  }

  async #transaction(execute) {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const result = await execute(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async close() {
    await this.#pool.end();
  }

  async saveOAuthState(state) {
    await this.#pool.query(
      `
        INSERT INTO google_sheet_oauth_states (
          state_hash,
          merchant_id,
          redirect_uri,
          spreadsheet_id,
          expires_at
        )
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (state_hash) DO UPDATE
        SET merchant_id = EXCLUDED.merchant_id,
            redirect_uri = EXCLUDED.redirect_uri,
            spreadsheet_id = EXCLUDED.spreadsheet_id,
            expires_at = EXCLUDED.expires_at
      `,
      [
        state.stateHash,
        state.merchantId,
        state.redirectUri,
        state.spreadsheetId ?? null,
        state.expiresAt,
      ],
    );
  }

  async consumeOAuthState({ stateHash, merchantId, now }) {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        `
          DELETE FROM google_sheet_oauth_states
          WHERE state_hash = $1
            AND merchant_id = $2
          RETURNING *
        `,
        [stateHash, merchantId],
      );
      await client.query("COMMIT");
      const row = result.rows[0];
      return row && Date.parse(row.expires_at) > now
        ? {
            stateHash: row.state_hash,
            merchantId: row.merchant_id,
            redirectUri: row.redirect_uri,
            spreadsheetId: row.spreadsheet_id,
            expiresAt: new Date(row.expires_at).toISOString(),
          }
        : null;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getConnection(merchantId) {
    const result = await this.#pool.query(
      "SELECT * FROM google_sheet_connections WHERE merchant_id = $1",
      [merchantId],
    );
    return connectionFromRow(result.rows[0]);
  }

  async listConnections() {
    const result = await this.#pool.query(
      "SELECT * FROM google_sheet_connections ORDER BY merchant_id",
    );
    return result.rows.map(connectionFromRow);
  }

  async saveConnection(connection) {
    const result = await this.#pool.query(
      `
        INSERT INTO google_sheet_connections (
          merchant_id,
          spreadsheet_id,
          spreadsheet_url,
          spreadsheet_title,
          encrypted_access_token,
          encrypted_refresh_token,
          access_token_expires_at,
          granted_scopes,
          status,
          sync_mode,
          last_export_at,
          last_import_at,
          last_reconciled_at,
          last_error,
          watch_channel_id,
          watch_resource_id,
          watch_token,
          watch_expires_at,
          watch_last_message_number
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
          $11, $12, $13, $14, $15, $16, $17, $18, $19
        )
        ON CONFLICT (merchant_id) DO UPDATE
        SET spreadsheet_id = EXCLUDED.spreadsheet_id,
            spreadsheet_url = EXCLUDED.spreadsheet_url,
            spreadsheet_title = EXCLUDED.spreadsheet_title,
            encrypted_access_token = EXCLUDED.encrypted_access_token,
            encrypted_refresh_token = EXCLUDED.encrypted_refresh_token,
            access_token_expires_at = EXCLUDED.access_token_expires_at,
            granted_scopes = EXCLUDED.granted_scopes,
            status = EXCLUDED.status,
            sync_mode = EXCLUDED.sync_mode,
            last_export_at = EXCLUDED.last_export_at,
            last_import_at = EXCLUDED.last_import_at,
            last_reconciled_at = EXCLUDED.last_reconciled_at,
            last_error = EXCLUDED.last_error,
            watch_channel_id = EXCLUDED.watch_channel_id,
            watch_resource_id = EXCLUDED.watch_resource_id,
            watch_token = EXCLUDED.watch_token,
            watch_expires_at = EXCLUDED.watch_expires_at,
            watch_last_message_number =
              EXCLUDED.watch_last_message_number,
            updated_at = CURRENT_TIMESTAMP
        RETURNING *
      `,
      [
        connection.merchantId,
        connection.spreadsheetId,
        connection.spreadsheetUrl,
        connection.spreadsheetTitle,
        connection.encryptedAccessToken,
        connection.encryptedRefreshToken,
        connection.accessTokenExpiresAt,
        connection.grantedScopes ?? [],
        connection.status,
        connection.syncMode ?? "manual",
        connection.lastExportAt,
        connection.lastImportAt,
        connection.lastReconciledAt,
        connection.lastError,
        connection.watchChannelId,
        connection.watchResourceId,
        connection.watchToken,
        connection.watchExpiresAt,
        connection.watchLastMessageNumber,
      ],
    );
    return connectionFromRow(result.rows[0]);
  }

  async updateConnection(merchantId, changes) {
    const patch = connectionPatch(changes, 2);
    if (patch.assignments.length === 0) return this.getConnection(merchantId);
    const result = await this.#pool.query(
      `
        UPDATE google_sheet_connections
        SET ${patch.assignments.join(", ")},
            updated_at = CURRENT_TIMESTAMP
        WHERE merchant_id = $1
        RETURNING *
      `,
      [merchantId, ...patch.values],
    );
    return connectionFromRow(result.rows[0]);
  }

  async compareAndSetConnection(
    merchantId,
    { expected = {}, changes = {} } = {},
  ) {
    const patch = connectionPatch(changes, 2);
    if (patch.assignments.length === 0) {
      throw new Error("changes must include at least one connection field");
    }
    const expectedPatch = connectionPatch(
      expected,
      2 + patch.values.length,
    );
    const conditions = expectedPatch.assignments.map((assignment) =>
      assignment.replace(" = ", " IS NOT DISTINCT FROM "));
    const result = await this.#pool.query(
      `
        UPDATE google_sheet_connections
        SET ${patch.assignments.join(", ")},
            updated_at = CURRENT_TIMESTAMP
        WHERE merchant_id = $1
          ${conditions.length ? `AND ${conditions.join(" AND ")}` : ""}
        RETURNING *
      `,
      [merchantId, ...patch.values, ...expectedPatch.values],
    );
    if (result.rows[0]) {
      return {
        updated: true,
        connection: connectionFromRow(result.rows[0]),
      };
    }
    return {
      updated: false,
      connection: await this.getConnection(merchantId),
    };
  }

  async compareAndSetWatchState({
    merchantId,
    expectedChannelId,
    expectedMessageNumber,
    changes,
  }) {
    return this.compareAndSetConnection(merchantId, {
      expected: {
        watchChannelId: expectedChannelId,
        watchLastMessageNumber: expectedMessageNumber,
      },
      changes,
    });
  }

  async advanceWatchMessageAndEnqueueNotification({
    merchantId,
    channelId,
    messageNumber,
    resourceId,
    resourceState,
    availableAt = new Date().toISOString(),
  }) {
    assertMessageNumber(messageNumber);
    return this.#transaction(async (client) => {
      const connectionResult = await client.query(
        `
          SELECT *
          FROM google_sheet_connections
          WHERE merchant_id = $1
          FOR UPDATE
        `,
        [merchantId],
      );
      const connection = connectionFromRow(connectionResult.rows[0]);
      if (!connection || connection.watchChannelId !== channelId) {
        return {
          accepted: false,
          reason: "watch_mismatch",
          notification: null,
        };
      }
      if (!isNewMessageNumber(
        connection.watchLastMessageNumber,
        messageNumber,
      )) {
        return {
          accepted: false,
          reason: "duplicate_or_out_of_order",
          notification: null,
        };
      }

      const inserted = await client.query(
        `
          INSERT INTO google_sheet_notification_queue (
            merchant_id,
            channel_id,
            message_number,
            resource_id,
            resource_state,
            available_at
          )
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (channel_id, message_number) DO NOTHING
          RETURNING *
        `,
        [
          merchantId,
          channelId,
          messageNumber,
          resourceId,
          resourceState,
          availableAt,
        ],
      );
      if (!inserted.rows[0]) {
        return {
          accepted: false,
          reason: "duplicate_or_out_of_order",
          notification: null,
        };
      }
      await client.query(
        `
          UPDATE google_sheet_connections
          SET watch_last_message_number = $2,
              updated_at = CURRENT_TIMESTAMP
          WHERE merchant_id = $1
        `,
        [merchantId, messageNumber],
      );
      return {
        accepted: true,
        reason: null,
        notification: notificationFromRow(inserted.rows[0]),
      };
    });
  }

  async listDueNotifications({
    now = new Date().toISOString(),
    limit = 100,
  } = {}) {
    const result = await this.#pool.query(
      `
        SELECT *
        FROM google_sheet_notification_queue
        WHERE processed_at IS NULL
          AND available_at <= $1
          AND (
            status <> 'processing'
            OR lease_expires_at <= $1
          )
        ORDER BY available_at, notification_id
        LIMIT $2
      `,
      [now, limit],
    );
    return result.rows.map(notificationFromRow);
  }

  async claimNotification({
    workerId,
    now = new Date().toISOString(),
    leaseMs = 60_000,
  }) {
    if (!workerId) throw new Error("workerId is required");
    const claimToken = randomUUID();
    const leaseExpiresAt = new Date(Date.parse(now) + leaseMs).toISOString();
    const result = await this.#pool.query(
      `
        WITH due AS (
          SELECT notification_id
          FROM google_sheet_notification_queue
          WHERE processed_at IS NULL
            AND available_at <= $1
            AND (
              status <> 'processing'
              OR lease_expires_at <= $1
            )
          ORDER BY available_at, notification_id
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )
        UPDATE google_sheet_notification_queue AS queue
        SET status = 'processing',
            attempts = queue.attempts + 1,
            last_error = NULL,
            claimed_at = $1,
            claimed_by = $2,
            claim_token = $3,
            lease_expires_at = $4,
            updated_at = $1
        FROM due
        WHERE queue.notification_id = due.notification_id
        RETURNING queue.*
      `,
      [now, workerId, claimToken, leaseExpiresAt],
    );
    return notificationFromRow(result.rows[0]);
  }

  async completeNotification({
    notificationId,
    claimToken,
    processedAt = new Date().toISOString(),
  }) {
    if (!claimToken) throw new Error("claimToken is required");
    const result = await this.#pool.query(
      `
        UPDATE google_sheet_notification_queue
        SET status = 'completed',
            processed_at = $3,
            lease_expires_at = NULL,
            updated_at = $3
        WHERE notification_id = $1
          AND status = 'processing'
          AND claim_token = $2
        RETURNING *
      `,
      [notificationId, claimToken, processedAt],
    );
    return notificationFromRow(result.rows[0]);
  }

  async failNotification({
    notificationId,
    claimToken,
    error,
    availableAt,
    failedAt = new Date().toISOString(),
  }) {
    if (!claimToken) throw new Error("claimToken is required");
    const result = await this.#pool.query(
      `
        UPDATE google_sheet_notification_queue
        SET status = 'failed',
            last_error = $3,
            available_at = $4,
            lease_expires_at = NULL,
            updated_at = $5
        WHERE notification_id = $1
          AND status = 'processing'
          AND claim_token = $2
        RETURNING *
      `,
      [
        notificationId,
        claimToken,
        String(error),
        availableAt ?? failedAt,
        failedAt,
      ],
    );
    return notificationFromRow(result.rows[0]);
  }

  async getOperation({ merchantId, operation, idempotencyKey }) {
    const result = await this.#pool.query(
      `
        SELECT *
        FROM google_sheet_operation_idempotency
        WHERE merchant_id = $1
          AND operation = $2
          AND idempotency_key = $3
      `,
      [merchantId, operation, idempotencyKey],
    );
    return operationFromRow(result.rows[0]);
  }

  async claimOperation({
    merchantId,
    operation,
    idempotencyKey,
    requestFingerprint,
    now = new Date().toISOString(),
    leaseMs = 60_000,
  }) {
    const claimToken = randomUUID();
    const leaseExpiresAt = new Date(Date.parse(now) + leaseMs).toISOString();
    return this.#transaction(async (client) => {
      const inserted = await client.query(
        `
          INSERT INTO google_sheet_operation_idempotency (
            merchant_id,
            operation,
            idempotency_key,
            request_fingerprint,
            claim_token,
            claimed_at,
            lease_expires_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          ON CONFLICT (merchant_id, operation, idempotency_key) DO NOTHING
          RETURNING *
        `,
        [
          merchantId,
          operation,
          idempotencyKey,
          requestFingerprint,
          claimToken,
          now,
          leaseExpiresAt,
        ],
      );
      if (inserted.rows[0]) {
        return {
          claimed: true,
          conflict: false,
          retried: false,
          operation: operationFromRow(inserted.rows[0]),
        };
      }

      const selected = await client.query(
        `
          SELECT *
          FROM google_sheet_operation_idempotency
          WHERE merchant_id = $1
            AND operation = $2
            AND idempotency_key = $3
          FOR UPDATE
        `,
        [merchantId, operation, idempotencyKey],
      );
      const existing = operationFromRow(selected.rows[0]);
      if (existing.requestFingerprint !== requestFingerprint) {
        return {
          claimed: false,
          conflict: true,
          operation: existing,
        };
      }
      if (existing.status === "completed") {
        return {
          claimed: false,
          conflict: false,
          response: clone(existing.response),
          operation: existing,
        };
      }
      if (
        existing.status === "processing"
        && Date.parse(existing.leaseExpiresAt ?? "") > Date.parse(now)
      ) {
        return {
          claimed: false,
          conflict: false,
          operation: existing,
        };
      }

      const retried = await client.query(
        `
          UPDATE google_sheet_operation_idempotency
          SET status = 'processing',
              attempts = attempts + 1,
              last_error = NULL,
              claimed_at = $4,
              claim_token = $5,
              lease_expires_at = $6,
              failed_at = NULL,
              updated_at = $4
          WHERE merchant_id = $1
            AND operation = $2
            AND idempotency_key = $3
          RETURNING *
        `,
        [
          merchantId,
          operation,
          idempotencyKey,
          now,
          claimToken,
          leaseExpiresAt,
        ],
      );
      return {
        claimed: true,
        conflict: false,
        retried: true,
        operation: operationFromRow(retried.rows[0]),
      };
    });
  }

  async completeOperation({
    merchantId,
    operation,
    idempotencyKey,
    requestFingerprint,
    claimToken,
    response,
    completedAt = new Date().toISOString(),
  }) {
    if (!claimToken) throw new Error("claimToken is required");
    const values = [
      merchantId,
      operation,
      idempotencyKey,
      JSON.stringify(response),
      completedAt,
      claimToken,
    ];
    const fingerprintCondition = requestFingerprint
      ? `AND request_fingerprint = $${values.push(requestFingerprint)}`
      : "";
    const result = await this.#pool.query(
      `
        UPDATE google_sheet_operation_idempotency
        SET status = 'completed',
            response = $4::jsonb,
            last_error = NULL,
            lease_expires_at = NULL,
            completed_at = $5,
            failed_at = NULL,
            updated_at = $5
        WHERE merchant_id = $1
          AND operation = $2
          AND idempotency_key = $3
          AND status = 'processing'
          AND claim_token = $6
          ${fingerprintCondition}
        RETURNING *
      `,
      values,
    );
    return operationFromRow(result.rows[0]);
  }

  async failOperation({
    merchantId,
    operation,
    idempotencyKey,
    requestFingerprint,
    claimToken,
    error,
    failedAt = new Date().toISOString(),
  }) {
    if (!claimToken) throw new Error("claimToken is required");
    const values = [
      merchantId,
      operation,
      idempotencyKey,
      String(error),
      failedAt,
      claimToken,
    ];
    const fingerprintCondition = requestFingerprint
      ? `AND request_fingerprint = $${values.push(requestFingerprint)}`
      : "";
    const result = await this.#pool.query(
      `
        UPDATE google_sheet_operation_idempotency
        SET status = 'failed',
            last_error = $4,
            lease_expires_at = NULL,
            failed_at = $5,
            updated_at = $5
        WHERE merchant_id = $1
          AND operation = $2
          AND idempotency_key = $3
          AND status = 'processing'
          AND claim_token = $6
          ${fingerprintCondition}
        RETURNING *
      `,
      values,
    );
    return operationFromRow(result.rows[0]);
  }

  async claimSyncLease({
    merchantId,
    operation,
    ownerId,
    now = new Date().toISOString(),
    leaseMs = 60_000,
  }) {
    if (!merchantId) throw new Error("merchantId is required");
    if (!operation) throw new Error("operation is required");
    if (!ownerId) throw new Error("ownerId is required");
    const claimToken = randomUUID();
    const leaseExpiresAt = new Date(Date.parse(now) + leaseMs).toISOString();
    const claimed = await this.#pool.query(
      `
        INSERT INTO google_sheet_sync_leases (
          merchant_id,
          operation,
          owner_id,
          claim_token,
          claimed_at,
          lease_expires_at
        )
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (merchant_id) DO UPDATE
        SET operation = EXCLUDED.operation,
            owner_id = EXCLUDED.owner_id,
            claim_token = EXCLUDED.claim_token,
            claimed_at = EXCLUDED.claimed_at,
            lease_expires_at = EXCLUDED.lease_expires_at,
            released_at = NULL,
            updated_at = EXCLUDED.claimed_at
        WHERE google_sheet_sync_leases.released_at IS NOT NULL
           OR google_sheet_sync_leases.lease_expires_at <= EXCLUDED.claimed_at
        RETURNING *
      `,
      [
        merchantId,
        operation,
        ownerId,
        claimToken,
        now,
        leaseExpiresAt,
      ],
    );
    if (claimed.rows[0]) {
      return { claimed: true, lease: syncLeaseFromRow(claimed.rows[0]) };
    }
    const current = await this.#pool.query(
      `
        SELECT *
        FROM google_sheet_sync_leases
        WHERE merchant_id = $1
      `,
      [merchantId],
    );
    return { claimed: false, lease: syncLeaseFromRow(current.rows[0]) };
  }

  async renewSyncLease({
    merchantId,
    claimToken,
    renewedAt = new Date().toISOString(),
    leaseMs = 60_000,
  }) {
    if (!claimToken) throw new Error("claimToken is required");
    const leaseExpiresAt = new Date(
      Date.parse(renewedAt) + leaseMs,
    ).toISOString();
    const result = await this.#pool.query(
      `
        UPDATE google_sheet_sync_leases
        SET lease_expires_at = $4,
            updated_at = $3
        WHERE merchant_id = $1
          AND claim_token = $2
          AND released_at IS NULL
          AND lease_expires_at > $3
        RETURNING *
      `,
      [merchantId, claimToken, renewedAt, leaseExpiresAt],
    );
    return syncLeaseFromRow(result.rows[0]);
  }

  async releaseSyncLease({
    merchantId,
    claimToken,
    releasedAt = new Date().toISOString(),
  }) {
    if (!claimToken) throw new Error("claimToken is required");
    const result = await this.#pool.query(
      `
        UPDATE google_sheet_sync_leases
        SET released_at = $3,
            lease_expires_at = $3,
            updated_at = $3
        WHERE merchant_id = $1
          AND claim_token = $2
          AND released_at IS NULL
        RETURNING *
      `,
      [merchantId, claimToken, releasedAt],
    );
    return syncLeaseFromRow(result.rows[0]);
  }

  async disconnectConnection(merchantId) {
    const result = await this.#pool.query(
      `
        UPDATE google_sheet_connections
        SET status = 'disconnected',
            encrypted_access_token = NULL,
            encrypted_refresh_token = NULL,
            access_token_expires_at = NULL,
            watch_channel_id = NULL,
            watch_resource_id = NULL,
            watch_token = NULL,
            watch_expires_at = NULL,
            watch_last_message_number = NULL,
            updated_at = CURRENT_TIMESTAMP
        WHERE merchant_id = $1
        RETURNING *
      `,
      [merchantId],
    );
    return connectionFromRow(result.rows[0]);
  }

  async startSyncJob(job) {
    await this.#pool.query(
      `
        INSERT INTO google_sheet_sync_jobs (
          job_id,
          merchant_id,
          operation,
          status,
          started_at
        )
        VALUES ($1, $2, $3, 'running', $4)
      `,
      [job.jobId, job.merchantId, job.operation, job.startedAt],
    );
  }

  async completeSyncJob(jobId, changes) {
    const result = await this.#pool.query(
      `
        UPDATE google_sheet_sync_jobs
        SET status = $2,
            rows_processed = $3,
            error_count = $4,
            error = $5,
            completed_at = $6
        WHERE job_id = $1
        RETURNING *
      `,
      [
        jobId,
        changes.status,
        changes.rowsProcessed ?? 0,
        changes.errorCount ?? 0,
        changes.error ?? null,
        changes.completedAt,
      ],
    );
    return result.rows[0] ?? null;
  }

  async getSyncJob(jobId) {
    const result = await this.#pool.query(
      "SELECT * FROM google_sheet_sync_jobs WHERE job_id = $1",
      [jobId],
    );
    return result.rows[0] ?? null;
  }

  async saveRowState(state) {
    const result = await this.#pool.query(
      `
        INSERT INTO google_sheet_row_state (
          merchant_id,
          sheet_name,
          record_id,
          row_number,
          record_version,
          checksum,
          last_synced_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (merchant_id, sheet_name, record_id) DO UPDATE
        SET row_number = EXCLUDED.row_number,
            record_version = EXCLUDED.record_version,
            checksum = EXCLUDED.checksum,
            last_synced_at = EXCLUDED.last_synced_at
        RETURNING *
      `,
      [
        state.merchantId,
        state.sheetName,
        state.recordId,
        state.rowNumber ?? null,
        state.recordVersion ?? 1,
        state.checksum,
        state.lastSyncedAt,
      ],
    );
    return rowStateFromRow(result.rows[0]);
  }

  async getRowState({ merchantId, sheetName, recordId }) {
    const result = await this.#pool.query(
      `
        SELECT *
        FROM google_sheet_row_state
        WHERE merchant_id = $1
          AND sheet_name = $2
          AND record_id = $3
      `,
      [merchantId, sheetName, recordId],
    );
    return rowStateFromRow(result.rows[0]);
  }

  async listRowStates({ merchantId, sheetName } = {}) {
    const conditions = [];
    const values = [];
    if (merchantId) {
      values.push(merchantId);
      conditions.push(`merchant_id = $${values.length}`);
    }
    if (sheetName) {
      values.push(sheetName);
      conditions.push(`sheet_name = $${values.length}`);
    }
    const result = await this.#pool.query(
      `
        SELECT *
        FROM google_sheet_row_state
        ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
        ORDER BY merchant_id, sheet_name, row_number, record_id
      `,
      values,
    );
    return result.rows.map(rowStateFromRow);
  }

  async healthCheck() {
    await this.#pool.query("SELECT 1");
    return { status: "ok" };
  }
}
