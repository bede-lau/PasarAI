BEGIN;

CREATE TABLE IF NOT EXISTS google_sheet_notification_queue (
    notification_id BIGSERIAL PRIMARY KEY,
    merchant_id TEXT NOT NULL REFERENCES merchants(merchant_id),
    channel_id TEXT NOT NULL,
    message_number TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    resource_state TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'processing', 'completed', 'failed')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    last_error TEXT,
    available_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    claimed_at TIMESTAMPTZ,
    claimed_by TEXT,
    lease_expires_at TIMESTAMPTZ,
    processed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (channel_id, message_number)
);

CREATE INDEX IF NOT EXISTS google_sheet_notification_queue_due_idx
    ON google_sheet_notification_queue (available_at, notification_id)
    WHERE processed_at IS NULL;

CREATE INDEX IF NOT EXISTS google_sheet_notification_queue_lease_idx
    ON google_sheet_notification_queue (lease_expires_at)
    WHERE status = 'processing';

CREATE TABLE IF NOT EXISTS google_sheet_operation_idempotency (
    merchant_id TEXT NOT NULL REFERENCES merchants(merchant_id),
    operation TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'processing'
        CHECK (status IN ('processing', 'completed', 'failed')),
    attempts INTEGER NOT NULL DEFAULT 1 CHECK (attempts > 0),
    response JSONB,
    last_error TEXT,
    claimed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    lease_expires_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    failed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (merchant_id, operation, idempotency_key)
);

CREATE INDEX IF NOT EXISTS google_sheet_operation_idempotency_lease_idx
    ON google_sheet_operation_idempotency (lease_expires_at)
    WHERE status = 'processing';

INSERT INTO schema_migrations (migration_id)
VALUES ('006_google_sheets_notification_queue')
ON CONFLICT (migration_id) DO NOTHING;

COMMIT;
