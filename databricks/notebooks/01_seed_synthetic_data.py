# Databricks notebook source
"""Idempotently load every PasarAI synthetic fixture into Delta landing tables."""

import json
import re
from pathlib import PurePosixPath

from pyspark.sql import functions as F
from pyspark.sql import types as T


dbutils.widgets.text("fixture_root", "")
dbutils.widgets.text("target_catalog", "")
dbutils.widgets.text("target_schema", "")

fixture_root = dbutils.widgets.get("fixture_root").rstrip("/")
target_catalog = dbutils.widgets.get("target_catalog")
target_schema = dbutils.widgets.get("target_schema")

identifier_pattern = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
if not fixture_root:
    raise ValueError("fixture_root is required")
for label, value in [("target_catalog", target_catalog), ("target_schema", target_schema)]:
    if not identifier_pattern.fullmatch(value):
        raise ValueError(f"{label} must be a simple workspace identifier")

spark.sql(f"CREATE SCHEMA IF NOT EXISTS `{target_catalog}`.`{target_schema}`")


def fixture_path(name):
    return str(PurePosixPath(fixture_root) / name)


def table_name(name):
    return f"{target_catalog}.{target_schema}.{name}"


def quoted_table(name):
    return f"`{target_catalog}`.`{target_schema}`.`{name}`"


@F.udf("string")
def canonical_json(value):
    if value is None:
        return None
    return json.dumps(json.loads(value), separators=(",", ":"), sort_keys=True)


def merge_into(name, dataframe, keys):
    target = table_name(name)
    target_sql = quoted_table(name)
    view = f"_pasarai_seed_{name}"
    dataframe.createOrReplaceTempView(view)
    if not spark.catalog.tableExists(target):
        dataframe.limit(0).write.format("delta").mode("overwrite").saveAsTable(target)
    condition = " AND ".join(
        f"target.`{key}` <=> source.`{key}`"
        for key in keys
    )
    spark.sql(
        f"""
        MERGE INTO {target_sql} AS target
        USING {view} AS source
        ON {condition}
        WHEN MATCHED THEN UPDATE SET *
        WHEN NOT MATCHED THEN INSERT *
        """
    )


def insert_only(name, dataframe, keys, immutable_columns):
    target = table_name(name)
    target_sql = quoted_table(name)
    view = f"_pasarai_seed_{name}"
    dataframe.createOrReplaceTempView(view)
    if not spark.catalog.tableExists(target):
        dataframe.limit(0).write.format("delta").mode("overwrite").saveAsTable(target)

    key_condition = " AND ".join(
        f"target.`{key}` <=> source.`{key}`"
        for key in keys
    )
    conflict_condition = " OR ".join(
        f"NOT (target.`{column}` <=> source.`{column}`)"
        for column in immutable_columns
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
            f"{name} replay conflicts with an existing immutable payload"
        )

    spark.sql(
        f"""
        MERGE INTO {target_sql} AS target
        USING {view} AS source
        ON {key_condition}
        WHEN NOT MATCHED THEN INSERT *
        """
    )


def whole_document(name):
    return (
        spark.read.format("text")
        .option("wholetext", True)
        .load(fixture_path(name))
        .select(
            F.lit(name).alias("fixture_name"),
            F.col("value").alias("document_json"),
            F.lit(True).alias("synthetic"),
        )
    )


# merchant.json
merchant = (
    spark.read.option("multiLine", True)
    .json(fixture_path("merchant.json"))
    .select(
        "merchant_id",
        "display_name",
        "location",
        "timezone",
        "currency",
        "primary_language",
        F.to_json("supported_languages").alias("supported_languages"),
        F.col("target_gross_margin_pct").cast("decimal(7,4)"),
    )
)
merge_into("source_merchants", merchant, ["merchant_id"])

# products.csv
products = (
    spark.read.option("header", True)
    .option("inferSchema", True)
    .csv(fixture_path("products.csv"))
    .withColumn("selling_price_rm", F.col("selling_price_rm").cast("decimal(18,2)"))
    .withColumn("synthetic", F.lit(True))
)
merge_into("seed_products", products, ["product_id"])

