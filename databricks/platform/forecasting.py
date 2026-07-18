"""Transparent, dependency-free daily product demand forecasting."""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from statistics import median
from typing import Any, Callable, Iterable, Mapping, Sequence


MODEL_VERSION = "pasarai-transparent-daily-v1"
MODEL_NAMES = (
    "weekday_seasonal_naive",
    "robust_same_weekday_median",
    "exponentially_weighted_recent_trend",
)


@dataclass(frozen=True)
class ForecastConfig:
    horizon_days: int = 14
    unavailable_below_days: int = 28
    display_candidate_days: int = 56
    backtest_window_days: int = 28
    minimum_backtest_points: int = 7
    maximum_wape: float = 0.35
    weekday_median_lookback: int = 8
    trend_lookback_days: int = 28
    trend_decay: float = 0.90
    target_field: str = "quantity"

    def __post_init__(self) -> None:
        if self.horizon_days < 1:
            raise ValueError("horizon_days must be positive")
        if self.unavailable_below_days < 2:
            raise ValueError("unavailable_below_days must be at least 2")
        if self.display_candidate_days <= self.unavailable_below_days:
            raise ValueError(
                "display_candidate_days must exceed unavailable_below_days"
            )
        if self.backtest_window_days < 1 or self.minimum_backtest_points < 1:
            raise ValueError("backtest settings must be positive")
        if not 0 < self.trend_decay <= 1:
            raise ValueError("trend_decay must be in (0, 1]")
        if self.maximum_wape < 0:
            raise ValueError("maximum_wape cannot be negative")


@dataclass(frozen=True)
class _Observation:
    day: date
    value: float


def _parse_date(value: Any) -> date:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    if isinstance(value, str):
        return date.fromisoformat(value[:10])
    raise TypeError(f"unsupported date value {value!r}")


def _truthy(row: Mapping[str, Any], names: Sequence[str]) -> bool:
    for name in names:
        value = row.get(name)
        if isinstance(value, str):
            value = value.strip().lower() in {"1", "true", "yes", "y"}
        if value:
            return True
    return False


def _is_complete(row: Mapping[str, Any]) -> bool:
    completeness = row.get("data_completeness")
    if completeness is not None and str(completeness).lower() != "complete":
        return False
    if "is_complete" in row:
        value = row["is_complete"]
        if isinstance(value, str):
            value = value.strip().lower() in {"1", "true", "yes", "y"}
        if not value:
            return False
    return True


def _is_censored(row: Mapping[str, Any]) -> bool:
    return _truthy(
        row,
        (
            "sold_out",
            "is_sold_out",
            "censored",
            "is_censored",
            "demand_censored",
        ),
    )


def _normalize_rows(
    rows: Iterable[Mapping[str, Any]],
    config: ForecastConfig,
) -> tuple[list[_Observation], dict[str, Any]]:
    observations: dict[date, _Observation] = {}
    source_days: list[date] = []
    incomplete = 0
    censored = 0
    invalid_target = 0
    source_rows = 0

    for row in rows:
        source_rows += 1
        day = _parse_date(row["date"])
        source_days.append(day)
        if not _is_complete(row):
            incomplete += 1
            continue
        if _is_censored(row):
            censored += 1
            continue
        raw_value = row.get(config.target_field)
        if raw_value is None:
            invalid_target += 1
            continue
        value = float(raw_value)
        if not math.isfinite(value) or value < 0:
            invalid_target += 1
            continue
        if day in observations:
            raise ValueError(f"duplicate usable daily metric for {day.isoformat()}")
        observations[day] = _Observation(day, value)

    usable = sorted(observations.values(), key=lambda item: item.day)
    metadata = {
        "source_row_count": source_rows,
        "source_watermark": max(source_days).isoformat() if source_days else None,
        "history_start": min(source_days).isoformat() if source_days else None,
        "usable_history_start": usable[0].day.isoformat() if usable else None,
        "usable_day_count": len(usable),
        "excluded_incomplete_day_count": incomplete,
        "excluded_censored_day_count": censored,
        "excluded_invalid_target_day_count": invalid_target,
    }
    return usable, metadata


def _weekday_seasonal_naive(
    history: Sequence[_Observation],
    target_day: date,
    config: ForecastConfig,
) -> float:
    same_weekday = [
        observation.value
        for observation in history
        if observation.day.weekday() == target_day.weekday()
    ]
    if same_weekday:
        return same_weekday[-1]
    return history[-1].value


