# Databricks notebook source
"""Snapshot Lakebase operational tables into idempotent Delta pipeline sources."""

import json
import re

from pyspark.sql import functions as F


dbutils.widgets.text("lakebase_jdbc_url", "")
dbutils.widgets.text("lakebase_user", "")
dbutils.widgets.text("lakebase_password_secret_scope", "")
dbutils.widgets.text("lakebase_password_secret_key", "")
dbutils.widgets.text("target_catalog", "")
dbutils.widgets.text("target_schema", "")

jdbc_url = dbutils.widgets.get("lakebase_jdbc_url")
jdbc_user = dbutils.widgets.get("lakebase_user")
password_scope = dbutils.widgets.get("lakebase_password_secret_scope")
password_key = dbutils.widgets.get("lakebase_password_secret_key")
target_catalog = dbutils.widgets.get("target_catalog")
target_schema = dbutils.widgets.get("target_schema")

identifier_pattern = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
for label, value in [
    ("target_catalog", target_catalog),
    ("target_schema", target_schema),
]:
    if not identifier_pattern.fullmatch(value):
        raise ValueError(f"{label} must be a simple workspace identifier")
for label, value in [
    ("lakebase_jdbc_url", jdbc_url),
    ("lakebase_user", jdbc_user),
    ("lakebase_password_secret_scope", password_scope),
    ("lakebase_password_secret_key", password_key),
]:
    if not value:
        raise ValueError(f"{label} is required")

jdbc_password = dbutils.secrets.get(scope=password_scope, key=password_key)
spark.sql(f"CREATE SCHEMA IF NOT EXISTS `{target_catalog}`.`{target_schema}`")


SOURCE_MAPPINGS = {
    "source_merchants": {
        "query": """
            SELECT
                merchant_id,
                display_name,
                location,
                timezone,
                currency,
                primary_language,
                supported_languages::text AS supported_languages,
                target_gross_margin_pct
            FROM merchants
        """,
        "keys": ["merchant_id"],
        "immutable": [],
    },
    "source_recipe_components": {
        "query": """
            SELECT
                merchant_id,
                product_id,
                component_id,
                component_name,
                baseline_cost_per_pack_rm,
                current_cost_per_pack_rm,
                uom,
                effective_at,
                snapshot_id,
                snapshot_sequence
            FROM recipe_components
        """,
        "keys": [
            "merchant_id",
            "product_id",
            "component_id",
            "effective_at",
            "snapshot_id",
        ],
        "immutable": [
            "component_name",
            "baseline_cost_per_pack_rm",
            "current_cost_per_pack_rm",
            "uom",
            "snapshot_sequence",
        ],
    },
    "source_raw_events": {
        "query": """
            SELECT
                event_id,
                merchant_id,
                endpoint_id,
                idempotency_key,
                event_type,
                occurred_at,
                source,
                source_language,
                payload::text AS payload,
                evidence::text AS evidence
            FROM raw_events
        """,
        "keys": ["merchant_id", "endpoint_id", "idempotency_key"],
        "immutable": [
            "event_id",
            "merchant_id",
            "endpoint_id",
            "idempotency_key",
            "event_type",
            "occurred_at",
            "source",
            "source_language",
            "payload",
            "evidence",
        ],
    },
    "source_purchase_receipts": {
        "query": """
            SELECT
                receipt_id,
                source_event_id,
                merchant_id,
                supplier_name,
                receipt_date,
                currency,
                total_rm,
                overall_confidence,
                review_state
            FROM purchase_receipts
        """,
        "keys": ["receipt_id"],
        "immutable": [],
    },
    "source_purchase_lines": {
        "query": """
            SELECT
                purchase_line_id,
                receipt_id,
                component_id,
                raw_name,
                quantity,
                uom,
                pack_size,
                unit_price_rm,
                total_price_rm,
                confidence
            FROM purchase_lines
        """,
        "keys": ["purchase_line_id"],
        "immutable": [],
    },
}


def quoted_table(name):
    return f"`{target_catalog}`.`{target_schema}`.`{name}`"


@F.udf("string")
def canonical_json(value):
    if value is None:
        return None
    return json.dumps(json.loads(value), separators=(",", ":"), sort_keys=True)


def read_lakebase(query):
    return (
        spark.read.format("jdbc")
        .option("url", jdbc_url)
        .option("driver", "org.postgresql.Driver")
        .option("user", jdbc_user)
        .option("password", jdbc_password)
        .option("dbtable", f"({query}) AS pasarai_source")
        .load()
    )


def snapshot_source(name, mapping):
    dataframe = read_lakebase(mapping["query"])
    if name == "source_raw_events":
        dataframe = (
            dataframe.withColumn("payload", canonical_json("payload"))
            .withColumn("evidence", canonical_json("evidence"))
        )
    target = f"{target_catalog}.{target_schema}.{name}"
    target_sql = quoted_table(name)
    view = f"_pasarai_snapshot_{name}"
    dataframe.createOrReplaceTempView(view)
    if not spark.catalog.tableExists(target):
        dataframe.limit(0).write.format("delta").mode("overwrite").saveAsTable(target)
    else:
        target_columns = set(spark.table(target).columns)
        missing_columns = [
            column for column in dataframe.columns
            if column not in target_columns
        ]
        if missing_columns:
            raise ValueError(
                f"{name} target is missing required columns "
                f"{', '.join(missing_columns)}; recreate the disposable "
                "synthetic target table before rerunning the snapshot"
            )

    key_condition = " AND ".join(
        f"target.`{key}` <=> source.`{key}`"
        for key in mapping["keys"]
    )
    if name == "source_raw_events":
        identity_conflicts = spark.sql(
            f"""
            SELECT source.event_id
            FROM {view} AS source
            INNER JOIN {target_sql} AS target
              ON target.event_id = source.event_id
            WHERE NOT ({key_condition})
            LIMIT 1
            """
        )
        if identity_conflicts.count():
            raise ValueError(
                "source_raw_events event_id conflicts with an existing "
                "endpoint-scoped identity"
            )
    immutable = mapping["immutable"]
    if immutable:
        conflict_condition = " OR ".join(
            f"NOT (target.`{column}` <=> source.`{column}`)"
            for column in immutable
        )
        conflicts = spark.sql(
            f"""
            SELECT source.*
            FROM {view} AS source
            INNER JOIN {target_sql} AS target
              ON {key_condition}
            WHERE {conflict_condition}
            LIMIT 1
            """
        )
        if conflicts.count():
            raise ValueError(
                f"{name} snapshot conflicts with existing immutable Delta data"
            )
        matched_clause = ""
    else:
        matched_clause = "WHEN MATCHED THEN UPDATE SET *"

    spark.sql(
        f"""
        MERGE INTO {target_sql} AS target
        USING {view} AS source
        ON {key_condition}
        {matched_clause}
        WHEN NOT MATCHED THEN INSERT *
        """
    )


for source_name, source_mapping in SOURCE_MAPPINGS.items():
    snapshot_source(source_name, source_mapping)

print("Lakebase operational snapshot completed idempotently.")