# recipe_components.csv
recipe_component_fixture = (
    spark.read.option("header", True)
    .option("inferSchema", True)
    .csv(fixture_path("recipe_components.csv"))
    .withColumn("merchant_id", F.lit("m_kak_lina_001"))
    .withColumn(
        "baseline_cost_per_pack_rm",
        F.col("baseline_cost_per_pack_rm").cast("decimal(18,2)"),
    )
    .withColumn(
        "current_cost_per_pack_rm",
        F.col("current_cost_per_pack_rm").cast("decimal(18,2)"),
    )
)
baseline_components = (
    recipe_component_fixture
    .withColumn(
        "current_cost_per_pack_rm",
        F.col("baseline_cost_per_pack_rm"),
    )
    .withColumn("effective_at", F.to_timestamp(F.lit("2026-07-05T00:00:00+08:00")))
    .withColumn("snapshot_id", F.lit("synthetic-baseline-v1"))
    .withColumn("snapshot_sequence", F.lit(1).cast("long"))
)
current_components = (
    recipe_component_fixture
    .withColumn("effective_at", F.to_timestamp(F.lit("2026-07-12T00:00:00+08:00")))
    .withColumn("snapshot_id", F.lit("synthetic-current-v1"))
    .withColumn("snapshot_sequence", F.lit(2).cast("long"))
)
recipe_components = baseline_components.unionByName(current_components)
insert_only(
    "source_recipe_components",
    recipe_components,
    ["merchant_id", "product_id", "component_id", "effective_at", "snapshot_id"],
    [
        "component_name",
        "baseline_cost_per_pack_rm",
        "current_cost_per_pack_rm",
        "uom",
        "snapshot_sequence",
    ],
)

# ingredient_price_history.csv
ingredient_prices = (
    spark.read.option("header", True)
    .option("inferSchema", True)
    .csv(fixture_path("ingredient_price_history.csv"))
    .withColumn("effective_date", F.to_date("effective_date"))
    .withColumn("purchase_qty", F.col("purchase_qty").cast("decimal(18,4)"))
    .withColumn("total_rm", F.col("total_rm").cast("decimal(18,2)"))
    .withColumn("synthetic", F.lit(True))
)
merge_into(
    "seed_ingredient_price_history",
    ingredient_prices,
    ["effective_date", "component_id", "supplier"],
)

# sales_history.csv
historical_sales = (
    spark.read.option("header", True)
    .option("inferSchema", True)
    .csv(fixture_path("sales_history.csv"))
    .withColumn("date", F.to_date("date"))
    .withColumn("quantity", F.col("quantity").cast("decimal(18,4)"))
    .withColumn("unit_price_rm", F.col("unit_price_rm").cast("decimal(18,2)"))
    .withColumn("unit_cogs_rm", F.col("unit_cogs_rm").cast("decimal(18,2)"))
    .withColumn("revenue_rm", F.col("revenue_rm").cast("decimal(18,2)"))
    .withColumn("gross_profit_rm", F.col("gross_profit_rm").cast("decimal(18,2)"))
    .withColumn("gross_margin_pct", F.col("gross_margin_pct").cast("decimal(7,2)"))
    .withColumn("synthetic", F.lit(True))
)
merge_into(
    "seed_historical_sales",
    historical_sales,
    ["date", "merchant_id", "product_id"],
)

# today_events.json remains available for fixture inspection, but Lakebase is
# the sole operational raw-event authority. The JDBC snapshot lands those rows.
today_events_document = whole_document("today_events.json")
merge_into("seed_today_events", today_events_document, ["fixture_name"])

