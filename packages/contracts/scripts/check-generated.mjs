import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const tempRoot = await mkdtemp(join(tmpdir(), "pasarai-contracts-"));

try {
  execFileSync(process.execPath, ["scripts/generate.mjs", "--out-dir", tempRoot], {
    cwd: packageRoot,
    stdio: "inherit",
  });

  for (const path of [
    "schema-bundle.generated.json",
    "runtime.generated.js",
    "types/generated.ts",
  ]) {
    const [committed, generated] = await Promise.all([
      readFile(join(packageRoot, "src", "v1", path), "utf8"),
      readFile(join(tempRoot, path), "utf8"),
    ]);
    assert.equal(committed, generated, `${path} is stale; run pnpm generate`);
  }
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
