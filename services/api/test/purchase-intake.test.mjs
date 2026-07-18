import assert from "node:assert/strict";
import { test } from "node:test";

import {
  InMemoryLedgerStore,
  allowMerchantForTests,
  createApiApp,
  createPasarAiService,
} from "../src/backend/index.js";

function createFixture() {
  const store = new InMemoryLedgerStore({
    productProfiles: [{
      merchantId: "m_001",
      productId: "p_001",
      baselineUnitCogsRm: "0.50",
      currentUnitCogsRm: "0.50",
      components: [{
        componentId: "c_egg",
        name: "Eggs",
        baselineCostRm: "0.50",
        currentCostRm: "0.50",
        usagePerProductUnit: "1",
      }],
    }],
  });
  const counts = new Map();
  const service = createPasarAiService({
    store,
    idFactory: (kind) => {
      const next = (counts.get(kind) ?? 0) + 1;
      counts.set(kind, next);
      return `${kind}_${next}`;
    },
  });
  return { service, store };
}

function partialRequest(overrides = {}) {
  return {
    merchant_id: "m_001",
    occurred_at: "2026-07-16T08:00:00+08:00",
    source: "telegram_text",
    source_language: "en",
    metadata: { payment_method: "cash" },
    item: { component_id: "c_egg", raw_name: "Eggs" },
    evidence: {
      transcript: "Bought eggs",
      external_message_id: "telegram:1:purchase-intake",
    },
    ...overrides,
  };
}

test("purchase intake persists clarification, invalidates stale confirmation, and commits once", async () => {
  const { service, store } = createFixture();
  const first = await service.upsertPurchaseIntake(partialRequest(), {
    idempotencyKey: "intake-1",
    conversationKey: "telegram:100",
  });
  assert.equal(first.state, "clarification_required");
  assert.deepEqual(first.missing_fields, [
    "supplier_name",
    "item.quantity",
    "item.uom",
    "item.pack_size",
    "item.total_price_rm",
  ]);
  assert.equal(
    store.listEvents({ merchantId: "m_001", type: "cost" }).length,
    0,
  );

  const active = await service.getActivePurchaseIntake({
    merchantId: "m_001",
    conversationKey: "telegram:100",
  });
  assert.equal(active.intake_id, first.intake_id);
  assert.equal(active.version, 1);

  const ready = await service.upsertPurchaseIntake(partialRequest({
    intake_id: first.intake_id,
    expected_version: 1,
    supplier_name: "Morning Market",
    item: {
      quantity: "2",
      uom: "tray",
      pack_size: "30",
      total_price_rm: "24.00",
    },
    evidence: {
      transcript: "Two trays, 30 each, RM24 from Morning Market",
      external_message_id: "telegram:2:purchase-intake",
    },
  }), {
    idempotencyKey: "intake-2",
    conversationKey: "telegram:100",
  });
  assert.equal(ready.state, "ready_for_confirmation");
  assert.equal(ready.version, 2);
  assert.deepEqual(ready.missing_fields, []);

  const stale = await service.confirmPurchaseIntake({
    merchant_id: "m_001",
    intake_id: ready.intake_id,
    expected_version: 1,
    confirmation_token: ready.confirmation_token,
  }, { idempotencyKey: "confirm-stale" });
  assert.equal(stale.state, "rejected");

  const committed = await service.confirmPurchaseIntake({
    merchant_id: "m_001",
    intake_id: ready.intake_id,
    expected_version: ready.version,
    confirmation_token: ready.confirmation_token,
  }, { idempotencyKey: "confirm-current" });
  assert.equal(committed.state, "committed");
  assert.equal(
    store.listEvents({ merchantId: "m_001", type: "cost" }).length,
    1,
  );

  const replay = await service.confirmPurchaseIntake({
    merchant_id: "m_001",
    intake_id: ready.intake_id,
    expected_version: ready.version,
    confirmation_token: ready.confirmation_token,
  }, { idempotencyKey: "confirm-replay" });
  assert.deepEqual(replay, committed);
  assert.equal(
    store.listEvents({ merchantId: "m_001", type: "cost" }).length,
    1,
  );
  assert.equal(
    (await store.getProductProfile("p_001", {
      merchantId: "m_001",
      asOfDate: "2026-07-16",
    })).currentUnitCogsRm,
    "0.4",
  );

  const forgedReplay = await service.confirmPurchaseIntake({
    merchant_id: "m_001",
    intake_id: ready.intake_id,
    expected_version: 999,
    confirmation_token: "confirmation_forged",
  }, { idempotencyKey: "confirm-forged-replay" });
  assert.equal(forgedReplay.state, "rejected");
  assert.equal(
    store.listEvents({ merchantId: "m_001", type: "cost" }).length,
    1,
  );
});

