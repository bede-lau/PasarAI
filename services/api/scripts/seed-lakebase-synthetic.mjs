import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

import { createPersistentKey } from "../src/persistent-key.js";

const { Pool } = pg;

const seedRoot = new URL(
  "../../../fixtures/synthetic/seed_data/",
  import.meta.url,
);

function parseCsv(text) {
  const [header, ...rows] = text.trim().split(/\r?\n/);
  const fields = header.split(",");
  return rows.map((row) =>
    Object.fromEntries(fields.map((field, index) => [
      field,
      row.split(",")[index],
    ])));
}

const [merchant, products, components, receiptTruth, todayEvents] = await Promise.all([
  readFile(new URL("merchant.json", seedRoot), "utf8").then(JSON.parse),
  readFile(new URL("products.csv", seedRoot), "utf8").then(parseCsv),
  readFile(new URL("recipe_components.csv", seedRoot), "utf8").then(parseCsv),
  readFile(new URL("receipt_ground_truth.json", seedRoot), "utf8").then(JSON.parse),
  readFile(new URL("today_events.json", seedRoot), "utf8").then(JSON.parse),
]);
export function syntheticEvidenceAssetUri(
  fileName,
  publicBaseUrl = process.env.PASARAI_PUBLIC_EVIDENCE_BASE_URL,
) {
  const evidenceBase = (publicBaseUrl?.trim() || "/evidence").replace(
    /\/$/,
    "",
  );
  return `${evidenceBase}/${fileName}`;
}

const receiptByComponent = new Map();
for (const [fileName, receipt] of Object.entries(receiptTruth)) {
  for (const line of receipt.line_items) {
    if (!line.normalized_component_id) continue;
    const evidenceId = receipt.receipt_id;
    const projection = receiptByComponent.get(line.normalized_component_id) ?? {
      evidenceId,
      title: `${receipt.supplier_name} receipt`,
      assetUri: syntheticEvidenceAssetUri(fileName),
      receiptId: receipt.receipt_id,
      supplierName: receipt.supplier_name,
      transcript: null,
      lineItems: [],
    };
    projection.lineItems.push({
      rawName: line.raw_name,
      componentId: line.normalized_component_id,
      totalPriceRm: Number(line.total_price_rm).toFixed(2),
      confidence: "1.00",
    });
    receiptByComponent.set(line.normalized_component_id, projection);
  }
}

export function buildSyntheticRawEvents(seedMerchant, events) {
  return events.map((event) => {
    if (event.event_id === "evt_voice_001") {
      const payload = {
        merchant_id: seedMerchant.merchant_id,
        occurred_at: event.occurred_at,
        source: event.source,
        source_language: event.language,
        lines: [{
          product_id: "p_nlb_001",
          quantity: "40",
          unit_price_rm: "5.00",
        }],
        evidence: {
          transcript:
            "Hari ni habis forty bungkus nasi lemak biasa, semua five ringgit.",
          external_message_id: event.event_id,
        },
      };
      return {
        eventId: event.event_id,
        merchantId: seedMerchant.merchant_id,
        endpointId: "sales.create",
        idempotencyKey: "synthetic:sales:2026-07-12",
        externalId: createPersistentKey(
          seedMerchant.merchant_id,
          "message",
          event.event_id,
        ),
        eventType: "sale",
        occurredAt: event.occurred_at,
        source: event.source,
        sourceLanguage: event.language,
        payload,
        evidence: payload.evidence,
        response: { state: "committed", event_id: event.event_id },
      };
    }

    return {
      eventId: event.event_id,
      merchantId: seedMerchant.merchant_id,
      endpointId: "synthetic.fixture",
      idempotencyKey: `synthetic:${event.event_id}`,
      externalId: null,
      eventType: event.type,
      occurredAt: event.occurred_at,
      source: event.source,
      sourceLanguage: event.language ?? null,
      payload: event,
      evidence: {
        ...(event.evidence_path ? { evidence_path: event.evidence_path } : {}),
        ...(event.receipt_id ? { receipt_id: event.receipt_id } : {}),
        ...(event.transcript ? { transcript: event.transcript } : {}),
        ...(event.resolves_event_id
          ? { resolves_event_id: event.resolves_event_id }
          : {}),
      },
      response: {},
    };
  });
}

export function buildSyntheticComponentSnapshots(
  component,
  evidenceProjection = null,
) {
  return [
    {
      currentCostRm: component.baseline_cost_per_pack_rm,
      evidenceProjection: null,
      effectiveAt: "2026-07-05T00:00:00+08:00",
      snapshotId: "synthetic-baseline-v1",
    },
    {
      currentCostRm: component.current_cost_per_pack_rm,
      evidenceProjection,
      effectiveAt: "2026-07-12T00:00:00+08:00",
      snapshotId: "synthetic-current-v1",
    },
  ];
}

