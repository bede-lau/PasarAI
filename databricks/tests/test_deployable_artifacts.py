import json
import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
DATABRICKS = ROOT / "databricks"


class DeployableArtifactTests(unittest.TestCase):
    def test_lakebase_migration_is_idempotent_and_covers_the_operational_model(self):
        migration = (
            DATABRICKS / "lakebase" / "migrations" / "001_initial.sql"
        ).read_text(encoding="utf-8")

        for table in [
            "merchants",
            "products",
            "recipe_components",
            "raw_events",
            "api_idempotency",
            "evidence_assets",
            "sales_lines",
            "purchase_receipts",
            "purchase_lines",
            "clarification_tasks",
            "corrections",
        ]:
            self.assertRegex(
                migration,
                rf"CREATE TABLE IF NOT EXISTS\s+{table}\b",
            )

        self.assertIn("CREATE OR REPLACE FUNCTION pasarai_append_raw_event", migration)
        self.assertIn("CREATE OR REPLACE FUNCTION pasarai_append_correction", migration)
        self.assertIn("p_endpoint_id TEXT", migration)
        self.assertIn(
            "MD5(p_merchant_id || ':' || p_endpoint_id || ':' || p_idempotency_key)",
            migration,
        )
        self.assertIn("'corrections.create'", migration)
        self.assertIn(
            "ON CONFLICT (merchant_id, endpoint_id, idempotency_key) DO NOTHING",
            migration,
        )
        self.assertIn("request_fingerprint TEXT NOT NULL", migration)
        api_idempotency_columns = re.search(
            r"CREATE TABLE IF NOT EXISTS api_idempotency\s*\((.*?)\);",
            migration,
            re.S,
        ).group(1)
        self.assertRegex(api_idempotency_columns, r"\bmerchant_id\s+TEXT NOT NULL\b")
        self.assertIn(
            "PRIMARY KEY (merchant_id, endpoint_id, idempotency_key)",
            api_idempotency_columns,
        )
        upgrade = (
            DATABRICKS
            / "lakebase"
            / "migrations"
            / "002_merchant_scoped_idempotency.sql"
        ).read_text(encoding="utf-8")
        self.assertIn("ADD COLUMN IF NOT EXISTS merchant_id", upgrade)
        self.assertIn(
            "ADD PRIMARY KEY (merchant_id, endpoint_id, idempotency_key)",
            upgrade,
        )
        raw_event_upgrade = (
            DATABRICKS
            / "lakebase"
            / "migrations"
            / "003_endpoint_scoped_raw_events.sql"
        ).read_text(encoding="utf-8")
        self.assertIn(
            "ADD COLUMN IF NOT EXISTS endpoint_id TEXT NOT NULL",
            raw_event_upgrade,
        )
        self.assertIn(
            "UNIQUE (merchant_id, endpoint_id, idempotency_key)",
            raw_event_upgrade,
        )
        self.assertIn("p_endpoint_id TEXT", raw_event_upgrade)
        self.assertIn(
            "DROP FUNCTION IF EXISTS pasarai_append_raw_event",
            raw_event_upgrade,
        )
        self.assertIn("pasarai_reject_append_only_mutation", migration)
        self.assertRegex(
            migration,
            r"confidence NUMERIC\(5, 4\) CHECK",
        )
        self.assertNotRegex(migration, r"\b(?:DROP TABLE|TRUNCATE)\b")

        google_sheets_queue = (
            DATABRICKS
            / "lakebase"
            / "migrations"
            / "006_google_sheets_notification_queue.sql"
        ).read_text(encoding="utf-8")
        self.assertIn(
            "CREATE TABLE IF NOT EXISTS google_sheet_notification_queue",
            google_sheets_queue,
        )
        self.assertIn(
            "UNIQUE (channel_id, message_number)",
            google_sheets_queue,
        )
        for column in [
            "attempts INTEGER NOT NULL DEFAULT 0",
            "last_error TEXT",
            "available_at TIMESTAMPTZ",
            "processed_at TIMESTAMPTZ",
        ]:
            self.assertIn(column, google_sheets_queue)
        self.assertIn(
            "CREATE TABLE IF NOT EXISTS google_sheet_operation_idempotency",
            google_sheets_queue,
        )
        self.assertIn(
            "PRIMARY KEY (merchant_id, operation, idempotency_key)",
            google_sheets_queue,
        )
        self.assertIn("request_fingerprint TEXT NOT NULL", google_sheets_queue)
        self.assertIn("response JSONB", google_sheets_queue)
        self.assertNotRegex(
            google_sheets_queue,
            r"\b(?:DROP TABLE|TRUNCATE)\b",
        )
        analytics_projection = (
            DATABRICKS
            / "lakebase"
            / "migrations"
            / "008_analytics_projections.sql"
        ).read_text(encoding="utf-8")
        for table in [
            "analytics_daily_product_metrics",
            "analytics_daily_component_costs",
            "analytics_refresh_state",
            "analytics_forecasts",
            "analytics_job_runs",
        ]:
            self.assertRegex(
                analytics_projection,
                rf"CREATE TABLE IF NOT EXISTS\s+{table}\b",
            )
        self.assertIn(
            "PRIMARY KEY (\n        merchant_id,\n        product_id,\n        forecast_date,\n        forecast_version",
            analytics_projection,
        )
        self.assertNotRegex(
            analytics_projection,
            r"\b(?:DROP TABLE|TRUNCATE)\b",
        )
        google_sheets_fencing = (
            DATABRICKS
            / "lakebase"
            / "migrations"
            / "007_google_sheets_lease_fencing.sql"
        ).read_text(encoding="utf-8")
        self.assertEqual(
            google_sheets_fencing.count(
                "ADD COLUMN IF NOT EXISTS claim_token TEXT"
            ),
            2,
        )
        notification_reset = re.search(
            r"UPDATE google_sheet_notification_queue\s+SET(.*?)"
            r"WHERE status = 'processing'\s+AND claim_token IS NULL;",
            google_sheets_fencing,
            re.S,
        ).group(1)
        for recovery_clause in [
            "status = 'failed'",
            "available_at = CURRENT_TIMESTAMP",
            "claimed_at = NULL",
            "claimed_by = NULL",
            "claim_token = NULL",
            "lease_expires_at = NULL",
        ]:
            self.assertIn(recovery_clause, notification_reset)
        operation_reset = re.search(
            r"UPDATE google_sheet_operation_idempotency\s+SET(.*?)"
            r"WHERE status = 'processing'\s+AND claim_token IS NULL;",
            google_sheets_fencing,
            re.S,
        ).group(1)
        for recovery_clause in [
            "status = 'failed'",
            "lease_expires_at = NULL",
            "failed_at = CURRENT_TIMESTAMP",
        ]:
            self.assertIn(recovery_clause, operation_reset)
        self.assertIn(
            "CREATE TABLE IF NOT EXISTS google_sheet_sync_leases",
            google_sheets_fencing,
        )
        self.assertIn(
            "merchant_id TEXT PRIMARY KEY REFERENCES merchants(merchant_id)",
            google_sheets_fencing,
        )
        for column in [
            "operation TEXT NOT NULL",
            "owner_id TEXT NOT NULL",
            "claim_token TEXT NOT NULL UNIQUE",
            "lease_expires_at TIMESTAMPTZ NOT NULL",
            "released_at TIMESTAMPTZ",
        ]:
            self.assertIn(column, google_sheets_fencing)
        self.assertIn(
            "VALUES ('007_google_sheets_lease_fencing')",
            google_sheets_fencing,
        )
        self.assertNotRegex(
            google_sheets_fencing,
            r"\b(?:DROP TABLE|TRUNCATE)\b",
        )

    def test_single_pipeline_uses_current_python_api_and_quality_expectations(self):
        pipeline_files = list((DATABRICKS / "pipeline").glob("*.py"))
        self.assertEqual([path.name for path in pipeline_files], ["pasarai_pipeline.py"])
        pipeline = pipeline_files[0].read_text(encoding="utf-8")

        self.assertIn("from pyspark import pipelines as dp", pipeline)
        self.assertIn("@dp.table", pipeline)
        self.assertIn("@dp.materialized_view", pipeline)
        for expectation in [
            "valid_event_id",
            "positive_quantity",
            "non_negative_myr_amount",
            "receipt_total_reconciliation",
        ]:
            self.assertIn(expectation, pipeline)
        self.assertIn('name="silver_cost_facts"', pipeline)
        self.assertIn("price_floor_rm", pipeline)
        for forbidden in ["collect(", "count(", "toPandas(", "saveAsTable(", "import dlt"]:
            self.assertNotIn(forbidden, pipeline)

        config = json.loads(
            (DATABRICKS / "pipeline" / "pipeline-config.example.json").read_text(
                encoding="utf-8"
            )
        )
        self.assertEqual(config["serverless"], True)
        self.assertEqual(config["continuous"], False)
        self.assertEqual(config["catalog"], "PLACEHOLDER")
        self.assertEqual(config["schema"], "PLACEHOLDER")
        self.assertEqual(config["libraries"], [{"file": "pasarai_pipeline.py"}])
        self.assertIn(
            "pasarai.source.historical_sales_table",
            config["configuration"],
        )

    def test_pipeline_matches_lakebase_columns_and_canonical_event_payloads(self):
        migration = (
            DATABRICKS / "lakebase" / "migrations" / "001_initial.sql"
        ).read_text(encoding="utf-8")
        pipeline = (
            DATABRICKS / "pipeline" / "pasarai_pipeline.py"
        ).read_text(encoding="utf-8")

        raw_events_columns = re.search(
            r"CREATE TABLE IF NOT EXISTS raw_events\s*\((.*?)\);",
            migration,
            re.S,
        ).group(1)
        self.assertRegex(raw_events_columns, r"\bpayload\s+JSONB\b")
        self.assertRegex(raw_events_columns, r"\bevidence\s+JSONB\b")
        self.assertNotIn("payload_json", raw_events_columns)
        self.assertNotIn("interpreted_payload_json", raw_events_columns)

        self.assertNotIn("payload_json", pipeline)
        self.assertNotIn("interpreted_payload_json", pipeline)
        self.assertIn('F.col("event_type") == "sale"', pipeline)
        self.assertIn('F.from_json(F.col("payload").cast("string")', pipeline)
        self.assertIn('F.posexplode("sale_payload.lines")', pipeline)
        self.assertIn(
            'F.posexplode("correction_payload.replacement_payload.changes")',
            pipeline,
        )
        self.assertIn(
            '"target_event_id",\n        "corrected_line_index",\n        "corrected_field"',
            pipeline,
        )
        self.assertIn('T.StructField("line_index", T.IntegerType())', pipeline)
        self.assertIn("line_corrections.corrected_line_index", pipeline)
        self.assertIn("sales.line_count", pipeline)

        self.assertIn('spark.read.table(purchase_lines_source).groupBy("receipt_id")', pipeline)
        self.assertIn('spark.read.table(purchase_receipts_source)', pipeline)
        self.assertNotIn('F.col("reconciled_line_total_rm")', pipeline)
        self.assertIn('"sale_date",\n        "component_id"', pipeline)
        self.assertIn('F.col("effective_at").desc()', pipeline)
        self.assertIn("historical_sales_source", pipeline)
        self.assertIn("resolved.unionByName(historical)", pipeline)
        self.assertIn("from_utc_timestamp(occurred_at, timezone)", pipeline)
        self.assertIn('F.col("review_state") == "accepted"', pipeline)
        self.assertIn("receipt_overall_confidence", pipeline)

    def test_notebooks_load_every_fixture_and_query_gold_without_credentials(self):
        seed_notebook = (
            DATABRICKS / "notebooks" / "01_seed_synthetic_data.py"
        ).read_text(encoding="utf-8")
        snapshot_notebook = (
            DATABRICKS / "notebooks" / "00_snapshot_lakebase_to_delta.py"
        ).read_text(encoding="utf-8")
        query_notebook = (
            DATABRICKS / "notebooks" / "02_query_gold.py"
        ).read_text(encoding="utf-8")
        guidance = (DATABRICKS / "README.md").read_text(encoding="utf-8")

        for fixture in [
            "expected_metrics.json",
            "ingredient_price_history.csv",
            "merchant.json",
            "products.csv",
            "receipt_ground_truth.json",
            "recipe_components.csv",
            "sales_history.csv",
            "today_events.json",
        ]:
            self.assertIn(fixture, seed_notebook)

        self.assertIn("def insert_only", seed_notebook)
        self.assertIn("WHEN NOT MATCHED THEN INSERT *", seed_notebook)
        self.assertIn('"seed_today_events"', seed_notebook)
        self.assertNotIn('insert_only(\n    "source_raw_events"', seed_notebook)
        self.assertIn("source_purchase_lines", seed_notebook)
        self.assertIn("daily_product_metrics", query_notebook)
        self.assertIn("cost_driver_metrics", query_notebook)
        self.assertIn("price_scenario_baselines", query_notebook)
        for source_table, lakebase_table in [
            ("source_merchants", "FROM merchants"),
            ("source_recipe_components", "FROM recipe_components"),
            ("source_raw_events", "FROM raw_events"),
            ("source_purchase_receipts", "FROM purchase_receipts"),
            ("source_purchase_lines", "FROM purchase_lines"),
        ]:
            self.assertIn(f'"{source_table}"', snapshot_notebook)
            self.assertIn(lakebase_table, snapshot_notebook)
        self.assertIn('.format("jdbc")', snapshot_notebook)
        self.assertIn("org.postgresql.Driver", snapshot_notebook)
        self.assertIn("snapshot conflicts with existing immutable Delta data", snapshot_notebook)
        raw_events_mapping = re.search(
            r'"source_raw_events":\s*\{.*?\n    \},',
            snapshot_notebook,
            re.S,
        ).group(0)
        self.assertIn("endpoint_id", raw_events_mapping)
        self.assertIn(
            '"keys": ["merchant_id", "endpoint_id", "idempotency_key"]',
            raw_events_mapping,
        )
        self.assertIn(
            "source_raw_events event_id conflicts with an existing ",
            snapshot_notebook,
        )
        self.assertIn("endpoint-scoped identity", snapshot_notebook)
        self.assertIn("target is missing required columns", snapshot_notebook)
        self.assertNotIn("AUTO CDC", snapshot_notebook)
        self.assertNotIn("Lakehouse Federation", snapshot_notebook)
        self.assertRegex(guidance, r"(?i)one.*pipeline")
        self.assertRegex(guidance, r"(?i)triggered")
        self.assertRegex(guidance, r"(?i)teardown")
        self.assertNotRegex(
            "\n".join([seed_notebook, snapshot_notebook, query_notebook, guidance]),
            re.compile(r"\b(?:dapi[A-Za-z0-9]+|postgres(?:ql)?://|https?://)\S*", re.I),
        )


if __name__ == "__main__":
    unittest.main()
