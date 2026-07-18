import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

import pg from "pg";
import { sumDecimal } from "@pasarai/finance";

const { Pool } = pg;

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function isMissingOptionalAnalyticsTable(error) {
  return error?.code === "42P01";
}

function rowEvent(row) {
  if (!row) return null;
  return {
    eventId: row.event_id,
    endpointId: row.endpoint_id,
    externalId: row.external_id,
    type: row.event_type,
    merchantId: row.merchant_id,
    occurredAt: new Date(row.occurred_at).toISOString(),
    ingestedAt: row.ingested_at
      ? new Date(row.ingested_at).toISOString()
      : null,
    targetEventId: row.target_event_id,
    payload: row.payload,
    evidence: row.evidence,
    response: row.response,
  };
}

function taskFromRow(row) {
  if (!row) return null;
  return {
    taskId: row.clarification_task_id,
    storageKey: row.storage_key,
    kind: row.kind,
    evidenceKind: row.evidence_kind,
    sourceEventId: row.raw_source_id,
    merchantId: row.merchant_id,
    occurredAt: new Date(row.occurred_at).toISOString(),
    componentId: row.component_id,
    increaseRm:
      row.increase_rm === null ? undefined : String(row.increase_rm),
    request: row.request,
    evidence: row.evidence,
    response: row.response,
    resolution: row.resolution,
  };
}

function profileFromComponentRows(productId, rows) {
  if (!rows.length) return null;
  const components = rows.map((row) => ({
    componentId: row.component_id,
    name: row.component_name,
    baselineCostRm: String(row.baseline_cost_per_pack_rm),
    currentCostRm: String(row.current_cost_per_pack_rm),
    usagePerProductUnit: String(row.usage_per_product_unit),
    evidence: row.evidence_projection,
  }));
  const sum = (field) => sumDecimal(
    components.map((component) => component[field]),
  );
  return {
    merchantId: rows[0].merchant_id,
    productId,
    baselineUnitCogsRm: sum("baselineCostRm"),
    currentUnitCogsRm: sum("currentCostRm"),
    targetGrossMarginPct: String(rows[0].target_gross_margin_pct),
    components,
  };
}

export class LakebaseLedgerStore {
  #pool;
  #transactionContext = new AsyncLocalStorage();

