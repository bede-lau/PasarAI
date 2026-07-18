"""Load authoritative synthetic fixtures into a deterministic normalized bundle."""

from __future__ import annotations

import csv
import json
import re
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


REQUIRED_FILES = (
    "expected_metrics.json",
    "ingredient_price_history.csv",
    "merchant.json",
    "products.csv",
    "receipt_ground_truth.json",
    "recipe_components.csv",
    "sales_history.csv",
    "today_events.json",
)

NUMBER_WORDS = {
    "zero": Decimal("0"),
    "one": Decimal("1"),
    "two": Decimal("2"),
    "three": Decimal("3"),
    "four": Decimal("4"),
    "five": Decimal("5"),
    "six": Decimal("6"),
    "seven": Decimal("7"),
    "eight": Decimal("8"),
    "nine": Decimal("9"),
    "ten": Decimal("10"),
    "twenty": Decimal("20"),
    "thirty": Decimal("30"),
    "forty": Decimal("40"),
    "fifty": Decimal("50"),
}


def _merchant_timezone(name: str):
    try:
        return ZoneInfo(name)
    except ZoneInfoNotFoundError:
        if name == "Asia/Kuala_Lumpur":
            return timezone(timedelta(hours=8), name)
        raise


def _read_csv(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8", newline="") as handle:
        return list(csv.DictReader(handle))


def _read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def _decimal_token(token: str) -> Decimal:
    normalized = token.strip().lower()
    if normalized in NUMBER_WORDS:
        return NUMBER_WORDS[normalized]
    return Decimal(normalized)


def _money(value: Decimal) -> str:
    return f"{value.quantize(Decimal('0.01')):.2f}"


def _synthetic_sales_candidates(
    merchant: dict[str, Any],
    products: list[dict[str, str]],
    events: list[dict[str, Any]],
) -> list[dict[str, str]]:
    aliases = sorted(
        ((product["name"].lower(), product["product_id"]) for product in products),
        key=lambda item: len(item[0]),
        reverse=True,
    )
    pattern = re.compile(
        r"\b(?P<quantity>[a-z0-9.]+)\s+bungkus\s+(?P<product>[^,.]+),"
        r"\s+semua\s+(?P<price>[a-z0-9.]+)\s+ringgit\b",
        re.IGNORECASE,
    )
    candidates = []

    for event in events:
        if event.get("type") != "sales_report":
            continue
        transcript = event.get("transcript", "")
        match = pattern.search(transcript)
        if not match:
            continue
        spoken_product = match.group("product").strip().lower()
        product_id = next(
            (identifier for alias, identifier in aliases if alias == spoken_product),
            None,
        )
        if product_id is None:
            continue
        candidates.append(
            {
                "source_event_id": event["event_id"],
                "merchant_id": merchant["merchant_id"],
                "occurred_at": event["occurred_at"],
                "line_index": 0,
                "product_id": product_id,
                "quantity": str(_decimal_token(match.group("quantity"))),
                "unit_price_rm": _money(_decimal_token(match.group("price"))),
                "source": event["source"],
                "source_language": event.get("language", merchant["primary_language"]),
            }
        )

    return candidates


def _recipe_component_snapshots(
    merchant: dict[str, Any],
    components: list[dict[str, str]],
    historical_sales: list[dict[str, str]],
    events: list[dict[str, Any]],
) -> list[dict[str, str]]:
    if any(component.get("effective_at") for component in components):
        return [
            {
                **component,
                "merchant_id": component.get("merchant_id", merchant["merchant_id"]),
                "snapshot_id": component.get("snapshot_id", "fixture-snapshot"),
                "snapshot_sequence": component.get("snapshot_sequence", "1"),
            }
            for component in components
        ]

    baseline_date = min(row["date"] for row in historical_sales)
    merchant_timezone = _merchant_timezone(merchant["timezone"])
    current_date = min(
        datetime.fromisoformat(event["occurred_at"])
        .astimezone(merchant_timezone)
        .date()
        .isoformat()
        for event in events
        if event.get("type") == "sales_report"
    )
    snapshots = []
    for component in components:
        shared = {
            **component,
            "merchant_id": merchant["merchant_id"],
        }
        snapshots.append(
            {
                **shared,
                "current_cost_per_pack_rm": component["baseline_cost_per_pack_rm"],
                "effective_at": f"{baseline_date}T00:00:00",
                "snapshot_id": "synthetic-baseline-v1",
                "snapshot_sequence": "1",
            }
        )
        snapshots.append(
            {
                **shared,
                "effective_at": f"{current_date}T00:00:00",
                "snapshot_id": "synthetic-current-v1",
                "snapshot_sequence": "2",
            }
        )
    return snapshots


def _receipt_ground_truth(receipts: dict[str, Any]) -> dict[str, Any]:
    normalized = deepcopy(receipts)
    for receipt in normalized.values():
        receipt["review_state"] = receipt.get(
            "review_state",
            "pending" if receipt.get("expected_behavior") else "accepted",
        )
        receipt["overall_confidence"] = receipt.get("overall_confidence")
        for item in receipt.get("line_items", []):
            item["confidence"] = item.get("confidence")
    return normalized


def build_seed_bundle(seed_directory: str | Path) -> dict[str, Any]:
    """Return every authoritative seed fixture in deterministic normalized form."""
    seed_root = Path(seed_directory)
    missing = [name for name in REQUIRED_FILES if not (seed_root / name).is_file()]
    if missing:
        raise FileNotFoundError(f"Missing authoritative seed fixtures: {', '.join(missing)}")

    merchant = _read_json(seed_root / "merchant.json")
    products = _read_csv(seed_root / "products.csv")
    events = _read_json(seed_root / "today_events.json")
    historical_sales = _read_csv(seed_root / "sales_history.csv")
    recipe_components = _read_csv(seed_root / "recipe_components.csv")

    return {
        "source_files": list(REQUIRED_FILES),
        "merchant": deepcopy(merchant),
        "products": products,
        "recipe_components": _recipe_component_snapshots(
            merchant,
            recipe_components,
            historical_sales,
            events,
        ),
        "ingredient_price_history": _read_csv(seed_root / "ingredient_price_history.csv"),
        "historical_sales": historical_sales,
        "receipt_ground_truth": _receipt_ground_truth(
            _read_json(seed_root / "receipt_ground_truth.json")
        ),
        "raw_events": deepcopy(events),
        "expected_metrics": _read_json(seed_root / "expected_metrics.json"),
        "synthetic_sales_candidates": _synthetic_sales_candidates(
            merchant,
            products,
            events,
        ),
    }
