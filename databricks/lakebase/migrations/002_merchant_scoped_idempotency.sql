BEGIN;

ALTER TABLE api_idempotency
ADD COLUMN IF NOT EXISTS merchant_id TEXT REFERENCES merchants(merchant_id);

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM api_idempotency
        WHERE merchant_id IS NULL
    ) THEN
        RAISE EXCEPTION
            'api_idempotency contains legacy rows without merchant_id; assign their merchant before rerunning migration 002';
    END IF;
END;
$$;

ALTER TABLE api_idempotency
ALTER COLUMN merchant_id SET NOT NULL;

DO $$
DECLARE
    primary_key_name TEXT;
    primary_key_definition TEXT;
BEGIN
    SELECT
        conname,
        pg_get_constraintdef(oid)
    INTO
        primary_key_name,
        primary_key_definition
    FROM pg_constraint
    WHERE conrelid = 'api_idempotency'::regclass
      AND contype = 'p';

    IF primary_key_definition IS DISTINCT FROM
       'PRIMARY KEY (merchant_id, endpoint_id, idempotency_key)'
    THEN
        IF primary_key_name IS NOT NULL THEN
            EXECUTE format(
                'ALTER TABLE api_idempotency DROP CONSTRAINT %I',
                primary_key_name
            );
        END IF;
        ALTER TABLE api_idempotency
        ADD PRIMARY KEY (merchant_id, endpoint_id, idempotency_key);
    END IF;
END;
$$;

INSERT INTO schema_migrations (migration_id)
VALUES ('002_merchant_scoped_idempotency')
ON CONFLICT (migration_id) DO NOTHING;

COMMIT;
