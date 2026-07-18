import assert from "node:assert/strict";
import { test } from "node:test";

import { createLakebaseTelegramEventStore } from "../src/index.js";
import { InMemoryLedgerStore } from "../src/backend/index.js";

test("Lakebase Telegram claims retry transient state but deduplicate completion", async () => {
  const ledgerStore = new InMemoryLedgerStore();
  const eventStore = createLakebaseTelegramEventStore({
    ledgerStore,
    merchantId: "merchant-1",
    now: () => "2026-07-13T00:00:00.000Z",
  });
  const claim = () => eventStore.claimUpdate({
    updateId: 7001,
    merchantId: "merchant-1",
    event: {
      event_id: "telegram:7001",
      update_id: 7001,
      source: "telegram",
      merchant_id: "merchant-1",
    },
  });

  assert.equal((await claim()).claimed, true);
  await eventStore.updateEvent(7001, {
    state: "review_required",
    processing_state: "retryable",
    reason: "transcription_provider_unavailable",
  });
  const retry = await claim();
  assert.equal(retry.claimed, true);
  assert.equal(retry.retried, true);

  await eventStore.updateEvent(7001, {
    state: "accepted",
    processing_state: "completed",
  });
  assert.equal((await claim()).claimed, false);
  assert.equal(
    ledgerStore.listEvents({ type: "telegram_update" }).length,
    1,
  );
});

test("Lakebase Telegram processing lease permits retry after restart and expiry", async () => {
  const ledgerStore = new InMemoryLedgerStore();
  const event = {
    event_id: "telegram:7002",
    update_id: 7002,
    source: "telegram",
    merchant_id: "merchant-1",
  };
  const firstProcess = createLakebaseTelegramEventStore({
    ledgerStore,
    merchantId: "merchant-1",
    now: () => "2026-07-13T00:00:00.000Z",
    processingLeaseMs: 1_000,
  });
  assert.equal((await firstProcess.claimUpdate({
    updateId: 7002,
    merchantId: "merchant-1",
    event,
  })).claimed, true);

  const restartedProcess = createLakebaseTelegramEventStore({
    ledgerStore,
    merchantId: "merchant-1",
    now: () => "2026-07-13T00:00:02.000Z",
    processingLeaseMs: 1_000,
  });
  const retry = await restartedProcess.claimUpdate({
    updateId: 7002,
    merchantId: "merchant-1",
    event,
  });

  assert.equal(retry.claimed, true);
  assert.equal(retry.retried, true);
  assert.equal(
    ledgerStore.listEvents({ type: "telegram_update" }).length,
    1,
  );
});

test("Lakebase Telegram preserves pending confirmations across restart", async () => {
  const ledgerStore = new InMemoryLedgerStore();
  const createStore = () => createLakebaseTelegramEventStore({
    ledgerStore,
    merchantId: "merchant-1",
    now: () => "2026-07-16T08:00:00.000Z",
  });
  const conversationKey = "telegram:9001";
  const confirmation = {
    confirmation_id: "telegram:8001:database-confirmation",
    original_update_id: 8001,
    occurred_at: "2026-07-16T03:30:00.000Z",
    text: "Sold five nasi lemak biasa at RM5.",
    source: "telegram_text",
    source_language: "en",
    evidence_uri: "memory://telegram/merchant-1/8001/update.json",
    reply_language: "en",
    date: "2026-07-16",
    details: [
      "Sales on 2026-07-16: 5 x Nasi Lemak Biasa "
        + "(p_nlb_001) at RM5.00 each",
    ],
    operations: [{
      endpoint_id: "sales.create",
      payload: {
        occurred_at: "2026-07-16T03:30:00.000Z",
        lines: [{
          product_id: "p_nlb_001",
          quantity: "5",
          unit_price_rm: "5.00",
        }],
      },
    }],
  };

  await createStore().savePendingConfirmation({
    merchantId: "merchant-1",
    conversationKey,
    confirmation,
  });
  const restarted = createStore();
  assert.deepEqual(
    await restarted.getPendingConfirmation({
      merchantId: "merchant-1",
      conversationKey,
    }),
    {
      ...confirmation,
      merchant_id: "merchant-1",
      conversation_key: conversationKey,
      state: "pending",
    },
  );

  await restarted.resolvePendingConfirmation({
    merchantId: "merchant-1",
    conversationKey,
    confirmationId: confirmation.confirmation_id,
    state: "confirmed",
    resolutionUpdateId: 8002,
  });

  assert.equal(
    await createStore().getPendingConfirmation({
      merchantId: "merchant-1",
      conversationKey,
    }),
    null,
  );
  assert.equal(
    ledgerStore.listEvents({ type: "telegram_confirmation" }).length,
    2,
  );
});
