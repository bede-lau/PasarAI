import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const artifact = join(root, "packages", "contracts", "src", "v1", "runtime.generated.js");

test("full ci:check fails closed when a committed generated artifact is stale", async () => {
  const npmExecPath = process.env.npm_execpath;
  assert.ok(npmExecPath, "test must be launched through the documented pnpm command");

  const original = await readFile(artifact, "utf8");
  try {
    await writeFile(artifact, `${original}\n// stale drift regression marker\n`);
    const result = spawnSync(process.execPath, [npmExecPath, "ci:check"], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
    });

    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /runtime\.generated\.js is stale/i);
  } finally {
    await writeFile(artifact, original);
  }
});
