import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

const { Pool } = pg;
const snapshotUrl = new URL(
  "../../../fixtures/demo/current-snapshot.json",
  import.meta.url,
);

export const demoSnapshot = JSON.parse(
  await readFile(snapshotUrl, "utf8"),
);

function cents(value) {
  const match = /^(0|[1-9][0-9]*)\.([0-9]{2})$/u.exec(String(value));
  if (!match) throw new Error(`Invalid MYR fixture amount: ${value}`);
  return Number(match[1]) * 100 + Number(match[2]);
}

function shiftDate(value, days) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function validateDemoSnapshot(snapshot = demoSnapshot) {
  if (shiftDate(snapshot.dashboard_date, -1) !== snapshot.baseline_date) {
    throw new Error("Demo baseline date must be the day before the dashboard date");
  }
  if (snapshot.merchant.currency !== "MYR") {
    throw new Error("Demo snapshot currency must be MYR");
  }

  const componentIds = new Set();
  let baselineTotal = 0;
  let currentTotal = 0;
  for (const component of snapshot.components) {
    if (componentIds.has(component.component_id)) {
      throw new Error(`Duplicate demo component: ${component.component_id}`);
    }
    componentIds.add(component.component_id);
    const baseline = cents(component.baseline_cost_per_pack_rm);
    const current = cents(component.current_cost_per_pack_rm);
    const change = cents(component.change_rm_per_pack);
    if (baseline >= current) {
      throw new Error(
        `Demo baseline must be cheaper for ${component.component_id}`,
      );
    }
    if (current - baseline !== change) {
      throw new Error(`Demo component change mismatch: ${component.component_id}`);
    }
    baselineTotal += baseline;
    currentTotal += current;
  }

  if (baselineTotal !== cents(snapshot.metrics.baseline_unit_cogs_rm)) {
    throw new Error("Demo baseline total does not match its components");
  }
  if (currentTotal !== cents(snapshot.metrics.current_unit_cogs_rm)) {
    throw new Error("Demo current total does not match its components");
  }
  if (
    currentTotal - baselineTotal
    !== cents(snapshot.metrics.cost_increase_rm)
  ) {
    throw new Error("Demo cost increase does not match its components");
  }
  return snapshot;
}

export function buildDemoComponentSnapshots(snapshot = demoSnapshot) {
  validateDemoSnapshot(snapshot);
  return snapshot.components.flatMap((component) => [
    {
      ...component,
      currentCostRm: component.baseline_cost_per_pack_rm,
      evidenceProjection: null,
      effectiveAt: `${snapshot.baseline_date}T00:00:00+08:00`,
      snapshotId: `demo-baseline-${snapshot.baseline_date}`,
    },
    {
      ...component,
      currentCostRm: component.current_cost_per_pack_rm,
      evidenceProjection: component.evidence_projection,
      effectiveAt: `${snapshot.dashboard_date}T00:00:00+08:00`,
      snapshotId: `demo-current-${snapshot.dashboard_date}`,
    },
  ]);
}

async function deleteOptionalAnalytics(client, snapshot) {
  const tables = [
    "analytics_daily_component_costs",
    "analytics_daily_product_metrics",
    "analytics_refresh_state",
    "analytics_forecasts",
  ];
  for (const table of tables) {
    const lookup = await client.query(
      "SELECT to_regclass($1) AS table_name",
      [table],
    );
    if (!lookup.rows[0]?.table_name) continue;
    await client.query(
      `DELETE FROM ${table} WHERE merchant_id = $1 AND product_id = $2`,
      [
        snapshot.merchant.merchant_id,
        snapshot.product.product_id,
      ],
    );
  }
}

