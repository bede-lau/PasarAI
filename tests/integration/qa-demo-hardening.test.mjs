import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  evaluationMatrix,
  runAmbiguityChecks,
  runDuplicateDeliveryChecks,
  runFailureModeChecks,
  runGoldenScenario,
} from "../../scripts/seed/demo-fixture-runner.mjs";
import { rehearseDemo } from "../../scripts/seed/rehearse-demo.mjs";
import { resetDemo } from "../../scripts/seed/reset-demo.mjs";

const rootUrl = new URL("../../", import.meta.url);

test("multilingual evaluation matrix covers every voice script and critical text ambiguity", () => {
  assert.equal(evaluationMatrix.synthetic, true);
  assert.deepEqual(
    evaluationMatrix.languages,
    ["en", "ms", "zh", "ms-en"],
  );
  assert.deepEqual(
    evaluationMatrix.cases.map(({ fixture_id: fixtureId }) => fixtureId),
    [
      "VN-01",
      "VN-02",
      "VN-03",
      "VN-04",
      "VN-05",
      "VN-06",
      "VN-07",
      "VN-08",
      "TM-03",
      "TM-07",
    ],
  );
  assert.ok(evaluationMatrix.cases.every((fixture) =>
    fixture.transcript
    && fixture.automated_assertion
    && fixture.manual_assertion
    && Array.isArray(fixture.forbidden_claims)
  ));
  assert.equal(
    evaluationMatrix.cases.find(({ fixture_id: id }) => id === "VN-04")
      .mutation_expectation,
    "read_only",
  );
});

test("golden receipt to Mandarin flow passes three isolated consecutive runs", async () => {
  const results = [];
  for (let run = 1; run <= 3; run += 1) {
    results.push(await runGoldenScenario({ runId: `test-${run}` }));
  }
  assert.deepEqual(results.map(({ status }) => status), [
    "pass",
    "pass",
    "pass",
  ]);
  assert.ok(results.every(({ dashboard }) =>
    dashboard.revenue_rm === "200.00"
    && dashboard.cogs_rm === "127.20"
    && dashboard.gross_profit_rm === "72.80"
    && dashboard.gross_margin_pct === "36.40"
  ));
  assert.ok(results.every(({ mandarin_simulation: scenario }) =>
    scenario.revenue_rm === "192.50"
    && scenario.gross_profit_rm === "81.20"
    && scenario.gross_margin_pct === "42.18"
  ));
});

test("ambiguity, duplicate delivery and provider failures preserve truthful state", async () => {
  const [ambiguity, duplicates, failures] = await Promise.all([
    runAmbiguityChecks(),
    runDuplicateDeliveryChecks(),
    runFailureModeChecks(),
  ]);
  assert.equal(ambiguity.status, "pass");
  assert.equal(ambiguity.mutation_events, 0);
  assert.deepEqual(
    ambiguity.checked_fixtures.map(({ fixture_id: fixtureId }) => fixtureId),
    ["VN-01", "TM-03", "receipt_003_pasar_pagi.jpg"],
  );
  assert.equal(ambiguity.retained_evidence_events, 1);
  assert.deepEqual(duplicates, {
    status: "pass",
    delivery_count: 3,
    sale_events: 1,
    response: {
      state: "committed",
      event_id: "sale-conversation-001",
    },
  });
  assert.equal(failures.provider_failure.state, "review_required");
  assert.equal(
    failures.provider_failure.reason,
    "receipt_provider_unavailable",
  );
  assert.equal(failures.health.status, "degraded");
});

test("demo reset and rehearsal commands produce separated automated, manual and untested reports", async () => {
  const reset = await resetDemo();
  assert.equal(reset.status, "pass");
  assert.equal(reset.synthetic, true);
  assert.equal(reset.live_services_reset, false);
  assert.equal(reset.dashboard_date, "2026-07-16");
  assert.equal(reset.baseline_date, "2026-07-15");
  assert.equal(reset.baseline_unit_cogs_rm, "2.50");
  assert.equal(reset.current_unit_cogs_rm, "3.22");

  const liveReset = await resetDemo({
    resetLiveServices: true,
    liveReset: async () => ({
      reset: true,
      dashboardDate: "2026-07-16",
      baselineDate: "2026-07-15",
      baselineUnitCogsRm: "2.50",
      currentUnitCogsRm: "3.22",
    }),
  });
  assert.equal(liveReset.live_services_reset, true);

  const report = await rehearseDemo({ runs: 3 });
  assert.equal(report.automated.status, "pass");
  assert.equal(report.automated.consecutive_golden_runs, 3);
  assert.equal(report.manual.status, "not_run");
  assert.ok(report.manual.required_actions.length > 0);
  assert.ok(report.untested_dependencies.length > 0);
});

test("timed rehearsal totals 120 seconds and every recovery branch requires disclosure", async () => {
  const plan = JSON.parse(await readFile(
    new URL("fixtures/qa/rehearsal-plan.json", rootUrl),
    "utf8",
  ));
  assert.equal(
    plan.stages.reduce(
      (seconds, stage) => seconds + stage.duration_seconds,
      0,
    ),
    plan.total_seconds,
  );
  assert.equal(plan.total_seconds, 120);
  assert.ok(plan.stages.every((stage) =>
    stage.operator_action && stage.success_signal
  ));
  assert.ok(plan.recovery.every((branch) =>
    branch.action && branch.disclosure
  ));
});

test("release and recovery documents preserve the automated/manual/untested boundary", async () => {
  const [releaseChecklist, rehearsal] = await Promise.all([
    readFile(new URL("docs/qa-demo-release-checklist.md", rootUrl), "utf8"),
    readFile(new URL("docs/demo-120-second-rehearsal.md", rootUrl), "utf8"),
  ]);
  assert.match(releaseChecklist, /Automated pass/i);
  assert.match(releaseChecklist, /Manual pass/i);
  assert.match(releaseChecklist, /Untested dependencies/i);
  assert.match(releaseChecklist, /pnpm demo:reset/);
  assert.match(releaseChecklist, /pnpm demo:rehearse/);
  assert.match(rehearsal, /120 seconds/i);
  assert.match(rehearsal, /receipt_provider_unavailable/);
  assert.match(rehearsal, /Do not claim/i);
});
