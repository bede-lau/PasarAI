const DAY_MS = 86_400_000;
const MODEL_VERSION = "demand-forecast-v1";
const MODEL_ORDER = [
  "weekday_seasonal_naive",
  "robust_same_weekday_median",
  "exponentially_weighted_recent_trend",
];

function finiteNonNegative(value, field) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new TypeError(`${field} must be a finite non-negative number`);
  }
  return parsed;
}

function parseInstant(value, field) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new TypeError(`${field} must be a valid date`);
  return timestamp;
}

function dateKey(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function weekday(timestamp) {
  return new Date(timestamp).getUTCDay();
}

function median(values) {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 1
    ? ordered[middle]
    : (ordered[middle - 1] + ordered[middle]) / 2;
}

function quantile(values, probability) {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  const index = (ordered.length - 1) * probability;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return ordered[lower];
  return ordered[lower] + (ordered[upper] - ordered[lower]) * (index - lower);
}

function rounded(value) {
  return Number(Math.max(0, value).toFixed(2));
}

function isComplete(observation) {
  return observation.complete === true
    || observation.isComplete === true
    || observation.completeness === "complete";
}

function isCensored(observation) {
  return observation.soldOut === true
    || observation.isSoldOut === true
    || observation.censored === true
    || observation.isCensored === true;
}

function normalizeObservations(observations) {
  if (!Array.isArray(observations)) {
    throw new TypeError("observations must be an array");
  }

  const byDate = new Map();
  observations.forEach((observation, index) => {
    if (!observation || typeof observation !== "object") {
      throw new TypeError(`observations[${index}] must be an object`);
    }
    const dateTimestamp = parseInstant(observation.date, `observations[${index}].date`);
    const key = dateKey(dateTimestamp);
    if (byDate.has(key)) throw new RangeError(`duplicate observation date: ${key}`);
    const observedTimestamp = parseInstant(
      observation.observedAt ?? observation.updatedAt ?? observation.date,
      `observations[${index}].observedAt`,
    );
    const demandValue = observation.demand ?? observation.quantity ?? observation.units;
    const complete = isComplete(observation);
    const censored = isCensored(observation);
    const usable = complete && !censored && demandValue !== undefined && demandValue !== null;
    byDate.set(key, {
      date: key,
      timestamp: Date.parse(`${key}T00:00:00.000Z`),
      observedTimestamp,
      complete,
      censored,
      usable,
      demand: usable
        ? finiteNonNegative(demandValue, `observations[${index}].demand`)
        : null,
    });
  });
  return [...byDate.values()].sort((left, right) => left.timestamp - right.timestamp);
}

function weightedTrend(values, alpha) {
  if (values.length === 1) return values[0];
  let sumWeight = 0;
  let sumX = 0;
  let sumY = 0;
  let sumXX = 0;
  let sumXY = 0;
  const lastIndex = values.length - 1;

  values.forEach((value, index) => {
    const weight = Math.pow(1 - alpha, lastIndex - index);
    sumWeight += weight;
    sumX += weight * index;
    sumY += weight * value;
    sumXX += weight * index * index;
    sumXY += weight * index * value;
  });

  const denominator = sumWeight * sumXX - sumX * sumX;
  if (Math.abs(denominator) < Number.EPSILON) return values.at(-1);
  const slope = (sumWeight * sumXY - sumX * sumY) / denominator;
  const intercept = (sumY - slope * sumX) / sumWeight;
  return Math.max(0, intercept + slope * values.length);
}

function predictionsFor(history, targetWeekday, alpha) {
  const sameWeekday = history
    .filter((observation) => weekday(observation.timestamp) === targetWeekday)
    .map((observation) => observation.demand);
  if (sameWeekday.length < 4) return null;
  const recent = sameWeekday.slice(-12);
  return {
    weekday_seasonal_naive: sameWeekday.at(-1),
    robust_same_weekday_median: median(sameWeekday.slice(-8)),
    exponentially_weighted_recent_trend: weightedTrend(recent, alpha),
  };
}

function backtest(usable, alpha) {
  const results = Object.fromEntries(MODEL_ORDER.map((name) => [name, []]));
  for (let index = 0; index < usable.length; index += 1) {
    const actual = usable[index];
    const predictions = predictionsFor(
      usable.slice(0, index),
      weekday(actual.timestamp),
      alpha,
    );
    if (!predictions) continue;
    for (const name of MODEL_ORDER) {
      results[name].push({
        actual: actual.demand,
        predicted: predictions[name],
        residual: actual.demand - predictions[name],
      });
    }
  }
  return results;
}

function modelDiagnostics(backtests, maxErrorPct) {
  return MODEL_ORDER.map((name) => {
    const origins = backtests[name];
    const absoluteError = origins.reduce(
      (total, origin) => total + Math.abs(origin.residual),
      0,
    );
    const actualTotal = origins.reduce((total, origin) => total + origin.actual, 0);
    const mae = origins.length === 0 ? null : absoluteError / origins.length;
    const wapePct = actualTotal === 0
      ? (absoluteError === 0 && origins.length > 0 ? 0 : null)
      : absoluteError / actualTotal * 100;
    return {
      name,
      origins: origins.length,
      mae: mae === null ? null : rounded(mae),
      wapePct: wapePct === null ? null : rounded(wapePct),
      errorGatePassed:
        origins.length >= 8
        && wapePct !== null
        && wapePct <= maxErrorPct,
    };
  });
}

function historyStatus(usableDays) {
  if (usableDays < 28) return "unavailable";
  if (usableDays < 56) return "shadow";
  return "potentially_ready";
}

export function buildDemandForecast(options) {
  if (!options || typeof options !== "object") {
    throw new TypeError("options must be an object");
  }
  const observations = normalizeObservations(options.observations);
  const forecastTimestamp = parseInstant(options.forecastDate, "forecastDate");
  const forecastDate = dateKey(forecastTimestamp);
  const forecastWeekday = weekday(Date.parse(`${forecastDate}T00:00:00.000Z`));
  const asOfTimestamp = parseInstant(options.asOf, "asOf");
  const alpha = options.trendAlpha === undefined
    ? 0.35
    : finiteNonNegative(options.trendAlpha, "trendAlpha");
  if (alpha <= 0 || alpha > 1) throw new RangeError("trendAlpha must be > 0 and <= 1");
  const maxErrorPct = options.maxErrorPct === undefined
    ? 35
    : finiteNonNegative(options.maxErrorPct, "maxErrorPct");

  const usable = observations.filter((observation) => observation.usable);
  const usableBeforeForecast = usable.filter(
    (observation) => observation.timestamp < Date.parse(`${forecastDate}T00:00:00.000Z`),
  );
  const status = historyStatus(usableBeforeForecast.length);
  const forecastWeekdayObservations = usableBeforeForecast.filter(
    (observation) => weekday(observation.timestamp) === forecastWeekday,
  ).length;

  const latestWindowEnd = Date.parse(`${dateKey(asOfTimestamp)}T00:00:00.000Z`);
  const latestWindowStart = latestWindowEnd - 27 * DAY_MS;
  const usableLatest28 = new Set(
    usable
      .filter((observation) =>
        observation.timestamp >= latestWindowStart
        && observation.timestamp <= latestWindowEnd)
      .map((observation) => observation.date),
  ).size;
  const completenessPct = usableLatest28 / 28 * 100;
  const latestObservedTimestamp = usable.length === 0
    ? null
    : Math.max(...usable.map((observation) => observation.observedTimestamp));
  const freshnessHours = latestObservedTimestamp === null
    ? null
    : (asOfTimestamp - latestObservedTimestamp) / 3_600_000;

  const backtests = backtest(usableBeforeForecast, alpha);
  const models = modelDiagnostics(backtests, maxErrorPct);
  const eligibleModels = models
    .filter((model) => model.errorGatePassed)
    .sort((left, right) =>
      left.wapePct - right.wapePct
      || left.mae - right.mae
      || MODEL_ORDER.indexOf(left.name) - MODEL_ORDER.indexOf(right.name));
  const selectedModel = eligibleModels[0] ?? null;

  const gates = {
    history: status,
    forecastWeekdayObservations: {
      required: 4,
      actual: forecastWeekdayObservations,
      passed: forecastWeekdayObservations >= 4,
    },
    latest28Completeness: {
      requiredPct: 90,
      actualPct: rounded(completenessPct),
      usableDays: usableLatest28,
      passed: completenessPct >= 90,
    },
    freshness: {
      requiredHoursLessThan: 24,
      actualHours: freshnessHours === null ? null : rounded(freshnessHours),
      passed:
        freshnessHours !== null
        && freshnessHours >= 0
        && freshnessHours < 24,
    },
    rollingOriginBacktest: {
      requiredOrigins: 8,
      actualOrigins: Math.max(0, ...models.map((model) => model.origins)),
      passed: models.some((model) => model.origins >= 8),
    },
    modelError: {
      maximumWapePct: maxErrorPct,
      passed: selectedModel !== null,
    },
  };

  const reasons = [];
  if (status === "unavailable") reasons.push("fewer_than_28_complete_usable_days");
  if (status === "shadow") reasons.push("shadow_mode_requires_56_complete_usable_days");
  if (!gates.forecastWeekdayObservations.passed) {
    reasons.push("fewer_than_4_usable_forecast_weekday_observations");
  }
  if (!gates.latest28Completeness.passed) reasons.push("latest_28_days_below_90_percent_complete");
  if (!gates.freshness.passed) reasons.push("latest_observation_is_not_fresh");
  if (!gates.rollingOriginBacktest.passed) reasons.push("fewer_than_8_backtest_origins");
  if (!gates.modelError.passed) reasons.push("no_candidate_model_passed_error_gate");

  const operationalGatesPassed =
    gates.forecastWeekdayObservations.passed
    && gates.latest28Completeness.passed
    && gates.freshness.passed
    && gates.rollingOriginBacktest.passed
    && gates.modelError.passed;
  const readiness = status === "unavailable"
    ? "unavailable"
    : status === "shadow"
      ? "shadow"
      : operationalGatesPassed
        ? "ready"
        : "not_ready";

  let forecast = { p10: null, p50: null, p90: null };
  if (status !== "unavailable" && operationalGatesPassed) {
    const pointPredictions = predictionsFor(
      usableBeforeForecast,
      forecastWeekday,
      alpha,
    );
    const point = pointPredictions[selectedModel.name];
    const residuals = backtests[selectedModel.name].map((origin) => origin.residual);
    forecast = {
      p10: rounded(point + quantile(residuals, 0.1)),
      p50: rounded(point),
      p90: rounded(point + quantile(residuals, 0.9)),
    };
    forecast.p10 = Math.min(forecast.p10, forecast.p50);
    forecast.p90 = Math.max(forecast.p90, forecast.p50);
  }

  return {
    forecastDate,
    readiness,
    ...forecast,
    forecast,
    selectedModel: selectedModel?.name ?? null,
    modelVersion: MODEL_VERSION,
    reasons,
    trainingWindow: usableBeforeForecast.length === 0
      ? { startDate: null, endDate: null }
      : {
          startDate: usableBeforeForecast[0].date,
          endDate: usableBeforeForecast.at(-1).date,
        },
    sampleSize: usableBeforeForecast.length,
    diagnostics: {
      gates,
      candidates: models,
      excluded: {
        incompleteDays: observations.filter((observation) => !observation.complete).length,
        censoredOrSoldOutDays: observations.filter((observation) => observation.censored).length,
      },
      assumptions: {
        timezone: "UTC",
        forecastHorizonDays: Math.round(
          (Date.parse(`${forecastDate}T00:00:00.000Z`)
            - (usableBeforeForecast.at(-1)?.timestamp
              ?? Date.parse(`${forecastDate}T00:00:00.000Z`))) / DAY_MS,
        ),
        intervals: "empirical_rolling_origin_residual_quantiles",
        censoredDemandTreatment: "excluded_not_zero_filled",
        missingDemandTreatment: "excluded_not_zero_filled",
        trendAlpha: alpha,
      },
    },
  };
}