export async function applyDemoSnapshot(
  client,
  snapshot = demoSnapshot,
) {
  validateDemoSnapshot(snapshot);
  const merchant = snapshot.merchant;
  const product = snapshot.product;
  const merchantId = merchant.merchant_id;
  const productId = product.product_id;

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
      merchantId,
      merchant.display_name,
      merchant.location,
      merchant.timezone,
      merchant.currency,
      merchant.primary_language,
      JSON.stringify(merchant.supported_languages),
      merchant.target_gross_margin_pct,
    ],
  );
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
        merchant_id = EXCLUDED.merchant_id,
        name = EXCLUDED.name,
        selling_price_rm = EXCLUDED.selling_price_rm,
        active = EXCLUDED.active
    `,
    [
      productId,
      merchantId,
      product.name,
      product.selling_price_rm,
      product.active,
    ],
  );

  await client.query(
    "ALTER TABLE raw_events DISABLE TRIGGER raw_events_append_only",
  );
  await client.query(
    "ALTER TABLE evidence_assets DISABLE TRIGGER evidence_assets_append_only",
  );
  await client.query(
    "ALTER TABLE corrections DISABLE TRIGGER corrections_append_only",
  );
  await client.query(`
    CREATE TEMP TABLE demo_reset_event_ids (
      event_id TEXT PRIMARY KEY
    ) ON COMMIT DROP
  `);
  await client.query(
    `
      INSERT INTO demo_reset_event_ids (event_id)
      SELECT events.event_id
      FROM raw_events AS events
      JOIN merchants USING (merchant_id)
      WHERE events.merchant_id = $1
        AND (
          events.occurred_at AT TIME ZONE merchants.timezone
        )::date >= $2::date
        AND events.event_type NOT IN ('telegram_update', 'telegram_status')
      ON CONFLICT DO NOTHING
    `,
    [merchantId, snapshot.baseline_date],
  );
  await client.query(
    `
      INSERT INTO demo_reset_event_ids (event_id)
      SELECT correction_event_id
      FROM corrections
      WHERE merchant_id = $1
        AND target_event_id IN (SELECT event_id FROM demo_reset_event_ids)
      ON CONFLICT DO NOTHING
    `,
    [merchantId],
  );
  await client.query(`
    DELETE FROM purchase_lines
    WHERE receipt_id IN (
      SELECT receipt_id
      FROM purchase_receipts
      WHERE source_event_id IN (SELECT event_id FROM demo_reset_event_ids)
    )
  `);
  await client.query(`
    DELETE FROM purchase_receipts
    WHERE source_event_id IN (SELECT event_id FROM demo_reset_event_ids)
  `);
  await client.query(`
    DELETE FROM sales_lines
    WHERE source_event_id IN (SELECT event_id FROM demo_reset_event_ids)
  `);
  await client.query(`
    DELETE FROM evidence_assets
    WHERE source_event_id IN (SELECT event_id FROM demo_reset_event_ids)
  `);
  await client.query(
    `
      DELETE FROM corrections
      WHERE merchant_id = $1
        AND (
          correction_event_id IN (SELECT event_id FROM demo_reset_event_ids)
          OR target_event_id IN (SELECT event_id FROM demo_reset_event_ids)
        )
    `,
    [merchantId],
  );
  await client.query(
    `
      DELETE FROM clarification_tasks AS tasks
      USING merchants
      WHERE tasks.merchant_id = $1
        AND merchants.merchant_id = tasks.merchant_id
        AND (
          tasks.occurred_at AT TIME ZONE merchants.timezone
        )::date >= $2::date
    `,
    [merchantId, snapshot.baseline_date],
  );
  await client.query(
    "DELETE FROM api_idempotency WHERE merchant_id = $1",
    [merchantId],
  );
  await client.query(`
    DELETE FROM raw_events
    WHERE event_id IN (SELECT event_id FROM demo_reset_event_ids)
  `);
  await client.query(
    "ALTER TABLE corrections ENABLE TRIGGER corrections_append_only",
  );
  await client.query(
    "ALTER TABLE evidence_assets ENABLE TRIGGER evidence_assets_append_only",
  );
  await client.query(
    "ALTER TABLE raw_events ENABLE TRIGGER raw_events_append_only",
  );

  await client.query(
    `
      DELETE FROM recipe_components
      WHERE merchant_id = $1 AND product_id = $2
    `,
    [merchantId, productId],
  );
  await deleteOptionalAnalytics(client, snapshot);

  for (const component of buildDemoComponentSnapshots(snapshot)) {
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
          $1, $2, $3, $4, $5, $6, 1, $7::jsonb, $8, $9, $10
        )
      `,
      [
        merchantId,
        productId,
        component.component_id,
        component.name,
        component.baseline_cost_per_pack_rm,
        component.currentCostRm,
        component.evidenceProjection
          ? JSON.stringify(component.evidenceProjection)
          : null,
        component.uom,
        component.effectiveAt,
        component.snapshotId,
      ],
    );
  }

  const sale = snapshot.sale;
  const salePayload = {
    merchant_id: merchantId,
    occurred_at: sale.occurred_at,
    source: sale.source,
    source_language: sale.source_language,
    lines: [{
      product_id: productId,
      quantity: sale.quantity,
      unit_price_rm: sale.unit_price_rm,
    }],
    evidence: {
      transcript: sale.transcript,
      external_message_id: sale.event_id,
    },
  };
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
        $1, $2, 'sales.create', $3, $4, 'sale', $5, $6, $7,
        $8::jsonb, $9::jsonb, $10::jsonb
      )
    `,
    [
      sale.event_id,
      merchantId,
      `demo-reset:${snapshot.dashboard_date}:sale`,
      JSON.stringify([merchantId, "message", sale.event_id]),
      sale.occurred_at,
      sale.source,
      sale.source_language,
      JSON.stringify(salePayload),
      JSON.stringify(salePayload.evidence),
      JSON.stringify({ state: "committed", event_id: sale.event_id }),
    ],
  );

  return {
    reset: true,
    dashboardDate: snapshot.dashboard_date,
    baselineDate: snapshot.baseline_date,
    baselineUnitCogsRm: snapshot.metrics.baseline_unit_cogs_rm,
    currentUnitCogsRm: snapshot.metrics.current_unit_cogs_rm,
    componentCount: snapshot.components.length,
  };
}

export async function resetLakebaseDemoSnapshot({
  environment = process.env,
  PoolClass = Pool,
  snapshot = demoSnapshot,
} = {}) {
  const databaseUrl = environment.LAKEBASE_DATABASE_URL;
  if (!databaseUrl || databaseUrl === "<PLACEHOLDER>") {
    return { reset: false, reason: "lakebase_not_configured" };
  }
  const pool = new PoolClass({
    connectionString: databaseUrl,
    ssl: environment.LAKEBASE_SSL === "0"
      ? false
      : {
          rejectUnauthorized:
            environment.LAKEBASE_SSL_REJECT_UNAUTHORIZED !== "0",
        },
  });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await applyDemoSnapshot(client, snapshot);
    await client.query("COMMIT");
    return result;
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
  try {
    process.loadEnvFile(fileURLToPath(new URL("../.env", import.meta.url)));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const result = await resetLakebaseDemoSnapshot();
  console.log(
    result.reset
      ? `Lakebase demo reset: PASS (${result.baselineDate} -> ${result.dashboardDate})`
      : "Lakebase demo reset: SKIPPED (LAKEBASE_DATABASE_URL is not configured)",
  );
}
