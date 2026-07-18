BEGIN;

ALTER TABLE raw_events
ADD COLUMN IF NOT EXISTS endpoint_id TEXT NOT NULL DEFAULT 'lakebase.raw';

ALTER TABLE raw_events
ALTER COLUMN endpoint_id SET DEFAULT 'lakebase.raw';

DO $$
DECLARE
    constraint_name TEXT;
BEGIN
    FOR constraint_name IN
        SELECT conname
        FROM pg_constraint
        WHERE conrelid = 'raw_events'::regclass
          AND contype = 'u'
          AND pg_get_constraintdef(oid) =
              'UNIQUE (merchant_id, idempotency_key)'
    LOOP
        EXECUTE format(
            'ALTER TABLE raw_events DROP CONSTRAINT %I',
            constraint_name
        );
    END LOOP;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'raw_events'::regclass
          AND contype = 'u'
          AND pg_get_constraintdef(oid) =
              'UNIQUE (merchant_id, endpoint_id, idempotency_key)'
    ) THEN
        ALTER TABLE raw_events
        ADD CONSTRAINT raw_events_merchant_endpoint_idempotency_key
        UNIQUE (merchant_id, endpoint_id, idempotency_key);
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

DROP FUNCTION IF EXISTS pasarai_append_raw_event(
    TEXT,
    TEXT,
    TEXT,
    TIMESTAMPTZ,
    TEXT,
    TEXT,
    JSONB,
    JSONB
);

INSERT INTO schema_migrations (migration_id)
VALUES ('003_endpoint_scoped_raw_events')
ON CONFLICT (migration_id) DO NOTHING;

COMMIT;
