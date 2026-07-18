import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const guard = join(root, "scripts", "quality", "check-scope.mjs");
const bypassDirectory = join(root, "packages", "unowned-specialist", "src");

function runGuard() {
  return spawnSync(process.execPath, [guard], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
}

test("scope guard permits active workstreams and rejects unowned package roots", async () => {
  assert.equal(runGuard().status, 0);

  try {
    await mkdir(bypassDirectory, { recursive: true });
    await writeFile(join(bypassDirectory, "index.js"), "export const bypass = true;\n");
    const result = runGuard();
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /outside the implementation allowlist/i);
  } finally {
    await rm(join(root, "packages", "unowned-specialist"), { recursive: true, force: true });
  }
});
