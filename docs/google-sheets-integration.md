# Google Sheets integration

## Architecture

Lakebase remains the financial system of record. Google Sheets is a familiar
reporting and controlled-input surface:

```text
PasarAI ledger -> Google Sheets Dashboard and Metrics
Google Sheets Inputs -> canonical sale, cost, and correction services
Google Drive notification -> durable Lakebase queue -> reconciliation worker
Periodic worker -> watch renewal and automatic reconciliation
```

OAuth tokens are encrypted before storage. Sync jobs and per-row versions are
stored in Lakebase. Public mutations require `Idempotency-Key`, and their
request fingerprints and completed responses are persisted for safe replay.
Imports remain idempotent, notifications survive process restarts, and sale
edits use atomic optimistic concurrency instead of overwriting ledger history.

## Google Cloud setup

1. Enable the Google Sheets API and Google Drive API in the selected Google
   Cloud project.
2. Configure the OAuth consent screen and create a Web application OAuth
   client.
3. Add the deployed web callback:

   ```text
   https://<web-host>/api/pasarai/integrations/google-sheets/callback
   ```

4. Expose the API webhook on public HTTPS:

   ```text
   https://<api-host>/webhooks/google-drive
   ```

5. Configure the API environment:

   ```text
   GOOGLE_CLIENT_ID=
   GOOGLE_CLIENT_SECRET=
   GOOGLE_API_TIMEOUT_MS=
   GOOGLE_TOKEN_ENCRYPTION_KEY=
   GOOGLE_SHEETS_WEBHOOK_URL=
   GOOGLE_SHEETS_SYNC_INTERVAL_MS=
   GOOGLE_SHEETS_SYNC_LEASE_MS=
   GOOGLE_SHEETS_WORKER_STAGE_TIMEOUT_MS=
   ```

   A suitable encryption key can be generated locally with:

   ```text
   node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
   ```

6. Apply Lakebase migrations:

   ```text
   pnpm --filter @pasarai/api db:migrate
   ```

   This includes migrations `004` through `007` for connections, row state,
   sync jobs, Drive message tracking, the durable notification queue, and
   claim-token-fenced operation and merchant synchronization leases.

The web server continues to use `PASARAI_API_BASE_URL` and the merchant-bound
`PASARAI_API_BEARER_TOKEN`; Google credentials are API-only secrets.

## Workbook contract

PasarAI creates or repairs these tabs:

- `Dashboard`: managed formulas and current headline metrics.
- `Metrics`: deterministic daily financial summaries.
- `Inputs`: controlled sale and cost intake.
- `Sync Errors`: row number, record type, error, and update time.
- `Configuration`: accepted actions, fields, payment methods, and statuses.

The `Inputs` columns are:

```text
Action | Record Type | Occurred At | Product ID | Component ID |
Quantity | Unit Price (RM) | Supplier | UOM | Pack Size |
Total Price (RM) | Payment Method | Note | Status | Record ID |
Record Version | Error | Row Checksum
```

Columns `Status` through `Row Checksum` are managed by PasarAI.

PasarAI writes user and technical values with the Sheets `RAW` mode. Only the
five application-owned formulas in `Dashboard!B3:B7` use `USER_ENTERED`.
Formula-bearing rows in `Inputs` are rejected and rewritten as literal values.

## Manual workflow

### Create a sale

Set `Action` to `CREATE`, `Record Type` to `sale`, and supply:

- `Occurred At`
- `Product ID`
- `Quantity`
- `Unit Price (RM)`

### Create a cost

Set `Action` to `CREATE`, `Record Type` to `cost`, and supply:

- `Occurred At`
- `Component ID`
- `Quantity`
- `Supplier`
- `UOM`
- `Pack Size`
- `Total Price (RM)`
- optional `Payment Method` and `Note`

Use the settings page `Import inputs` action to validate and commit rows.
Valid rows commit independently; invalid rows are marked `error` and copied to
`Sync Errors`. Existing unresolved errors remain listed when another row causes
the error tab to be rebuilt.

## Bidirectional sale edits

Synchronized sales are editable only through append-only corrections:

1. Keep `Action` as `UPDATE`.
2. Change `Product ID`, `Quantity`, or `Unit Price (RM)`.
3. Import or reconcile.

PasarAI verifies the row checksum and record version before creating a
correction event. Synchronized costs remain read-only.

When the database changes and the sheet row has not changed, reconciliation
refreshes the row and advances `Record Version`.

When both sides changed, the row becomes `conflict`. Set `Action` to `REFRESH`
and reconcile to restore the latest database values, then reapply the desired
sale edit against the new version.

## Automatic mode

The settings page sync-mode control calls the merchant-authenticated API:

- `manual`: stops the active Drive notification channel when possible.
- `automatic`: creates a token-protected Drive watch and records its resource,
  channel, expiration, and message number.

Drive notifications are validated by channel ID, channel token, resource ID,
and monotonically increasing message number. The message advance and queue
insert commit atomically before the webhook acknowledges delivery. The
background worker uses globally unique, claim-token-fenced leases for queued
notifications, records failures, retries with backoff, renews expiring watches,
and periodically reconciles automatic connections. Each worker stage has a
deadline and a no-overlap guard, so a stalled provider request cannot starve
later stages or create duplicate stage runners.

Imports, exports, and reconciliations also acquire a durable per-merchant lease.
The lease is renewed by heartbeat and revalidated before workbook, ledger-row,
watch, and connection mutations. Disconnect and sync-mode changes use the same
lease, while stale watch creation is stopped instead of published. This prevents
API requests and multiple worker replicas from rewriting the same workbook
concurrently or reactivating a disconnected connection.

Unchanged managed rows do not produce sheet writes, preventing PasarAI's own
exports from creating a notification loop.

## Operations

- `Reconcile` imports changed input rows and refreshes managed metrics.
- `Export` refreshes `Dashboard` and `Metrics` only.
- `Disconnect` stops the active notification channel when possible and removes
  durable OAuth tokens while retaining the audit record.
- Direct API clients must send a unique `Idempotency-Key` for every Google
  Sheets POST operation. The web BFF creates or forwards these keys.
- A connection in `error` remains retryable; reconnect when Google access has
  been revoked or the refresh token is no longer available.
- Monitor `google_sheet_sync_jobs`, `google_sheet_notification_queue`,
  `google_sheet_operation_idempotency`, `google_sheet_sync_leases`, connection
  timestamps, and `last_error` when diagnosing delayed synchronization.
