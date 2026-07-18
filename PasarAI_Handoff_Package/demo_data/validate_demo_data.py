from decimal import Decimal, ROUND_HALF_UP
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
expected = json.loads((ROOT / "seed_data" / "expected_metrics.json").read_text(encoding="utf-8"))

D = Decimal
qty = D("40")
price = D("5.00")
unit_cogs = D("3.18")
revenue = qty * price
cogs = qty * unit_cogs
gross = revenue - cogs
margin = (gross / revenue * D("100")).quantize(D("0.01"), rounding=ROUND_HALF_UP)
price_floor = (unit_cogs / (D("1") - D("0.40"))).quantize(D("0.01"), rounding=ROUND_HALF_UP)

assert revenue == D(str(expected["today"]["revenue_rm"]))
assert cogs == D(str(expected["today"]["cogs_rm"]))
assert gross == D(str(expected["today"]["gross_profit_rm"]))
assert margin == D(str(expected["today"]["gross_margin_pct"]))
assert price_floor == D(str(expected["price_floor_for_40pct_margin_rm"]))

scenario_qty = D("35")
scenario_price = D("5.50")
scenario_revenue = scenario_qty * scenario_price
scenario_cogs = scenario_qty * unit_cogs
scenario_gross = scenario_revenue - scenario_cogs
scenario_margin = (scenario_gross / scenario_revenue * D("100")).quantize(D("0.01"), rounding=ROUND_HALF_UP)
scenario = expected["scenario_35_at_5_50"]
assert scenario_revenue == D(str(scenario["revenue_rm"]))
assert scenario_cogs == D(str(scenario["cogs_rm"]))
assert scenario_gross == D(str(scenario["gross_profit_rm"]))
assert scenario_margin == D(str(scenario["gross_margin_pct"]))

print("PasarAI golden demo metrics: PASS")
