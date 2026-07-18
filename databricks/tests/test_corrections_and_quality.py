import json
import shutil
import tempfile
import unittest
from pathlib import Path

from databricks.platform import DataQualityError, build_platform_snapshot
from databricks.platform.pipeline_snapshot import _resolve_corrections


ROOT = Path(__file__).resolve().parents[2]
SEED_DIR = ROOT / "PasarAI_Handoff_Package" / "demo_data" / "seed_data"


class CorrectionsAndQualityTests(unittest.TestCase):
    def test_correction_resolves_in_silver_and_gold_without_mutating_bronze(self):
        correction = {
            "event_id": "evt_correction_001",
            "type": "correction",
            "occurred_at": "2026-07-12T15:00:00+08:00",
            "source": "text_reply",
            "target_event_id": "evt_voice_001",
            "replacement_payload": {
                "changes": [
                    {
                        "kind": "decimal",
                        "field": "quantity",
                        "previous_value": "40",
                        "corrected_value": "38",
                    }
                ]
            },
            "evidence": {"transcript": "The 40 packs earlier should be 38."},
        }

        snapshot = build_platform_snapshot(SEED_DIR, corrections=[correction])

        original = next(
            event
            for event in snapshot["bronze"]["raw_events"]
            if event["event_id"] == "evt_voice_001"
        )
        resolved = next(
            row
            for row in snapshot["silver"]["resolved_sales"]
            if row["source_event_id"] == "evt_voice_001"
        )
        daily = next(
            row
            for row in snapshot["gold"]["daily_product_metrics"]
            if row["date"] == "2026-07-12"
        )

        self.assertNotIn("replacement_payload", original)
        self.assertEqual(len(snapshot["bronze"]["raw_events"]), 5)
        self.assertEqual(resolved["source_event_id"], "evt_voice_001")
        self.assertEqual(resolved["quantity"], "38")
        self.assertEqual(daily["quantity"], "38")
        self.assertEqual(daily["revenue_rm"], "190.00")
        self.assertEqual(daily["cogs_rm"], "120.84")
        self.assertEqual(daily["gross_profit_rm"], "69.16")

    def test_receipt_total_mismatch_over_five_sen_fails_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            seed_copy = Path(directory) / "seed_data"
            shutil.copytree(SEED_DIR, seed_copy)
            receipts_path = seed_copy / "receipt_ground_truth.json"
            receipts = json.loads(receipts_path.read_text(encoding="utf-8"))
            receipts["receipt_001_sinar_borong.jpg"]["total_rm"] = 140.0
            receipts_path.write_text(
                json.dumps(receipts, indent=2) + "\n",
                encoding="utf-8",
            )

            with self.assertRaises(DataQualityError) as raised:
                build_platform_snapshot(seed_copy)

        self.assertIn("receipt_total_reconciliation", raised.exception.violations)

    def test_multiple_append_only_corrections_resolve_latest_value_per_field(self):
        corrections = [
            {
                "event_id": "evt_correction_001",
                "type": "correction",
                "occurred_at": "2026-07-12T15:00:00+08:00",
                "source": "text_reply",
                "target_event_id": "evt_voice_001",
                "replacement_payload": {
                    "changes": [
                        {
                            "kind": "decimal",
                            "field": "quantity",
                            "corrected_value": "38",
                        },
                        {
                            "kind": "money",
                            "field": "unit_price_rm",
                            "corrected_value": "5.50",
                        },
                    ]
                },
                "evidence": {"transcript": "Make that 38 packs at RM5.50."},
            },
            {
                "event_id": "evt_correction_002",
                "type": "correction",
                "occurred_at": "2026-07-12T15:05:00+08:00",
                "source": "text_reply",
                "target_event_id": "evt_voice_001",
                "replacement_payload": {
                    "changes": [
                        {
                            "kind": "decimal",
                            "field": "quantity",
                            "corrected_value": "39",
                        }
                    ]
                },
                "evidence": {"transcript": "Final count was 39."},
            },
        ]

        snapshot = build_platform_snapshot(SEED_DIR, corrections=corrections)
        resolved = next(
            row
            for row in snapshot["silver"]["resolved_sales"]
            if row["source_event_id"] == "evt_voice_001"
        )
        daily = next(
            row
            for row in snapshot["gold"]["daily_product_metrics"]
            if row["date"] == "2026-07-12"
        )

        self.assertEqual(len(snapshot["bronze"]["raw_events"]), 6)
        self.assertEqual(resolved["quantity"], "39")
        self.assertEqual(resolved["unit_price_rm"], "5.50")
        self.assertEqual(daily["revenue_rm"], "214.50")

    def test_line_scoped_corrections_only_change_the_matching_sale_line(self):
        sales = [
            {
                "source_event_id": "evt_multi",
                "line_index": 0,
                "product_id": "p_first",
                "quantity": "2",
                "unit_price_rm": "5.00",
                "source_language": "ms",
            },
            {
                "source_event_id": "evt_multi",
                "line_index": 1,
                "product_id": "p_second",
                "quantity": "3",
                "unit_price_rm": "6.00",
                "source_language": "ms",
            },
        ]
        correction = {
            "event_id": "evt_correction_multi",
            "type": "correction",
            "occurred_at": "2026-07-12T15:10:00+08:00",
            "target_event_id": "evt_multi",
            "replacement_payload": {
                "changes": [
                    {
                        "field": "quantity",
                        "line_index": 1,
                        "corrected_value": "4",
                    },
                    {
                        "field": "source_language",
                        "corrected_value": "en",
                    },
                ]
            },
        }

        resolved = _resolve_corrections(sales, [correction])

        self.assertEqual(resolved[0]["quantity"], "2")
        self.assertEqual(resolved[1]["quantity"], "4")
        self.assertEqual(
            [row["source_language"] for row in resolved],
            ["en", "en"],
        )

        correction["replacement_payload"]["changes"][0].pop("line_index")
        with self.assertRaises(DataQualityError) as raised:
            _resolve_corrections(sales, [correction])
        self.assertIn(
            "correction_line_index_required",
            raised.exception.violations,
        )


if __name__ == "__main__":
    unittest.main()
