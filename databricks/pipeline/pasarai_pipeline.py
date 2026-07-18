"""One serverless Lakeflow pipeline for PasarAI Bronze, Silver, and Gold datasets."""

from pyspark import pipelines as dp
from pyspark.sql import Window
from pyspark.sql import functions as F
from pyspark.sql import types as T


raw_events_source = spark.conf.get("pasarai.source.raw_events_table")
historical_sales_source = spark.conf.get("pasarai.source.historical_sales_table")
recipe_components_source = spark.conf.get("pasarai.source.recipe_components_table")
purchase_receipts_source = spark.conf.get("pasarai.source.purchase_receipts_table")
purchase_lines_source = spark.conf.get("pasarai.source.purchase_lines_table")
merchants_source = spark.conf.get("pasarai.source.merchants_table")

money_type = "decimal(18,2)"
quantity_type = "decimal(18,4)"

sale_payload_schema = T.StructType(
    [
        T.StructField(
            "lines",
            T.ArrayType(
                T.StructType(
                    [
                        T.StructField("product_id", T.StringType()),
                        T.StructField("quantity", T.StringType()),
                        T.StructField("unit_price_rm", T.StringType()),
                    ]
                )
            ),
        )
    ]
)
correction_payload_schema = T.StructType(
    [
        T.StructField("target_event_id", T.StringType()),
        T.StructField(
            "replacement_payload",
            T.StructType(
                [
                    T.StructField(
                        "changes",
                        T.ArrayType(
                            T.StructType(
                                [
                                    T.StructField("field", T.StringType()),
                                    T.StructField("corrected_value", T.StringType()),
                                    T.StructField("line_index", T.IntegerType()),
                                ]
                            )
                        ),
                    )
                ]
            ),
        ),
    ]
)


@dp.table(name="bronze_raw_events", comment="Immutable append-only source events and evidence.")
@dp.expect("valid_event_id", "event_id IS NOT NULL AND length(event_id) > 0")
def bronze_raw_events():
    return spark.readStream.table(raw_events_source)


