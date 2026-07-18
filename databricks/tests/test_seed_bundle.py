import tempfile
import unittest
from pathlib import Path

from databricks.platform import build_seed_bundle


ROOT = Path(__file__).resolve().parents[2]
SEED_DIR = ROOT / "PasarAI_Handoff_Package" / "demo_data" / "seed_data"


class SeedBundleTests(unittest.TestCase):
    def test_all_authoritative_fixtures_load_idempotently(self):
        first = build_seed_bundle(SEED_DIR)
        second = build_seed_bundle(SEED_DIR)

        self.assertEqual(first, second)
        self.assertEqual(
            first["source_files"],
            [
                "expected_metrics.json",
                "ingredient_price_history.csv",
                "merchant.json",
                "products.csv",
                "receipt_ground_truth.json",
                "recipe_components.csv",
                "sales_history.csv",
                "today_events.json",
            ],
        )
        self.assertEqual(first["merchant"]["merchant_id"], "m_kak_lina_001")
        self.assertEqual(len(first["products"]), 3)
        self.assertEqual(len(first["recipe_components"]), 18)
        self.assertEqual(len(first["historical_sales"]), 7)
        self.assertEqual(len(first["raw_events"]), 4)
        self.assertEqual(len(first["receipt_ground_truth"]), 3)
        self.assertEqual(
            {
                receipt["receipt_id"]: receipt["review_state"]
                for receipt in first["receipt_ground_truth"].values()
            },
            {
                "SBR-120726-184": "accepted",
                "PPT-260712-077": "accepted",
                "PPSS2-1207": "pending",
            },
        )
        self.assertTrue(
            all(
                receipt["overall_confidence"] is None
                for receipt in first["receipt_ground_truth"].values()
            )
        )
        self.assertEqual(
            first["synthetic_sales_candidates"],
            [
                {
                    "source_event_id": "evt_voice_001",
                    "merchant_id": "m_kak_lina_001",
                    "occurred_at": "2026-07-12T14:30:00+08:00",
                    "line_index": 0,
                    "product_id": "p_nlb_001",
                    "quantity": "40",
                    "unit_price_rm": "5.00",
                    "source": "voice_agent",
                    "source_language": "ms-en",
                }
            ],
        )


if __name__ == "__main__":
    unittest.main()
