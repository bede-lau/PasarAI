import assert from "node:assert/strict";
import { test } from "node:test";

import { LakebaseLedgerStore } from "../src/backend/index.js";

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

test("Lakebase idempotency claims are merchant scoped", async () => {
  const queries = [];
  const store = new LakebaseLedgerStore({
    pool: fakePool(async (text, values) => {
      queries.push({ text, values });
      if (text.includes("INSERT INTO api_idempotency")) {
        return {
          rows: [{
            request_fingerprint: "fingerprint",
            response: null,
          }],
        };
      }
      return { rows: [] };
    }),
  });

  const result = await store.runIdempotent({
    merchantId: "m_001",
    endpointId: "sales.create",
    key: "shared-key",
    fingerprint: "fingerprint",
    execute: async () => ({ state: "committed", event_id: "evt_001" }),
  });

  assert.deepEqual(result, {
    conflict: false,
    response: { state: "committed", event_id: "evt_001" },
  });
  const insert = queries.find(({ text }) =>
    text.includes("INSERT INTO api_idempotency"));
  assert.match(insert.text, /merchant_id/);
  assert.match(
    insert.text,
    /ON CONFLICT \(merchant_id, endpoint_id, idempotency_key\)/,
  );
  assert.deepEqual(insert.values, [
    "m_001",
    "sales.create",
    "shared-key",
    "fingerprint",
  ]);
  const update = queries.find(({ text }) =>
    text.includes("UPDATE api_idempotency"));
  assert.deepEqual(update.values.slice(0, 3), [
    "m_001",
    "sales.create",
    "shared-key",
  ]);
});

test("Lakebase raw events require and persist the canonical endpoint ID", async () => {
  const queries = [];
  const row = {
    event_id: "evt_sale_001",
    merchant_id: "m_001",
    endpoint_id: "sales.create",
    external_id: JSON.stringify(["m_001", "message", "voice_001"]),
    event_type: "sale",
    occurred_at: "2026-07-12T06:30:00.000Z",
    target_event_id: null,
    payload: { lines: [] },
    evidence: { external_message_id: "voice_001" },
    response: { state: "committed", event_id: "evt_sale_001" },
  };
  const store = new LakebaseLedgerStore({
    pool: fakePool(async (text, values) => {
      queries.push({ text, values });
      return text.includes("INSERT INTO raw_events")
        ? { rows: [row] }
        : { rows: [] };
    }),
  });

  await assert.rejects(
    store.appendEvent({
      eventId: row.event_id,
      type: row.event_type,
      merchantId: row.merchant_id,
      occurredAt: row.occurred_at,
      payload: row.payload,
      evidence: row.evidence,
      response: row.response,
    }),
    /event\.endpointId is required/,
  );

  const result = await store.appendEvent({
    eventId: row.event_id,
    endpointId: row.endpoint_id,
    externalId: row.external_id,
    type: row.event_type,
    merchantId: row.merchant_id,
    occurredAt: row.occurred_at,
    payload: row.payload,
    evidence: row.evidence,
    response: row.response,
  });

  assert.equal(result.appended, true);
  assert.equal(result.event.endpointId, "sales.create");
  const insert = queries.find(({ text }) =>
    text.includes("INSERT INTO raw_events"));
  assert.equal(insert.values[2], "sales.create");
});

