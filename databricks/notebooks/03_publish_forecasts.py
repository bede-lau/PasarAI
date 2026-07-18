# Databricks notebook source
"""Generate shadow forecasts from Gold metrics and upsert them into Lakebase."""

from __future__ import annotations

import os
import re
from typing import Any, Iterable, Mapping

from databricks.platform.forecasting import ForecastConfig, generate_forecasts


SIMPLE_IDENTIFIER = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
FORECAST_COLUMNS = (
    "merchant_id",
    "product_id",
    "forecast_date",
    "horizon_day",
    "p10",
    "p50",
    "p90",
    "eligibility_status",
    "visibility_status",
    "accuracy_gate_passed",
    "selected_model",
    "model_version",
    "forecast_version",
    "generated_at",
    "source_watermark",
    "source_row_count",
    "usable_day_count",
    "diagnostics_json",
)


def _widget_value(dbutils: Any, name: str, default: str = "") -> str:
    dbutils.widgets.text(name, default)
    return dbutils.widgets.get(name).strip()


def _configured_value(
    dbutils: Any,
    widget_name: str,
    environment_name: str,
    default: str = "",
) -> str:
    return _widget_value(dbutils, widget_name, os.environ.get(environment_name, default))


def _quoted_table_identifier(value: str) -> str:
    parts = value.split(".")
    if not 1 <= len(parts) <= 2 or any(
        not SIMPLE_IDENTIFIER.fullmatch(part) for part in parts
    ):
        raise ValueError("Lakebase table must be table or schema.table")
    return ".".join(f'"{part}"' for part in parts)


def _delta_table_name(catalog: str, schema: str, table: str) -> str:
    for label, value in [
        ("target_catalog", catalog),
        ("target_schema", schema),
        ("source_table", table),
    ]:
        if not SIMPLE_IDENTIFIER.fullmatch(value):
            raise ValueError(f"{label} must be a simple workspace identifier")
    return f"{catalog}.{schema}.{table}"


def _read_daily_metrics(spark: Any, table_name: str) -> list[dict[str, Any]]:
    dataframe = spark.table(table_name)
    required = {"merchant_id", "product_id", "date", "quantity"}
    missing = sorted(required.difference(dataframe.columns))
    if missing:
        raise ValueError(
            "daily_product_metrics is missing required columns "
            + ", ".join(missing)
        )
    optional = [
        column
        for column in (
            "data_completeness",
            "is_complete",
            "sold_out",
            "is_sold_out",
            "censored",
            "is_censored",
            "demand_censored",
        )
        if column in dataframe.columns
    ]
    selected = dataframe.select(
        "merchant_id",
        "product_id",
        "date",
        "quantity",
        *optional,
    )
    return [row.asDict(recursive=True) for row in selected.toLocalIterator()]


def _flatten_forecasts(results: Iterable[Mapping[str, Any]]) -> list[dict[str, Any]]:
    return [
        record
        for result in results
        for record in result["forecasts"]
    ]


def _upsert_forecasts(
    spark: Any,
    *,
    jdbc_url: str,
    jdbc_user: str,
    jdbc_password: str,
    target_table: str,
    records: Iterable[Mapping[str, Any]],
) -> int:
    records = list(records)
    if not records:
        return 0
    quoted_table = _quoted_table_identifier(target_table)
    insert_columns = ", ".join(f'"{column}"' for column in FORECAST_COLUMNS)
    update_columns = [
        column
        for column in FORECAST_COLUMNS
        if column not in {
            "merchant_id",
            "product_id",
            "forecast_date",
            "forecast_version",
        }
    ]
    update_clause = ", ".join(
        f'"{column}" = EXCLUDED."{column}"' for column in update_columns
    )
    placeholders = (
        "?, ?, CAST(? AS date), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, "
        "CAST(? AS timestamptz), CAST(? AS date), ?, ?, CAST(? AS jsonb)"
    )
    sql = f"""
        INSERT INTO {quoted_table} ({insert_columns})
        VALUES ({placeholders})
        ON CONFLICT ("merchant_id", "product_id", "forecast_date", "forecast_version")
        DO UPDATE SET {update_clause}
    """

    jvm = spark.sparkContext._gateway.jvm
    jvm.java.lang.Class.forName("org.postgresql.Driver")
    connection = jvm.java.sql.DriverManager.getConnection(
        jdbc_url,
        jdbc_user,
        jdbc_password,
    )
    statement = None
    try:
        connection.setAutoCommit(False)
        statement = connection.prepareStatement(sql)
        for record in records:
            statement.setString(1, str(record["merchant_id"]))
            statement.setString(2, str(record["product_id"]))
            statement.setString(3, str(record["forecast_date"]))
            statement.setInt(4, int(record["horizon_day"]))
            statement.setDouble(5, float(record["p10"]))
            statement.setDouble(6, float(record["p50"]))
            statement.setDouble(7, float(record["p90"]))
            statement.setString(8, str(record["eligibility_status"]))
            statement.setString(9, str(record["visibility_status"]))
            statement.setBoolean(10, bool(record["accuracy_gate_passed"]))
            statement.setString(11, str(record["selected_model"]))
            statement.setString(12, str(record["model_version"]))
            statement.setString(13, str(record["forecast_version"]))
            statement.setString(14, str(record["generated_at"]))
            statement.setString(15, str(record["source_watermark"]))
            statement.setInt(16, int(record["source_row_count"]))
            statement.setInt(17, int(record["usable_day_count"]))
            statement.setString(18, str(record["diagnostics_json"]))
            statement.addBatch()
        statement.executeBatch()
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        if statement is not None:
            statement.close()
        connection.close()
    return len(records)


