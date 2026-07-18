BEGIN;

CREATE TABLE IF NOT EXISTS google_sheet_connections (
    merchant_id TEXT PRIMARY KEY REFERENCES merchants(merchant_id),
    spreadsheet_id TEXT NOT NULL,
    spreadsheet_url TEXT NOT NULL,
    spreadsheet_title TEXT NOT NULL,
    encrypted_access_token TEXT,
    encrypted_refresh_token TEXT,
    access_token_expires_at TIMESTAMPTZ,
    granted_scopes TEXT[] NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'error', 'disconnected')),
    sync_mode TEXT NOT NULL DEFAULT 'manual'
        CHECK (sync_mode IN ('manual', 'automatic')),
    last_export_at TIMESTAMPTZ,
    last_import_at TIMESTAMPTZ,
    last_reconciled_at TIMESTAMPTZ,
    last_error TEXT,
    watch_channel_id TEXT,
    watch_resource_id TEXT,
    watch_token TEXT,
    watch_expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS google_sheet_oauth_states (
    state_hash TEXT PRIMARY KEY,
    merchant_id TEXT NOT NULL REFERENCES merchants(merchant_id),
    redirect_uri TEXT NOT NULL,
    spreadsheet_id TEXT,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS google_sheet_oauth_states_expiry_idx
    ON google_sheet_oauth_states (expires_at);

CREATE TABLE IF NOT EXISTS google_sheet_sync_jobs (
    job_id TEXT PRIMARY KEY,
    merchant_id TEXT NOT NULL REFERENCES merchants(merchant_id),
    operation TEXT NOT NULL
        CHECK (operation IN ('export', 'import', 'reconcile')),
    status TEXT NOT NULL
        CHECK (status IN ('queued', 'running', 'completed', 'failed')),
    rows_processed INTEGER NOT NULL DEFAULT 0,
    error_count INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    started_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS google_sheet_sync_jobs_merchant_started_idx
    ON google_sheet_sync_jobs (merchant_id, started_at DESC);

CREATE TABLE IF NOT EXISTS google_sheet_row_state (
    merchant_id TEXT NOT NULL REFERENCES merchants(merchant_id),
    sheet_name TEXT NOT NULL,
    record_id TEXT NOT NULL,
    row_number INTEGER,
    record_version INTEGER NOT NULL DEFAULT 1,
    checksum TEXT NOT NULL,
    last_synced_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (merchant_id, sheet_name, record_id)
);

INSERT INTO schema_migrations (migration_id)
VALUES ('004_google_sheets_integration')
ON CONFLICT (migration_id) DO NOTHING;

COMMIT;
