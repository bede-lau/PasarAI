BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
    migration_id TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS merchants (
    merchant_id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    location TEXT,
    timezone TEXT NOT NULL,
    currency TEXT NOT NULL CHECK (currency = 'MYR'),
    primary_language TEXT NOT NULL,
    supported_languages JSONB NOT NULL DEFAULT '[]'::jsonb,
    target_gross_margin_pct NUMERIC(7, 4) NOT NULL CHECK (
        target_gross_margin_pct >= 0 AND target_gross_margin_pct < 100
    ),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS products (
    product_id TEXT PRIMARY KEY,
    merchant_id TEXT NOT NULL REFERENCES merchants(merchant_id),
    name TEXT NOT NULL,
    selling_price_rm NUMERIC(18, 2) NOT NULL CHECK (selling_price_rm >= 0),
    active BOOLEAN NOT NULL DEFAULT TRUE,
    UNIQUE (merchant_id, name)
);

CREATE TABLE IF NOT EXISTS recipe_components (
    merchant_id TEXT NOT NULL REFERENCES merchants(merchant_id),
    product_id TEXT NOT NULL REFERENCES products(product_id),
    component_id TEXT NOT NULL,
    component_name TEXT NOT NULL,
    baseline_cost_per_pack_rm NUMERIC(18, 4) NOT NULL CHECK (
        baseline_cost_per_pack_rm >= 0
    ),
    current_cost_per_pack_rm NUMERIC(18, 4) NOT NULL CHECK (
        current_cost_per_pack_rm >= 0
    ),
    usage_per_product_unit NUMERIC(18, 4) NOT NULL DEFAULT 1 CHECK (
        usage_per_product_unit > 0
    ),
    evidence_projection JSONB,
    uom TEXT NOT NULL,
    effective_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    snapshot_id TEXT NOT NULL,
    snapshot_sequence BIGINT GENERATED ALWAYS AS IDENTITY,
    PRIMARY KEY (
        merchant_id,
        product_id,
        component_id,
        effective_at,
        snapshot_id
    )
);

CREATE TABLE IF NOT EXISTS raw_events (
    event_id TEXT PRIMARY KEY,
    merchant_id TEXT NOT NULL REFERENCES merchants(merchant_id),
    endpoint_id TEXT NOT NULL DEFAULT 'lakebase.raw',
    idempotency_key TEXT NOT NULL,
    external_id TEXT,
    event_type TEXT NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL,
    source TEXT NOT NULL,
    source_language TEXT,
    payload JSONB NOT NULL,
    evidence JSONB NOT NULL,
    response JSONB NOT NULL DEFAULT '{}'::jsonb,
    target_event_id TEXT,
    ingested_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (merchant_id, endpoint_id, idempotency_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS raw_events_merchant_external_idx
    ON raw_events (merchant_id, external_id)
    WHERE external_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS api_idempotency (
    merchant_id TEXT NOT NULL REFERENCES merchants(merchant_id),
    endpoint_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL,
    response JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMPTZ,
    PRIMARY KEY (merchant_id, endpoint_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS evidence_assets (
    evidence_asset_id TEXT PRIMARY KEY,
    merchant_id TEXT NOT NULL REFERENCES merchants(merchant_id),
    source_event_id TEXT NOT NULL REFERENCES raw_events(event_id),
    asset_uri TEXT NOT NULL,
    media_type TEXT,
    sha256 TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (merchant_id, source_event_id, asset_uri)
);

CREATE TABLE IF NOT EXISTS sales_lines (
    sales_line_id TEXT PRIMARY KEY,
    source_event_id TEXT NOT NULL REFERENCES raw_events(event_id),
    merchant_id TEXT NOT NULL REFERENCES merchants(merchant_id),
    product_id TEXT NOT NULL REFERENCES products(product_id),
    quantity NUMERIC(18, 4) NOT NULL CHECK (quantity > 0),
    unit_price_rm NUMERIC(18, 2) NOT NULL CHECK (unit_price_rm >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (source_event_id, product_id)
);

CREATE TABLE IF NOT EXISTS purchase_receipts (
    receipt_id TEXT PRIMARY KEY,
    source_event_id TEXT NOT NULL REFERENCES raw_events(event_id),
    merchant_id TEXT NOT NULL REFERENCES merchants(merchant_id),
    supplier_name TEXT,
    receipt_date DATE,
    currency TEXT NOT NULL CHECK (currency = 'MYR'),
    total_rm NUMERIC(18, 2) CHECK (total_rm >= 0),
    overall_confidence NUMERIC(5, 4) CHECK (
        overall_confidence >= 0 AND overall_confidence <= 1
    ),
    review_state TEXT NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS purchase_lines (
    purchase_line_id TEXT PRIMARY KEY,
    receipt_id TEXT NOT NULL REFERENCES purchase_receipts(receipt_id),
    component_id TEXT,
    raw_name TEXT NOT NULL,
    quantity NUMERIC(18, 4) CHECK (quantity > 0),
    uom TEXT,
    pack_size NUMERIC(18, 4) CHECK (pack_size > 0),
    unit_price_rm NUMERIC(18, 2) CHECK (unit_price_rm >= 0),
    total_price_rm NUMERIC(18, 2) CHECK (total_price_rm >= 0),
    confidence NUMERIC(5, 4) CHECK (confidence >= 0 AND confidence <= 1)
);

CREATE TABLE IF NOT EXISTS clarification_tasks (
    clarification_task_id TEXT PRIMARY KEY,
    storage_key TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL,
    merchant_id TEXT NOT NULL REFERENCES merchants(merchant_id),
    evidence_kind TEXT NOT NULL,
    raw_source_id TEXT NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL,
    component_id TEXT,
    increase_rm NUMERIC(18, 2),
    request JSONB,
    evidence JSONB NOT NULL,
    response JSONB NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending',
    resolution JSONB,
    resolution_fingerprint TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    resolved_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS corrections (
    correction_event_id TEXT PRIMARY KEY REFERENCES raw_events(event_id),
    merchant_id TEXT NOT NULL REFERENCES merchants(merchant_id),
    target_event_id TEXT NOT NULL REFERENCES raw_events(event_id),
    reason TEXT NOT NULL,
    replacement_payload JSONB NOT NULL,
    evidence JSONB NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS raw_events_merchant_occurred_idx
    ON raw_events (merchant_id, occurred_at);
CREATE INDEX IF NOT EXISTS sales_lines_merchant_product_idx
    ON sales_lines (merchant_id, product_id);
CREATE INDEX IF NOT EXISTS corrections_target_idx
    ON corrections (target_event_id, occurred_at);

CREATE OR REPLACE FUNCTION pasarai_reject_append_only_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION '% is append-only; append a correction instead', TG_TABLE_NAME;
END;
$$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'raw_events_append_only'
    ) THEN
        CREATE TRIGGER raw_events_append_only
        BEFORE UPDATE OR DELETE ON raw_events
        FOR EACH ROW EXECUTE FUNCTION pasarai_reject_append_only_mutation();
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'evidence_assets_append_only'
    ) THEN
        CREATE TRIGGER evidence_assets_append_only
        BEFORE UPDATE OR DELETE ON evidence_assets
        FOR EACH ROW EXECUTE FUNCTION pasarai_reject_append_only_mutation();
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'corrections_append_only'
    ) THEN
        CREATE TRIGGER corrections_append_only
        BEFORE UPDATE OR DELETE ON corrections
        FOR EACH ROW EXECUTE FUNCTION pasarai_reject_append_only_mutation();
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION pasarai_append_raw_event(
    p_merchant_id TEXT,
    p_endpoint_id TEXT,
    p_idempotency_key TEXT,
    p_event_type TEXT,
    p_occurred_at TIMESTAMPTZ,
    p_source TEXT,
    p_source_language TEXT,
    p_payload JSONB,
    p_evidence JSONB
)
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
    v_event_id TEXT;
    v_event_type TEXT;
    v_occurred_at TIMESTAMPTZ;
    v_source TEXT;
    v_source_language TEXT;
    v_payload JSONB;
    v_evidence JSONB;
BEGIN
    v_event_id := 'evt_' || SUBSTRING(
        MD5(p_merchant_id || ':' || p_endpoint_id || ':' || p_idempotency_key)
        FROM 1 FOR 24
    );

    INSERT INTO raw_events (
        event_id,
        merchant_id,
        endpoint_id,
        idempotency_key,
        event_type,
        occurred_at,
        source,
        source_language,
        payload,
        evidence
    )
    VALUES (
        v_event_id,
        p_merchant_id,
        p_endpoint_id,
        p_idempotency_key,
        p_event_type,
        p_occurred_at,
        p_source,
        p_source_language,
        p_payload,
        p_evidence
    )
    ON CONFLICT (merchant_id, endpoint_id, idempotency_key) DO NOTHING;

    SELECT
        event_id,
        event_type,
        occurred_at,
        source,
        source_language,
        payload,
        evidence
    INTO
        v_event_id,
        v_event_type,
        v_occurred_at,
        v_source,
        v_source_language,
        v_payload,
        v_evidence
    FROM raw_events
    WHERE merchant_id = p_merchant_id
      AND endpoint_id = p_endpoint_id
      AND idempotency_key = p_idempotency_key;

    IF v_event_type IS DISTINCT FROM p_event_type
       OR v_occurred_at IS DISTINCT FROM p_occurred_at
       OR v_source IS DISTINCT FROM p_source
       OR v_source_language IS DISTINCT FROM p_source_language
       OR v_payload IS DISTINCT FROM p_payload
       OR v_evidence IS DISTINCT FROM p_evidence
    THEN
        RAISE EXCEPTION
            'Idempotency key % was already used with a different payload',
            p_idempotency_key;
    END IF;

    RETURN v_event_id;
END;
$$;

CREATE OR REPLACE FUNCTION pasarai_append_correction(
    p_merchant_id TEXT,
    p_idempotency_key TEXT,
    p_target_event_id TEXT,
    p_occurred_at TIMESTAMPTZ,
    p_reason TEXT,
    p_replacement_payload JSONB,
    p_evidence JSONB
)
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
    v_event_id TEXT;
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM raw_events
        WHERE event_id = p_target_event_id
          AND merchant_id = p_merchant_id
    ) THEN
        RAISE EXCEPTION 'Unknown correction target %', p_target_event_id;
    END IF;

    v_event_id := pasarai_append_raw_event(
        p_merchant_id,
        'corrections.create',
        p_idempotency_key,
        'correction',
        p_occurred_at,
        'api',
        NULL,
        jsonb_build_object(
            'target_event_id', p_target_event_id,
            'reason', p_reason,
            'replacement_payload', p_replacement_payload
        ),
        p_evidence
    );

    INSERT INTO corrections (
        correction_event_id,
        merchant_id,
        target_event_id,
        reason,
        replacement_payload,
        evidence,
        occurred_at
    )
    VALUES (
        v_event_id,
        p_merchant_id,
        p_target_event_id,
        p_reason,
        p_replacement_payload,
        p_evidence,
        p_occurred_at
    )
    ON CONFLICT (correction_event_id) DO NOTHING;

    RETURN v_event_id;
END;
$$;

INSERT INTO schema_migrations (migration_id)
VALUES ('001_initial')
ON CONFLICT (migration_id) DO NOTHING;

COMMIT;