@dp.materialized_view(
    name="silver_sales_facts",
    comment="Validated sales with latest append-only corrections resolved.",
)
@dp.expect_or_drop("valid_event_id", "source_event_id IS NOT NULL AND length(source_event_id) > 0")
@dp.expect_or_drop("positive_quantity", "quantity > 0")
@dp.expect_or_drop("non_negative_myr_amount", "unit_price_rm >= 0")
def silver_sales_facts():
    raw = spark.read.table("bronze_raw_events")
    merchants = spark.read.table(merchants_source).select("merchant_id", "timezone")
    sales = (
        raw.filter(F.col("event_type") == "sale")
        .join(merchants, "merchant_id", "inner")
        .withColumn(
            "sale_payload",
            F.from_json(F.col("payload").cast("string"), sale_payload_schema),
        )
        .select(
            F.col("event_id").alias("source_event_id"),
            "merchant_id",
            F.expr(
                "to_date(from_utc_timestamp(occurred_at, timezone))"
            ).alias("sale_date"),
            "source",
            "source_language",
            F.size("sale_payload.lines").alias("line_count"),
            F.posexplode("sale_payload.lines").alias("line_index", "sale_line"),
        )
        .select(
            "source_event_id",
            "merchant_id",
            "sale_date",
            "line_index",
            F.col("sale_line.product_id").alias("original_product_id"),
            F.col("sale_line.quantity").cast(quantity_type).alias("original_quantity"),
            F.col("sale_line.unit_price_rm")
            .cast(money_type)
            .alias("original_unit_price_rm"),
            "source",
            "source_language",
            "line_count",
        )
    )
    correction_window = Window.partitionBy(
        "target_event_id",
        "corrected_line_index",
        "corrected_field",
    ).orderBy(
        F.col("occurred_at").desc(),
        F.col("event_id").desc(),
        F.col("change_index").desc(),
    )
    latest_changes = (
        raw.filter(F.col("event_type") == "correction")
        .withColumn(
            "correction_payload",
            F.from_json(F.col("payload").cast("string"), correction_payload_schema),
        )
        .select(
            F.col("event_id"),
            F.col("occurred_at"),
            F.col("correction_payload.target_event_id").alias("target_event_id"),
            F.posexplode("correction_payload.replacement_payload.changes").alias(
                "change_index", "change"
            ),
        )
        .select(
            "event_id",
            "occurred_at",
            "target_event_id",
            "change_index",
            F.col("change.field").alias("corrected_field"),
            F.col("change.corrected_value").alias("corrected_value"),
            F.col("change.line_index").alias("corrected_line_index"),
        )
        .withColumn("correction_rank", F.row_number().over(correction_window))
        .filter(F.col("correction_rank") == 1)
    )
    latest_line_corrections = (
        latest_changes.filter(F.col("corrected_field") != "source_language")
        .groupBy("target_event_id", "corrected_line_index")
        .agg(
            F.max(
                F.when(
                    F.col("corrected_field") == "product_id",
                    F.col("corrected_value"),
                )
            ).alias("corrected_product_id"),
            F.max(
                F.when(
                    F.col("corrected_field") == "quantity",
                    F.col("corrected_value"),
                )
            ).alias("corrected_quantity"),
            F.max(
                F.when(
                    F.col("corrected_field") == "unit_price_rm",
                    F.col("corrected_value"),
                )
            ).alias("corrected_unit_price_rm"),
        )
    )
    event_correction_window = Window.partitionBy(
        "target_event_id",
        "corrected_field",
    ).orderBy(
        F.col("occurred_at").desc(),
        F.col("event_id").desc(),
        F.col("change_index").desc(),
    )
    latest_event_corrections = (
        latest_changes.filter(F.col("corrected_field") == "source_language")
        .withColumn(
            "event_correction_rank",
            F.row_number().over(event_correction_window),
        )
        .filter(F.col("event_correction_rank") == 1)
        .select(
            "target_event_id",
            F.col("corrected_value").alias("corrected_source_language"),
        )
    )
    sales_alias = sales.alias("sales")
    line_alias = latest_line_corrections.alias("line_corrections")
    event_alias = latest_event_corrections.alias("event_corrections")
    resolved = (
        sales_alias.join(
            line_alias,
            (F.col("sales.source_event_id") == F.col("line_corrections.target_event_id"))
            & (
                (
                    F.col("line_corrections.corrected_line_index")
                    == F.col("sales.line_index")
                )
                | (
                    F.col("line_corrections.corrected_line_index").isNull()
                    & (F.col("sales.line_count") == 1)
                )
            ),
            "left",
        )
        .join(
            event_alias,
            F.col("sales.source_event_id")
            == F.col("event_corrections.target_event_id"),
            "left",
        )
        .select(
            F.col("sales.source_event_id").alias("source_event_id"),
            F.col("sales.merchant_id").alias("merchant_id"),
            F.col("sales.sale_date").alias("sale_date"),
            F.col("sales.line_index").alias("line_index"),
            F.coalesce(
                F.col("line_corrections.corrected_product_id"),
                F.col("sales.original_product_id"),
            ).alias("product_id"),
            F.coalesce(
                F.col("line_corrections.corrected_quantity").cast(quantity_type),
                F.col("sales.original_quantity"),
            ).alias("quantity"),
            F.coalesce(
                F.col("line_corrections.corrected_unit_price_rm").cast(money_type),
                F.col("sales.original_unit_price_rm"),
            ).alias("unit_price_rm"),
            F.col("sales.source").alias("source"),
            F.coalesce(
                F.col("event_corrections.corrected_source_language"),
                F.col("sales.source_language"),
            ).alias("source_language"),
        )
    )
    historical = (
        spark.read.table(historical_sales_source)
        .select(
            F.concat_ws(
                ":",
                F.lit("historical"),
                "merchant_id",
                "product_id",
                F.col("date").cast("string"),
            ).alias("source_event_id"),
            "merchant_id",
            F.to_date("date").alias("sale_date"),
            F.lit(0).cast("int").alias("line_index"),
            "product_id",
            F.col("quantity").cast(quantity_type).alias("quantity"),
            F.col("unit_price_rm").cast(money_type).alias("unit_price_rm"),
            "source",
            F.lit(None).cast("string").alias("source_language"),
        )
    )
    return resolved.unionByName(historical)


