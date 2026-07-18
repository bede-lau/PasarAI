import importlib.util
import unittest
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from databricks.platform.forecasting import (
    ForecastConfig,
    MODEL_NAMES,
    forecast_product,
    generate_forecasts,
)


ROOT = Path(__file__).resolve().parents[2]
NOTEBOOK_PATH = ROOT / "databricks" / "notebooks" / "03_publish_forecasts.py"
GENERATED_AT = datetime(2026, 7, 16, 4, 0, tzinfo=timezone.utc)


def metric_rows(
    count,
    *,
    start=date(2026, 1, 1),
    merchant_id="m_001",
    product_id="p_001",
    quantity=None,
):
    quantity = quantity or (lambda index, day: 20 + day.weekday())
    return [
        {
            "merchant_id": merchant_id,
            "product_id": product_id,
            "date": start + timedelta(days=index),
            "quantity": quantity(index, start + timedelta(days=index)),
            "data_completeness": "complete",
        }
        for index in range(count)
    ]


class ForecastingTests(unittest.TestCase):
    def test_too_short_history_is_unavailable(self):
        result = forecast_product(metric_rows(27), generated_at=GENERATED_AT)

        self.assertEqual(result["eligibility_status"], "unavailable")
        self.assertEqual(result["visibility_status"], "unavailable")
        self.assertEqual(result["usable_day_count"], 27)
        self.assertEqual(result["forecasts"], [])

    def test_28_to_55_usable_days_remain_shadow(self):
        result = forecast_product(
            metric_rows(40),
            config=ForecastConfig(horizon_days=3),
            generated_at=GENERATED_AT,
        )

        self.assertEqual(result["eligibility_status"], "shadow")
        self.assertEqual(result["visibility_status"], "shadow")
        self.assertTrue(result["accuracy_gate_passed"])
        self.assertEqual(len(result["forecasts"]), 3)
        self.assertTrue(all(row["visibility_status"] == "shadow" for row in result["forecasts"]))

    def test_incomplete_and_censored_days_are_excluded(self):
        rows = metric_rows(61)
        rows[10]["data_completeness"] = "partial"
        rows[20]["is_complete"] = "false"
        rows[30]["sold_out"] = True
        rows[40]["is_censored"] = "true"
        rows[60]["data_completeness"] = "incomplete"
        rows[60]["quantity"] = 9999

        result = forecast_product(
            rows,
            config=ForecastConfig(horizon_days=1),
            generated_at=GENERATED_AT,
        )

        self.assertEqual(result["source_row_count"], 61)
        self.assertEqual(result["usable_day_count"], 56)
        self.assertEqual(result["excluded_incomplete_day_count"], 3)
        self.assertEqual(result["excluded_censored_day_count"], 2)
        self.assertEqual(result["source_watermark"], "2026-03-02")
        self.assertEqual(result["eligibility_status"], "display_candidate")
        self.assertLess(result["forecasts"][0]["p50"], 100)
        self.assertEqual(result["forecasts"][0]["forecast_date"], "2026-03-02")

    def test_eligible_series_emits_versioned_quantiles_and_diagnostics(self):
        result = forecast_product(
            metric_rows(70),
            config=ForecastConfig(horizon_days=4),
            generated_at=GENERATED_AT,
            forecast_version="daily-2026-07-16",
        )

        self.assertEqual(result["eligibility_status"], "display_candidate")
        self.assertEqual(result["visibility_status"], "display")
        self.assertTrue(result["accuracy_gate_passed"])
        self.assertIn(result["selected_model"], MODEL_NAMES)
        self.assertEqual(
            {item["model_name"] for item in result["diagnostics"]["models"]},
            set(MODEL_NAMES),
        )
        self.assertEqual(len(result["forecasts"]), 4)
        for row in result["forecasts"]:
            self.assertLessEqual(row["p10"], row["p50"])
            self.assertLessEqual(row["p50"], row["p90"])
            self.assertEqual(row["forecast_version"], "daily-2026-07-16")
            self.assertEqual(row["source_watermark"], "2026-03-11")
            self.assertIn('"accuracy_gate"', row["diagnostics_json"])

    def test_failed_accuracy_gate_keeps_display_candidate_in_shadow(self):
        rows = metric_rows(
            70,
            quantity=lambda index, day: 1 + ((index * 37 + index * index * 11) % 47),
        )
        result = forecast_product(
            rows,
            config=ForecastConfig(horizon_days=2, maximum_wape=0.01),
            generated_at=GENERATED_AT,
        )

        self.assertEqual(result["eligibility_status"], "display_candidate")
        self.assertFalse(result["accuracy_gate_passed"])
        self.assertEqual(result["visibility_status"], "shadow")
        self.assertTrue(all(row["visibility_status"] == "shadow" for row in result["forecasts"]))

    def test_generate_forecasts_groups_series_deterministically(self):
        rows = metric_rows(28, merchant_id="m_b", product_id="p_2")
        rows.extend(metric_rows(28, merchant_id="m_a", product_id="p_1"))

        results = generate_forecasts(rows, generated_at=GENERATED_AT)

        self.assertEqual(
            [(result["merchant_id"], result["product_id"]) for result in results],
            [("m_a", "p_1"), ("m_b", "p_2")],
        )

    def test_notebook_import_does_not_require_pyspark_or_databricks_globals(self):
        spec = importlib.util.spec_from_file_location("publish_forecasts", NOTEBOOK_PATH)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)

        self.assertEqual(
            module._quoted_table_identifier("analytics.analytics_forecasts"),
            '"analytics"."analytics_forecasts"',
        )
        with self.assertRaisesRegex(RuntimeError, "requires Databricks"):
            module.run_notebook()


if __name__ == "__main__":
    unittest.main()