  constructor({
    databaseUrl,
    pool,
    ssl,
  } = {}) {
    if (!pool && !databaseUrl) {
      throw new Error("databaseUrl or pool is required");
    }
    this.#pool = pool ?? new Pool({
      connectionString: databaseUrl,
      ...(ssl === undefined ? {} : { ssl }),
      max: 5,
    });
  }

  async #query(text, values = []) {
    const client = this.#transactionContext.getStore();
    return (client ?? this.#pool).query(text, values);
  }

  async #transaction(execute) {
    const activeClient = this.#transactionContext.getStore();
    if (activeClient) return execute();

    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const result = await this.#transactionContext.run(
        client,
        execute,
      );
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

  async runReceiptReviewMutation({
    merchantId,
    receiptEventId,
  }, execute) {
    return this.#transaction(async () => {
      const receipt = await this.#query(
        `
          SELECT event_id
          FROM raw_events
          WHERE event_id = $1
            AND merchant_id = $2
            AND event_type = 'receipt'
          FOR UPDATE
        `,
        [receiptEventId, merchantId],
      );
      if (!receipt.rows[0]) {
        throw new Error(
          `Receipt review target could not be locked: ${receiptEventId}`,
        );
      }
      return execute();
    });
  }

  async runIdempotent({
    merchantId,
    endpointId,
    key,
    fingerprint,
    execute,
  }) {
    return this.#transaction(async () => {
      const inserted = await this.#query(
        `
          INSERT INTO api_idempotency (
            merchant_id,
            endpoint_id,
            idempotency_key,
            request_fingerprint
          )
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (merchant_id, endpoint_id, idempotency_key) DO NOTHING
          RETURNING request_fingerprint, response
        `,
        [merchantId, endpointId, key, fingerprint],
      );
      const claim = inserted.rows[0] ?? (
        await this.#query(
          `
            SELECT request_fingerprint, response
            FROM api_idempotency
            WHERE merchant_id = $1
              AND endpoint_id = $2
              AND idempotency_key = $3
            FOR UPDATE
          `,
          [merchantId, endpointId, key],
        )
      ).rows[0];

      if (claim.request_fingerprint !== fingerprint) {
        return { conflict: true };
      }
      if (claim.response !== null) {
        return { conflict: false, response: clone(claim.response) };
      }

      const response = await execute();
      await this.#query(
        `
          UPDATE api_idempotency
          SET response = $4::jsonb,
              completed_at = CURRENT_TIMESTAMP
          WHERE merchant_id = $1
            AND endpoint_id = $2
            AND idempotency_key = $3
        `,
        [merchantId, endpointId, key, JSON.stringify(response)],
      );
      return { conflict: false, response: clone(response) };
    });
  }

  async findEventByExternalId(externalId) {
    const result = await this.#query(
      `
        SELECT *
        FROM raw_events
        WHERE external_id = $1
        LIMIT 1
      `,
      [externalId],
    );
    return rowEvent(result.rows[0]);
  }

  async appendEvent(event) {
    if (!event.endpointId) {
      throw new Error("event.endpointId is required");
    }
    const result = await this.#query(
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
          response,
          target_event_id
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9,
          $10::jsonb, $11::jsonb, $12::jsonb, $13
        )
        ON CONFLICT DO NOTHING
        RETURNING *
      `,
      [
        event.eventId,
        event.merchantId,
        event.endpointId,
        event.idempotencyKey ?? event.externalId ?? event.eventId,
        event.externalId ?? null,
        event.type,
        event.occurredAt,
        event.payload?.source ?? "api",
        event.payload?.source_language ?? null,
        JSON.stringify(event.payload ?? {}),
        JSON.stringify(event.evidence ?? {}),
        JSON.stringify(event.response ?? {}),
        event.targetEventId ?? null,
      ],
    );
    if (result.rows[0]) {
      return { appended: true, event: rowEvent(result.rows[0]) };
    }

    const existing = event.externalId
      ? await this.findEventByExternalId(event.externalId)
      : await this.getEvent(event.eventId);
    if (!existing) {
      throw new Error(`Event conflict could not be resolved: ${event.eventId}`);
    }
    return { appended: false, event: existing };
  }

  async appendCorrection(event, { expectedTargetVersion } = {}) {
    return this.#transaction(async () => {
      if (expectedTargetVersion !== undefined) {
        const target = await this.#query(
          `
            SELECT event_id
            FROM raw_events
            WHERE event_id = $1
              AND merchant_id = $2
              AND event_type = 'sale'
            FOR UPDATE
          `,
          [event.targetEventId, event.merchantId],
        );
        if (!target.rows[0]) {
          throw new Error(
            `Correction target could not be locked: ${event.targetEventId}`,
          );
        }
        const version = await this.#query(
          `
            SELECT COUNT(*)::integer + 1 AS target_version
            FROM corrections
            WHERE target_event_id = $1
          `,
          [event.targetEventId],
        );
        const targetVersion = Number(version.rows[0].target_version);
        if (targetVersion !== expectedTargetVersion) {
          return {
            appended: false,
            conflict: true,
            targetVersion,
          };
        }
      }

      const appended = await this.appendEvent(event);
      if (!appended.appended) return appended;

      await this.#query(
        `
          INSERT INTO corrections (
            correction_event_id,
            merchant_id,
            target_event_id,
            reason,
            replacement_payload,
            evidence,
            occurred_at
          )
          VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)
        `,
        [
          event.eventId,
          event.merchantId,
          event.targetEventId,
          event.payload.reason,
          JSON.stringify(event.payload.replacement_payload),
          JSON.stringify(event.evidence ?? {}),
          event.occurredAt,
        ],
      );
      return appended;
    });
  }

  async getEvent(eventId) {
    const result = await this.#query(
      "SELECT * FROM raw_events WHERE event_id = $1",
      [eventId],
    );
    return rowEvent(result.rows[0]);
  }

  async listEvents({
    merchantId,
    date,
    fromDate,
    toDate,
    type,
  } = {}) {
    const conditions = [];
    const values = [];
    const add = (sql, value) => {
      values.push(value);
      conditions.push(sql.replace("?", `$${values.length}`));
    };
    if (merchantId) add("events.merchant_id = ?", merchantId);
    if (type) add("events.event_type = ?", type);
    if (date) add(
      "(events.occurred_at AT TIME ZONE merchants.timezone)::date = ?::date",
      date,
    );
    if (fromDate) add(
      "(events.occurred_at AT TIME ZONE merchants.timezone)::date >= ?::date",
      fromDate,
    );
    if (toDate) add(
      "(events.occurred_at AT TIME ZONE merchants.timezone)::date <= ?::date",
      toDate,
    );
    const result = await this.#query(
      `
        SELECT events.*
        FROM raw_events AS events
        JOIN merchants USING (merchant_id)
        ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
        ORDER BY events.occurred_at, events.ingested_at, events.event_id
      `,
      values,
    );
    return result.rows.map(rowEvent);
  }

  async saveAnalyticsOverview(overview) {
    try {
      return await this.#transaction(async () => {
        for (const day of overview.days) {
          await this.#query(
            `
              INSERT INTO analytics_daily_product_metrics (
                merchant_id,
                product_id,
                date,
                data_state,
                sold_out_state,
                quantity,
                revenue_rm,
                cogs_rm,
                gross_profit_rm,
                gross_margin_pct,
                source_watermark,
                projection_version,
                generated_at
              )
              VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13
              )
              ON CONFLICT (merchant_id, product_id, date)
              DO UPDATE SET
                data_state = EXCLUDED.data_state,
                sold_out_state = EXCLUDED.sold_out_state,
                quantity = EXCLUDED.quantity,
                revenue_rm = EXCLUDED.revenue_rm,
                cogs_rm = EXCLUDED.cogs_rm,
                gross_profit_rm = EXCLUDED.gross_profit_rm,
                gross_margin_pct = EXCLUDED.gross_margin_pct,
                source_watermark = EXCLUDED.source_watermark,
                projection_version = EXCLUDED.projection_version,
                generated_at = EXCLUDED.generated_at
            `,
            [
              overview.merchant_id,
              overview.product_id,
              day.date,
              day.state,
              day.sold_out_state,
              day.quantity,
              day.revenue_rm,
              day.cogs_rm,
              day.gross_profit_rm,
              day.gross_margin_pct,
              overview.freshness.source_max_ingested_at,
              overview.freshness.projection_version,
              overview.generated_at,
            ],
          );
        }

        if (overview.cost_waterfall) {
          for (const component of overview.cost_waterfall.components) {
            await this.#query(
              `
                INSERT INTO analytics_daily_component_costs (
                  merchant_id,
                  product_id,
                  date,
                  component_id,
                  component_name,
                  baseline_cost_rm_per_pack,
                  current_cost_rm_per_pack,
                  change_rm_per_pack,
                  evidence_id,
                  projection_version,
                  generated_at
                )
                VALUES (
                  $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
                )
                ON CONFLICT (merchant_id, product_id, date, component_id)
                DO UPDATE SET
                  component_name = EXCLUDED.component_name,
                  baseline_cost_rm_per_pack =
                    EXCLUDED.baseline_cost_rm_per_pack,
                  current_cost_rm_per_pack =
                    EXCLUDED.current_cost_rm_per_pack,
                  change_rm_per_pack = EXCLUDED.change_rm_per_pack,
                  evidence_id = EXCLUDED.evidence_id,
                  projection_version = EXCLUDED.projection_version,
                  generated_at = EXCLUDED.generated_at
              `,
              [
                overview.merchant_id,
                overview.product_id,
                overview.to,
                component.component_id,
                component.name,
                component.baseline_cost_rm_per_pack,
                component.current_cost_rm_per_pack,
                component.change_rm_per_pack,
                component.evidence_id,
                overview.freshness.projection_version,
                overview.generated_at,
              ],
            );
          }
        }

        await this.#query(
          `
            INSERT INTO analytics_refresh_state (
              merchant_id,
              product_id,
              data_through,
              source_watermark,
              projection_version,
              generated_at,
              last_error
            )
            VALUES ($1, $2, $3, $4, $5, $6, NULL)
            ON CONFLICT (merchant_id, product_id)
            DO UPDATE SET
              data_through = EXCLUDED.data_through,
              source_watermark = EXCLUDED.source_watermark,
              projection_version = EXCLUDED.projection_version,
              generated_at = EXCLUDED.generated_at,
              last_error = NULL
          `,
          [
            overview.merchant_id,
            overview.product_id,
            overview.data_through,
            overview.freshness.source_max_ingested_at,
            overview.freshness.projection_version,
            overview.generated_at,
          ],
        );
        return true;
      });
    } catch (error) {
      if (isMissingOptionalAnalyticsTable(error)) return false;
      throw error;
    }
  }

  async getLatestAnalyticsForecast({
    merchantId,
    productId,
    forecastDate,
  }) {
    let result;
    try {
      result = await this.#query(
        `
          SELECT *
          FROM analytics_forecasts
          WHERE merchant_id = $1
            AND product_id = $2
            AND forecast_date = $3::date
          ORDER BY generated_at DESC, forecast_version DESC
          LIMIT 1
        `,
        [merchantId, productId, forecastDate],
      );
    } catch (error) {
      if (isMissingOptionalAnalyticsTable(error)) return null;
      throw error;
    }
    const row = result.rows[0];
    if (!row) return null;
    return {
      merchantId: row.merchant_id,
      productId: row.product_id,
      forecastDate: String(row.forecast_date).slice(0, 10),
      horizonDay: Number(row.horizon_day),
      p10: String(row.p10),
      p50: String(row.p50),
      p90: String(row.p90),
      eligibilityStatus: row.eligibility_status,
      visibilityStatus: row.visibility_status,
      accuracyGatePassed: row.accuracy_gate_passed,
      selectedModel: row.selected_model,
      modelVersion: row.model_version,
      forecastVersion: row.forecast_version,
      generatedAt: new Date(row.generated_at).toISOString(),
      sourceWatermark: String(row.source_watermark).slice(0, 10),
      sourceRowCount: Number(row.source_row_count),
      usableDayCount: Number(row.usable_day_count),
      diagnostics: row.diagnostics_json,
    };
  }

  async getMerchantCalendarDate(merchantId, occurredAt) {
    const result = await this.#query(
      `
        SELECT ($2::timestamptz AT TIME ZONE timezone)::date::text
          AS calendar_date
        FROM merchants
        WHERE merchant_id = $1
      `,
      [merchantId, occurredAt],
    );
    return result.rows[0]?.calendar_date
      ?? new Date(occurredAt).toISOString().slice(0, 10);
  }

  async getMerchantDateTime(merchantId, date) {
    const result = await this.#query(
      `
        SELECT (($2::date + TIME '12:00') AT TIME ZONE timezone)
          AS occurred_at
        FROM merchants
        WHERE merchant_id = $1
      `,
      [merchantId, date],
    );
    const occurredAt = result.rows[0]?.occurred_at;
    if (!occurredAt) {
      throw new Error(`Unknown merchant: ${merchantId}`);
    }
    return new Date(occurredAt).toISOString();
  }

  async getProductProfile(productId, { asOfDate, merchantId } = {}) {
    const cutoff = asOfDate ?? "9999-12-31";
    const result = await this.#query(
      `
        WITH latest AS (
          SELECT DISTINCT ON (component_id)
            merchant_id,
            product_id,
            component_id,
            component_name,
            baseline_cost_per_pack_rm,
            current_cost_per_pack_rm,
            usage_per_product_unit,
            evidence_projection
          FROM recipe_components AS components
          JOIN merchants USING (merchant_id)
          WHERE product_id = $1
            AND ($3::text IS NULL OR components.merchant_id = $3)
            AND (
              components.effective_at AT TIME ZONE merchants.timezone
            )::date <= $2::date
          ORDER BY
            component_id,
            components.effective_at DESC,
            snapshot_sequence DESC
        )
        SELECT
          latest.*,
          merchants.target_gross_margin_pct
        FROM latest
        JOIN merchants USING (merchant_id)
        ORDER BY component_id
      `,
      [productId, cutoff, merchantId ?? null],
    );
    return profileFromComponentRows(productId, result.rows);
  }

  async getProductCostComparison(
    productId,
    { currentDate, comparisonDate, merchantId } = {},
  ) {
    const result = await this.#query(
      `
        WITH boundaries(boundary, cutoff_date) AS (
          VALUES
            ('baseline', $2::date),
            ('current', $3::date)
        ),
        resolved AS (
          SELECT DISTINCT ON (
            boundaries.boundary,
            components.component_id
          )
            boundaries.boundary,
            components.merchant_id,
            components.component_id,
            components.component_name,
            components.baseline_cost_per_pack_rm,
            components.current_cost_per_pack_rm,
            components.usage_per_product_unit,
            components.evidence_projection,
            merchants.target_gross_margin_pct
          FROM boundaries
          CROSS JOIN recipe_components AS components
          JOIN merchants USING (merchant_id)
          WHERE components.product_id = $1
            AND ($4::text IS NULL OR components.merchant_id = $4)
            AND (
              components.effective_at AT TIME ZONE merchants.timezone
            )::date <= boundaries.cutoff_date
          ORDER BY
            boundaries.boundary,
            components.component_id,
            components.effective_at DESC,
            components.snapshot_sequence DESC,
            components.snapshot_id DESC
        )
        SELECT *
        FROM resolved
        ORDER BY boundary, component_id
      `,
      [
        productId,
        comparisonDate,
        currentDate,
        merchantId ?? null,
      ],
    );
    const rows = {
      baseline: result.rows.filter((row) => row.boundary === "baseline"),
      current: result.rows.filter((row) => row.boundary === "current"),
    };
    return {
      baseline: profileFromComponentRows(productId, rows.baseline),
      current: profileFromComponentRows(productId, rows.current),
    };
  }

  async findProductProfilesByComponent(
    merchantId,
    componentId,
    { asOfDate } = {},
  ) {
    const products = await this.#query(
      `
        SELECT DISTINCT product_id
        FROM recipe_components
        WHERE merchant_id = $1 AND component_id = $2
      `,
      [merchantId, componentId],
    );
    const profiles = await Promise.all(
      products.rows.map(({ product_id: productId }) =>
        this.getProductProfile(productId, { asOfDate, merchantId })),
    );
    return profiles.filter(Boolean);
  }

  async listComponents(merchantId, { asOfDate } = {}) {
    const cutoff = asOfDate ?? "9999-12-31";
    const result = await this.#query(
      `
        SELECT DISTINCT ON (components.component_id)
          components.component_id,
          components.component_name
        FROM recipe_components AS components
        JOIN merchants USING (merchant_id)
        WHERE components.merchant_id = $1
          AND (
            components.effective_at AT TIME ZONE merchants.timezone
          )::date <= $2::date
        ORDER BY
          components.component_id,
          components.effective_at DESC,
          components.snapshot_sequence DESC
      `,
      [merchantId, cutoff],
    );
    return result.rows
      .map((row) => ({
        componentId: row.component_id,
        name: row.component_name,
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async saveProductProfile(
    profile,
    { effectiveAt, changedComponentIds = [] } = {},
  ) {
    for (const componentId of changedComponentIds) {
      const component = profile.components.find(
        (candidate) => candidate.componentId === componentId,
      );
      if (!component) continue;
      await this.#query(
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
        `,
        [
          profile.merchantId,
          profile.productId,
          component.componentId,
          component.name,
          component.baselineCostRm,
          component.currentCostRm,
          component.usagePerProductUnit ?? "1",
          component.evidence
            ? JSON.stringify(component.evidence)
            : null,
          component.uom ?? "unit",
          effectiveAt ?? new Date().toISOString(),
          randomUUID(),
        ],
      );
    }
  }

  async savePurchaseReceipt({
    receiptId,
    sourceEventId,
    merchantId,
    extraction,
  }) {
    return this.#transaction(async () => {
      const existing = await this.#query(
        `
          SELECT source_event_id, merchant_id
          FROM purchase_receipts
          WHERE receipt_id = $1
          FOR UPDATE
        `,
        [receiptId],
      );
      if (
        existing.rows[0]
        && (
          existing.rows[0].source_event_id !== sourceEventId
          || existing.rows[0].merchant_id !== merchantId
        )
      ) {
        throw new Error(`Receipt ID already exists: ${receiptId}`);
      }
      if (!existing.rows[0]) {
        await this.#query(
          `
            INSERT INTO purchase_receipts (
              receipt_id,
              source_event_id,
              merchant_id,
              supplier_name,
              receipt_date,
              currency,
              total_rm,
              overall_confidence,
              review_state
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'accepted')
          `,
          [
            receiptId,
            sourceEventId,
            merchantId,
            extraction.supplier_name,
            extraction.date,
            extraction.currency,
            extraction.total_rm,
            extraction.overall_confidence,
          ],
        );
      }
      for (const [index, line] of extraction.line_items.entries()) {
        await this.#query(
          `
            INSERT INTO purchase_lines (
              purchase_line_id,
              receipt_id,
              component_id,
              raw_name,
              quantity,
              uom,
              pack_size,
              unit_price_rm,
              total_price_rm,
              confidence
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            ON CONFLICT (purchase_line_id) DO NOTHING
          `,
          [
            `${receiptId}:${index}`,
            receiptId,
            line.normalized_component_id,
            line.raw_name,
            line.quantity,
            line.uom,
            line.pack_size,
            line.unit_price_rm,
            line.total_price_rm,
            line.confidence,
          ],
        );
      }
      return true;
    });
  }

  async saveClarification(task) {
    await this.#query(
      `
        INSERT INTO clarification_tasks (
          clarification_task_id,
          storage_key,
          kind,
          merchant_id,
          evidence_kind,
          raw_source_id,
          occurred_at,
          component_id,
          increase_rm,
          request,
          evidence,
          response,
          resolution
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9,
          $10::jsonb, $11::jsonb, $12::jsonb, $13::jsonb
        )
      `,
      [
        task.taskId,
        task.storageKey ?? task.sourceEventId,
        task.kind,
        task.merchantId,
        task.evidenceKind,
        task.sourceEventId,
        task.occurredAt,
        task.componentId ?? null,
        task.increaseRm ?? null,
        task.request ? JSON.stringify(task.request) : null,
        JSON.stringify(task.evidence ?? {}),
        JSON.stringify(task.response),
        task.resolution ? JSON.stringify(task.resolution) : null,
      ],
    );
  }

  async getClarificationBySourceEventId(storageKey) {
    const result = await this.#query(
      "SELECT * FROM clarification_tasks WHERE storage_key = $1",
      [storageKey],
    );
    return taskFromRow(result.rows[0]);
  }

  async findClarificationsByRawSourceId(sourceEventId) {
    const result = await this.#query(
      `
        SELECT *
        FROM clarification_tasks
        WHERE raw_source_id = $1
        ORDER BY created_at, clarification_task_id
      `,
      [sourceEventId],
    );
    return result.rows.map(taskFromRow);
  }

  async resolveClarification(storageKey, resolution) {
    await this.#query(
      `
        UPDATE clarification_tasks
        SET resolution = $2::jsonb,
            state = 'resolved',
            resolved_at = CURRENT_TIMESTAMP
        WHERE storage_key = $1 AND resolution IS NULL
      `,
      [storageKey, JSON.stringify(resolution)],
    );
    return this.getClarificationBySourceEventId(storageKey);
  }

  async runClarificationResolution(storageKey, execute) {
    return this.#transaction(async () => {
      const result = await this.#query(
        `
          SELECT *
          FROM clarification_tasks
          WHERE storage_key = $1
          FOR UPDATE
        `,
        [storageKey],
      );
      const task = taskFromRow(result.rows[0]);
      if (!task) return null;
      if (task.resolution) return clone(task.resolution);

      const resolution = await execute(task);
      await this.#query(
        `
          UPDATE clarification_tasks
          SET resolution = $2::jsonb,
              resolution_fingerprint = $3,
              state = 'resolved',
              resolved_at = CURRENT_TIMESTAMP
          WHERE storage_key = $1
        `,
        [
          storageKey,
          JSON.stringify(resolution),
          resolution.fingerprint ?? null,
        ],
      );
      return clone(resolution);
    });
  }

  async healthCheck() {
    await this.#query("SELECT 1");
    return { status: "ok" };
  }
}