async function seedLakebase() {
  const databaseUrl = process.env.LAKEBASE_DATABASE_URL;
  if (!databaseUrl || databaseUrl === "<PLACEHOLDER>") {
    throw new Error("LAKEBASE_DATABASE_URL is required");
  }
  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: process.env.LAKEBASE_SSL === "0"
      ? false
      : {
          rejectUnauthorized:
            process.env.LAKEBASE_SSL_REJECT_UNAUTHORIZED !== "0",
        },
  });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `
        INSERT INTO merchants (
          merchant_id,
          display_name,
          location,
          timezone,
          currency,
          primary_language,
          supported_languages,
          target_gross_margin_pct
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
        ON CONFLICT (merchant_id) DO UPDATE SET
          display_name = EXCLUDED.display_name,
          location = EXCLUDED.location,
          timezone = EXCLUDED.timezone,
          currency = EXCLUDED.currency,
          primary_language = EXCLUDED.primary_language,
          supported_languages = EXCLUDED.supported_languages,
          target_gross_margin_pct = EXCLUDED.target_gross_margin_pct
      `,
      [
        merchant.merchant_id,
        merchant.display_name,
        merchant.location,
        merchant.timezone,
        merchant.currency,
        merchant.primary_language,
        JSON.stringify(merchant.supported_languages),
        String(merchant.target_gross_margin_pct),
      ],
    );
    for (const product of products) {
      await client.query(
        `
          INSERT INTO products (
            product_id,
            merchant_id,
            name,
            selling_price_rm,
            active
          )
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (product_id) DO UPDATE SET
            name = EXCLUDED.name,
            selling_price_rm = EXCLUDED.selling_price_rm,
            active = EXCLUDED.active
        `,
        [
          product.product_id,
          product.merchant_id,
          product.name,
          product.selling_price_rm,
          product.active.toLowerCase() === "true",
        ],
      );
    }
    for (const component of components) {
      const snapshots = buildSyntheticComponentSnapshots(
        component,
        receiptByComponent.has(component.component_id)
          ? JSON.stringify(receiptByComponent.get(component.component_id))
          : null,
      );
      for (const snapshot of snapshots) {
        await client.query(
          `
            INSERT INTO recipe_components (
              merchant_id,
              product_id,
              component_id,
              component_name,
              baseline_cost_per_pack_rm,
              current_cost_per_pack_rm,
              usage_per_product_unit,
              evidence_projection,
              uom,
              effective_at,
              snapshot_id
            )
            VALUES (
              $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11
            )
            ON CONFLICT (
              merchant_id,
              product_id,
              component_id,
              effective_at,
              snapshot_id
            ) DO UPDATE SET
              component_name = EXCLUDED.component_name,
              baseline_cost_per_pack_rm = EXCLUDED.baseline_cost_per_pack_rm,
              current_cost_per_pack_rm = EXCLUDED.current_cost_per_pack_rm,
              usage_per_product_unit = EXCLUDED.usage_per_product_unit,
              evidence_projection = EXCLUDED.evidence_projection,
              uom = EXCLUDED.uom
          `,
          [
            merchant.merchant_id,
            component.product_id,
            component.component_id,
            component.component_name,
            component.baseline_cost_per_pack_rm,
            snapshot.currentCostRm,
            component.usage_per_product_unit,
            snapshot.evidenceProjection,
            component.uom,
            snapshot.effectiveAt,
            snapshot.snapshotId,
          ],
        );
      }
    }

    for (const event of buildSyntheticRawEvents(merchant, todayEvents)) {
      await client.query(
        `
          INSERT INTO raw_events (
            event_id,
            merchant_id,
            endpoint_id,
            idempotency_key,
            external_id,
            event_type,
            occurred_at,
            source,
            source_language,
            payload,
            evidence,
            response
          )
          VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9,
            $10::jsonb, $11::jsonb, $12::jsonb
          )
          ON CONFLICT DO NOTHING
        `,
        [
          event.eventId,
          event.merchantId,
          event.endpointId,
          event.idempotencyKey,
          event.externalId,
          event.eventType,
          event.occurredAt,
          event.source,
          event.sourceLanguage,
          JSON.stringify(event.payload),
          JSON.stringify(event.evidence),
          JSON.stringify(event.response),
        ],
      );
    }
    await client.query("COMMIT");
    console.log("Lakebase synthetic seed: PASS");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

if (
  process.argv[1]
  && fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  await seedLakebase();
}
