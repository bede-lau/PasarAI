# New purchase receipt demo

These six files are fictional receipt images for demonstrating the receipt
upload, review, confirmation and cost-change flow. They extend the original
golden demo without changing its seeded metrics.

All supplier names, addresses, receipt IDs and purchases are synthetic. Every
image is marked `SYNTHETIC DEMO RECEIPT` and `NOT VALID FOR PURCHASE`.

## Suggested upload order

| Order | File | Date | Main cost story |
| --- | --- | --- | --- |
| 1 | `receipts/receipt_004_cerah_borong.jpg` | 2026-07-13 | Eggs, cooking oil and coconut milk increase. |
| 2 | `receipts/receipt_005_pakar_pek.jpg` | 2026-07-13 | Food-container packaging increases by 8%. |
| 3 | `receipts/receipt_006_pasar_harian_megah.jpg` | 2026-07-14 | Cucumber, peanuts and anchovies increase. |
| 4 | `receipts/receipt_007_maju_beras.jpg` | 2026-07-15 | Rice gets its first purchase price; coconut milk falls slightly. |
| 5 | `receipts/receipt_008_dapur_niaga.jpg` | 2026-07-15 | Cooking oil rises again and fuel gets a purchase price. |
| 6 | `receipts/receipt_009_jimat_borong_pek.jpg` | 2026-07-16 | Eggs, packaging and rice decrease on the latest purchase. |

Exact extraction fields, component mappings and expected changes are in
`new_purchase_receipt_ground_truth.json`.

## Demo notes

- Upload and confirm one receipt at a time so the latest-cost changes are easy
  to observe.
- Do not assign component IDs to intentionally unmapped lines unless the
  merchant explicitly confirms the mapping.
- The final receipt is useful for showing that a new purchase can lower a cost,
  rather than every upload producing an increase.
- Copies of all six images are also available under
  `apps/web/public/evidence` for local web evidence links.
