BEGIN;

ALTER TABLE google_sheet_connections
    ADD COLUMN IF NOT EXISTS watch_last_message_number TEXT;

INSERT INTO schema_migrations (migration_id)
VALUES ('005_google_sheets_notifications')
ON CONFLICT (migration_id) DO NOTHING;

COMMIT;
