import unittest

from databricks.lakebase import InMemoryLakebaseRepository


class LakebaseRepositoryTests(unittest.TestCase):
    def test_mutations_are_idempotent_and_corrections_are_append_only(self):
        repository = InMemoryLakebaseRepository()
        sale = {
            "type": "sales_report",
            "occurred_at": "2026-07-12T14:30:00+08:00",
            "evidence": {"transcript": "Sold 40 packs at RM5."},
        }

        first_id = repository.append_raw_event(
            merchant_id="m_kak_lina_001",
            endpoint_id="sales.create",
            idempotency_key="telegram:update:1001",
            payload=sale,
        )
        second_id = repository.append_raw_event(
            merchant_id="m_kak_lina_001",
            endpoint_id="sales.create",
            idempotency_key="telegram:update:1001",
            payload=sale,
        )
        with self.assertRaisesRegex(ValueError, "different payload"):
            repository.append_raw_event(
                merchant_id="m_kak_lina_001",
                endpoint_id="sales.create",
                idempotency_key="telegram:update:1001",
                payload={"type": "should_not_replace"},
            )
        other_endpoint_id = repository.append_raw_event(
            merchant_id="m_kak_lina_001",
            endpoint_id="costs.create",
            idempotency_key="telegram:update:1001",
            payload=sale,
        )
        correction_id = repository.append_correction(
            merchant_id="m_kak_lina_001",
            idempotency_key="telegram:update:1002",
            target_event_id=first_id,
            occurred_at="2026-07-12T15:00:00+08:00",
            reason="Quantity correction",
            replacement_payload={
                "changes": [
                    {
                        "kind": "decimal",
                        "field": "quantity",
                        "corrected_value": "38",
                    }
                ]
            },
            evidence={"transcript": "The earlier 40 should be 38."},
        )

        events = repository.events()
        self.assertEqual(first_id, second_id)
        self.assertNotEqual(first_id, other_endpoint_id)
        self.assertNotEqual(first_id, correction_id)
        self.assertEqual(len(events), 3)
        self.assertEqual(events[0]["endpoint_id"], "sales.create")
        self.assertEqual(events[1]["endpoint_id"], "costs.create")
        self.assertEqual(events[2]["endpoint_id"], "corrections.create")
        self.assertEqual(events[0]["payload"], sale)
        self.assertEqual(events[2]["payload"]["target_event_id"], first_id)

        events[0]["payload"]["type"] = "mutated_by_caller"
        self.assertEqual(repository.events()[0]["payload"]["type"], "sales_report")


if __name__ == "__main__":
    unittest.main()
