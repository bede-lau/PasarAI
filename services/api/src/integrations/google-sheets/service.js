import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

import { validateContract } from "@pasarai/contracts/v1";

import { GoogleWorkspaceApiError } from "./google-workspace-client.js";

const WORKBOOK_SHEETS = [
  "Dashboard",
  "Metrics",
  "Inputs",
  "Sync Errors",
  "Configuration",
];
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const TOKEN_REFRESH_WINDOW_MS = 60 * 1000;
const DEFAULT_WATCH_TTL_MS = 23 * 60 * 60 * 1000;
const DEFAULT_WATCH_RENEWAL_WINDOW_MS = 60 * 60 * 1000;
const OPERATION_LEASE_MS = 45 * 60 * 1000;
const SYNC_LEASE_MS = 30 * 60 * 1000;
const INPUT_COLUMN_COUNT = 18;
const INPUT_HEADERS = [
  "Action",
  "Record Type",
  "Occurred At",
  "Product ID",
  "Component ID",
  "Quantity",
  "Unit Price (RM)",
  "Supplier",
  "UOM",
  "Pack Size",
  "Total Price (RM)",
  "Payment Method",
  "Note",
  "Status",
  "Record ID",
  "Record Version",
  "Error",
  "Row Checksum",
];
const SYNC_ERROR_HEADERS = [
  "Input Row",
  "Record Type",
  "Error",
  "Updated At",
];
const PAYMENT_METHODS = new Set([
  "cash",
  "card",
  "bank_transfer",
  "other",
]);

export class GoogleSheetsIntegrationError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = "GoogleSheetsIntegrationError";
    this.code = code;
    this.status = status;
    this.public = true;
  }
}

function contract(id, value) {
  const errors = validateContract(id, value);
  if (errors.length) {
    throw new Error(`Invalid ${id}: ${errors.join("; ")}`);
  }
  return value;
}

function requestContract(id, value) {
  const errors = validateContract(id, value);
  if (errors.length) throw new TypeError(errors.join("; "));
  return value;
}

