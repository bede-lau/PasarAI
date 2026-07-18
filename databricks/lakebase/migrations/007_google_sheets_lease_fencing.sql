BEGIN;

ALTER TABLE google_sheet_notification_queue
    ADD COLUMN IF NOT EXISTS claim_token TEXT;

UPDATE google_sheet_notification_queue
SET status = 'failed',
    last_error = COALESCE(
        last_error,
        'Lease reset by migration 007 because claim token was missing'
    ),
    available_at = CURRENT_TIMESTAMP,
    claimed_at = NULL,
    claimed_by = NULL,
    claim_token = NULL,
    lease_expires_at = NULL,
    updated_at = CURRENT_TIMESTAMP
WHERE status = 'processing'
  AND claim_token IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS google_sheet_notification_queue_claim_token_idx
    ON google_sheet_notification_queue (claim_token)
    WHERE claim_token IS NOT NULL;

ALTER TABLE google_sheet_operation_idempotency
    ADD COLUMN IF NOT EXISTS claim_token TEXT;

UPDATE google_sheet_operation_idempotency
SET status = 'failed',
    last_error = COALESCE(
        last_error,
        'Lease reset by migration 007 because claim token was missing'
    ),
    lease_expires_at = NULL,
    failed_at = CURRENT_TIMESTAMP,
    updated_at = CURRENT_TIMESTAMP
WHERE status = 'processing'
  AND claim_token IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS google_sheet_operation_claim_token_idx
    ON google_sheet_operation_idempotency (claim_token)
    WHERE claim_token IS NOT NULL;

CREATE TABLE IF NOT EXISTS google_sheet_sync_leases (
    merchant_id TEXT PRIMARY KEY REFERENCES merchants(merchant_id),
    operation TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    claim_token TEXT NOT NULL UNIQUE,
    claimed_at TIMESTAMPTZ NOT NULL,
    lease_expires_at TIMESTAMPTZ NOT NULL,
    released_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS google_sheet_sync_leases_expiry_idx
    ON google_sheet_sync_leases (lease_expires_at)
    WHERE released_at IS NULL;

INSERT INTO schema_migrations (migration_id)
VALUES ('007_google_sheets_lease_fencing')
ON CONFLICT (migration_id) DO NOTHING;

COMMIT;
