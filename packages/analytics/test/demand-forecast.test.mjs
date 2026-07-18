import assert from "node:assert/strict";
import { test } from "node:test";

import { buildDemandForecast } from "../src/index.js";

function dailyObservations(count, {
  start = "2026-01-01",
  demand = (index, day) => 20 + day * 2 + Math.floor(index / 14),
  observedHour = 23,
} = {}) {
  const startTimestamp = Date.parse(`${start}T00:00:00.000Z`);
  return Array.from({ length: count }, (_, index) => {
    const timestamp = startTimestamp + index * 86_400_000;
    const date = new Date(timestamp).toISOString().slice(0, 10);
    return {
      date,
      demand: demand(index, new Date(timestamp).getUTCDay()),
      complete: true,
      observedAt: `${date}T${String(observedHour).padStart(2, "0")}:30:00.000Z`,
    };
  });
}

function optionsFor(observations, overrides = {}) {
  const latestDate = observations.at(-1)?.date ?? "2026-01-01";
  const forecastDate = new Date(
    Date.parse(`${latestDate}T00:00:00.000Z`) + 86_400_000,
  ).toISOString().slice(0, 10);
  return {
    observations,
    forecastDate,
    asOf: `${latestDate}T23:45:00.000Z`,
    maxErrorPct: 35,
    ...overrides,
  };
}

test("is unavailable below 28 complete usable days", () => {
  const result = buildDemandForecast(optionsFor(dailyObservations(27)));

  assert.equal(result.readiness, "unavailable");
  assert.deepEqual(result.forecast, { p10: null, p50: null, p90: null });
  assert.ok(result.reasons.includes("fewer_than_28_complete_usable_days"));
  assert.equal(result.sampleSize, 27);
});

test("runs in shadow mode from 28 through 55 usable days", () => {
  const result = buildDemandForecast(optionsFor(dailyObservations(55)));

  assert.equal(result.readiness, "shadow");
  assert.ok(result.reasons.includes("shadow_mode_requires_56_complete_usable_days"));
  assert.ok(result.selectedModel);
  assert.ok(result.forecast.p50 > 0);
});

test("becomes ready at 56 days when all transparent gates pass", () => {
  const result = buildDemandForecast(optionsFor(dailyObservations(84)));

  assert.equal(result.readiness, "ready");
  assert.equal(result.reasons.length, 0);
  assert.equal(result.modelVersion, "demand-forecast-v1");
  assert.match(result.selectedModel, /weekday|trend/);
  assert.ok(result.forecast.p10 <= result.forecast.p50);
  assert.ok(result.forecast.p50 <= result.forecast.p90);
  assert.equal(result.p50, result.forecast.p50);
  assert.ok(result.diagnostics.gates.rollingOriginBacktest.actualOrigins >= 8);
  assert.deepEqual(
    buildDemandForecast(optionsFor(dailyObservations(84))),
    result,
  );
});

test("does not zero-fill sold-out, censored, or incomplete days", () => {
  const observations = dailyObservations(84);
  observations[70] = {
    ...observations[70],
    demand: 0,
    soldOut: true,
  };
  observations[71] = {
    ...observations[71],
    demand: 0,
    complete: false,
  };
  const result = buildDemandForecast(optionsFor(observations));

  assert.equal(result.sampleSize, 82);
  assert.deepEqual(result.diagnostics.excluded, {
    incompleteDays: 1,
    censoredOrSoldOutDays: 1,
  });
  assert.equal(result.diagnostics.latest28Completeness, undefined);
  assert.equal(result.diagnostics.gates.latest28Completeness.usableDays, 26);
  assert.equal(result.readiness, "ready");
});

test("fails completeness and freshness gates independently", () => {
  const observations = dailyObservations(84);
  for (let index = 60; index < 64; index += 1) observations[index].complete = false;
  const incomplete = buildDemandForecast(optionsFor(observations));
  assert.equal(incomplete.readiness, "not_ready");
  assert.ok(incomplete.reasons.includes("latest_28_days_below_90_percent_complete"));

  const stale = buildDemandForecast(optionsFor(dailyObservations(84), {
    asOf: "2026-03-27T23:45:00.000Z",
  }));
  assert.equal(stale.readiness, "not_ready");
  assert.ok(stale.reasons.includes("latest_observation_is_not_fresh"));
});

test("does not let a fresh excluded record satisfy freshness", () => {
  const observations = dailyObservations(84);
  observations.push({
    date: "2026-03-26",
    complete: false,
    observedAt: "2026-03-26T23:30:00.000Z",
  });
  const result = buildDemandForecast(optionsFor(observations, {
    forecastDate: "2026-03-27",
    asOf: "2026-03-26T23:45:00.000Z",
  }));

  assert.equal(result.diagnostics.gates.freshness.passed, false);
  assert.ok(result.reasons.includes("latest_observation_is_not_fresh"));
});

test("requires four observations for the forecast weekday", () => {
  const observations = dailyObservations(56).map((observation) => ({
    ...observation,
    soldOut: new Date(`${observation.date}T00:00:00.000Z`).getUTCDay() === 0,
  }));
  const result = buildDemandForecast(optionsFor(observations, {
    forecastDate: "2026-03-01",
  }));

  assert.equal(result.diagnostics.gates.forecastWeekdayObservations.actual, 0);
  assert.ok(result.reasons.includes(
    "fewer_than_4_usable_forecast_weekday_observations",
  ));
});

test("rejects every model when rolling-origin error exceeds the configured gate", () => {
  const observations = dailyObservations(84, {
    demand: (index) => index % 2 === 0 ? 1 : 100,
  });
  const result = buildDemandForecast(optionsFor(observations, {
    maxErrorPct: 1,
  }));

  assert.equal(result.readiness, "not_ready");
  assert.equal(result.selectedModel, null);
  assert.deepEqual(result.forecast, { p10: null, p50: null, p90: null });
  assert.ok(result.reasons.includes("no_candidate_model_passed_error_gate"));
  assert.ok(result.diagnostics.candidates.every(
    (candidate) => !candidate.errorGatePassed,
  ));
});

test("preserves legitimate complete zero-demand observations", () => {
  const observations = dailyObservations(84, {
    demand: () => 0,
  });
  const result = buildDemandForecast(optionsFor(observations));

  assert.equal(result.readiness, "ready");
  assert.deepEqual(result.forecast, { p10: 0, p50: 0, p90: 0 });
  assert.equal(result.sampleSize, 84);
});
