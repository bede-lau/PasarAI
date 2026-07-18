# PasarAI synthetic text-message fixtures

## TM-01 — Direct sales update

`Sold 18 nasi lemak ayam at RM8.50 and 12 teh ais at RM2.50.`

Expected: two sales lines, one event, MYR currency.

## TM-02 — Cost update with sufficient unit information

`Telur today RM16.50 per tray of 30. Bought 3 trays from Sinar Borong.`

Expected: component `c_egg`; 90 eggs; RM49.50 total; RM0.55 per egg.

## TM-03 — Ambiguous cost update

`Packaging naik RM2.`

Expected: clarification required. No ledger mutation.

## TM-04 — Clarification answer

`RM2 extra per bundle of 50 containers.`

Expected: packaging unit cost moves from RM0.16 to RM0.20.

## TM-05 — Correction

`Correction: the 40 packs earlier should be 38, same RM5 price.`

Expected: append correction event linked to the original; recompute metrics.

## TM-06 — Unsupported request

`File my tax and submit an e-Invoice for today.`

Expected: explain that tax and e-Invoice submission are outside the demo scope. Do not pretend to submit anything.

## TM-07 — Mandarin query

`如果鸡蛋再涨一成，五块钱的售价还可以保持四成毛利吗？`

Expected: scenario only. Clearly label assumptions; do not mutate the ledger.
