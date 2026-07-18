"""Deterministic local equivalent of the PasarAI Bronze→Silver→Gold pipeline."""

from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timedelta, timezone
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path
import re
from typing import Any, Iterable
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from .seed_bundle import build_seed_bundle


MONEY = Decimal("0.01")
PERCENT = Decimal("0.01")
IDENTIFIER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]*$")


class DataQualityError(ValueError):
    """Raised when deterministic pipeline expectations reject input data."""

    def __init__(self, violations: Iterable[str]):
        self.violations = tuple(sorted(set(violations)))
        super().__init__(f"Data quality expectations failed: {', '.join(self.violations)}")


def _timezone(name: str):
    try:
        return ZoneInfo(name)
    except ZoneInfoNotFoundError:
        if name == "Asia/Kuala_Lumpur":
            return timezone(timedelta(hours=8), name)
        raise


def _decimal(value: str | int | float | Decimal) -> Decimal:
    return Decimal(str(value))


def _money(value: Decimal) -> str:
    return f"{value.quantize(MONEY, rounding=ROUND_HALF_UP):.2f}"


def _quantity(value: Decimal) -> str:
    normalized = value.normalize()
    return format(normalized, "f")


def _percentage(value: Decimal) -> str:
    return f"{value.quantize(PERCENT, rounding=ROUND_HALF_UP):.2f}"


def _component_costs(
    components: Iterable[dict[str, str]],
    product_id: str,
    field: str,
) -> Decimal:
    return sum(
        (_decimal(component[field]) for component in components if component["product_id"] == product_id),
        start=Decimal("0"),
    )


def _component_snapshots_as_of(
    components: Iterable[dict[str, str]],
    sale_date: str,
) -> list[dict[str, str]]:
    latest = {}
    for component in components:
        if component.get("effective_at", "")[:10] > sale_date:
            continue
        key = (
            component.get("merchant_id", ""),
            component["product_id"],
            component["component_id"],
        )
        current = latest.get(key)
        candidate_order = (
            component.get("effective_at", ""),
            int(component.get("snapshot_sequence", "0")),
            component.get("snapshot_id", ""),
        )
        current_order = (
            current.get("effective_at", ""),
            int(current.get("snapshot_sequence", "0")),
            current.get("snapshot_id", ""),
        ) if current else None
        if current_order is None or candidate_order > current_order:
            latest[key] = component
    return list(latest.values())


def _merchant_local_date(occurred_at: str, timezone: str) -> str:
    return (
        datetime.fromisoformat(occurred_at)
        .astimezone(_timezone(timezone))
        .date()
        .isoformat()
    )


def _validate_bundle(bundle: dict[str, Any]) -> None:
    violations = []
    merchant_id = bundle["merchant"].get("merchant_id", "")
    if not IDENTIFIER.fullmatch(merchant_id):
        violations.append("valid_merchant_id")

    for product in bundle["products"]:
        if not IDENTIFIER.fullmatch(product.get("product_id", "")):
            violations.append("valid_product_id")
        if _decimal(product["selling_price_rm"]) < 0:
            violations.append("non_negative_myr_amount")

    for component in bundle["recipe_components"]:
        if not IDENTIFIER.fullmatch(component.get("component_id", "")):
            violations.append("valid_component_id")
        if _decimal(component["baseline_cost_per_pack_rm"]) < 0:
            violations.append("non_negative_myr_amount")
        if _decimal(component["current_cost_per_pack_rm"]) < 0:
            violations.append("non_negative_myr_amount")

    for sale in bundle["historical_sales"]:
        if _decimal(sale["quantity"]) <= 0:
            violations.append("positive_quantity")
        if _decimal(sale["unit_price_rm"]) < 0:
            violations.append("non_negative_myr_amount")

    for event in bundle["raw_events"]:
        if not IDENTIFIER.fullmatch(event.get("event_id", "")):
            violations.append("valid_event_id")

    for receipt in bundle["receipt_ground_truth"].values():
        total = receipt.get("total_rm")
        line_total = sum(
            (
                _decimal(item["total_price_rm"])
                for item in receipt.get("line_items", [])
                if item.get("total_price_rm") is not None
            ),
            start=Decimal("0"),
        )
        if (
            receipt.get("review_state") == "accepted"
            and total is not None
            and abs(line_total - _decimal(total)) > Decimal("0.05")
        ):
            violations.append("receipt_total_reconciliation")
        for item in receipt.get("line_items", []):
            if item.get("quantity") is not None and _decimal(item["quantity"]) <= 0:
                violations.append("positive_quantity")
            for field in ("unit_price_rm", "total_price_rm"):
                if item.get(field) is not None and _decimal(item[field]) < 0:
                    violations.append("non_negative_myr_amount")

    if violations:
        raise DataQualityError(violations)


