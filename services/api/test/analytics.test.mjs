import assert from "node:assert/strict";
import { test } from "node:test";

import {
  InMemoryLedgerStore,
  createPasarAiService,
} from "../src/backend/index.js";

function fixture() {
  const ids = [
    "evt_day_status_001",
  ];
  const store = new InMemoryLedgerStore({
    merchantTimeZones: {
      m_001: "Asia/Kuala_Lumpur",
    },
    productProfiles: [{
      merchantId: "m_001",
      productId: "p_001",
      effectiveAt: "2026-01-01T00:00:00+08:00",
      baselineUnitCogsRm: "3.00",
      currentUnitCogsRm: "3.20",
      targetGrossMarginPct: "40.00",
      components: [{
        componentId: "c_rice",
        name: "Rice",
        baselineCostRm: "1.00",
        currentCostRm: "1.10",
        usagePerProductUnit: "1",
      }, {
        componentId: "c_other",
        name: "Other",
        baselineCostRm: "2.00",
        currentCostRm: "2.10",
        usagePerProductUnit: "1",
      }],
    }],
  });
  store.appendEvent({
    eventId: "evt_sale_001",
    endpointId: "sales.create",
    type: "sale",
    merchantId: "m_001",
    occurredAt: "2026-07-15T10:00:00+08:00",
    payload: {
      source: "telegram_text",
      lines: [{
        product_id: "p_001",
        quantity: "40",
        unit_price_rm: "5.00",
      }],
    },
    evidence: {
      external_message_id: "tg_001",
    },
    response: {
      state: "committed",
      event_id: "evt_sale_001",
    },
  });
  return {
    store,
    service: createPasarAiService({
      store,
      idFactory: () => ids.shift(),
    }),
  };
}

test("analytics overview distinguishes complete, missing and closed-no-sales days", async () => {
  const { service } = fixture();

  const initial = await service.getAnalyticsOverview({
    merchantId: "m_001",
    productId: "p_001",
    from: "2026-07-15",
    to: "2026-07-16",
  });
  assert.equal(initial.days[0].state, "complete");
  assert.equal(initial.days[0].quantity, "40");
  assert.equal(initial.days[1].state, "missing");
  assert.equal(initial.days[1].gross_profit_rm, null);
  assert.equal(initial.completeness_coverage_pct, "50.00");
  assert.ok(initial.alerts.some(({ action }) => action === "record_sales"));

  const closed = await service.recordAnalyticsDayStatus({
    merchant_id: "m_001",
    product_id: "p_001",
    date: "2026-07-16",
    occurred_at: "2026-07-16T18:00:00+08:00",
    business_day_state: "closed_no_sales",
    sold_out_state: "no",
  }, {
    idempotencyKey: "close-2026-07-16",
  });
  assert.equal(closed.state, "committed");

  const updated = await service.getAnalyticsOverview({
    merchantId: "m_001",
    productId: "p_001",
    from: "2026-07-15",
    to: "2026-07-16",
  });
  assert.deepEqual(updated.days[1], {
    date: "2026-07-16",
    state: "closed_no_sales",
    quantity: "0",
    revenue_rm: "0.00",
    cogs_rm: "0.00",
    gross_profit_rm: "0.00",
    gross_margin_pct: null,
    sold_out_state: "no",
  });
  assert.equal(updated.completeness_coverage_pct, "100.00");
});

test("analytics overview does not wait for projection persistence", async () => {
  const { store, service } = fixture();
  let persistenceStarted = false;
  store.saveAnalyticsOverview = () => {
    persistenceStarted = true;
    return new Promise(() => {});
  };

  const result = await Promise.race([
    service.getAnalyticsOverview({
      merchantId: "m_001",
      productId: "p_001",
      from: "2026-07-15",
      to: "2026-07-16",
    }),
    new Promise((resolve) => {
      setTimeout(() => resolve("persistence-blocked-response"), 25);
    }),
  ]);

  assert.equal(persistenceStarted, true);
  assert.notEqual(result, "persistence-blocked-response");
  assert.equal(result.days.length, 2);
});

test("price-volume scenarios remain deterministic and forecast gates stay truthful", async () => {
  const { service } = fixture();

  const scenarios = await service.simulatePriceVolume({
    merchant_id: "m_001",
    product_id: "p_001",
    as_of: "2026-07-15",
    center_price_rm: "5.00",
    center_quantity: "40",
    price_step_pct: "10",
    quantity_step_pct: "10",
  });
  assert.equal(scenarios.scenarios.length, 9);
  assert.deepEqual(
    scenarios.scenarios.find(({ row, column }) => row === 1 && column === 1),
    {
      row: 1,
      column: 1,
      quantity: "40",
      unit_price_rm: "5.00",
      revenue_rm: "200.00",
      cogs_rm: "128.00",
      gross_profit_rm: "72.00",
      gross_margin_pct: "36.00",
      incremental_gross_profit_rm: "0.00",
      target_margin_met: false,
    },
  );

  const forecast = await service.getAnalyticsForecast({
    merchantId: "m_001",
    productId: "p_001",
    asOf: "2026-07-15",
  });
  assert.equal(forecast.status, "unavailable");
  assert.equal(forecast.forecast, null);
  assert.ok(
    forecast.reasons.includes("fewer_than_28_complete_usable_days"),
  );
});

test("activity timeline exposes safe event summaries instead of raw payloads", async () => {
  const { service } = fixture();
  const activity = await service.getAnalyticsActivity({
    merchantId: "m_001",
    productId: "p_001",
    from: "2026-07-15",
    to: "2026-07-16",
  });

  assert.equal(activity.items.length, 1);
  assert.deepEqual(activity.items[0], {
    event_id: "evt_sale_001",
    occurred_at: "2026-07-15T10:00:00+08:00",
    source: "telegram_text",
    type: "sale",
    state: "committed",
    title: "Sale recorded",
    evidence_uri: null,
    target_event_id: null,
  });
});

test("activity timeline normalizes receipt evidence into a viewable link", async () => {
  const { store, service } = fixture();
  store.appendEvent({
    eventId: "evt_receipt_001",
    endpointId: "receipts.extract",
    type: "receipt_uploaded",
    merchantId: "m_001",
    occurredAt: "2026-07-15T08:00:00+08:00",
    payload: {
      source: "telegram_photo",
      receipt_id: "R-001",
      evidence_path: "../receipts/receipt_001.jpg",
    },
    evidence: {
      evidence_path: "../receipts/receipt_001.jpg",
    },
    response: {},
  });

  const activity = await service.getAnalyticsActivity({
    merchantId: "m_001",
    productId: "p_001",
    from: "2026-07-15",
    to: "2026-07-15",
  });
  assert.deepEqual(
    activity.items.find(({ event_id }) => event_id === "evt_receipt_001"),
    {
    event_id: "evt_receipt_001",
    occurred_at: "2026-07-15T08:00:00+08:00",
    source: "telegram_photo",
    type: "receipt_uploaded",
    state: "recorded",
    title: "Receipt R-001 uploaded",
    evidence_uri: "/evidence/receipt_001.jpg",
    target_event_id: null,
    },
  );
});