function stateHash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function checksum(value) {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

function spreadsheetUrl(spreadsheetId, supplied) {
  return supplied
    ?? `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;
}

function publicStatus(connection) {
  const connected = connection?.status === "active";
  const failed = connection?.status === "error";
  return contract("google-sheets-status.response", {
    state: connected ? "connected" : failed ? "error" : "not_connected",
    spreadsheet_id: connected || failed ? connection.spreadsheetId : null,
    spreadsheet_url: connected || failed ? connection.spreadsheetUrl : null,
    spreadsheet_title: connected || failed ? connection.spreadsheetTitle : null,
    sync_mode: connection?.syncMode === "automatic"
      ? "automatic"
      : "manual",
    last_export_at: connection?.lastExportAt ?? null,
    last_import_at: connection?.lastImportAt ?? null,
    last_reconciled_at: connection?.lastReconciledAt ?? null,
    watch_expires_at: connection?.watchExpiresAt ?? null,
    last_error: connection?.lastError ?? null,
  });
}

function oauthState() {
  return `${randomUUID()}.${randomBytes(24).toString("base64url")}`;
}

function validateRedirectUri(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("redirect_uri must be a valid URL");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new TypeError("redirect_uri must use http or https");
  }
  return url.toString();
}

function validateWebhookUrl(value) {
  if (!value) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("GOOGLE_SHEETS_WEBHOOK_URL must be a valid URL");
  }
  if (url.protocol !== "https:") {
    throw new Error("GOOGLE_SHEETS_WEBHOOK_URL must use HTTPS");
  }
  return url.toString();
}

function accessTokenExpiry(now, expiresIn) {
  const seconds = Number(expiresIn);
  return new Date(
    now + (Number.isFinite(seconds) ? seconds * 1000 : 3600 * 1000),
  ).toISOString();
}

function sheetTitles(metadata) {
  return new Set(
    (metadata.sheets ?? [])
      .map((sheet) => sheet.properties?.title)
      .filter(Boolean),
  );
}

function dashboardValues() {
  return [
    ["PasarAI Metrics Dashboard"],
    [],
    ["Latest reporting date", ""],
    ["Revenue (RM)", ""],
    ["Cost of sales (RM)", ""],
    ["Gross profit (RM)", ""],
    ["Gross margin (%)", ""],
    [],
    ["Managed by PasarAI. Use the application to refresh this workbook."],
  ];
}

function dashboardFormulaData() {
  return [{
    range: "Dashboard!B3:B7",
    majorDimension: "ROWS",
    values: [
      ['=IFERROR(LOOKUP(2,1/(Metrics!A:A<>""),Metrics!A:A),"")'],
      ['=IFERROR(LOOKUP(2,1/(Metrics!A:A<>""),Metrics!B:B),0)'],
      ['=IFERROR(LOOKUP(2,1/(Metrics!A:A<>""),Metrics!C:C),0)'],
      ['=IFERROR(LOOKUP(2,1/(Metrics!A:A<>""),Metrics!D:D),0)'],
      ['=IFERROR(LOOKUP(2,1/(Metrics!A:A<>""),Metrics!E:E),0)'],
    ],
  }];
}

function metricRows(summaries, completedAt) {
  return [
    [
      "Date",
      "Revenue (RM)",
      "COGS (RM)",
      "Gross Profit (RM)",
      "Gross Margin (%)",
      "Data Completeness",
      "Baseline Margin (%)",
      "Margin Change (pp)",
      "Updated At",
      "Record ID",
      "Record Version",
      "Checksum",
    ],
    ...summaries.map((summary) => [
      summary.date,
      summary.revenue_rm,
      summary.cogs_rm,
      summary.gross_profit_rm,
      summary.gross_margin_pct,
      summary.data_completeness.state,
      summary.baseline_comparison.baseline_margin_pct,
      summary.baseline_comparison.margin_change_percentage_points,
      completedAt,
      `daily:${summary.date}`,
      1,
      checksum(summary),
    ]),
  ];
}

function inputTemplateValues() {
  return [INPUT_HEADERS];
}

function configurationValues() {
  return [
    ["PasarAI Google Sheets Configuration"],
    ["Accepted record types", "sale, cost"],
    ["Accepted actions", "CREATE, UPDATE, REFRESH"],
    ["Editable after sync", "sale: Product ID, Quantity, Unit Price"],
    ["Read-only after sync", "cost"],
    ["Payment methods", "cash, card, bank_transfer, other"],
    ["Managed status values", "synced, error, conflict"],
    ["Currency", "MYR"],
  ];
}

function initialWorkbookData(completedAt) {
  return [{
    range: "Dashboard!A1:B9",
    majorDimension: "ROWS",
    values: dashboardValues(),
  }, {
    range: "Metrics!A1:L1",
    majorDimension: "ROWS",
    values: metricRows([], completedAt),
  }, {
    range: "Inputs!A1:R1",
    majorDimension: "ROWS",
    values: inputTemplateValues(),
  }, {
    range: "Sync Errors!A1:D1",
    majorDimension: "ROWS",
    values: [SYNC_ERROR_HEADERS],
  }, {
    range: "Configuration!A1:B8",
    majorDimension: "ROWS",
    values: configurationValues(),
  }];
}

function initialDataForSheets(titles, completedAt) {
  const requested = new Set(titles);
  return initialWorkbookData(completedAt).filter(({ range }) =>
    requested.has(range.split("!")[0]));
}

function inputCell(row, index) {
  return String(row[index] ?? "").trim();
}

function inputContainsFormula(row) {
  return row.some((value) => String(value ?? "").trimStart().startsWith("="));
}

function normalizedInputRow(row) {
  return Array.from(
    { length: INPUT_COLUMN_COUNT },
    (_, index) => row[index] ?? "",
  );
}

function nonNegativeDecimal(value, field) {
  if (!/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(value)) {
    throw new TypeError(`${field} must be a non-negative decimal`);
  }
  return value;
}

function positiveDecimal(value, field) {
  if (!/^(0\.(0*[1-9][0-9]*)|[1-9][0-9]*(\.[0-9]+)?)$/.test(value)) {
    throw new TypeError(`${field} must be greater than zero`);
  }
  return value;
}

function money(value, field) {
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,2}))?$/.exec(value);
  if (!match) throw new TypeError(`${field} must be a MYR amount`);
  return `${match[1]}.${(match[2] ?? "").padEnd(2, "0")}`;
}

function occurredAt(value) {
  let normalized = value;
  if (/^\d+(?:\.\d+)?$/.test(value)) {
    const serial = Number(value);
    if (!Number.isFinite(serial) || serial < 1) {
      throw new TypeError("Occurred At must be an ISO date or timestamp");
    }
    const milliseconds = Date.UTC(1899, 11, 30)
      + Math.round(serial * 24 * 60 * 60 * 1000);
    const spreadsheetDate = new Date(milliseconds);
    normalized = Number.isInteger(serial)
      ? `${spreadsheetDate.toISOString().slice(0, 10)}T12:00:00+08:00`
      : spreadsheetDate.toISOString();
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    normalized = `${value}T12:00:00+08:00`;
  }
  const date = new Date(normalized);
  if (!value || Number.isNaN(date.valueOf())) {
    throw new TypeError("Occurred At must be an ISO date or timestamp");
  }
  return normalized;
}

function rowError(result) {
  if (result?.errors?.length) {
    return result.errors.map(({ message }) => message).join("; ");
  }
  if (result?.clarifications?.length) {
    return result.clarifications
      .map(({ question }) => question)
      .join("; ");
  }
  return `The ${result?.state ?? "unknown"} result cannot be imported`;
}

function inputSource(row) {
  return row.slice(0, 13).map((value) => String(value ?? "").trim());
}

function inputIsBlank(row) {
  return inputSource(row).every((value) => value === "");
}

function sourceEventId(spreadsheetId, rowNumber, sourceChecksum) {
  return [
    "google_sheet",
    spreadsheetId,
    "Inputs",
    rowNumber,
    sourceChecksum.slice(0, 24),
  ].join(":");
}

function parsedInput(row, {
  merchantId,
  spreadsheetId,
  rowNumber,
  sourceChecksum,
}) {
  const action = inputCell(row, 0).toUpperCase();
  if (action && action !== "CREATE") {
    throw new TypeError("Action must be CREATE or blank");
  }
  const recordType = inputCell(row, 1).toLowerCase();
  if (!["sale", "cost"].includes(recordType)) {
    throw new TypeError("Record Type must be sale or cost");
  }
  const evidenceId = sourceEventId(
    spreadsheetId,
    rowNumber,
    sourceChecksum,
  );
  const common = {
    merchant_id: merchantId,
    occurred_at: occurredAt(inputCell(row, 2)),
    source: "web_manual",
    source_language: "en",
    evidence: { source_event_id: evidenceId },
  };

  if (recordType === "sale") {
    const productId = inputCell(row, 3);
    if (!productId) throw new TypeError("Product ID is required for a sale");
    return {
      recordType,
      evidenceId,
      request: {
        ...common,
        lines: [{
          product_id: productId,
          quantity: positiveDecimal(inputCell(row, 5), "Quantity"),
          unit_price_rm: money(
            inputCell(row, 6),
            "Unit Price (RM)",
          ),
        }],
      },
    };
  }

  const componentId = inputCell(row, 4);
  if (!componentId) {
    throw new TypeError("Component ID is required for a cost");
  }
  const supplier = inputCell(row, 7);
  if (!supplier) throw new TypeError("Supplier is required for a cost");
  const uom = inputCell(row, 8);
  if (!uom) throw new TypeError("UOM is required for a cost");
  const paymentMethod = inputCell(row, 11).toLowerCase() || "cash";
  if (!PAYMENT_METHODS.has(paymentMethod)) {
    throw new TypeError(
      "Payment Method must be cash, card, bank_transfer, or other",
    );
  }
  const note = inputCell(row, 12);
  return {
    recordType,
    evidenceId,
    request: {
      ...common,
      supplier_name: supplier,
      metadata: {
        payment_method: paymentMethod,
        ...(note ? { note } : {}),
      },
      lines: [{
        component_id: componentId,
        quantity: positiveDecimal(inputCell(row, 5), "Quantity"),
        uom,
        pack_size: positiveDecimal(inputCell(row, 9), "Pack Size"),
        total_price_rm: money(
          inputCell(row, 10),
          "Total Price (RM)",
        ),
        confidence: "1.00",
      }],
    },
  };
}

function setInputError(row, message, sourceChecksum) {
  row[13] = "error";
  row[14] = inputCell(row, 14);
  row[15] = inputCell(row, 15);
  row[16] = message;
  row[17] = sourceChecksum;
}

function setInputSynced(
  row,
  {
    recordId,
    recordVersion,
    sourceChecksum,
  },
) {
  row[13] = "synced";
  row[14] = recordId;
  row[15] = recordVersion;
  row[16] = "";
  row[17] = sourceChecksum;
}

function setInputConflict(row, message, sourceChecksum) {
  row[13] = "conflict";
  row[16] = message;
  row[17] = sourceChecksum;
}

function normalizedDecimal(value) {
  const [integer, fraction = ""] = String(value).split(".");
  const normalizedInteger = integer.replace(/^0+(?=\d)/, "") || "0";
  const normalizedFraction = fraction.replace(/0+$/, "");
  return normalizedFraction
    ? `${normalizedInteger}.${normalizedFraction}`
    : normalizedInteger;
}

function decimalEquivalent(left, right) {
  return normalizedDecimal(left) === normalizedDecimal(right);
}

function applySaleCorrection(payload, change) {
  const line = payload.lines[change.line_index ?? 0];
  if (change.field === "source_language") {
    payload.source_language = change.corrected_value;
  } else {
    line[change.field] = change.corrected_value;
  }
}

async function effectiveRecord(ledgerStore, merchantId, recordId) {
  const event = await ledgerStore.getEvent(recordId);
  if (!event || event.merchantId !== merchantId) return null;
  if (event.type !== "sale") {
    return {
      event,
      payload: structuredClone(event.payload),
      version: 1,
    };
  }
  const payload = structuredClone(event.payload);
  const corrections = (await ledgerStore.listEvents({
    merchantId,
    type: "correction",
  })).filter((candidate) => candidate.targetEventId === recordId);
  for (const correction of corrections) {
    for (const change of correction.payload.replacement_payload.changes) {
      applySaleCorrection(payload, change);
    }
  }
  return {
    event,
    payload,
    version: corrections.length + 1,
  };
}

function refreshSaleRow(row, payload, recordVersion) {
  const line = payload.lines[0];
  row[0] = "UPDATE";
  row[1] = "sale";
  row[2] = payload.occurred_at;
  row[3] = line.product_id;
  row[4] = "";
  row[5] = line.quantity;
  row[6] = line.unit_price_rm;
  for (let index = 7; index <= 12; index += 1) row[index] = "";
  const refreshedChecksum = checksum(inputSource(row));
  setInputSynced(row, {
    recordId: inputCell(row, 14),
    recordVersion,
    sourceChecksum: refreshedChecksum,
  });
  return refreshedChecksum;
}

function refreshCostRow(row, payload, recordVersion) {
  const line = payload.lines[0];
  row[0] = "CREATE";
  row[1] = "cost";
  row[2] = payload.occurred_at;
  row[3] = "";
  row[4] = line.component_id;
  row[5] = line.quantity;
  row[6] = "";
  row[7] = payload.supplier_name;
  row[8] = line.uom;
  row[9] = line.pack_size;
  row[10] = line.total_price_rm;
  row[11] = payload.metadata?.payment_method ?? "cash";
  row[12] = payload.metadata?.note ?? "";
  const refreshedChecksum = checksum(inputSource(row));
  setInputSynced(row, {
    recordId: inputCell(row, 14),
    recordVersion,
    sourceChecksum: refreshedChecksum,
  });
  return refreshedChecksum;
}

function saleCorrectionChanges(row, payload) {
  if (payload.lines.length !== 1) {
    throw new TypeError(
      "Only single-line sale records can be edited in Google Sheets",
    );
  }
  if (occurredAt(inputCell(row, 2)) !== payload.occurred_at) {
    throw new TypeError("Occurred At is read-only after synchronization");
  }
  if (inputCell(row, 1).toLowerCase() !== "sale") {
    throw new TypeError("Record Type is read-only after synchronization");
  }
  for (const index of [4, 7, 8, 9, 10, 11, 12]) {
    if (inputCell(row, index)) {
      throw new TypeError(
        "Cost-only fields must remain blank for a sale record",
      );
    }
  }
  const line = payload.lines[0];
  const productId = inputCell(row, 3);
  if (!productId) throw new TypeError("Product ID is required for a sale");
  const quantity = positiveDecimal(inputCell(row, 5), "Quantity");
  const unitPrice = money(inputCell(row, 6), "Unit Price (RM)");
  row[5] = quantity;
  row[6] = unitPrice;
  const changes = [];
  if (productId !== line.product_id) {
    changes.push({
      kind: "identifier",
      field: "product_id",
      line_index: 0,
      previous_value: line.product_id,
      corrected_value: productId,
    });
  }
  if (!decimalEquivalent(quantity, line.quantity)) {
    changes.push({
      kind: "decimal",
      field: "quantity",
      line_index: 0,
      previous_value: line.quantity,
      corrected_value: quantity,
    });
  }
  if (!decimalEquivalent(unitPrice, line.unit_price_rm)) {
    changes.push({
      kind: "money",
      field: "unit_price_rm",
      line_index: 0,
      previous_value: line.unit_price_rm,
      corrected_value: unitPrice,
    });
  }
  return changes;
}

function secureEqual(left, right) {
  const leftBytes = Buffer.from(String(left ?? ""));
  const rightBytes = Buffer.from(String(right ?? ""));
  return leftBytes.length === rightBytes.length
    && timingSafeEqual(leftBytes, rightBytes);
}

function newMessageNumber(previous, supplied) {
  try {
    const current = BigInt(supplied);
    return current >= 1n
      && (previous === null || previous === undefined
        || current > BigInt(previous));
  } catch {
    return false;
  }
}

export function createGoogleSheetsIntegration({
  store,
  ledgerStore,
  businessService,
  googleClient,
  tokenCipher,
  webhookUrl,
  watchTtlMs = DEFAULT_WATCH_TTL_MS,
  watchRenewalWindowMs = DEFAULT_WATCH_RENEWAL_WINDOW_MS,
  syncLeaseMs = SYNC_LEASE_MS,
  syncLeaseHeartbeatMs = Math.max(1, Math.floor(syncLeaseMs / 3)),
  now = () => Date.now(),
  idFactory = (kind) => `${kind}_${randomUUID()}`,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
}) {
  if (!store) throw new Error("store is required");
  if (!ledgerStore) throw new Error("ledgerStore is required");
  if (!businessService) throw new Error("businessService is required");
  if (!googleClient) throw new Error("googleClient is required");
  if (!tokenCipher) throw new Error("tokenCipher is required");
  if (!Number.isFinite(syncLeaseMs) || syncLeaseMs <= 0) {
    throw new Error("syncLeaseMs must be a positive number");
  }
  if (!Number.isFinite(syncLeaseHeartbeatMs) || syncLeaseHeartbeatMs <= 0) {
    throw new Error("syncLeaseHeartbeatMs must be a positive number");
  }
  const normalizedWebhookUrl = validateWebhookUrl(webhookUrl);
  const syncOwnerId = `google_sheets_sync_owner_${randomUUID()}`;
  const heldSyncLeases = new Map();

  function syncLeaseLostError() {
    return new GoogleSheetsIntegrationError(
      "google_sheets_sync_lease_lost",
      "The Google Sheets synchronization lease was lost. Retry the operation.",
      409,
    );
  }

  async function renewHeldSyncLease(merchantId, claimToken) {
    const held = heldSyncLeases.get(claimToken);
    if (held?.lost) throw held.lost;
    const renewed = await store.renewSyncLease({
      merchantId,
      claimToken,
      renewedAt: new Date(now()).toISOString(),
      leaseMs: syncLeaseMs,
    });
    if (!renewed) {
      const error = syncLeaseLostError();
      if (held) held.lost = error;
      throw error;
    }
    return renewed;
  }

  async function assertSyncLease(merchantId, claimToken) {
    if (!claimToken) return null;
    const held = heldSyncLeases.get(claimToken);
    if (held?.heartbeat) await held.heartbeat;
    if (held?.lost) throw held.lost;
    return renewHeldSyncLease(merchantId, claimToken);
  }

  async function withSyncLease({
    merchantId,
    operation,
    claimToken,
    execute,
  }) {
    if (claimToken) {
      await assertSyncLease(merchantId, claimToken);
      return execute(claimToken);
    }
    const claimed = await store.claimSyncLease({
      merchantId,
      operation,
      ownerId: syncOwnerId,
      now: new Date(now()).toISOString(),
      leaseMs: syncLeaseMs,
    });
    if (!claimed.claimed) {
      throw new GoogleSheetsIntegrationError(
        "google_sheets_sync_in_progress",
        "Another Google Sheets synchronization is already in progress.",
        409,
      );
    }
    const held = {
      heartbeat: null,
      lost: null,
      timer: null,
    };
    const heartbeat = () => {
      if (held.heartbeat || held.lost) return held.heartbeat;
      held.heartbeat = renewHeldSyncLease(
        merchantId,
        claimed.lease.claimToken,
      ).catch((error) => {
        held.lost = error;
      }).finally(() => {
        held.heartbeat = null;
      });
      return held.heartbeat;
    };
    heldSyncLeases.set(claimed.lease.claimToken, held);
    held.timer = setIntervalImpl(() => {
      void heartbeat();
    }, Math.min(
      syncLeaseHeartbeatMs,
      Math.max(1, Math.floor(syncLeaseMs / 2)),
    ));
    held.timer?.unref?.();
    try {
      return await execute(claimed.lease.claimToken);
    } finally {
      if (held.timer) clearIntervalImpl(held.timer);
      await held.heartbeat;
      heldSyncLeases.delete(claimed.lease.claimToken);
      await store.releaseSyncLease({
        merchantId,
        claimToken: claimed.lease.claimToken,
        releasedAt: new Date(now()).toISOString(),
      });
    }
  }

  function coreConnectionExpectation(connection) {
    return {
      status: connection.status,
      spreadsheetId: connection.spreadsheetId,
      encryptedAccessToken: connection.encryptedAccessToken,
      encryptedRefreshToken: connection.encryptedRefreshToken,
    };
  }

  function watchConnectionExpectation(connection) {
    return {
      ...coreConnectionExpectation(connection),
      syncMode: connection.syncMode,
      watchChannelId: connection.watchChannelId,
      watchResourceId: connection.watchResourceId,
      watchToken: connection.watchToken,
      watchExpiresAt: connection.watchExpiresAt,
      watchLastMessageNumber: connection.watchLastMessageNumber,
    };
  }

  function connectionChangedError() {
    return new GoogleSheetsIntegrationError(
      "google_sheets_connection_changed",
      "The Google Sheets connection changed concurrently. Retry the operation.",
      409,
    );
  }

  async function patchConnectedConnection(
    merchantId,
    changes,
    syncLeaseToken,
  ) {
    await assertSyncLease(merchantId, syncLeaseToken);
    const connection = await connectionFor(merchantId);
    const patched = await store.compareAndSetConnection(merchantId, {
      expected: coreConnectionExpectation(connection),
      changes,
    });
    if (!patched.updated) throw connectionChangedError();
    return patched.connection;
  }

  async function idempotentOperation({
    merchantId,
    operation,
    idempotencyKey,
    payload,
    execute,
  }) {
    if (idempotencyKey === undefined) return execute();
    const normalizedKey = String(idempotencyKey).trim();
    if (!normalizedKey) {
      throw new TypeError("Idempotency-Key must not be empty");
    }
    const requestFingerprint = checksum(payload);
    const claimed = await store.claimOperation({
      merchantId,
      operation,
      idempotencyKey: normalizedKey,
      requestFingerprint,
      now: new Date(now()).toISOString(),
      leaseMs: OPERATION_LEASE_MS,
    });
    if (claimed.conflict) {
      throw new GoogleSheetsIntegrationError(
        "idempotency_key_reused",
        "Idempotency-Key was already used with a different request.",
        409,
      );
    }
    if (!claimed.claimed) {
      if (claimed.response !== undefined) return claimed.response;
      throw new GoogleSheetsIntegrationError(
        "idempotency_request_in_progress",
        "A request with this Idempotency-Key is already in progress.",
        409,
      );
    }
    const claimToken = claimed.operation.claimToken;
    try {
      const response = await execute();
      const completed = await store.completeOperation({
        merchantId,
        operation,
        idempotencyKey: normalizedKey,
        requestFingerprint,
        claimToken,
        response,
        completedAt: new Date(now()).toISOString(),
      });
      if (!completed) {
        throw new GoogleSheetsIntegrationError(
          "idempotency_lease_lost",
          "The idempotency lease expired before the operation completed.",
          409,
        );
      }
      return response;
    } catch (error) {
      await store.failOperation({
        merchantId,
        operation,
        idempotencyKey: normalizedKey,
        requestFingerprint,
        claimToken,
        error: error?.message ?? String(error),
        failedAt: new Date(now()).toISOString(),
      });
      throw error;
    }
  }

  async function connectionFor(merchantId) {
    const connection = await store.getConnection(merchantId);
    if (!connection || connection.status === "disconnected") {
      throw new GoogleSheetsIntegrationError(
        "google_sheets_not_connected",
        "Google Sheets is not connected for this merchant.",
        409,
      );
    }
    return connection;
  }

  async function authorizedConnection(
    merchantId,
    { syncLeaseToken } = {},
  ) {
    let connection = await connectionFor(merchantId);
    let accessToken = tokenCipher.decrypt(connection.encryptedAccessToken);
    if (
      !accessToken
      || Date.parse(connection.accessTokenExpiresAt ?? "") - now()
        <= TOKEN_REFRESH_WINDOW_MS
    ) {
      const refreshToken = tokenCipher.decrypt(
        connection.encryptedRefreshToken,
      );
      if (!refreshToken) {
        throw new GoogleSheetsIntegrationError(
          "google_sheets_reauthorization_required",
          "Google Sheets access has expired. Reconnect the spreadsheet.",
          409,
        );
      }
      const refreshed = await googleClient.refreshAccessToken(refreshToken);
      accessToken = refreshed.access_token;
      await assertSyncLease(merchantId, syncLeaseToken);
      const rotated = await store.compareAndSetConnection(merchantId, {
        expected: coreConnectionExpectation(connection),
        changes: {
          encryptedAccessToken: tokenCipher.encrypt(accessToken),
          accessTokenExpiresAt: accessTokenExpiry(
            now(),
            refreshed.expires_in,
          ),
          lastError: null,
        },
      });
      if (!rotated.updated) throw connectionChangedError();
      connection = rotated.connection;
    }
    return { connection, accessToken };
  }

  async function ensureWorkbook({
    connection,
    accessToken,
    syncLeaseToken,
  }) {
    const merchantId = connection.merchantId;
    const metadata = await googleClient.getSpreadsheet({
      accessToken,
      spreadsheetId: connection.spreadsheetId,
    });
    const existing = sheetTitles(metadata);
    const missing = WORKBOOK_SHEETS.filter((title) => !existing.has(title));
    if (missing.length) {
      await assertSyncLease(merchantId, syncLeaseToken);
      await googleClient.batchUpdateSpreadsheet({
        accessToken,
        spreadsheetId: connection.spreadsheetId,
        requests: missing.map((title) => ({
          addSheet: { properties: { title } },
        })),
      });
      await assertSyncLease(merchantId, syncLeaseToken);
      await googleClient.batchUpdateValues({
        accessToken,
        spreadsheetId: connection.spreadsheetId,
        data: initialDataForSheets(
          missing,
          new Date(now()).toISOString(),
        ),
      });
      if (missing.includes("Dashboard")) {
        await assertSyncLease(merchantId, syncLeaseToken);
        await googleClient.batchUpdateValues({
          accessToken,
          spreadsheetId: connection.spreadsheetId,
          data: dashboardFormulaData(),
          valueInputOption: "USER_ENTERED",
        });
      }
    }
    return metadata;
  }

  async function reportingDates(merchantId, requestedDates) {
    if (requestedDates?.length) {
      return [...new Set(requestedDates)].sort();
    }
    const events = await ledgerStore.listEvents({ merchantId });
    const dates = await Promise.all(
      events.map((event) =>
        ledgerStore.getMerchantCalendarDate(merchantId, event.occurredAt)),
    );
    if (!dates.length) {
      dates.push(await ledgerStore.getMerchantCalendarDate(
        merchantId,
        new Date(now()).toISOString(),
      ));
    }
    return [...new Set(dates)].sort();
  }

  async function failConnection(merchantId, error) {
    const connection = await store.getConnection(merchantId);
    if (!connection || connection.status === "disconnected") return null;
    return store.compareAndSetConnection(merchantId, {
      expected: coreConnectionExpectation(connection),
      changes: {
        status: "error",
        lastError: error.message,
      },
    });
  }

  function providerError(error) {
    if (error instanceof GoogleSheetsIntegrationError) return error;
    if (error instanceof GoogleWorkspaceApiError) {
      return new GoogleSheetsIntegrationError(
        "google_api_error",
        error.message,
        502,
      );
    }
    return error;
  }

  async function replaceWatch(merchantId, { syncLeaseToken } = {}) {
    if (!syncLeaseToken) {
      return withSyncLease({
        merchantId,
        operation: "replace-watch",
        execute: (claimToken) =>
          replaceWatch(merchantId, { syncLeaseToken: claimToken }),
      });
    }
    if (!normalizedWebhookUrl) {
      throw new GoogleSheetsIntegrationError(
        "google_sheets_webhook_not_configured",
        "Automatic synchronization requires an HTTPS Google Sheets webhook URL.",
        409,
      );
    }
    const authorized = await authorizedConnection(merchantId, {
      syncLeaseToken,
    });
    const previous = authorized.connection;
    const channelId = String(idFactory("google_drive_channel")).slice(0, 64);
    const channelToken = randomBytes(32).toString("base64url");
    const expiration = now() + Math.min(
      Math.max(1, watchTtlMs),
      DEFAULT_WATCH_TTL_MS,
    );
    let replacement = null;
    let published;
    try {
      await assertSyncLease(merchantId, syncLeaseToken);
      const watched = await googleClient.watchFile({
        accessToken: authorized.accessToken,
        spreadsheetId: previous.spreadsheetId,
        channelId,
        webhookUrl: normalizedWebhookUrl,
        channelToken,
        expiration,
      });
      const watchExpiration = Number(watched?.expiration ?? expiration);
      replacement = {
        status: "active",
        syncMode: "automatic",
        lastError: null,
        watchChannelId: watched?.id ?? channelId,
        watchResourceId: watched?.resourceId,
        watchToken: watched?.token ?? channelToken,
        watchExpiresAt: new Date(
          Number.isFinite(watchExpiration)
            ? watchExpiration
            : expiration,
        ).toISOString(),
        watchLastMessageNumber: null,
      };
      await assertSyncLease(merchantId, syncLeaseToken);
      published = await store.compareAndSetConnection(merchantId, {
        expected: watchConnectionExpectation(previous),
        changes: replacement,
      });
      if (!published.updated) throw connectionChangedError();
    } catch (error) {
      if (replacement?.watchChannelId && replacement.watchResourceId) {
        try {
          await googleClient.stopChannel({
            accessToken: authorized.accessToken,
            channelId: replacement.watchChannelId,
            resourceId: replacement.watchResourceId,
          });
        } catch {
          // The unpublished replacement will expire independently.
        }
      }
      throw error;
    }
    const updated = published.connection;
    if (
      previous.watchChannelId
      && previous.watchResourceId
      && previous.watchChannelId !== updated.watchChannelId
    ) {
      try {
        await googleClient.stopChannel({
          accessToken: authorized.accessToken,
          channelId: previous.watchChannelId,
          resourceId: previous.watchResourceId,
        });
      } catch {
        // The superseded channel will expire independently.
      }
    }
    return updated;
  }

  let api;
  api = {
    async status({ merchantId }) {
      return publicStatus(await store.getConnection(merchantId));
    },

    async startOAuth(args = {}, { idempotencyKey } = {}) {
      const { merchantId, redirectUri, spreadsheetId } = args;
      if (idempotencyKey !== undefined) {
        return idempotentOperation({
          merchantId,
          operation: "google-sheets.oauth-start",
          idempotencyKey,
          payload: args,
          execute: () => api.startOAuth(args),
        });
      }
      requestContract("google-sheets-oauth-start.request", {
        redirect_uri: redirectUri,
        ...(spreadsheetId ? { spreadsheet_id: spreadsheetId } : {}),
      });
      const normalizedRedirectUri = validateRedirectUri(redirectUri);
      const state = oauthState();
      const expiresAt = new Date(now() + OAUTH_STATE_TTL_MS).toISOString();
      await store.saveOAuthState({
        stateHash: stateHash(state),
        merchantId,
        redirectUri: normalizedRedirectUri,
        spreadsheetId: spreadsheetId ?? null,
        expiresAt,
      });
      return contract("google-sheets-oauth-start.response", {
        authorization_url: googleClient.authorizationUrl({
          redirectUri: normalizedRedirectUri,
          state,
        }),
        state,
        expires_at: expiresAt,
      });
    },

    async completeOAuth(args = {}, { idempotencyKey } = {}) {
      const { merchantId, code, state, redirectUri } = args;
      if (idempotencyKey !== undefined) {
        return idempotentOperation({
          merchantId,
          operation: "google-sheets.oauth-complete",
          idempotencyKey,
          payload: args,
          execute: () => api.completeOAuth(args),
        });
      }
      requestContract("google-sheets-oauth-complete.request", {
        code,
        state,
        redirect_uri: redirectUri,
      });
      const normalizedRedirectUri = validateRedirectUri(redirectUri);
      const savedState = await store.consumeOAuthState({
        stateHash: stateHash(state),
        merchantId,
        now: now(),
      });
      if (
        !savedState
        || savedState.redirectUri !== normalizedRedirectUri
      ) {
        throw new GoogleSheetsIntegrationError(
          "invalid_oauth_state",
          "Google OAuth state is invalid or expired.",
          400,
        );
      }

      try {
        const tokens = await googleClient.exchangeCode({
          code,
          redirectUri: normalizedRedirectUri,
        });
        const existing = await store.getConnection(merchantId);
        const refreshToken = tokens.refresh_token
          ?? tokenCipher.decrypt(existing?.encryptedRefreshToken);
        if (!tokens.access_token || !refreshToken) {
          throw new GoogleSheetsIntegrationError(
            "google_refresh_token_missing",
            "Google did not return durable spreadsheet access.",
            502,
          );
        }

        let metadata;
        if (savedState.spreadsheetId) {
          metadata = await googleClient.getSpreadsheet({
            accessToken: tokens.access_token,
            spreadsheetId: savedState.spreadsheetId,
          });
        } else {
          metadata = await googleClient.createSpreadsheet({
            accessToken: tokens.access_token,
            title: "PasarAI Metrics",
            sheetTitles: WORKBOOK_SHEETS,
          });
        }
        const connectionValues = {
          spreadsheetId: metadata.spreadsheetId,
          spreadsheetUrl: spreadsheetUrl(
            metadata.spreadsheetId,
            metadata.spreadsheetUrl,
          ),
          spreadsheetTitle: metadata.properties?.title ?? "PasarAI Metrics",
          encryptedAccessToken: tokenCipher.encrypt(tokens.access_token),
          encryptedRefreshToken: tokenCipher.encrypt(refreshToken),
          accessTokenExpiresAt: accessTokenExpiry(now(), tokens.expires_in),
          grantedScopes: String(tokens.scope ?? "")
            .split(/\s+/)
            .filter(Boolean),
          status: "active",
          syncMode: existing?.syncMode ?? "manual",
          lastError: null,
        };
        const connection = existing
          ? await store.updateConnection(merchantId, connectionValues)
          : await store.saveConnection({
              merchantId,
              ...connectionValues,
              lastExportAt: null,
              lastImportAt: null,
              lastReconciledAt: null,
              watchChannelId: null,
              watchResourceId: null,
              watchToken: null,
              watchExpiresAt: null,
              watchLastMessageNumber: null,
            });
        const authorized = {
          connection,
          accessToken: tokens.access_token,
        };
        await ensureWorkbook(authorized);
        await googleClient.batchUpdateValues({
          accessToken: tokens.access_token,
          spreadsheetId: connection.spreadsheetId,
          data: initialWorkbookData(new Date(now()).toISOString()),
        });
        await googleClient.batchUpdateValues({
          accessToken: tokens.access_token,
          spreadsheetId: connection.spreadsheetId,
          data: dashboardFormulaData(),
          valueInputOption: "USER_ENTERED",
        });
        const readyConnection = connection.syncMode === "automatic"
          ? await replaceWatch(merchantId)
          : connection;
        return publicStatus(readyConnection);
      } catch (error) {
        await failConnection(merchantId, error);
        throw providerError(error);
      }
    },

    async exportMetrics(
      args = {},
      { idempotencyKey, syncLeaseToken } = {},
    ) {
      const { merchantId, dates } = args;
      if (idempotencyKey !== undefined) {
        return idempotentOperation({
          merchantId,
          operation: "google-sheets.export",
          idempotencyKey,
          payload: args,
          execute: () => api.exportMetrics(args),
        });
      }
      if (!syncLeaseToken) {
        return withSyncLease({
          merchantId,
          operation: "export",
          execute: (claimToken) =>
            api.exportMetrics(args, { syncLeaseToken: claimToken }),
        });
      }
      requestContract("google-sheets-export.request", {
        ...(dates ? { dates } : {}),
      });
      const jobId = idFactory("google_sheets_export");
      const startedAt = new Date(now()).toISOString();
      await store.startSyncJob({
        jobId,
        merchantId,
        operation: "export",
        startedAt,
      });

      try {
        const authorized = await authorizedConnection(merchantId, {
          syncLeaseToken,
        });
        await ensureWorkbook({
          ...authorized,
          syncLeaseToken,
        });
        const resolvedDates = await reportingDates(merchantId, dates);
        const summaries = [];
        for (const date of resolvedDates) {
          await assertSyncLease(merchantId, syncLeaseToken);
          summaries.push(await businessService.getDailySummary({
            merchantId,
            date,
          }));
        }
        const completedAt = new Date(now()).toISOString();
        await assertSyncLease(merchantId, syncLeaseToken);
        await googleClient.batchClearValues({
          accessToken: authorized.accessToken,
          spreadsheetId: authorized.connection.spreadsheetId,
          ranges: ["Dashboard!A1:Z100", "Metrics!A1:Z10000"],
        });
        await assertSyncLease(merchantId, syncLeaseToken);
        await googleClient.batchUpdateValues({
          accessToken: authorized.accessToken,
          spreadsheetId: authorized.connection.spreadsheetId,
          data: [{
            range: "Dashboard!A1:B9",
            majorDimension: "ROWS",
            values: dashboardValues(),
          }, {
            range: `Metrics!A1:L${summaries.length + 1}`,
            majorDimension: "ROWS",
            values: metricRows(summaries, completedAt),
          }],
        });
        await assertSyncLease(merchantId, syncLeaseToken);
        await googleClient.batchUpdateValues({
          accessToken: authorized.accessToken,
          spreadsheetId: authorized.connection.spreadsheetId,
          data: dashboardFormulaData(),
          valueInputOption: "USER_ENTERED",
        });
        await patchConnectedConnection(merchantId, {
          status: "active",
          lastExportAt: completedAt,
          lastError: null,
        }, syncLeaseToken);
        await store.completeSyncJob(jobId, {
          status: "completed",
          rowsProcessed: summaries.length,
          errorCount: 0,
          completedAt,
          error: null,
        });
        return contract("google-sheets-sync.response", {
          state: "completed",
          job_id: jobId,
          operation: "export",
          rows_processed: summaries.length,
          errors: 0,
          spreadsheet_url: authorized.connection.spreadsheetUrl,
          completed_at: completedAt,
        });
      } catch (error) {
        const completedAt = new Date(now()).toISOString();
        await store.completeSyncJob(jobId, {
          status: "failed",
          rowsProcessed: 0,
          errorCount: 1,
          completedAt,
          error: error.message,
        });
        await failConnection(merchantId, error);
        throw providerError(error);
      }
    },

    async importInputs(
      args = {},
      { idempotencyKey, syncLeaseToken } = {},
    ) {
      const { merchantId } = args;
      if (idempotencyKey !== undefined) {
        return idempotentOperation({
          merchantId,
          operation: "google-sheets.import",
          idempotencyKey,
          payload: args,
          execute: () => api.importInputs(args),
        });
      }
      if (!syncLeaseToken) {
        return withSyncLease({
          merchantId,
          operation: "import",
          execute: (claimToken) =>
            api.importInputs(args, { syncLeaseToken: claimToken }),
        });
      }
      requestContract("google-sheets-import.request", {});
      const jobId = idFactory("google_sheets_import");
      const startedAt = new Date(now()).toISOString();
      await store.startSyncJob({
        jobId,
        merchantId,
        operation: "import",
        startedAt,
      });

      try {
        const authorized = await authorizedConnection(merchantId, {
          syncLeaseToken,
        });
        await ensureWorkbook({
          ...authorized,
          syncLeaseToken,
        });
        const values = await googleClient.getValues({
          accessToken: authorized.accessToken,
          spreadsheetId: authorized.connection.spreadsheetId,
          range: "Inputs!A2:R10000",
        });
        const rows = (values?.values ?? []).map(normalizedInputRow);
        const syncErrors = [];
        let rowsProcessed = 0;
        let sheetChanged = false;

        for (const [index, row] of rows.entries()) {
          if (inputIsBlank(row)) continue;
          const rowNumber = index + 2;
          await assertSyncLease(merchantId, syncLeaseToken);
          const sourceChecksum = checksum(inputSource(row));
          const recordType = inputCell(row, 1).toLowerCase();
          const status = inputCell(row, 13).toLowerCase();
          const recordId = inputCell(row, 14);
          const action = inputCell(row, 0).toUpperCase();

          if (inputContainsFormula(row)) {
            const message =
              "Formulas are not accepted in the managed Inputs range. Enter literal values only.";
            setInputError(row, message, sourceChecksum);
            syncErrors.push([
              rowNumber,
              recordType || "unknown",
              message,
              new Date(now()).toISOString(),
            ]);
            sheetChanged = true;
            continue;
          }

          if (
            ["error", "conflict"].includes(status)
            && inputCell(row, 17) === sourceChecksum
            && inputCell(row, 16)
            && action !== "REFRESH"
          ) {
            syncErrors.push([
              rowNumber,
              recordType || "unknown",
              inputCell(row, 16),
              new Date(now()).toISOString(),
            ]);
            continue;
          }

          if (
            recordId
            && ["synced", "error", "conflict"].includes(status)
          ) {
            const saved = await store.getRowState({
              merchantId,
              sheetName: "Inputs",
              recordId,
            });
            const current = await effectiveRecord(
              ledgerStore,
              merchantId,
              recordId,
            );
            if (!saved || !current) {
              const message =
                "This synchronized row is not recognized by PasarAI.";
              setInputError(row, message, sourceChecksum);
              syncErrors.push([
                rowNumber,
                recordType || "unknown",
                message,
                new Date(now()).toISOString(),
              ]);
              sheetChanged = true;
              continue;
            }
            const sheetEdited = saved.checksum !== sourceChecksum;
            const databaseEdited = saved.recordVersion !== current.version;

            if (current.event.type === "cost") {
              if (action === "REFRESH") {
                const refreshedChecksum = refreshCostRow(
                  row,
                  current.payload,
                  current.version,
                );
                await assertSyncLease(merchantId, syncLeaseToken);
                await store.saveRowState({
                  ...saved,
                  rowNumber,
                  recordVersion: current.version,
                  checksum: refreshedChecksum,
                  lastSyncedAt: new Date(now()).toISOString(),
                });
                rowsProcessed += 1;
                sheetChanged = true;
              } else if (sheetEdited) {
                const message =
                  "Cost records are read-only after synchronization. Use REFRESH to restore the database values.";
                setInputError(row, message, sourceChecksum);
                syncErrors.push([
                  rowNumber,
                  "cost",
                  message,
                  new Date(now()).toISOString(),
                ]);
                sheetChanged = true;
              }
              continue;
            }

            if (current.event.type !== "sale") {
              const message = "Only sale and cost records are supported.";
              setInputError(row, message, sourceChecksum);
              syncErrors.push([
                rowNumber,
                recordType || "unknown",
                message,
                new Date(now()).toISOString(),
              ]);
              sheetChanged = true;
              continue;
            }

            if (action === "REFRESH" || (!sheetEdited && databaseEdited)) {
              const refreshedChecksum = refreshSaleRow(
                row,
                current.payload,
                current.version,
              );
              await assertSyncLease(merchantId, syncLeaseToken);
              await store.saveRowState({
                ...saved,
                rowNumber,
                recordVersion: current.version,
                checksum: refreshedChecksum,
                lastSyncedAt: new Date(now()).toISOString(),
              });
              rowsProcessed += 1;
              sheetChanged = true;
              continue;
            }
            if (!sheetEdited) continue;
            if (databaseEdited) {
              const message =
                `Conflict: the database is at version ${current.version} while this row is based on version ${saved.recordVersion}. Use REFRESH, then reapply the edit.`;
              setInputConflict(row, message, sourceChecksum);
              syncErrors.push([
                rowNumber,
                "sale",
                message,
                new Date(now()).toISOString(),
              ]);
              sheetChanged = true;
              continue;
            }
            if (action !== "UPDATE") {
              const message =
                "Set Action to UPDATE before changing a synchronized sale.";
              setInputError(row, message, sourceChecksum);
              syncErrors.push([
                rowNumber,
                "sale",
                message,
                new Date(now()).toISOString(),
              ]);
              sheetChanged = true;
              continue;
            }

            try {
              const changes = saleCorrectionChanges(row, current.payload);
              const updatedChecksum = checksum(inputSource(row));
              let nextVersion = current.version;
              if (changes.length) {
                const correctionEvidence = [
                  "google_sheet_correction",
                  authorized.connection.spreadsheetId,
                  rowNumber,
                  current.version,
                  updatedChecksum.slice(0, 20),
                ].join(":");
                await assertSyncLease(merchantId, syncLeaseToken);
                const result = await businessService.recordCorrection({
                  merchant_id: merchantId,
                  target_event_id: recordId,
                  occurred_at: new Date(now()).toISOString(),
                  reason: `Google Sheets Inputs row ${rowNumber}`,
                  replacement_payload: { changes },
                  evidence: { source_event_id: correctionEvidence },
                }, {
                  idempotencyKey: correctionEvidence,
                  expectedTargetVersion: current.version,
                });
                if (result.state !== "committed") {
                  throw new TypeError(rowError(result));
                }
                nextVersion += 1;
              }
              setInputSynced(row, {
                recordId,
                recordVersion: nextVersion,
                sourceChecksum: updatedChecksum,
              });
              await assertSyncLease(merchantId, syncLeaseToken);
              await store.saveRowState({
                ...saved,
                rowNumber,
                recordVersion: nextVersion,
                checksum: updatedChecksum,
                lastSyncedAt: new Date(now()).toISOString(),
              });
              rowsProcessed += 1;
              sheetChanged = true;
            } catch (error) {
              const message = error instanceof Error
                ? error.message
                : "The sale edit could not be synchronized";
              setInputError(row, message, sourceChecksum);
              syncErrors.push([
                rowNumber,
                "sale",
                message,
                new Date(now()).toISOString(),
              ]);
              sheetChanged = true;
            }
            continue;
          }

          try {
            const parsed = parsedInput(row, {
              merchantId,
              spreadsheetId: authorized.connection.spreadsheetId,
              rowNumber,
              sourceChecksum,
            });
            await assertSyncLease(merchantId, syncLeaseToken);
            const result = parsed.recordType === "sale"
              ? await businessService.recordSale(parsed.request, {
                  idempotencyKey: parsed.evidenceId,
                })
              : await businessService.recordCost(parsed.request, {
                  idempotencyKey: parsed.evidenceId,
                });
            if (result.state !== "committed") {
              throw new TypeError(rowError(result));
            }
            if (parsed.recordType === "sale") {
              row[0] = "UPDATE";
              row[2] = parsed.request.occurred_at;
              row[5] = parsed.request.lines[0].quantity;
              row[6] = parsed.request.lines[0].unit_price_rm;
            } else {
              row[2] = parsed.request.occurred_at;
              row[5] = parsed.request.lines[0].quantity;
              row[9] = parsed.request.lines[0].pack_size;
              row[10] = parsed.request.lines[0].total_price_rm;
              row[11] = parsed.request.metadata.payment_method;
            }
            const syncedChecksum = checksum(inputSource(row));
            setInputSynced(row, {
              recordId: result.event_id,
              recordVersion: 1,
              sourceChecksum: syncedChecksum,
            });
            await assertSyncLease(merchantId, syncLeaseToken);
            await store.saveRowState({
              merchantId,
              sheetName: "Inputs",
              recordId: result.event_id,
              rowNumber,
              recordVersion: 1,
              checksum: syncedChecksum,
              lastSyncedAt: new Date(now()).toISOString(),
            });
            rowsProcessed += 1;
            sheetChanged = true;
          } catch (error) {
            const message = error instanceof Error
              ? error.message
              : "The row could not be imported";
            setInputError(row, message, sourceChecksum);
            syncErrors.push([
              rowNumber,
              recordType || "unknown",
              message,
              new Date(now()).toISOString(),
            ]);
            sheetChanged = true;
          }
        }

        const completedAt = new Date(now()).toISOString();
        if (sheetChanged) {
          await assertSyncLease(merchantId, syncLeaseToken);
          await googleClient.batchClearValues({
            accessToken: authorized.accessToken,
            spreadsheetId: authorized.connection.spreadsheetId,
            ranges: ["Sync Errors!A1:D10000"],
          });
          const data = [{
            range: `Sync Errors!A1:D${syncErrors.length + 1}`,
            majorDimension: "ROWS",
            values: [SYNC_ERROR_HEADERS, ...syncErrors],
          }];
          if (rows.length) {
            data.unshift({
              range: `Inputs!A2:R${rows.length + 1}`,
              majorDimension: "ROWS",
              values: rows,
            });
          }
          await assertSyncLease(merchantId, syncLeaseToken);
          await googleClient.batchUpdateValues({
            accessToken: authorized.accessToken,
            spreadsheetId: authorized.connection.spreadsheetId,
            data,
          });
        }
        await patchConnectedConnection(merchantId, {
          status: "active",
          lastImportAt: completedAt,
          lastError: null,
        }, syncLeaseToken);
        await store.completeSyncJob(jobId, {
          status: "completed",
          rowsProcessed,
          errorCount: syncErrors.length,
          completedAt,
          error: null,
        });
        return contract("google-sheets-sync.response", {
          state: "completed",
          job_id: jobId,
          operation: "import",
          rows_processed: rowsProcessed,
          errors: syncErrors.length,
          spreadsheet_url: authorized.connection.spreadsheetUrl,
          completed_at: completedAt,
        });
      } catch (error) {
        const completedAt = new Date(now()).toISOString();
        await store.completeSyncJob(jobId, {
          status: "failed",
          rowsProcessed: 0,
          errorCount: 1,
          completedAt,
          error: error.message,
        });
        await failConnection(merchantId, error);
        throw providerError(error);
      }
    },

    async reconcile(
      args = {},
      { idempotencyKey, syncLeaseToken } = {},
    ) {
      const {
        merchantId,
        exportWhenUnchanged = true,
      } = args;
      if (idempotencyKey !== undefined) {
        return idempotentOperation({
          merchantId,
          operation: "google-sheets.reconcile",
          idempotencyKey,
          payload: args,
          execute: () => api.reconcile(args),
        });
      }
      if (!syncLeaseToken) {
        return withSyncLease({
          merchantId,
          operation: "reconcile",
          execute: (claimToken) =>
            api.reconcile(args, { syncLeaseToken: claimToken }),
        });
      }
      requestContract("google-sheets-reconcile.request", {});
      const jobId = idFactory("google_sheets_reconcile");
      const startedAt = new Date(now()).toISOString();
      await store.startSyncJob({
        jobId,
        merchantId,
        operation: "reconcile",
        startedAt,
      });

      try {
        const imported = await api.importInputs(
          { merchantId },
          { syncLeaseToken },
        );
        const exported = exportWhenUnchanged || imported.rows_processed > 0
          ? await api.exportMetrics(
              { merchantId },
              { syncLeaseToken },
            )
          : null;
        const completedAt = new Date(now()).toISOString();
        const rowsProcessed = imported.rows_processed
          + (exported?.rows_processed ?? 0);
        const errorCount = imported.errors + (exported?.errors ?? 0);
        const connection = await patchConnectedConnection(merchantId, {
          status: "active",
          lastReconciledAt: completedAt,
          lastError: null,
        }, syncLeaseToken);
        await store.completeSyncJob(jobId, {
          status: "completed",
          rowsProcessed,
          errorCount,
          completedAt,
          error: null,
        });
        return contract("google-sheets-sync.response", {
          state: "completed",
          job_id: jobId,
          operation: "reconcile",
          rows_processed: rowsProcessed,
          errors: errorCount,
          spreadsheet_url: connection.spreadsheetUrl,
          completed_at: completedAt,
        });
      } catch (error) {
        const completedAt = new Date(now()).toISOString();
        await store.completeSyncJob(jobId, {
          status: "failed",
          rowsProcessed: 0,
          errorCount: 1,
          completedAt,
          error: error.message,
        });
        await failConnection(merchantId, error);
        throw providerError(error);
      }
    },

    async configureSyncMode(
      args = {},
      { idempotencyKey, syncLeaseToken } = {},
    ) {
      const { merchantId, syncMode } = args;
      if (idempotencyKey !== undefined) {
        return idempotentOperation({
          merchantId,
          operation: "google-sheets.sync-mode",
          idempotencyKey,
          payload: args,
          execute: () => api.configureSyncMode(args),
        });
      }
      if (!syncLeaseToken) {
        return withSyncLease({
          merchantId,
          operation: "configure-sync-mode",
          execute: (claimToken) =>
            api.configureSyncMode(args, { syncLeaseToken: claimToken }),
        });
      }
      requestContract("google-sheets-sync-mode.request", {
        sync_mode: syncMode,
      });
      if (syncMode === "automatic") {
        return publicStatus(await replaceWatch(merchantId, {
          syncLeaseToken,
        }));
      }

      let connection = await connectionFor(merchantId);
      let accessToken = null;
      if (connection.watchChannelId && connection.watchResourceId) {
        const authorized = await authorizedConnection(merchantId, {
          syncLeaseToken,
        });
        connection = authorized.connection;
        accessToken = authorized.accessToken;
      }
      await assertSyncLease(merchantId, syncLeaseToken);
      const disabled = await store.compareAndSetConnection(merchantId, {
        expected: watchConnectionExpectation(connection),
        changes: {
          status: "active",
          syncMode: "manual",
          lastError: null,
          watchChannelId: null,
          watchResourceId: null,
          watchToken: null,
          watchExpiresAt: null,
          watchLastMessageNumber: null,
        },
      });
      if (!disabled.updated) throw connectionChangedError();
      if (connection.watchChannelId && connection.watchResourceId) {
        try {
          await googleClient.stopChannel({
            accessToken,
            channelId: connection.watchChannelId,
            resourceId: connection.watchResourceId,
          });
        } catch {
          // Manual mode remains authoritative even if channel cleanup fails.
        }
      }
      return publicStatus(disabled.connection);
    },

    async renewAutomaticWatches() {
      const renewed = [];
      for (const connection of await store.listConnections()) {
        if (
          connection.status === "disconnected"
          || connection.syncMode !== "automatic"
        ) {
          continue;
        }
        const expiration = Date.parse(connection.watchExpiresAt ?? "");
        if (
          connection.watchChannelId
          && Number.isFinite(expiration)
          && expiration - now() > watchRenewalWindowMs
        ) {
          continue;
        }
        try {
          renewed.push(publicStatus(await replaceWatch(connection.merchantId)));
        } catch (error) {
          if (error?.code !== "google_sheets_sync_in_progress") {
            await failConnection(connection.merchantId, error);
          }
        }
      }
      return renewed;
    },

    async runAutomaticSync() {
      const results = [];
      for (const connection of await store.listConnections()) {
        if (
          connection.status === "disconnected"
          || connection.syncMode !== "automatic"
        ) {
          continue;
        }
        try {
          results.push(await api.reconcile({
            merchantId: connection.merchantId,
            exportWhenUnchanged: true,
          }));
        } catch {
          // A failed merchant is recorded on its connection and job.
        }
      }
      return results;
    },

    async processDriveNotification(notification = {}) {
      const connection = await store.getConnection(notification.merchantId);
      if (
        !connection
        || connection.status === "disconnected"
        || connection.syncMode !== "automatic"
      ) {
        return { state: "ignored" };
      }
      return api.reconcile({
        merchantId: notification.merchantId,
        exportWhenUnchanged: false,
      });
    },

    async handleDriveNotification({ headers } = {}) {
      const supplied = new Headers(headers);
      const channelId = supplied.get("x-goog-channel-id");
      const channelToken = supplied.get("x-goog-channel-token");
      const resourceId = supplied.get("x-goog-resource-id");
      const resourceState = supplied.get("x-goog-resource-state");
      const messageNumber = supplied.get("x-goog-message-number");
      if (
        !channelId
        || !channelToken
        || !resourceId
        || !resourceState
        || !messageNumber
      ) {
        return {
          status: 400,
          body: { error: "invalid_google_drive_notification" },
        };
      }
      const connection = (await store.listConnections()).find(
        (candidate) => candidate.watchChannelId === channelId,
      );
      if (!connection) {
        return {
          status: 404,
          body: { error: "google_drive_channel_not_found" },
        };
      }
      if (
        !secureEqual(connection.watchToken, channelToken)
        || !secureEqual(connection.watchResourceId, resourceId)
      ) {
        return {
          status: 403,
          body: { error: "invalid_google_drive_channel" },
        };
      }
      if (!newMessageNumber(
        connection.watchLastMessageNumber,
        messageNumber,
      )) {
        return { status: 204, body: null };
      }
      const actionable = !(
        resourceState === "sync"
        || connection.syncMode !== "automatic"
        || !["add", "remove", "update", "trash", "untrash", "change"]
          .includes(resourceState)
      );
      if (!actionable) {
        await store.compareAndSetWatchState({
          merchantId: connection.merchantId,
          expectedChannelId: connection.watchChannelId,
          expectedMessageNumber: connection.watchLastMessageNumber,
          changes: { watchLastMessageNumber: messageNumber },
        });
        return { status: 204, body: null };
      }
      const queued = await store.advanceWatchMessageAndEnqueueNotification({
        merchantId: connection.merchantId,
        channelId,
        messageNumber,
        resourceId,
        resourceState,
        availableAt: new Date(now()).toISOString(),
      });
      if (!queued.accepted) {
        return { status: 204, body: null };
      }
      return {
        status: 202,
        body: { state: "accepted" },
      };
    },

    async disconnect(
      args = {},
      { idempotencyKey, syncLeaseToken } = {},
    ) {
      const { merchantId } = args;
      if (idempotencyKey !== undefined) {
        return idempotentOperation({
          merchantId,
          operation: "google-sheets.disconnect",
          idempotencyKey,
          payload: args,
          execute: () => api.disconnect(args),
        });
      }
      if (!syncLeaseToken) {
        return withSyncLease({
          merchantId,
          operation: "disconnect",
          execute: (claimToken) =>
            api.disconnect(args, { syncLeaseToken: claimToken }),
        });
      }
      let connection = await store.getConnection(merchantId);
      if (!connection || connection.status === "disconnected") {
        return contract("google-sheets-disconnect.response", {
          state: "disconnected",
        });
      }
      if (connection?.watchChannelId && connection.watchResourceId) {
        try {
          const authorized = await authorizedConnection(merchantId, {
            syncLeaseToken,
          });
          connection = authorized.connection;
          await googleClient.stopChannel({
            accessToken: authorized.accessToken,
            channelId: connection.watchChannelId,
            resourceId: connection.watchResourceId,
          });
        } catch {
          // Token removal must still complete when Google is unavailable.
        }
      }
      await assertSyncLease(merchantId, syncLeaseToken);
      const disconnected = await store.compareAndSetConnection(merchantId, {
        expected: coreConnectionExpectation(connection),
        changes: {
          status: "disconnected",
          encryptedAccessToken: null,
          encryptedRefreshToken: null,
          accessTokenExpiresAt: null,
          watchChannelId: null,
          watchResourceId: null,
          watchToken: null,
          watchExpiresAt: null,
          watchLastMessageNumber: null,
        },
      });
      if (!disconnected.updated) throw connectionChangedError();
      return contract("google-sheets-disconnect.response", {
        state: "disconnected",
      });
    },

    healthCheck() {
      return store.healthCheck();
    },
  };
  return api;
}
