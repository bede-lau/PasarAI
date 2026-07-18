# PasarAI Databricks notebooks

- `00_snapshot_lakebase_to_delta.py` snapshots the five operational Lakebase tables into exact Delta source tables over PostgreSQL JDBC. Raw events and recipe snapshots are insert-only and fail on conflicting replay.
- `01_seed_synthetic_data.py` loads all authoritative synthetic fixtures into
  idempotent Delta-only sources, including seven historical sales days,
  fixture documents, receipt rows, and baseline/current recipe snapshots. It
  does not write `source_raw_events`.
- `02_query_gold.py` displays Gold datasets and checks the golden daily result from the loaded expected-metrics fixture.
- `03_publish_forecasts.py` runs transparent daily product shadow forecasting
  from Gold `daily_product_metrics` and upserts versioned p10/p50/p90 records
  into a configurable Lakebase `analytics_forecasts` table.

The seed notebook requires `fixture_root`, `target_catalog`, and `target_schema`.
The operational snapshot notebook requires the target catalog/schema, Lakebase
JDBC URL and user, plus a Databricks secret scope/key for the password. Keep the
fixture root in a workspace file or Volume chosen by the product owner. Run the
snapshot notebook before the existing triggered pipeline; it is not a second
pipeline. Lakebase is the only operational raw-event authority.

The forecast notebook requires the target catalog/schema, Lakebase JDBC URL and
user, and either a Databricks password secret scope/key or the
`PASARAI_LAKEBASE_PASSWORD` environment variable. The destination table may be
set with `lakebase_forecast_table` and defaults to `analytics_forecasts`; no
credential or workspace identifier is embedded in the notebook.
