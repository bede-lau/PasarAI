# PasarAI Lakeflow pipeline

`pasarai_pipeline.py` is the only required Bronze→Silver→Gold pipeline.

Use `pipeline-config.example.json` as a field checklist in the workspace UI:

- choose serverless compute;
- choose triggered, not continuous, execution;
- replace every `PLACEHOLDER` with an existing catalog, schema, or source table selected by the product owner;
- do not create a second pipeline for this demo;
- stop rerunning after the Gold verification notebook passes.

The Python file uses the current `pyspark.pipelines` API. Its dataset functions only return Spark DataFrames and do not perform arbitrary writes or driver-side collection.

Configure the six source settings as follows:

| Setting | Delta table |
| --- | --- |
| `pasarai.source.raw_events_table` | `source_raw_events` |
| `pasarai.source.historical_sales_table` | `seed_historical_sales` |
| `pasarai.source.recipe_components_table` | `source_recipe_components` |
| `pasarai.source.purchase_receipts_table` | `source_purchase_receipts` |
| `pasarai.source.purchase_lines_table` | `source_purchase_lines` |
| `pasarai.source.merchants_table` | `source_merchants` |

`00_snapshot_lakebase_to_delta.py` creates the five operational Delta sources
from Lakebase with explicit JDBC projections. `01_seed_synthetic_data.py`
creates the historical and fixture-only sources; it never creates competing
operational raw-event rows.

Raw events use `payload` and `evidence`; canonical sale events use
`event_type = 'sale'` with a `payload.lines` array. Receipt confidence/review
fields are retained, but only accepted receipts enter Silver cost facts.
Historical and current sales share `silver_sales_facts`. Current timestamps are
converted to merchant-local dates using `merchants.timezone`, and recipe
components are selected by latest `effective_at` on or before each sale date.

Correction changes may include zero-based `line_index`. Product, quantity, and
unit-price changes are ranked by target event, line index, and field, then join
only to the matching exploded sale line. A missing line index remains valid for
single-line sales only. Unscoped `source_language` changes remain event-wide and
apply to every line.