def _robust_same_weekday_median(
    history: Sequence[_Observation],
    target_day: date,
    config: ForecastConfig,
) -> float:
    same_weekday = [
        observation.value
        for observation in history
        if observation.day.weekday() == target_day.weekday()
    ][-config.weekday_median_lookback :]
    values = same_weekday or [
        observation.value
        for observation in history[-config.weekday_median_lookback :]
    ]
    return float(median(values))


def _exponentially_weighted_recent_trend(
    history: Sequence[_Observation],
    target_day: date,
    config: ForecastConfig,
) -> float:
    recent = history[-config.trend_lookback_days :]
    if len(recent) == 1:
        return recent[0].value

    anchor = recent[-1].day
    points = [
        ((observation.day - anchor).days, observation.value)
        for observation in recent
    ]
    weights = [
        config.trend_decay ** (len(points) - index - 1)
        for index in range(len(points))
    ]
    weight_sum = sum(weights)
    mean_x = sum(weight * x for weight, (x, _) in zip(weights, points)) / weight_sum
    mean_y = sum(weight * y for weight, (_, y) in zip(weights, points)) / weight_sum
    denominator = sum(
        weight * (x - mean_x) ** 2
        for weight, (x, _) in zip(weights, points)
    )
    slope = (
        sum(
            weight * (x - mean_x) * (y - mean_y)
            for weight, (x, y) in zip(weights, points)
        )
        / denominator
        if denominator
        else 0.0
    )
    target_x = (target_day - anchor).days
    return max(0.0, mean_y + slope * (target_x - mean_x))


_MODEL_FUNCTIONS: dict[
    str,
    Callable[[Sequence[_Observation], date, ForecastConfig], float],
] = {
    "weekday_seasonal_naive": _weekday_seasonal_naive,
    "robust_same_weekday_median": _robust_same_weekday_median,
    "exponentially_weighted_recent_trend": _exponentially_weighted_recent_trend,
}


def _score_model(
    observations: Sequence[_Observation],
    model_name: str,
    config: ForecastConfig,
) -> dict[str, Any]:
    first_test_index = max(
        config.unavailable_below_days,
        len(observations) - config.backtest_window_days,
    )
    predictions = []
    actuals = []
    residuals = []
    model = _MODEL_FUNCTIONS[model_name]
    for index in range(first_test_index, len(observations)):
        actual = observations[index]
        prediction = max(0.0, model(observations[:index], actual.day, config))
        predictions.append(prediction)
        actuals.append(actual.value)
        residuals.append(actual.value - prediction)

    absolute_error = sum(
        abs(actual - prediction)
        for actual, prediction in zip(actuals, predictions)
    )
    actual_total = sum(abs(actual) for actual in actuals)
    wape = absolute_error / actual_total if actual_total else (
        0.0 if absolute_error == 0 else math.inf
    )
    mae = absolute_error / len(actuals) if actuals else math.inf
    return {
        "model_name": model_name,
        "backtest_points": len(actuals),
        "wape": wape,
        "mae": mae,
        "residuals": residuals,
    }