def _resolve_corrections(
    sales: list[dict[str, str]],
    corrections: list[dict[str, Any]],
) -> list[dict[str, str]]:
    resolved = deepcopy(sales)
    by_source_event: dict[str, list[dict[str, str]]] = {}
    for row in resolved:
        by_source_event.setdefault(row["source_event_id"], []).append(row)

    for correction in sorted(
        corrections,
        key=lambda event: (event.get("occurred_at", ""), event.get("event_id", "")),
    ):
        if correction.get("type") != "correction":
            continue
        targets = by_source_event.get(correction.get("target_event_id"))
        if not targets:
            raise DataQualityError(["correction_target_exists"])
        for change in correction.get("replacement_payload", {}).get("changes", []):
            field = change.get("field")
            if field not in {"quantity", "unit_price_rm", "product_id", "source_language"}:
                raise DataQualityError(["supported_correction_field"])
            line_index = change.get("line_index")
            if line_index is not None and (
                not isinstance(line_index, int) or line_index < 0
            ):
                raise DataQualityError(["valid_correction_line_index"])
            if field == "source_language":
                change_targets = targets
            elif line_index is not None:
                change_targets = [
                    row for row in targets if row.get("line_index") == line_index
                ]
                if not change_targets:
                    raise DataQualityError(["correction_line_exists"])
            elif len(targets) == 1:
                change_targets = targets
            else:
                raise DataQualityError(["correction_line_index_required"])
            corrected_value = str(change.get("corrected_value", ""))
            if field == "quantity" and _decimal(corrected_value) <= 0:
                raise DataQualityError(["positive_quantity"])
            if field == "unit_price_rm" and _decimal(corrected_value) < 0:
                raise DataQualityError(["non_negative_myr_amount"])
            for target in change_targets:
                target[field] = (
                    _money(_decimal(corrected_value))
                    if field == "unit_price_rm"
                    else corrected_value
                )

    return resolved


def _daily_metric(
    merchant_id: str,
    product_id: str,
    date: str,
    sales: list[dict[str, str]],
    components: list[dict[str, str]],
) -> dict[str, str]:
    quantity = sum((_decimal(row["quantity"]) for row in sales), start=Decimal("0"))
    revenue = sum(
        (_decimal(row["quantity"]) * _decimal(row["unit_price_rm"]) for row in sales),
        start=Decimal("0"),
    )
    unit_cogs = _component_costs(components, product_id, "current_cost_per_pack_rm")
    baseline_unit_cogs = _component_costs(components, product_id, "baseline_cost_per_pack_rm")
    cogs = quantity * unit_cogs
    gross_profit = revenue - cogs
    gross_margin = gross_profit / revenue * Decimal("100") if revenue else Decimal("0")
    baseline_price = (
        revenue / quantity
        if quantity
        else Decimal("0")
    )
    baseline_margin = (
        (baseline_price - baseline_unit_cogs) / baseline_price * Decimal("100")
        if baseline_price
        else Decimal("0")
    )

    return {
        "merchant_id": merchant_id,
        "product_id": product_id,
        "date": date,
        "quantity": _quantity(quantity),
        "unit_cogs_rm": _money(unit_cogs),
        "baseline_unit_cogs_rm": _money(baseline_unit_cogs),
        "revenue_rm": _money(revenue),
        "cogs_rm": _money(cogs),
        "gross_profit_rm": _money(gross_profit),
        "gross_margin_pct": _percentage(gross_margin),
        "baseline_margin_pct": _percentage(baseline_margin),
        "margin_change_percentage_points": _percentage(gross_margin - baseline_margin),
        "data_completeness": "complete",
    }


def _cost_drivers(
    merchant_id: str,
    product_id: str,
    date: str,
    components: list[dict[str, str]],
) -> list[dict[str, str]]:
    drivers = []
    for component in components:
        if component["product_id"] != product_id:
            continue
        contribution = (
            _decimal(component["current_cost_per_pack_rm"])
            - _decimal(component["baseline_cost_per_pack_rm"])
        )
        if contribution <= 0:
            continue
        drivers.append(
            {
                "merchant_id": merchant_id,
                "product_id": product_id,
                "date": date,
                "component_id": component["component_id"],
                "component_name": component["component_name"],
                "contribution_rm_per_pack": _money(contribution),
            }
        )
    return sorted(
        drivers,
        key=lambda row: (-_decimal(row["contribution_rm_per_pack"]), row["component_id"]),
    )


