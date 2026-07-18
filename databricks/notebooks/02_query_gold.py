# Databricks notebook source
"""Display PasarAI Gold datasets and verify the fixture-driven golden result."""

import json
import re
from decimal import Decimal


dbutils.widgets.text("target_catalog", "")
dbutils.widgets.text("target_schema", "")

target_catalog = dbutils.widgets.get("target_catalog")
target_schema = dbutils.widgets.get("target_schema")
identifier_pattern = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
for label, value in [("target_catalog", target_catalog), ("target_schema", target_schema)]:
    if not identifier_pattern.fullmatch(value):
        raise ValueError(f"{label} must be a simple workspace identifier")


def table_name(name):
    return f"{target_catalog}.{target_schema}.{name}"


daily_product_metrics = spark.table(table_name("daily_product_metrics"))
cost_driver_metrics = spark.table(table_name("cost_driver_metrics"))
price_scenario_baselines = spark.table(table_name("price_scenario_baselines"))

display(daily_product_metrics.orderBy("date", "product_id"))
display(
    cost_driver_metrics.orderBy(
        "date",
        "product_id",
        cost_driver_metrics.contribution_rm_per_pack.desc(),
    )
)
display(price_scenario_baselines.orderBy("as_of", "product_id"))

expected_document = (
    spark.table(table_name("seed_expected_metrics"))
    .filter("fixture_name = 'expected_metrics.json'")
    .select("document_json")
    .first()
)
if expected_document is None:
    raise RuntimeError("Run 01_seed_synthetic_data.py before the Gold query notebook")

expected = json.loads(expected_document["document_json"])
today = (
    daily_product_metrics.filter(
        "merchant_id = 'm_kak_lina_001' AND product_id = 'p_nlb_001' AND date = '2026-07-12'"
    )
    .first()
)
if today is None:
    raise AssertionError("Golden daily row was not produced")

checks = {
    "revenue_rm": Decimal(str(expected["today"]["revenue_rm"])),
    "cogs_rm": Decimal(str(expected["today"]["cogs_rm"])),
    "gross_profit_rm": Decimal(str(expected["today"]["gross_profit_rm"])),
    "gross_margin_pct": Decimal(str(expected["today"]["gross_margin_pct"])),
}
for field, expected_value in checks.items():
    actual_value = Decimal(str(today[field]))
    if actual_value != expected_value:
        raise AssertionError(f"{field}: expected {expected_value}, found {actual_value}")

print("PasarAI Gold golden metrics: PASS")
