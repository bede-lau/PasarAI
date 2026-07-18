import json
import csv
import shutil
import tempfile
import unittest
from decimal import Decimal
from pathlib import Path

from databricks.platform import build_platform_snapshot


ROOT = Path(__file__).resolve().parents[2]
SEED_DIR = ROOT / "PasarAI_Handoff_Package" / "demo_data" / "seed_data"


class PipelineSnapshotTests(unittest.TestCase):
    def test_one_run_matches_golden_daily_metrics(self):
        expected = json.loads((SEED_DIR / "expected_metrics.json").read_text(encoding="utf-8"))

        snapshot = build_platform_snapshot(SEED_DIR)
        daily = next(
            row
            for row in snapshot["gold"]["daily_product_metrics"]
            if row["date"] == "2026-07-12"
        )

        self.assertEqual(len(snapshot["bronze"]["raw_events"]), 4)
        self.assertEqual(snapshot["bronze"]["raw_events"][2]["event_id"], "evt_voice_001")
        self.assertEqual(len(snapshot["silver"]["resolved_sales"]), 8)
        self.assertEqual(len(snapshot["gold"]["daily_product_metrics"]), 8)
        self.assertEqual(len(snapshot["silver"]["cost_facts"]), 6)
        self.assertNotIn(
            "PPSS2-1207",
            {row["receipt_id"] for row in snapshot["silver"]["cost_facts"]},
        )
        self.assertEqual(
            sum(
                (
                    Decimal(row["total_price_rm"])
                    for row in snapshot["silver"]["cost_facts"]
                    if row["receipt_id"] == "PPT-260712-077"
                ),
                start=Decimal("0"),
            ),
            Decimal("50.30"),
        )
        self.assertEqual(daily["merchant_id"], "m_kak_lina_001")
        self.assertEqual(daily["product_id"], "p_nlb_001")
        self.assertEqual(daily["date"], "2026-07-12")
        self.assertEqual(daily["quantity"], "40")
        self.assertEqual(daily["unit_cogs_rm"], f"{expected['current_unit_cogs_rm']:.2f}")
        self.assertEqual(daily["revenue_rm"], f"{expected['today']['revenue_rm']:.2f}")
        self.assertEqual(daily["cogs_rm"], f"{expected['today']['cogs_rm']:.2f}")
        self.assertEqual(daily["gross_profit_rm"], f"{expected['today']['gross_profit_rm']:.2f}")
        self.assertEqual(daily["gross_margin_pct"], f"{expected['today']['gross_margin_pct']:.2f}")
        self.assertEqual(
            daily["margin_change_percentage_points"],
            f"{expected['today']['margin_change_percentage_points']:.2f}",
        )
        self.assertEqual(
            snapshot["gold"]["cost_driver_metrics"],
            [
                {
                    "merchant_id": "m_kak_lina_001",
                    "product_id": "p_nlb_001",
                    "date": "2026-07-12",
                    "component_id": "c_egg",
                    "component_name": "Telur",
                    "contribution_rm_per_pack": "0.10",
                },
                {
                    "merchant_id": "m_kak_lina_001",
                    "product_id": "p_nlb_001",
                    "date": "2026-07-12",
                    "component_id": "c_sambal",
                    "component_name": "Sambal + Minyak",
                    "contribution_rm_per_pack": "0.08",
                },
                {
                    "merchant_id": "m_kak_lina_001",
                    "product_id": "p_nlb_001",
                    "date": "2026-07-12",
                    "component_id": "c_coconut",
                    "component_name": "Santan",
                    "contribution_rm_per_pack": "0.06",
                },
                {
                    "merchant_id": "m_kak_lina_001",
                    "product_id": "p_nlb_001",
                    "date": "2026-07-12",
                    "component_id": "c_packaging",
                    "component_name": "Bekas Makanan",
                    "contribution_rm_per_pack": "0.04",
                },
            ],
        )
        historical = next(
            row
            for row in snapshot["gold"]["daily_product_metrics"]
            if row["date"] == "2026-07-05"
        )
        self.assertEqual(historical["quantity"], "52")
        self.assertEqual(historical["unit_cogs_rm"], "2.90")
        self.assertEqual(historical["gross_profit_rm"], "109.20")
        scenario_baseline = next(
            row
            for row in snapshot["gold"]["price_scenario_baselines"]
            if row["as_of"] == "2026-07-12"
        )
        self.assertEqual(
            scenario_baseline["price_floor_rm"],
            f"{expected['price_floor_for_40pct_margin_rm']:.2f}",
        )
        self.assertEqual(scenario_baseline["target_gross_margin_pct"], "40.00")

    def test_recipe_component_history_uses_only_latest_effective_snapshot(self):
        with tempfile.TemporaryDirectory() as directory:
            seed_copy = Path(directory) / "seed_data"
            shutil.copytree(SEED_DIR, seed_copy)
            recipe_path = seed_copy / "recipe_components.csv"
            with recipe_path.open(encoding="utf-8", newline="") as handle:
                rows = list(csv.DictReader(handle))
            fieldnames = [*rows[0], "effective_at"]
            for row in rows:
                row["effective_at"] = "2026-07-01T00:00:00+08:00"
            latest = dict(next(row for row in rows if row["component_id"] == "c_egg"))
            latest["current_cost_per_pack_rm"] = "0.65"
            latest["effective_at"] = "2026-07-12T12:00:00+08:00"
            rows.append(latest)
            with recipe_path.open("w", encoding="utf-8", newline="") as handle:
                writer = csv.DictWriter(handle, fieldnames=fieldnames)
                writer.writeheader()
                writer.writerows(rows)

            snapshot = build_platform_snapshot(seed_copy)

        daily = next(
            row
            for row in snapshot["gold"]["daily_product_metrics"]
            if row["date"] == "2026-07-12"
        )
        self.assertEqual(daily["unit_cogs_rm"], "3.28")
        self.assertEqual(daily["cogs_rm"], "131.20")

    def test_receipt_confidence_and_review_state_are_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            seed_copy = Path(directory) / "seed_data"
            shutil.copytree(SEED_DIR, seed_copy)
            receipts_path = seed_copy / "receipt_ground_truth.json"
            receipts = json.loads(receipts_path.read_text(encoding="utf-8"))
            accepted = receipts["receipt_001_sinar_borong.jpg"]
            accepted["overall_confidence"] = 0.88
            accepted["review_state"] = "accepted"
            accepted["line_items"][0]["confidence"] = 0.77
            pending = receipts["receipt_003_pasar_pagi.jpg"]
            pending["overall_confidence"] = 0.41
            pending["review_state"] = "pending"
            receipts_path.write_text(
                json.dumps(receipts, indent=2) + "\n",
                encoding="utf-8",
            )

            snapshot = build_platform_snapshot(seed_copy)

        fact = next(
            row
            for row in snapshot["silver"]["cost_facts"]
            if row["purchase_line_id"] == "SBR-120726-184:1"
        )
        self.assertEqual(fact["receipt_overall_confidence"], 0.88)
        self.assertEqual(fact["line_confidence"], 0.77)
        self.assertEqual(fact["receipt_review_state"], "accepted")
        self.assertNotIn(
            "PPSS2-1207",
            {row["receipt_id"] for row in snapshot["silver"]["cost_facts"]},
        )

    def test_sale_date_uses_merchant_timezone(self):
        with tempfile.TemporaryDirectory() as directory:
            seed_copy = Path(directory) / "seed_data"
            shutil.copytree(SEED_DIR, seed_copy)
            events_path = seed_copy / "today_events.json"
            events = json.loads(events_path.read_text(encoding="utf-8"))
            sale = next(event for event in events if event["event_id"] == "evt_voice_001")
            sale["occurred_at"] = "2026-07-11T16:30:00+00:00"
            events_path.write_text(
                json.dumps(events, indent=2) + "\n",
                encoding="utf-8",
            )

            snapshot = build_platform_snapshot(seed_copy)

        resolved = next(
            row
            for row in snapshot["silver"]["resolved_sales"]
            if row["source_event_id"] == "evt_voice_001"
        )
        self.assertEqual(resolved["sale_date"], "2026-07-12")


if __name__ == "__main__":
    unittest.main()
