# PasarAI Lakebase

Run the numbered SQL files under `migrations/` in lexical order in the Lakebase
SQL Editor, or run `pnpm --filter @pasarai/api db:migrate` with the connection
details copied from the workspace. Migration `003` upgrades legacy raw-event
tables to endpoint-scoped idempotency before the JDBC snapshot runs.
Migrations `004` through `007` add Google Sheets connections, row and sync-job
state, Drive message tracking, a durable notification queue, claim-token
fencing, operation idempotency, and per-merchant synchronization leases.

The migration is safe to rerun. It creates the operational tables, merchant-scoped
raw-event idempotency, idempotent append functions, and append-only protection
for raw events, evidence assets, and corrections. Google Drive notification
acceptance advances the channel message number and inserts its queue record in
one transaction. Receipt and purchase-line confidence values remain nullable
when the source ground truth does not provide them; `review_state` controls
whether downstream cost facts are accepted.

To land operational data for the single Lakeflow pipeline, store the Lakebase
password in a Databricks secret and run
`../notebooks/00_snapshot_lakebase_to_delta.py`. The notebook uses standard
PostgreSQL JDBC reads and Delta `MERGE`, with insert-only conflict checks for
immutable raw events and recipe snapshots.

Do not commit a connection string, token, project identifier, branch identifier, database name, or role. The product owner supplies those values during manual setup.