test("Lakebase corrections update raw events and the canonical correction table atomically", async () => {
  const queries = [];
  const row = {
    event_id: "evt_correction_001",
    merchant_id: "m_001",
    endpoint_id: "corrections.create",
    external_id: JSON.stringify(["m_001", "source_event", "voice_005"]),
    event_type: "correction",
    occurred_at: "2026-07-12T06:35:00.000Z",
    target_event_id: "evt_sale_001",
    payload: {
      merchant_id: "m_001",
      target_event_id: "evt_sale_001",
      reason: "Correct quantity.",
      replacement_payload: {
        changes: [{
          kind: "decimal",
          field: "quantity",
          corrected_value: "38",
        }],
      },
    },
    evidence: { source_event_id: "voice_005" },
    response: { state: "committed" },
  };
  const store = new LakebaseLedgerStore({
    pool: fakePool(async (text, values) => {
      queries.push({ text, values });
      if (text.includes("INSERT INTO raw_events")) return { rows: [row] };
      return { rows: [] };
    }),
  });

  const result = await store.appendCorrection({
    eventId: row.event_id,
    endpointId: "corrections.create",
    externalId: row.external_id,
    type: row.event_type,
    merchantId: row.merchant_id,
    occurredAt: row.occurred_at,
    targetEventId: row.target_event_id,
    payload: row.payload,
    evidence: row.evidence,
    response: row.response,
  });

  assert.equal(result.appended, true);
  assert.ok(queries.some(({ text }) => text.trim() === "BEGIN"));
  const rawEvent = queries.find(({ text }) =>
    text.includes("INSERT INTO raw_events"));
  assert.equal(rawEvent.values[2], "corrections.create");
  const correction = queries.find(({ text }) =>
    text.includes("INSERT INTO corrections"));
  assert.deepEqual(correction.values.slice(0, 4), [
    "evt_correction_001",
    "m_001",
    "evt_sale_001",
    "Correct quantity.",
  ]);
  assert.ok(queries.some(({ text }) => text.trim() === "COMMIT"));
});

test("Lakebase locks and rejects a stale correction before appending", async () => {
  const queries = [];
  const store = new LakebaseLedgerStore({
    pool: fakePool(async (text, values) => {
      queries.push({ text, values });
      if (text.includes("FROM raw_events") && text.includes("FOR UPDATE")) {
        return { rows: [{ event_id: "evt_sale_001" }] };
      }
      if (text.includes("COUNT(*)::integer + 1")) {
        return { rows: [{ target_version: 2 }] };
      }
      if (text.includes("INSERT INTO raw_events")) {
        throw new Error("stale correction must not append a raw event");
      }
      return { rows: [] };
    }),
  });

  const result = await store.appendCorrection({
    eventId: "evt_correction_002",
    endpointId: "corrections.create",
    type: "correction",
    merchantId: "m_001",
    occurredAt: "2026-07-12T06:36:00.000Z",
    targetEventId: "evt_sale_001",
    payload: {
      reason: "Stale correction.",
      replacement_payload: { changes: [] },
    },
    evidence: {},
    response: { state: "committed" },
  }, { expectedTargetVersion: 1 });

  assert.deepEqual(result, {
    appended: false,
    conflict: true,
    targetVersion: 2,
  });
  const lock = queries.find(({ text }) => text.includes("FOR UPDATE"));
  assert.deepEqual(lock.values, ["evt_sale_001", "m_001"]);
  assert.equal(
    queries.some(({ text }) => text.includes("INSERT INTO raw_events")),
    false,
  );
  assert.ok(queries.some(({ text }) => text.trim() === "COMMIT"));
});

test("Lakebase derives business dates using the merchant timezone", async () => {
  const store = new LakebaseLedgerStore({
    pool: fakePool(async (text, values) => {
      assert.match(text, /AT TIME ZONE timezone/);
      assert.deepEqual(values, [
        "m_001",
        "2026-07-11T16:30:00.000Z",
      ]);
      return { rows: [{ calendar_date: "2026-07-12" }] };
    }),
  });

  assert.equal(
    await store.getMerchantCalendarDate(
      "m_001",
      "2026-07-11T16:30:00.000Z",
    ),
    "2026-07-12",
  );
});

