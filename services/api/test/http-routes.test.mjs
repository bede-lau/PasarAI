import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  InMemoryLedgerStore,
  allowMerchantForTests,
  createApiApp,
  createPasarAiService,
} from "../src/backend/index.js";

const salesRequest = JSON.parse(
  await readFile(
    new URL("../../../fixtures/contracts/v1/valid/sales-request.json", import.meta.url),
    "utf8",
  ),
).payload;
const costsRequest = JSON.parse(
  await readFile(
    new URL("../../../fixtures/contracts/v1/valid/costs-request.json", import.meta.url),
    "utf8",
  ),
).payload;

function apiUrl(path) {
  return ["http", "://", "pasarai.test", path].join("");
}

function createTestApp() {
  const store = new InMemoryLedgerStore({
    productProfiles: [
      {
        merchantId: "m_kak_lina_001",
        productId: "p_nlb_001",
        baselineUnitCogsRm: "2.90",
        currentUnitCogsRm: "3.18",
        components: [],
      },
    ],
  });
  const service = createPasarAiService({
    store,
    idFactory: () => "evt_sales_001",
  });
  return createApiApp({
    service,
    dependencies: { ledger: store },
    authenticate: allowMerchantForTests("m_kak_lina_001"),
  });
}

test("health and sales routes expose dependency status and idempotent contract responses", async () => {
  const app = createTestApp();
  const health = await app.fetch(new Request(apiUrl("/healthz")));
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), {
    status: "ok",
    dependencies: {
      ledger: "ok",
    },
  });

  const request = () => new Request(apiUrl("/api/v1/sales"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": "sales-key-001",
    },
    body: JSON.stringify(salesRequest),
  });
  const first = await app.fetch(request());
  const duplicate = await app.fetch(request());

  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), {
    state: "committed",
    event_id: "evt_sales_001",
  });
  assert.deepEqual(await duplicate.json(), {
    state: "committed",
    event_id: "evt_sales_001",
  });
});

test("cost route commits a confident receipt line and updates component COGS", async () => {
  const ids = ["evt_sales_001", "evt_cost_001"];
  const store = new InMemoryLedgerStore({
    productProfiles: [
      {
        merchantId: "m_kak_lina_001",
        productId: "p_nlb_001",
        baselineUnitCogsRm: "2.90",
        currentUnitCogsRm: "3.14",
        components: [
          { componentId: "c_other", name: "Other", baselineCostRm: "2.74", currentCostRm: "2.98" },
          {
            componentId: "c_packaging",
            name: "Bekas Makanan",
            baselineCostRm: "0.16",
            currentCostRm: "0.16",
            usagePerProductUnit: "1",
          },
        ],
      },
    ],
  });
  const app = createApiApp({
    service: createPasarAiService({
      store,
      idFactory: () => ids.shift(),
    }),
    dependencies: { ledger: store },
    authenticate: allowMerchantForTests("m_kak_lina_001"),
  });
  await app.fetch(new Request(apiUrl("/api/v1/sales"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": "sales-key-001",
    },
    body: JSON.stringify(salesRequest),
  }));

  const response = await app.fetch(new Request(apiUrl("/api/v1/costs"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": "cost-key-001",
    },
    body: JSON.stringify(costsRequest),
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    state: "committed",
    event_id: "evt_cost_001",
  });

  const summary = await app.fetch(new Request(apiUrl(
    "/api/v1/summary/daily?merchant_id=m_kak_lina_001&date=2026-07-12",
  )));
  assert.equal(summary.status, 200);
  assert.equal((await summary.json()).cogs_rm, "127.20");
});

test("simulation and correction routes preserve read-only and append-only semantics", async () => {
  const ids = ["evt_sales_001", "evt_correction_001"];
  const store = new InMemoryLedgerStore({
    productProfiles: [
      {
        merchantId: "m_kak_lina_001",
        productId: "p_nlb_001",
        baselineUnitCogsRm: "2.90",
        currentUnitCogsRm: "3.18",
        components: [],
      },
    ],
  });
  const app = createApiApp({
    service: createPasarAiService({
      store,
      idFactory: () => ids.shift(),
    }),
    dependencies: { ledger: store },
    authenticate: allowMerchantForTests("m_kak_lina_001"),
  });
  await app.fetch(new Request(apiUrl("/api/v1/sales"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": "sales-key-001",
    },
    body: JSON.stringify(salesRequest),
  }));

  const simulation = await app.fetch(new Request(
    apiUrl("/api/v1/simulations/price"),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        merchant_id: "m_kak_lina_001",
        product_id: "p_nlb_001",
        quantity: "35",
        proposed_unit_price_rm: "5.50",
        as_of: "2026-07-12",
      }),
    },
  ));
  assert.equal(simulation.status, 200);
  assert.equal((await simulation.json()).gross_profit_rm, "81.20");

  const correction = await app.fetch(new Request(
    apiUrl("/api/v1/corrections"),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "correction-key-001",
      },
      body: JSON.stringify({
        merchant_id: "m_kak_lina_001",
        target_event_id: "evt_sales_001",
        occurred_at: "2026-07-12T14:35:00+08:00",
        reason: "Quantity should be 38.",
        replacement_payload: {
          changes: [
            {
              kind: "decimal",
              field: "quantity",
              previous_value: "40",
              corrected_value: "38",
            },
          ],
        },
        evidence: { source_event_id: "evt_voice_005" },
      }),
    },
  ));
  assert.equal(correction.status, 200);
  assert.deepEqual(await correction.json(), {
    state: "committed",
    correction_event_id: "evt_correction_001",
    target_event_id: "evt_sales_001",
    changes: [{
      field: "quantity",
      before_value: "40",
      after_value: "38",
    }],
  });

  const summary = await app.fetch(new Request(apiUrl(
    "/api/v1/summary/daily?merchant_id=m_kak_lina_001&date=2026-07-12",
  )));
  assert.equal((await summary.json()).gross_profit_rm, "69.16");
});