# receipt_ground_truth.json
receipt_document = whole_document("receipt_ground_truth.json")
receipt_payload = json.loads(
    dbutils.fs.head(fixture_path("receipt_ground_truth.json"), 1_000_000)
)
receipt_rows = []
purchase_line_rows = []
receipt_source_events = {
    "SBR-120726-184": "evt_receipt_001",
    "PPT-260712-077": "evt_receipt_002",
}
for receipt_index, (fixture_name, receipt) in enumerate(receipt_payload.items(), start=1):
    receipt_rows.append(
        {
            "receipt_id": receipt["receipt_id"],
            "source_event_id": receipt_source_events.get(
                receipt["receipt_id"],
                f"evt_receipt_ground_truth_{receipt_index:03d}",
            ),
            "merchant_id": "m_kak_lina_001",
            "supplier_name": receipt["supplier_name"],
            "receipt_date": receipt["date"],
            "currency": receipt["currency"],
            "total_rm": str(receipt["total_rm"]),
            "overall_confidence": receipt.get("overall_confidence"),
            "review_state": receipt.get(
                "review_state",
                "pending" if receipt.get("expected_behavior") else "accepted",
            ),
        }
    )
    for index, item in enumerate(receipt["line_items"], start=1):
        purchase_line_rows.append(
            {
                "purchase_line_id": f"{receipt['receipt_id']}:{index}",
                "receipt_id": receipt["receipt_id"],
                "component_id": item.get("normalized_component_id"),
                "raw_name": item["raw_name"],
                "quantity": None if item.get("quantity") is None else str(item["quantity"]),
                "uom": item.get("uom"),
                "pack_size": None if item.get("pack_size") is None else str(item["pack_size"]),
                "unit_price_rm": (
                    None if item.get("unit_price_rm") is None else str(item["unit_price_rm"])
                ),
                "total_price_rm": (
                    None if item.get("total_price_rm") is None else str(item["total_price_rm"])
                ),
                "confidence": item.get("confidence"),
            }
        )
receipt_schema = T.StructType(
    [
        T.StructField("receipt_id", T.StringType(), False),
        T.StructField("source_event_id", T.StringType(), False),
        T.StructField("merchant_id", T.StringType(), False),
        T.StructField("supplier_name", T.StringType(), True),
        T.StructField("receipt_date", T.StringType(), True),
        T.StructField("currency", T.StringType(), False),
        T.StructField("total_rm", T.StringType(), True),
        T.StructField("overall_confidence", T.StringType(), True),
        T.StructField("review_state", T.StringType(), False),
    ]
)
purchase_receipts = (
    spark.createDataFrame(receipt_rows, receipt_schema)
    .withColumn("receipt_date", F.to_date("receipt_date"))
    .withColumn("total_rm", F.col("total_rm").cast("decimal(18,2)"))
    .withColumn("overall_confidence", F.col("overall_confidence").cast("decimal(5,4)"))
)
merge_into("source_purchase_receipts", purchase_receipts, ["receipt_id"])
purchase_line_schema = T.StructType(
    [
        T.StructField("purchase_line_id", T.StringType(), False),
        T.StructField("receipt_id", T.StringType(), False),
        T.StructField("component_id", T.StringType(), True),
        T.StructField("raw_name", T.StringType(), False),
        T.StructField("quantity", T.StringType(), True),
        T.StructField("uom", T.StringType(), True),
        T.StructField("pack_size", T.StringType(), True),
        T.StructField("unit_price_rm", T.StringType(), True),
        T.StructField("total_price_rm", T.StringType(), True),
        T.StructField("confidence", T.StringType(), True),
    ]
)
purchase_lines = (
    spark.createDataFrame(purchase_line_rows, purchase_line_schema)
    .withColumn("quantity", F.col("quantity").cast("decimal(18,4)"))
    .withColumn("pack_size", F.col("pack_size").cast("decimal(18,4)"))
    .withColumn("unit_price_rm", F.col("unit_price_rm").cast("decimal(18,2)"))
    .withColumn("total_price_rm", F.col("total_price_rm").cast("decimal(18,2)"))
    .withColumn("confidence", F.col("confidence").cast("decimal(5,4)"))
)
merge_into("source_purchase_lines", purchase_lines, ["purchase_line_id"])

# expected_metrics.json and raw receipt JSON are retained as visibly synthetic documents.
expected_metrics = whole_document("expected_metrics.json")
merge_into("seed_expected_metrics", expected_metrics, ["fixture_name"])
merge_into("seed_receipt_ground_truth", receipt_document, ["fixture_name"])

print("PasarAI synthetic seed completed idempotently.")
