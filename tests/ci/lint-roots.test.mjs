import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const lint = join(root, "scripts", "quality", "lint.mjs");

test("lint fails closed for a missing configured root and accepts a configured file root", () => {
  const missing = spawnSync(process.execPath, [lint, "--scan-root", "missing-quality-root"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.notEqual(missing.status, 0);
  assert.match(`${missing.stdout}${missing.stderr}`, /configured lint scan root is missing/i);

  const fileRoot = spawnSync(process.execPath, [lint, "--scan-root", "package.json"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(fileRoot.status, 0, `${fileRoot.stdout}${fileRoot.stderr}`);
});
