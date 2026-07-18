import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resetSyntheticSeed } from "./reset-synthetic.mjs";

const defaultWorkspaceRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

function qaReportRoot(workspaceRoot) {
  const root = resolve(workspaceRoot, ".tmp", "qa-demo");
  if (dirname(root) !== resolve(workspaceRoot, ".tmp")) {
    throw new Error(`Refusing unsafe QA report root: ${root}`);
  }
  return root;
}

export async function resetDemo({
  workspaceRoot = defaultWorkspaceRoot,
  resetLiveServices = false,
  environment = process.env,
  liveReset,
} = {}) {
  const resolvedWorkspaceRoot = resolve(workspaceRoot);
  const reportRoot = qaReportRoot(resolvedWorkspaceRoot);
  await rm(reportRoot, { recursive: true, force: true });
  const seed = await resetSyntheticSeed({
    workspaceRoot: resolvedWorkspaceRoot,
  });
  let live = { reset: false, reason: "not_requested" };
  if (resetLiveServices) {
    const reset = liveReset
      ?? (await import(
        "../../services/api/scripts/reset-lakebase-demo.mjs"
      )).resetLakebaseDemoSnapshot;
    live = await reset({ environment });
  }
  await mkdir(reportRoot, { recursive: true });

  const report = {
    status: "pass",
    synthetic: true,
    live_services_reset: live.reset,
    fixture_count: seed.fixtureCount,
    seed_output: relative(resolvedWorkspaceRoot, seed.targetRoot)
      .replaceAll("\\", "/"),
    dashboard_date: live.dashboardDate ?? "2026-07-16",
    baseline_date: live.baselineDate ?? "2026-07-15",
    baseline_unit_cogs_rm: live.baselineUnitCogsRm ?? "2.50",
    current_unit_cogs_rm: live.currentUnitCogsRm ?? "3.22",
    note: live.reset
      ? "Local fixtures and Kak Lina's Lakebase demo snapshot were restored."
      : "Local fixtures were restored. Lakebase was not changed because the live reset was not requested or configured.",
  };
  await writeFile(
    resolve(reportRoot, "reset-report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.loadEnvFile(resolve(defaultWorkspaceRoot, "services", "api", ".env"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const report = await resetDemo({ resetLiveServices: true });
  console.log(
    `PasarAI demo reset: PASS (${report.fixture_count} fixtures; Lakebase ${
      report.live_services_reset ? "restored" : "not configured"
    }; dashboard ${report.dashboard_date})`,
  );
}
