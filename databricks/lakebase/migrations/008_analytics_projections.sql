BEGIN;

CREATE TABLE IF NOT EXISTS analytics_daily_product_metrics (
    merchant_id TEXT NOT NULL REFERENCES merchants(merchant_id),
    product_id TEXT NOT NULL REFERENCES products(product_id),
    date DATE NOT NULL,
    data_state TEXT NOT NULL CHECK (
        data_state IN ('complete', 'partial', 'closed_no_sales', 'missing')
    ),
    sold_out_state TEXT NOT NULL CHECK (
        sold_out_state IN ('yes', 'no', 'unknown')
    ),
    quantity NUMERIC(18, 4),
    revenue_rm NUMERIC(18, 2),
    cogs_rm NUMERIC(18, 2),
    gross_profit_rm NUMERIC(18, 2),
    gross_margin_pct NUMERIC(9, 4),
    source_watermark TIMESTAMPTZ,
    projection_version TEXT NOT NULL,
    generated_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (merchant_id, product_id, date)
);

CREATE INDEX IF NOT EXISTS analytics_daily_metrics_lookup_idx
    ON analytics_daily_product_metrics (
        merchant_id,
        product_id,
        date DESC
    );

CREATE TABLE IF NOT EXISTS analytics_daily_component_costs (
    merchant_id TEXT NOT NULL REFERENCES merchants(merchant_id),
    product_id TEXT NOT NULL REFERENCES products(product_id),
    date DATE NOT NULL,
    component_id TEXT NOT NULL,
    component_name TEXT NOT NULL,
    baseline_cost_rm_per_pack NUMERIC(18, 2) NOT NULL,
    current_cost_rm_per_pack NUMERIC(18, 2) NOT NULL,
    change_rm_per_pack NUMERIC(18, 2) NOT NULL,
    evidence_id TEXT,
    projection_version TEXT NOT NULL,
    generated_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (merchant_id, product_id, date, component_id)
);

CREATE TABLE IF NOT EXISTS analytics_refresh_state (
    merchant_id TEXT NOT NULL REFERENCES merchants(merchant_id),
    product_id TEXT NOT NULL REFERENCES products(product_id),
    data_through DATE,
    source_watermark TIMESTAMPTZ,
    projection_version TEXT NOT NULL,
    generated_at TIMESTAMPTZ NOT NULL,
    last_error TEXT,
    PRIMARY KEY (merchant_id, product_id)
);

CREATE TABLE IF NOT EXISTS analytics_forecasts (
    merchant_id TEXT NOT NULL REFERENCES merchants(merchant_id),
    product_id TEXT NOT NULL REFERENCES products(product_id),
    forecast_date DATE NOT NULL,
    horizon_day INTEGER NOT NULL CHECK (horizon_day >= 1),
    p10 NUMERIC(18, 4) NOT NULL CHECK (p10 >= 0),
    p50 NUMERIC(18, 4) NOT NULL CHECK (p50 >= 0),
    p90 NUMERIC(18, 4) NOT NULL CHECK (p90 >= 0),
    eligibility_status TEXT NOT NULL,
    visibility_status TEXT NOT NULL CHECK (
        visibility_status IN ('unavailable', 'shadow', 'display')
    ),
    accuracy_gate_passed BOOLEAN NOT NULL,
    selected_model TEXT NOT NULL,
    model_version TEXT NOT NULL,
    forecast_version TEXT NOT NULL,
    generated_at TIMESTAMPTZ NOT NULL,
    source_watermark DATE NOT NULL,
    source_row_count INTEGER NOT NULL CHECK (source_row_count >= 0),
    usable_day_count INTEGER NOT NULL CHECK (usable_day_count >= 0),
    diagnostics_json JSONB NOT NULL,
    PRIMARY KEY (
        merchant_id,
        product_id,
        forecast_date,
        forecast_version
    ),
    CHECK (p10 <= p50 AND p50 <= p90)
);

CREATE INDEX IF NOT EXISTS analytics_forecast_latest_idx
    ON analytics_forecasts (
        merchant_id,
        product_id,
        forecast_date,
        generated_at DESC
    );

CREATE TABLE IF NOT EXISTS analytics_job_runs (
    job_run_id TEXT PRIMARY KEY,
    job_name TEXT NOT NULL,
    state TEXT NOT NULL CHECK (
        state IN ('running', 'completed', 'failed')
    ),
    source_watermark TEXT,
    started_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ,
    detail JSONB NOT NULL DEFAULT '{}'::jsonb
);

INSERT INTO schema_migrations (migration_id)
VALUES ('008_analytics_projections')
ON CONFLICT (migration_id) DO NOTHING;

COMMIT;