test("component catalog is merchant scoped and unknown items remain unconfirmed", async () => {
  const { service } = createFixture();
  assert.deepEqual(await service.getComponentCatalog({
    merchantId: "m_001",
    asOfDate: "2026-07-16",
  }), {
    merchant_id: "m_001",
    components: [{ component_id: "c_egg", name: "Eggs" }],
  });

  const result = await service.upsertPurchaseIntake(partialRequest({
    supplier_name: "Morning Market",
    item: {
      component_id: "c_unknown",
      raw_name: "Unknown ingredient",
      quantity: "1",
      uom: "bag",
      pack_size: "1",
      total_price_rm: "10.00",
    },
  }), {
    idempotencyKey: "unknown-item",
  });
  assert.equal(result.state, "clarification_required");
  assert.deepEqual(result.missing_fields, ["item.component_id"]);
  assert.equal(result.confirmation_token, null);
});

test("purchase intake and component catalog HTTP routes enforce the shared contracts", async () => {
  const { service } = createFixture();
  const app = createApiApp({
    service,
    authenticate: allowMerchantForTests("m_001"),
  });
  const catalog = await app.fetch(new Request(
    "http://pasarai.test/api/v1/catalog/components?merchant_id=m_001&as_of=2026-07-16",
  ));
  assert.equal(catalog.status, 200);
  assert.equal((await catalog.json()).components[0].component_id, "c_egg");

  const created = await app.fetch(new Request(
    "http://pasarai.test/api/v1/purchase-intakes",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "web-intake",
      },
      body: JSON.stringify(partialRequest({
        source: "web_manual",
        supplier_name: "Morning Market",
        item: {
          component_id: "c_egg",
          quantity: "2",
          uom: "tray",
          pack_size: "30",
          total_price_rm: "24.00",
        },
      })),
    },
  ));
  assert.equal(created.status, 200);
  const intake = await created.json();
  assert.equal(intake.state, "ready_for_confirmation");

  const confirmed = await app.fetch(new Request(
    "http://pasarai.test/api/v1/purchase-intakes/confirm",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "web-confirm",
      },
      body: JSON.stringify({
        merchant_id: "m_001",
        intake_id: intake.intake_id,
        expected_version: intake.version,
        confirmation_token: intake.confirmation_token,
      }),
    },
  ));
  assert.equal(confirmed.status, 200);
  assert.equal((await confirmed.json()).state, "committed");
});

test("purchase intake rejects non-cash metadata at the canonical contract boundary", async () => {
  const { service, store } = createFixture();
  const result = await service.upsertPurchaseIntake(partialRequest({
    metadata: { payment_method: "card" },
  }), {
    idempotencyKey: "non-cash-intake",
  });

  assert.equal(result.state, "rejected");
  assert.equal(
    store.listEvents({ merchantId: "m_001", type: "purchase_intake" }).length,
    0,
  );
});

test("concurrent edits produce one next version and reject the stale competitor", async () => {
  const { service, store } = createFixture();
  const first = await service.upsertPurchaseIntake(partialRequest(), {
    idempotencyKey: "concurrent-create",
    conversationKey: "telegram:concurrent",
  });

  const updates = await Promise.all([
    service.upsertPurchaseIntake(partialRequest({
      intake_id: first.intake_id,
      expected_version: first.version,
      supplier_name: "Supplier A",
      evidence: {
        transcript: "Supplier A",
        external_message_id: "telegram:concurrent:a",
      },
    }), {
      idempotencyKey: "concurrent-update-a",
      conversationKey: "telegram:concurrent",
    }),
    service.upsertPurchaseIntake(partialRequest({
      intake_id: first.intake_id,
      expected_version: first.version,
      supplier_name: "Supplier B",
      evidence: {
        transcript: "Supplier B",
        external_message_id: "telegram:concurrent:b",
      },
    }), {
      idempotencyKey: "concurrent-update-b",
      conversationKey: "telegram:concurrent",
    }),
  ]);

  assert.equal(
    updates.filter(({ state }) => state !== "rejected").length,
    1,
  );
  assert.equal(
    updates.filter(({ state }) => state === "rejected").length,
    1,
  );
  assert.deepEqual(
    store
      .listEvents({ merchantId: "m_001", type: "purchase_intake" })
      .map(({ payload }) => payload.version),
    [1, 2],
  );
});