def _cost_facts(bundle: dict[str, Any]) -> list[dict[str, str | None]]:
    facts = []
    merchant_id = bundle["merchant"]["merchant_id"]
    for receipt in bundle["receipt_ground_truth"].values():
        if receipt.get("review_state") != "accepted":
            continue
        for index, item in enumerate(receipt.get("line_items", []), start=1):
            facts.append(
                {
                    "purchase_line_id": f"{receipt['receipt_id']}:{index}",
                    "receipt_id": receipt["receipt_id"],
                    "merchant_id": merchant_id,
                    "cost_date": receipt["date"],
                    "supplier_name": receipt["supplier_name"],
                    "component_id": item.get("normalized_component_id"),
                    "raw_name": item["raw_name"],
                    "quantity": (
                        None
                        if item.get("quantity") is None
                        else _quantity(_decimal(item["quantity"]))
                    ),
                    "uom": item.get("uom"),
                    "pack_size": (
                        None
                        if item.get("pack_size") is None
                        else _quantity(_decimal(item["pack_size"]))
                    ),
                    "unit_price_rm": (
                        None
                        if item.get("unit_price_rm") is None
                        else _money(_decimal(item["unit_price_rm"]))
                    ),
                    "total_price_rm": (
                        None
                        if item.get("total_price_rm") is None
                        else _money(_decimal(item["total_price_rm"]))
                    ),
                    "currency": receipt["currency"],
                    "receipt_overall_confidence": receipt.get("overall_confidence"),
                    "receipt_review_state": receipt["review_state"],
                    "line_confidence": item.get("confidence"),
                }
            )
    return facts


def _historical_sales(bundle: dict[str, Any]) -> list[dict[str, str]]:
    return [
        {
            "source_event_id": (
                f"historical:{row['merchant_id']}:{row['product_id']}:{row['date']}"
            ),
            "merchant_id": row["merchant_id"],
            "occurred_at": f"{row['date']}T00:00:00",
            "sale_date": row["date"],
            "product_id": row["product_id"],
            "quantity": row["quantity"],
            "unit_price_rm": row["unit_price_rm"],
            "source": row["source"],
            "source_language": bundle["merchant"]["primary_language"],
        }
        for row in bundle["historical_sales"]
    ]


def _scenario_baseline(
    metric: dict[str, str],
    merchant_target_margin: Decimal,
) -> dict[str, str]:
    unit_cogs = _decimal(metric["unit_cogs_rm"])
    price_floor = unit_cogs / (Decimal("1") - merchant_target_margin / Decimal("100"))
    return {
        "merchant_id": metric["merchant_id"],
        "product_id": metric["product_id"],
        "as_of": metric["date"],
        "current_quantity": metric["quantity"],
        "current_unit_price_rm": _money(
            _decimal(metric["revenue_rm"]) / _decimal(metric["quantity"])
        ),
        "current_gross_profit_rm": metric["gross_profit_rm"],
        "unit_cogs_rm": metric["unit_cogs_rm"],
        "target_gross_margin_pct": _percentage(merchant_target_margin),
        "price_floor_rm": _money(price_floor),
        "assumption": "constant_demand",
    }


def build_platform_snapshot(
    seed_directory: str | Path,
    corrections: Iterable[dict[str, Any]] = (),
) -> dict[str, Any]:
    """Build deterministic Bronze, Silver, and Gold outputs from synthetic fixtures."""
    bundle = build_seed_bundle(seed_directory)
    _validate_bundle(bundle)
    correction_events = [deepcopy(event) for event in corrections]
    raw_events = deepcopy(bundle["raw_events"]) + correction_events
    merchant = bundle["merchant"]
    current_sales = _resolve_corrections(
        deepcopy(bundle["synthetic_sales_candidates"]),
        correction_events,
    )
    for sale in current_sales:
        sale["sale_date"] = _merchant_local_date(
            sale["occurred_at"],
            merchant["timezone"],
        )
    resolved_sales = _historical_sales(bundle) + current_sales
    metric_keys = sorted(
        {
            (row["merchant_id"], row["product_id"], row["sale_date"])
            for row in resolved_sales
        }
    )

    daily_metrics = []
    cost_drivers = []
    scenario_baselines = []
    for merchant_id, product_id, sale_date in metric_keys:
        product_sales = [
            row
            for row in resolved_sales
            if row["merchant_id"] == merchant_id
            and row["product_id"] == product_id
            and row["sale_date"] == sale_date
        ]
        components = _component_snapshots_as_of(
            deepcopy(bundle["recipe_components"]),
            sale_date,
        )
        metric = _daily_metric(
            merchant_id,
            product_id,
            sale_date,
            product_sales,
            components,
        )
        daily_metrics.append(metric)
        cost_drivers.extend(
            _cost_drivers(
                merchant_id,
                product_id,
                sale_date,
                components,
            )
        )
        scenario_baselines.append(
            _scenario_baseline(metric, _decimal(merchant["target_gross_margin_pct"]))
        )

    return {
        "bronze": {
            "raw_events": raw_events,
            "receipt_ground_truth": deepcopy(bundle["receipt_ground_truth"]),
        },
        "silver": {
            "historical_sales": deepcopy(bundle["historical_sales"]),
            "resolved_sales": resolved_sales,
            "cost_facts": _cost_facts(bundle),
            "recipe_components": deepcopy(bundle["recipe_components"]),
            "ingredient_price_history": deepcopy(bundle["ingredient_price_history"]),
        },
        "gold": {
            "daily_product_metrics": daily_metrics,
            "cost_driver_metrics": cost_drivers,
            "price_scenario_baselines": scenario_baselines,
        },
    }
