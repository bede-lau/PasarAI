import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  buildSyntheticComponentSnapshots,
  buildSyntheticRawEvents,
  syntheticEvidenceAssetUri,
} from "../scripts/seed-lakebase-synthetic.mjs";
import {
  applyDemoSnapshot,
  buildDemoComponentSnapshots,
  demoSnapshot,
  validateDemoSnapshot,
} from "../scripts/reset-lakebase-demo.mjs";

const seedRoot = new URL(
  "../../../fixtures/synthetic/seed_data/",
  import.meta.url,
);

test("Lakebase synthetic seed produces every authoritative raw event idempotently", async () => {
  const [merchant, todayEvents] = await Promise.all([
    readFile(new URL("merchant.json", seedRoot), "utf8").then(JSON.parse),
    readFile(new URL("today_events.json", seedRoot), "utf8").then(JSON.parse),
  ]);

  const rawEvents = buildSyntheticRawEvents(merchant, todayEvents);
  assert.deepEqual(
    rawEvents.map((event) => event.eventId),
    todayEvents.map((event) => event.event_id),
  );
  assert.equal(
    new Set(rawEvents.map((event) =>
      `${event.merchantId}\u0000${event.endpointId}\u0000${event.idempotencyKey}`
    )).size,
    todayEvents.length,
  );

  const voice = rawEvents.find((event) => event.eventId === "evt_voice_001");
  assert.equal(voice.endpointId, "sales.create");
  assert.equal(voice.idempotencyKey, "synthetic:sales:2026-07-12");
  assert.equal(
    voice.externalId,
    JSON.stringify([merchant.merchant_id, "message", "evt_voice_001"]),
  );
  assert.equal(voice.externalId.includes("\u0000"), false);
  assert.deepEqual(voice.payload.lines, [{
    product_id: "p_nlb_001",
    quantity: "40",
    unit_price_rm: "5.00",
  }]);
  assert.equal(voice.payload.evidence.external_message_id, "evt_voice_001");
  assert.equal(
    voice.payload.evidence.transcript,
    "Hari ni habis forty bungkus nasi lemak biasa, semua five ringgit.",
  );
});

test("Lakebase synthetic seed exposes bundled receipt images by default", () => {
  assert.equal(
    syntheticEvidenceAssetUri("receipt_003_pasar_pagi.jpg"),
    "/evidence/receipt_003_pasar_pagi.jpg",
  );
  assert.equal(
    syntheticEvidenceAssetUri(
      "receipt_003_pasar_pagi.jpg",
      "https://pasarai.example/evidence/",
    ),
    "https://pasarai.example/evidence/receipt_003_pasar_pagi.jpg",
  );
});

test("Lakebase synthetic seed keeps distinct baseline and current snapshots", () => {
  const snapshots = buildSyntheticComponentSnapshots({
    baseline_cost_per_pack_rm: "0.55",
    current_cost_per_pack_rm: "0.61",
  }, "{\"evidenceId\":\"receipt-sinar\"}");

  assert.deepEqual(snapshots, [
    {
      currentCostRm: "0.55",
      evidenceProjection: null,
      effectiveAt: "2026-07-05T00:00:00+08:00",
      snapshotId: "synthetic-baseline-v1",
    },
    {
      currentCostRm: "0.61",
      evidenceProjection: "{\"evidenceId\":\"receipt-sinar\"}",
      effectiveAt: "2026-07-12T00:00:00+08:00",
      snapshotId: "synthetic-current-v1",
    },
  ]);
});

test("demo snapshot keeps July 15 cheaper than every July 16 component", () => {
  assert.equal(validateDemoSnapshot(), demoSnapshot);
  const snapshots = buildDemoComponentSnapshots();
  assert.equal(snapshots.length, 18);
  assert.equal(
    snapshots.filter(({ effectiveAt }) =>
      effectiveAt === "2026-07-15T00:00:00+08:00"
    ).length,
    9,
  );
  assert.equal(
    snapshots.filter(({ effectiveAt }) =>
      effectiveAt === "2026-07-16T00:00:00+08:00"
    ).length,
    9,
  );
  assert.equal(demoSnapshot.metrics.baseline_unit_cogs_rm, "2.50");
  assert.equal(demoSnapshot.metrics.current_unit_cogs_rm, "3.22");
  assert.ok(demoSnapshot.components.every((component) =>
    Number(component.baseline_cost_per_pack_rm)
      < Number(component.current_cost_per_pack_rm)
  ));
});

test("demo reset replaces scoped business state and restores append-only triggers", async () => {
  const calls = [];
  const client = {
    async query(text, values = []) {
      calls.push({ text: text.replace(/\s+/gu, " ").trim(), values });
      if (/SELECT to_regclass/u.test(text)) {
        return { rows: [{ table_name: null }] };
      }
      return { rows: [] };
    },
  };

  const result = await applyDemoSnapshot(client);

  assert.deepEqual(result, {
    reset: true,
    dashboardDate: "2026-07-16",
    baselineDate: "2026-07-15",
    baselineUnitCogsRm: "2.50",
    currentUnitCogsRm: "3.22",
    componentCount: 9,
  });
  assert.ok(calls.some(({ text }) =>
    text === "ALTER TABLE raw_events DISABLE TRIGGER raw_events_append_only"
  ));
  assert.ok(calls.some(({ text }) =>
    text === "ALTER TABLE raw_events ENABLE TRIGGER raw_events_append_only"
  ));
  assert.ok(calls.some(({ text, values }) =>
    /INSERT INTO demo_reset_event_ids/u.test(text)
    && /event_type NOT IN \('telegram_update', 'telegram_status'\)/u.test(text)
    && values[0] === "m_kak_lina_001"
    && values[1] === "2026-07-15"
  ));
  assert.ok(calls.some(({ text }) =>
    /DELETE FROM purchase_lines/u.test(text)
    && /purchase_receipts/u.test(text)
    && /demo_reset_event_ids/u.test(text)
  ));
  assert.ok(calls.some(({ text }) =>
    /DELETE FROM purchase_receipts/u.test(text)
    && /demo_reset_event_ids/u.test(text)
  ));
  assert.ok(calls.some(({ text }) =>
    /DELETE FROM evidence_assets/u.test(text)
    && /demo_reset_event_ids/u.test(text)
  ));
  assert.ok(calls.some(({ text }) =>
    /DELETE FROM raw_events/u.test(text)
    && /demo_reset_event_ids/u.test(text)
  ));
  assert.ok(calls.some(({ text, values }) =>
    /DELETE FROM recipe_components/u.test(text)
    && values[0] === "m_kak_lina_001"
    && values[1] === "p_nlb_001"
  ));
  assert.equal(
    calls.filter(({ text }) =>
      /INSERT INTO recipe_components/u.test(text)
    ).length,
    18,
  );
  assert.ok(calls.some(({ text, values }) =>
    /INSERT INTO raw_events/u.test(text)
    && values[0] === "demo_sale_2026_07_16"
  ));
});