test("Lakebase product profiles resolve the latest state at one date boundary", async () => {
  const queries = [];
  const store = new LakebaseLedgerStore({
    pool: fakePool(async (text, values) => {
      queries.push({ text, values });
      return {
        rows: [{
          merchant_id: "m_001",
          component_id: "c_egg",
          component_name: "Eggs",
          baseline_cost_per_pack_rm: "0.45",
          current_cost_per_pack_rm: "0.55",
          usage_per_product_unit: "1",
          evidence_projection: null,
          target_gross_margin_pct: "40.00",
        }],
      };
    }),
  });

  const profile = await store.getProductProfile("p_001", {
    asOfDate: "2026-07-12",
    merchantId: "m_001",
  });

  assert.equal(profile.baselineUnitCogsRm, "0.45");
  assert.equal(profile.currentUnitCogsRm, "0.55");
  assert.doesNotMatch(queries[0].text, /MIN\(\(/);
  assert.deepEqual(queries[0].values, [
    "p_001",
    "2026-07-12",
    "m_001",
  ]);
});

test("Lakebase resolves previous-day and current cost states in one query", async () => {
  const queries = [];
  const store = new LakebaseLedgerStore({
    pool: fakePool(async (text, values) => {
      queries.push({ text, values });
      return {
        rows: [
          {
            boundary: "baseline",
            merchant_id: "m_001",
            component_id: "c_egg",
            component_name: "Eggs",
            baseline_cost_per_pack_rm: "0.45",
            current_cost_per_pack_rm: "0.45",
            usage_per_product_unit: "1",
            evidence_projection: null,
            target_gross_margin_pct: "40.00",
          },
          {
            boundary: "current",
            merchant_id: "m_001",
            component_id: "c_egg",
            component_name: "Eggs",
            baseline_cost_per_pack_rm: "0.45",
            current_cost_per_pack_rm: "0.55",
            usage_per_product_unit: "1",
            evidence_projection: null,
            target_gross_margin_pct: "40.00",
          },
        ],
      };
    }),
  });

  const comparison = await store.getProductCostComparison("p_001", {
    comparisonDate: "2026-07-15",
    currentDate: "2026-07-16",
    merchantId: "m_001",
  });

  assert.equal(comparison.baseline.currentUnitCogsRm, "0.45");
  assert.equal(comparison.current.currentUnitCogsRm, "0.55");
  assert.match(queries[0].text, /WITH boundaries/);
  assert.match(queries[0].text, /snapshot_sequence DESC/);
  assert.deepEqual(queries[0].values, [
    "p_001",
    "2026-07-15",
    "2026-07-16",
    "m_001",
  ]);
});

test("Lakebase component catalogs use the merchant and as-of snapshot boundary", async () => {
  const queries = [];
  const store = new LakebaseLedgerStore({
    pool: fakePool(async (text, values) => {
      queries.push({ text, values });
      return {
        rows: [
          { component_id: "c_egg", component_name: "Eggs" },
          { component_id: "c_rice", component_name: "Rice" },
        ],
      };
    }),
  });

  assert.deepEqual(
    await store.listComponents("m_001", {
      asOfDate: "2026-07-16",
    }),
    [
      { componentId: "c_egg", name: "Eggs" },
      { componentId: "c_rice", name: "Rice" },
    ],
  );
  assert.match(queries[0].text, /DISTINCT ON \(components\.component_id\)/);
  assert.match(queries[0].text, /components\.merchant_id = \$1/);
  assert.deepEqual(queries[0].values, ["m_001", "2026-07-16"]);
});

test("Lakebase analytics projections degrade safely before migration 008", async () => {
  const missingTable = Object.assign(
    new Error('relation "analytics_daily_product_metrics" does not exist'),
    { code: "42P01" },
  );
  const store = new LakebaseLedgerStore({
    pool: fakePool(async (text) => {
      if (
        text.includes("analytics_daily_product_metrics")
        || text.includes("analytics_forecasts")
      ) {
        throw missingTable;
      }
      return { rows: [] };
    }),
  });

  const persisted = await store.saveAnalyticsOverview({
    merchant_id: "m_001",
    product_id: "p_001",
    to: "2026-07-16",
    generated_at: "2026-07-16T12:00:00.000Z",
    data_through: "2026-07-16",
    freshness: {
      source_max_ingested_at: "2026-07-16T11:59:00.000Z",
      projection_version: "analytics-v1",
    },
    days: [{
      date: "2026-07-16",
      state: "complete",
      sold_out_state: "no",
      quantity: "40",
      revenue_rm: "200.00",
      cogs_rm: "128.00",
      gross_profit_rm: "72.00",
      gross_margin_pct: "36.00",
    }],
    cost_waterfall: null,
  });

  assert.equal(persisted, false);
  assert.equal(
    await store.getLatestAnalyticsForecast({
      merchantId: "m_001",
      productId: "p_001",
      forecastDate: "2026-07-17",
    }),
    null,
  );
});
