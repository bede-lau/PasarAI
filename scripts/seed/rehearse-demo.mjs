import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  runAmbiguityChecks,
  runDuplicateDeliveryChecks,
  runFailureModeChecks,
  runGoldenScenario,
} from "./demo-fixture-runner.mjs";
import { resetDemo } from "./reset-demo.mjs";

const workspaceRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

function rehearsalRuns(argv) {
  const inline = argv.find((argument) => argument.startsWith("--runs="));
  const index = argv.indexOf("--runs");
  const raw = inline?.slice("--runs=".length)
    ?? (index >= 0 ? argv[index + 1] : undefined)
    ?? process.env.PASARAI_REHEARSAL_RUNS
    ?? "3";
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 3) {
    throw new Error("Golden rehearsal requires at least three consecutive runs");
  }
  return parsed;
}

export async function rehearseDemo({
  runs = 3,
} = {}) {
  if (!Number.isSafeInteger(runs) || runs < 3) {
    throw new Error("Golden rehearsal requires at least three consecutive runs");
  }
  await resetDemo({ workspaceRoot });

  const results = [];
  for (let index = 1; index <= runs; index += 1) {
    results.push(await runGoldenScenario({
      runId: `golden-${index}`,
    }));
  }
  const [ambiguity, duplicates, failures] = await Promise.all([
    runAmbiguityChecks(),
    runDuplicateDeliveryChecks(),
    runFailureModeChecks(),
  ]);
  const report = {
    status: "pass",
    synthetic: true,
    live_provider_used: false,
    automated: {
      status: "pass",
      consecutive_golden_runs: results.length,
      golden_metrics_exact: true,
      ambiguity_checks: ambiguity,
      duplicate_delivery_checks: duplicates,
      failure_mode_checks: failures,
    },
    manual: {
      status: "not_run",
      required_actions: [
        "Run the configured ElevenLabs remote conversation suite three times.",
        "Listen to English, Malay, Mandarin, and Manglish pronunciation.",
        "Send live Telegram text, voice, and receipt updates once each.",
        "Warm Lakebase, SQL warehouse, pipeline, and public application.",
        "Run the timed 120-second rehearsal with the selected live receipt provider.",
      ],
    },
    untested_dependencies: [
      "ElevenLabs credits, agent deployment, voices, and microphone permission",
      "Telegram bot token, webhook registration, and merchant chat mapping",
      "Databricks Free Edition quota, Lakebase, SQL warehouse, and Lakeflow availability",
      "Selected live receipt extraction provider and model endpoint",
      "Public HTTPS deployment and production secrets",
    ],
    runs: results,
  };

  const reportRoot = resolve(workspaceRoot, ".tmp", "qa-demo");
  await mkdir(reportRoot, { recursive: true });
  await writeFile(
    resolve(reportRoot, "rehearsal-report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await rehearseDemo({
    runs: rehearsalRuns(process.argv.slice(2)),
  });
  console.log(
    `PasarAI golden rehearsal: PASS (${report.automated.consecutive_golden_runs} consecutive synthetic runs)`,
  );
  console.log(
    "Manual provider checks remain NOT RUN; see .tmp/qa-demo/rehearsal-report.json",
  );
}