@dp.materialized_view(
    name="silver_recipe_components",
    comment="Validated current and baseline component cost per product pack.",
)
@dp.expect_or_drop("valid_event_id", "component_id IS NOT NULL AND length(component_id) > 0")
@dp.expect_or_drop(
    "non_negative_myr_amount",
    "baseline_cost_per_pack_rm >= 0 AND current_cost_per_pack_rm >= 0",
)
def silver_recipe_components():
    return (
        spark.read.table(recipe_components_source)
        .select(
            "merchant_id",
            "product_id",
            "component_id",
            "component_name",
            F.col("baseline_cost_per_pack_rm").cast(money_type),
            F.col("current_cost_per_pack_rm").cast(money_type),
            "uom",
            "effective_at",
            "snapshot_id",
            "snapshot_sequence",
        )
        .dropDuplicates(
            [
                "merchant_id",
                "product_id",
                "component_id",
                "effective_at",
                "snapshot_id",
            ]
        )
    )


@dp.materialized_view(
    name="silver_purchase_receipts",
    comment="Receipt totals accepted only when line reconciliation is within RM0.05.",
)
@dp.expect_or_fail("valid_event_id", "receipt_id IS NOT NULL AND length(receipt_id) > 0")
@dp.expect_or_fail(
    "non_negative_myr_amount",
    "(total_rm IS NULL OR total_rm >= 0) "
    "AND (reconciled_line_total_rm IS NULL OR reconciled_line_total_rm >= 0)",
)
@dp.expect_or_fail(
    "receipt_total_reconciliation",
    "review_state <> 'accepted' OR "
    "(total_rm IS NOT NULL AND reconciled_line_total_rm IS NOT NULL "
    "AND abs(total_rm - reconciled_line_total_rm) <= 0.05)",
)
def silver_purchase_receipts():
    reconciled_line_totals = (
        spark.read.table(purchase_lines_source).groupBy("receipt_id")
        .agg(F.sum(F.col("total_price_rm").cast(money_type)).alias("reconciled_line_total_rm"))
    )
    return (
        spark.read.table(purchase_receipts_source)
        .select(
            "receipt_id",
            "source_event_id",
            "merchant_id",
            "supplier_name",
            F.to_date("receipt_date").alias("receipt_date"),
            "currency",
            F.col("total_rm").cast(money_type),
            F.col("overall_confidence").cast("decimal(5,4)"),
            "review_state",
        )
        .join(reconciled_line_totals, "receipt_id", "left")
    )


@dp.materialized_view(
    name="silver_cost_facts",
    comment="Normalized purchase-line cost facts linked to reconciled receipts.",
)
@dp.expect_or_drop("valid_event_id", "purchase_line_id IS NOT NULL AND length(purchase_line_id) > 0")
@dp.expect_or_drop("positive_quantity", "quantity > 0")
@dp.expect_or_drop(
    "non_negative_myr_amount",
    "total_price_rm >= 0 AND (unit_price_rm IS NULL OR unit_price_rm >= 0)",
)
def silver_cost_facts():
    lines = (
        spark.read.table(purchase_lines_source)
        .select(
            "purchase_line_id",
            "receipt_id",
            "component_id",
            "raw_name",
            F.col("quantity").cast(quantity_type),
            "uom",
            F.col("pack_size").cast(quantity_type),
            F.col("unit_price_rm").cast(money_type),
            F.col("total_price_rm").cast(money_type),
            F.col("confidence").cast("decimal(5,4)").alias("line_confidence"),
        )
    )
    reconciled_receipts = (
        spark.read.table("silver_purchase_receipts")
        .filter(F.col("review_state") == "accepted")
        .select(
            "receipt_id",
            "source_event_id",
            "merchant_id",
            F.col("receipt_date").alias("cost_date"),
            "supplier_name",
            "currency",
            F.col("overall_confidence").alias("receipt_overall_confidence"),
            "review_state",
            F.lit(True).alias("receipt_reconciled"),
        )
    )
    return lines.join(reconciled_receipts, "receipt_id", "inner")


def resolved_components_by_sale_date():
    dates = spark.read.table("silver_sales_facts").select(
        "merchant_id",
        "product_id",
        "sale_date",
    ).distinct()
    merchants = spark.read.table(merchants_source).select("merchant_id", "timezone")
    candidates = (
        dates.join(merchants, "merchant_id", "inner")
        .join(
            spark.read.table("silver_recipe_components"),
            ["merchant_id", "product_id"],
            "inner",
        )
        .withColumn(
            "component_effective_date",
            F.expr("to_date(from_utc_timestamp(effective_at, timezone))"),
        )
        .filter(F.col("component_effective_date") <= F.col("sale_date"))
    )
    component_window = Window.partitionBy(
        "merchant_id",
        "product_id",
        "sale_date",
        "component_id",
    ).orderBy(
        F.col("effective_at").desc(),
        F.col("snapshot_sequence").desc(),
        F.col("snapshot_id").desc(),
    )
    return (
        candidates.withColumn(
            "component_rank",
            F.row_number().over(component_window),
        )
        .filter(F.col("component_rank") == 1)
        .drop("component_rank", "component_effective_date", "timezone")
    )