def _quantile(values: Sequence[float], probability: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    position = (len(ordered) - 1) * probability
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    fraction = position - lower
    return ordered[lower] * (1 - fraction) + ordered[upper] * fraction


def _rounded(value: float) -> float:
    return round(max(0.0, value), 3)


def forecast_product(
    rows: Iterable[Mapping[str, Any]],
    *,
    config: ForecastConfig | None = None,
    generated_at: datetime | None = None,
    forecast_version: str | None = None,
) -> dict[str, Any]:
    """Forecast one merchant/product series and return records plus diagnostics."""

    config = config or ForecastConfig()
    source_rows = list(rows)
    identities = {
        (str(row["merchant_id"]), str(row["product_id"]))
        for row in source_rows
    }
    if len(identities) != 1:
        raise ValueError("forecast_product requires exactly one merchant/product series")
    merchant_id, product_id = next(iter(identities))
    observations, source_metadata = _normalize_rows(source_rows, config)
    usable_days = len(observations)
    if usable_days < config.unavailable_below_days:
        eligibility_status = "unavailable"
    elif usable_days < config.display_candidate_days:
        eligibility_status = "shadow"
    else:
        eligibility_status = "display_candidate"

    generated_at = generated_at or datetime.now(timezone.utc)
    if generated_at.tzinfo is None:
        generated_at = generated_at.replace(tzinfo=timezone.utc)
    generated_at_text = generated_at.astimezone(timezone.utc).isoformat()
    watermark = source_metadata["source_watermark"]
    forecast_version = forecast_version or f"{MODEL_VERSION}:{watermark or 'empty'}"

    result = {
        "merchant_id": merchant_id,
        "product_id": product_id,
        "eligibility_status": eligibility_status,
        "visibility_status": "unavailable",
        "accuracy_gate_passed": False,
        "selected_model": None,
        "model_version": MODEL_VERSION,
        "forecast_version": forecast_version,
        "generated_at": generated_at_text,
        **source_metadata,
        "diagnostics": {
            "models": [],
            "accuracy_gate": {
                "metric": "wape",
                "maximum": config.maximum_wape,
                "minimum_backtest_points": config.minimum_backtest_points,
                "passed": False,
            },
            "exclusion_policy": {
                "incomplete_days": "excluded",
                "sold_out_or_censored_days": "excluded",
            },
        },
        "forecasts": [],
    }
    if eligibility_status == "unavailable":
        return result

    scores = [
        _score_model(observations, model_name, config)
        for model_name in MODEL_NAMES
    ]
    selected = min(scores, key=lambda score: (score["wape"], score["mae"], score["model_name"]))
    accuracy_gate_passed = (
        selected["backtest_points"] >= config.minimum_backtest_points
        and math.isfinite(selected["wape"])
        and selected["wape"] <= config.maximum_wape
    )
    visibility_status = (
        "display"
        if eligibility_status == "display_candidate" and accuracy_gate_passed
        else "shadow"
    )
    diagnostics_models = [
        {
            "model_name": score["model_name"],
            "backtest_points": score["backtest_points"],
            "wape": round(score["wape"], 6) if math.isfinite(score["wape"]) else None,
            "mae": round(score["mae"], 6) if math.isfinite(score["mae"]) else None,
            "selected": score is selected,
        }
        for score in scores
    ]
    result.update(
        {
            "visibility_status": visibility_status,
            "accuracy_gate_passed": accuracy_gate_passed,
            "selected_model": selected["model_name"],
        }
    )
    result["diagnostics"]["models"] = diagnostics_models
    result["diagnostics"]["accuracy_gate"]["passed"] = accuracy_gate_passed

    residual_low = _quantile(selected["residuals"], 0.10)
    residual_high = _quantile(selected["residuals"], 0.90)
    last_day = observations[-1].day
    model = _MODEL_FUNCTIONS[selected["model_name"]]
    diagnostics_json = json.dumps(result["diagnostics"], sort_keys=True, separators=(",", ":"))
    for horizon_day in range(1, config.horizon_days + 1):
        forecast_day = last_day + timedelta(days=horizon_day)
        p50 = max(0.0, model(observations, forecast_day, config))
        p10 = min(p50, max(0.0, p50 + residual_low))
        p90 = max(p50, p50 + residual_high)
        result["forecasts"].append(
            {
                "merchant_id": merchant_id,
                "product_id": product_id,
                "forecast_date": forecast_day.isoformat(),
                "horizon_day": horizon_day,
                "p10": _rounded(p10),
                "p50": _rounded(p50),
                "p90": _rounded(p90),
                "eligibility_status": eligibility_status,
                "visibility_status": visibility_status,
                "accuracy_gate_passed": accuracy_gate_passed,
                "selected_model": selected["model_name"],
                "model_version": MODEL_VERSION,
                "forecast_version": forecast_version,
                "generated_at": generated_at_text,
                "source_watermark": watermark,
                "source_row_count": source_metadata["source_row_count"],
                "usable_day_count": usable_days,
                "diagnostics_json": diagnostics_json,
            }
        )
    return result


def generate_forecasts(
    rows: Iterable[Mapping[str, Any]],
    *,
    config: ForecastConfig | None = None,
    generated_at: datetime | None = None,
    forecast_version: str | None = None,
) -> list[dict[str, Any]]:
    """Forecast every merchant/product series in a daily metric row iterable."""

    grouped: dict[tuple[str, str], list[Mapping[str, Any]]] = {}
    for row in rows:
        key = (str(row["merchant_id"]), str(row["product_id"]))
        grouped.setdefault(key, []).append(row)
    return [
        forecast_product(
            grouped[key],
            config=config,
            generated_at=generated_at,
            forecast_version=forecast_version,
        )
        for key in sorted(grouped)
    ]


__all__ = [
    "ForecastConfig",
    "MODEL_NAMES",
    "MODEL_VERSION",
    "forecast_product",
    "generate_forecasts",
]