def run_notebook(
    *,
    spark: Any | None = None,
    dbutils: Any | None = None,
) -> dict[str, int]:
    spark = spark or globals().get("spark")
    dbutils = dbutils or globals().get("dbutils")
    if spark is None or dbutils is None:
        raise RuntimeError("run_notebook requires Databricks spark and dbutils")

    target_catalog = _configured_value(
        dbutils,
        "target_catalog",
        "PASARAI_TARGET_CATALOG",
    )
    target_schema = _configured_value(
        dbutils,
        "target_schema",
        "PASARAI_TARGET_SCHEMA",
    )
    source_table = _configured_value(
        dbutils,
        "source_table",
        "PASARAI_FORECAST_SOURCE_TABLE",
        "daily_product_metrics",
    )
    jdbc_url = _configured_value(
        dbutils,
        "lakebase_jdbc_url",
        "PASARAI_LAKEBASE_JDBC_URL",
    )
    jdbc_user = _configured_value(
        dbutils,
        "lakebase_user",
        "PASARAI_LAKEBASE_USER",
    )
    target_table = _configured_value(
        dbutils,
        "lakebase_forecast_table",
        "PASARAI_LAKEBASE_FORECAST_TABLE",
        "analytics_forecasts",
    )
    password_scope = _configured_value(
        dbutils,
        "lakebase_password_secret_scope",
        "PASARAI_LAKEBASE_PASSWORD_SECRET_SCOPE",
    )
    password_key = _configured_value(
        dbutils,
        "lakebase_password_secret_key",
        "PASARAI_LAKEBASE_PASSWORD_SECRET_KEY",
    )
    horizon_days = int(
        _configured_value(
            dbutils,
            "forecast_horizon_days",
            "PASARAI_FORECAST_HORIZON_DAYS",
            "14",
        )
    )
    maximum_wape = float(
        _configured_value(
            dbutils,
            "forecast_maximum_wape",
            "PASARAI_FORECAST_MAXIMUM_WAPE",
            "0.35",
        )
    )
    forecast_version = _configured_value(
        dbutils,
        "forecast_version",
        "PASARAI_FORECAST_VERSION",
    ) or None

    for label, value in [
        ("target_catalog", target_catalog),
        ("target_schema", target_schema),
        ("lakebase_jdbc_url", jdbc_url),
        ("lakebase_user", jdbc_user),
    ]:
        if not value:
            raise ValueError(f"{label} is required")
    if bool(password_scope) != bool(password_key):
        raise ValueError("Lakebase password secret scope and key must be provided together")
    jdbc_password = (
        dbutils.secrets.get(scope=password_scope, key=password_key)
        if password_scope
        else os.environ.get("PASARAI_LAKEBASE_PASSWORD", "")
    )
    if not jdbc_password:
        raise ValueError(
            "Lakebase password must come from a Databricks secret or "
            "PASARAI_LAKEBASE_PASSWORD"
        )

    metrics_table = _delta_table_name(
        target_catalog,
        target_schema,
        source_table,
    )
    metric_rows = _read_daily_metrics(spark, metrics_table)
    results = generate_forecasts(
        metric_rows,
        config=ForecastConfig(
            horizon_days=horizon_days,
            maximum_wape=maximum_wape,
        ),
        forecast_version=forecast_version,
    )
    records = _flatten_forecasts(results)
    published = _upsert_forecasts(
        spark,
        jdbc_url=jdbc_url,
        jdbc_user=jdbc_user,
        jdbc_password=jdbc_password,
        target_table=target_table,
        records=records,
    )
    summary = {
        "series_evaluated": len(results),
        "series_unavailable": sum(
            result["eligibility_status"] == "unavailable" for result in results
        ),
        "series_shadow": sum(
            result["visibility_status"] == "shadow" for result in results
        ),
        "series_display": sum(
            result["visibility_status"] == "display" for result in results
        ),
        "records_published": published,
    }
    print(f"PasarAI forecast publication completed: {summary}")
    return summary


if __name__ == "__main__":
    run_notebook()