@dp.materialized_view(
    name="daily_product_metrics",
    comment="Deterministic daily revenue, COGS, gross profit, and gross margin.",
)
@dp.expect_or_fail("positive_quantity", "quantity > 0")
@dp.expect_or_fail(
    "non_negative_myr_amount",
    "revenue_rm >= 0 AND cogs_rm >= 0",
)
def gold_daily_product_metrics():
    sales = spark.read.table("silver_sales_facts")
    components = resolved_components_by_sale_date()
    unit_costs = components.groupBy("merchant_id", "product_id", "sale_date").agg(
        F.sum("current_cost_per_pack_rm").alias("unit_cogs_rm"),
        F.sum("baseline_cost_per_pack_rm").alias("baseline_unit_cogs_rm"),
    )
    daily = sales.groupBy("merchant_id", "product_id", "sale_date").agg(
        F.sum("quantity").alias("quantity"),
        F.sum(F.col("quantity") * F.col("unit_price_rm")).alias("revenue_rm"),
    )
    enriched = daily.join(
        unit_costs,
        ["merchant_id", "product_id", "sale_date"],
        "inner",
    )
    return (
        enriched.withColumn("cogs_rm", F.col("quantity") * F.col("unit_cogs_rm"))
        .withColumn("gross_profit_rm", F.col("revenue_rm") - F.col("cogs_rm"))
        .withColumn(
            "gross_margin_pct",
            F.round(F.col("gross_profit_rm") / F.col("revenue_rm") * F.lit(100), 2),
        )
        .withColumn(
            "baseline_margin_pct",
            F.round(
                (
                    F.col("revenue_rm") / F.col("quantity")
                    - F.col("baseline_unit_cogs_rm")
                )
                / (F.col("revenue_rm") / F.col("quantity"))
                * F.lit(100),
                2,
            ),
        )
        .withColumn(
            "margin_change_percentage_points",
            F.round(F.col("gross_margin_pct") - F.col("baseline_margin_pct"), 2),
        )
        .withColumnRenamed("sale_date", "date")
        .withColumn("data_completeness", F.lit("complete"))
    )


@dp.materialized_view(
    name="cost_driver_metrics",
    comment="Component contributions to per-pack cost change.",
)
@dp.expect_or_drop("non_negative_myr_amount", "contribution_rm_per_pack >= 0")
def gold_cost_driver_metrics():
    components = resolved_components_by_sale_date()
    return (
        components.withColumn(
            "contribution_rm_per_pack",
            F.round(
                F.col("current_cost_per_pack_rm") - F.col("baseline_cost_per_pack_rm"),
                2,
            ),
        )
        .filter(F.col("contribution_rm_per_pack") > 0)
        .select(
            "merchant_id",
            "product_id",
            F.col("sale_date").alias("date"),
            "component_id",
            "component_name",
            "contribution_rm_per_pack",
        )
    )


@dp.materialized_view(
    name="price_scenario_baselines",
    comment="Read-only inputs for constant-demand price and volume simulation.",
)
def gold_price_scenario_baselines():
    metrics = spark.read.table("daily_product_metrics")
    merchants = spark.read.table(merchants_source).select(
        "merchant_id",
        F.col("target_gross_margin_pct").cast("decimal(7,2)"),
    )
    return (
        metrics.join(merchants, "merchant_id", "inner")
        .select(
            "merchant_id",
            "product_id",
            F.col("date").alias("as_of"),
            F.col("quantity").alias("current_quantity"),
            F.round(F.col("revenue_rm") / F.col("quantity"), 2).alias("current_unit_price_rm"),
            "unit_cogs_rm",
            "gross_profit_rm",
            "target_gross_margin_pct",
            F.round(
                F.col("unit_cogs_rm")
                / (F.lit(1) - F.col("target_gross_margin_pct") / F.lit(100)),
                2,
            ).alias("price_floor_rm"),
            F.lit("constant_demand").alias("assumption"),
        )
    )
