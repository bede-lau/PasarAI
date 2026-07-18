import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const scanner = join(root, "scripts", "security", "check-unsafe-values.mjs");
const probes = [
  "apps/web/security-probe.txt",
  "services/api/security-probe.txt",
  "databricks/notebooks/security-probe.txt",
  "tests/security-probe.txt",
  "docs/security-probe.md",
  "fixtures/security-probe.json",
  "security-probe.yaml",
  ".github/workflows/security-probe.yml",
];

function runDefaultSecurityCheck(npmExecPath) {
  return spawnSync(process.execPath, [npmExecPath, "security:check"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
}

test("default security:check rejects unsafe values across every implementation area", async () => {
  const npmExecPath = process.env.npm_execpath;
  assert.ok(npmExecPath, "test must be launched through the documented pnpm command");

  const hostileUrl = ["https", "://", ["provider", "invalid"].join("."), "/endpoint"].join("");
  const hostileModel = ["vision", "model", "private"].join("-");
  const hostileWorkspace = ["workspace", "private"].join("-");
  const hostileCatalog = ["merchant", "private"].join("_");
  const hostileKey = ["sk", "proj", "B".repeat(24)].join("-");
  const values = [
    ["DATABRICKS_HOST", hostileUrl].join("="),
    ["ELEVENLABS_API_KEY", hostileKey].join("="),
    ["DATABRICKS_ENDPOINT", hostileUrl].join("="),
    ["DATABRICKS_MODEL_ID", hostileModel].join("="),
    ["DATABRICKS_WORKSPACE_ID", hostileWorkspace].join("="),
    ["DATABRICKS_CATALOG", hostileCatalog].join("="),
    ["RAILWAY_PUBLIC_URL", hostileUrl].join("="),
    ["TELEGRAM_WEBHOOK_SECRET", hostileKey].join("="),
  ];

  for (const [index, relativePath] of probes.entries()) {
    const path = join(root, relativePath);
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `${values[index]}\n`);
      const result = runDefaultSecurityCheck(npmExecPath);
      assert.notEqual(result.status, 0, relativePath);
      assert.match(`${result.stdout}${result.stderr}`, new RegExp(relativePath.replaceAll("\\", "/").replaceAll(".", "\\."), "i"));
    } finally {
      await rm(path, { force: true });
    }
  }
});
