# PasarAI Databricks Free Edition data platform

This directory contains the complete Prompt 02 handoff:

- `lakebase/migrations/001_initial.sql`: idempotent operational-ledger migration and append functions;
- `lakebase/repository.py`: DB-API Lakebase adapter plus in-memory behavioral test double;
- `notebooks/00_snapshot_lakebase_to_delta.py`: Free-Edition-compatible JDBC snapshot from Lakebase into Delta source tables;
- `notebooks/01_seed_synthetic_data.py`: idempotent loader for every authoritative synthetic fixture;
- `pipeline/pasarai_pipeline.py`: the single Bronze→Silver→Gold Lakeflow pipeline;
- `notebooks/02_query_gold.py`: Gold datasets and fixture-driven golden verification;
- `notebooks/03_publish_forecasts.py`: versioned shadow/display-candidate daily
  demand forecasts published to configurable Lakebase `analytics_forecasts`;
- `platform/forecasting.py`: dependency-free weekday, robust median, trend, and
  rolling-origin forecast implementation used by the notebook and tests;
- `platform/`: dependency-free local equivalent used by automated tests.

The production Node API consumes the same migration through
`LakebaseLedgerStore`. Run the API package's `db:migrate` and
`db:seed:synthetic` commands with secure environment configuration before
starting the public service.

## Quota-aware setup

1. Create the single Lakebase project manually, run the ordered migrations,
   and run the API package's synthetic Lakebase seed once.
2. Upload the synthetic seed directory to a workspace file area or Volume.
3. Run the seed notebook once with explicit widget values. It creates the
   seven-day historical sales source, synthetic fixture documents, receipt
   rows, and recipe-component snapshots. It never writes operational raw events.
4. Store the Lakebase password in a Databricks secret and run `00_snapshot_lakebase_to_delta.py` with the Lakebase JDBC URL, user, secret scope/key, catalog, and schema.
5. Create one serverless pipeline in triggered mode from the example configuration and map it to `source_raw_events`, `seed_historical_sales`, `source_recipe_components`, `source_purchase_receipts`, `source_purchase_lines`, and `source_merchants`.
6. Run one pipeline update, then run the Gold query notebook.
7. After provisioning the Lakebase `analytics_forecasts` destination, run the
   forecast notebook with JDBC and secret/environment configuration. Series
   with 28-55 usable days or a failed accuracy gate remain shadow-only; only
   series with at least 56 usable days and a passing gate are displayable.
8. For later operational refreshes, rerun only the JDBC snapshot notebook, the
   same triggered pipeline, and then the forecast publication notebook. Do not
   create a second ingestion pipeline.
9. Avoid continuous mode, repeated full refreshes, extra pipelines, and unnecessary notebook sessions.

Lakebase is the sole producer of operational `source_raw_events`; the JDBC
snapshot is the only path that lands them into Delta. It uses ordinary notebook
compute and Delta `MERGE`; it does not
require Lakehouse Federation, managed ingestion, change-data capture, or another
pipeline. Immutable raw events and recipe snapshots are insert-only. Replaying an
identical row is a no-op, while reusing an existing key with different immutable
content, or reusing an event ID under a different endpoint-scoped identity,
fails before the Delta write.

Receipt confidence and review state are copied without synthetic defaults.
`silver_purchase_receipts` retains pending rows for review, while
`silver_cost_facts` includes only receipts whose `review_state` is `accepted`.
Gold combines the seven historical sales days with current raw-event sales,
derives live sale dates in `merchants.timezone`, and resolves each recipe
component snapshot as of that local sale date.

Line-scoped corrections use the optional zero-based `line_index` from the shared
correction payload. Multi-line sales require it for product, quantity, and
unit-price changes; legacy single-line corrections remain valid. Unscoped
`source_language` corrections apply to all lines in the target event.

## Teardown

Stop the pipeline after verification. Delete only the synthetic target schema and Lakebase project through the workspace UI when the demo environment is no longer needed. Confirm the selected catalog, schema, and project visually before deletion; teardown is intentionally not automated.

## Manual values still required

The product owner selects the Lakebase project, database, role, JDBC URL, secret
scope/key, catalog, schema, and fixture location. No workspace URL, credential,
endpoint, model identifier, or catalog name is stored in this repository.