test("confirmation and cancellation serialize against the same intake version", async () => {
  const { service, store } = createFixture();
  const ready = await service.upsertPurchaseIntake(partialRequest({
    supplier_name: "Morning Market",
    item: {
      component_id: "c_egg",
      raw_name: "Eggs",
      quantity: "2",
      uom: "tray",
      pack_size: "30",
      total_price_rm: "24.00",
    },
  }), {
    idempotencyKey: "race-create",
    conversationKey: "telegram:race",
  });

  const [confirmed, cancelled] = await Promise.all([
    service.confirmPurchaseIntake({
      merchant_id: "m_001",
      intake_id: ready.intake_id,
      expected_version: ready.version,
      confirmation_token: ready.confirmation_token,
    }, { idempotencyKey: "race-confirm" }),
    service.cancelPurchaseIntake({
      merchantId: "m_001",
      intakeId: ready.intake_id,
      expectedVersion: ready.version,
    }),
  ]);

  const confirmationSucceeded = confirmed.state === "committed";
  assert.notEqual(confirmationSucceeded, cancelled);
  assert.equal(
    store.listEvents({ merchantId: "m_001", type: "cost" }).length,
    confirmationSucceeded ? 1 : 0,
  );
  const snapshots = store.listEvents({
    merchantId: "m_001",
    type: "purchase_intake",
  });
  assert.deepEqual(snapshots.map(({ payload }) => payload.version), [1, 2]);
  assert.ok(["committed", "cancelled"].includes(
    snapshots.at(-1).payload.state,
  ));
});

test("confirmed purchases update the cost stack on dates without sales", async () => {
  const { service } = createFixture();
  const ready = await service.upsertPurchaseIntake(partialRequest({
    supplier_name: "Morning Market",
    item: {
      component_id: "c_egg",
      raw_name: "Eggs",
      quantity: "2",
      uom: "tray",
      pack_size: "30",
      total_price_rm: "24.00",
    },
  }), {
    idempotencyKey: "purchase-only-create",
  });
  assert.equal((await service.confirmPurchaseIntake({
    merchant_id: "m_001",
    intake_id: ready.intake_id,
    expected_version: ready.version,
    confirmation_token: ready.confirmation_token,
  }, {
    idempotencyKey: "purchase-only-confirm",
  })).state, "committed");

  const summary = await service.getDailySummary({
    merchantId: "m_001",
    date: "2026-07-16",
  });
  assert.equal(summary.data_completeness.state, "partial");
  assert.deepEqual(summary.data_completeness.missing_inputs, ["sales"]);
  assert.equal(summary.cost_stack.current_unit_cogs_rm, "0.40");
  assert.equal(
    summary.cost_stack.components[0].current_cost_rm_per_pack,
    "0.40",
  );
});

test("a Telegram conversation can start a new intake after the prior one closes", async () => {
  const { service } = createFixture();
  const first = await service.upsertPurchaseIntake(partialRequest({
    supplier_name: "Morning Market",
    item: {
      component_id: "c_egg",
      raw_name: "Eggs",
      quantity: "2",
      uom: "tray",
      pack_size: "30",
      total_price_rm: "24.00",
    },
  }), {
    idempotencyKey: "conversation-first-create",
    conversationKey: "telegram:repeat",
  });
  assert.equal((await service.confirmPurchaseIntake({
    merchant_id: "m_001",
    intake_id: first.intake_id,
    expected_version: first.version,
    confirmation_token: first.confirmation_token,
  }, {
    idempotencyKey: "conversation-first-confirm",
  })).state, "committed");

  const second = await service.upsertPurchaseIntake(partialRequest({
    evidence: {
      transcript: "Bought eggs again",
      external_message_id: "telegram:repeat:second",
    },
  }), {
    idempotencyKey: "conversation-second-create",
    conversationKey: "telegram:repeat",
  });

  assert.equal(second.state, "clarification_required");
  assert.equal(second.version, 1);
  assert.notEqual(second.intake_id, first.intake_id);
});
