import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));

async function snapshot(directory) {
  const names = (await readdir(directory)).sort();
  return Object.fromEntries(await Promise.all(
    names.map(async (name) => [name, await readFile(join(directory, name), "utf8")]),
  ));
}

test("minimal committed seed boundary resets deterministically without the handoff package", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "pasarai-seed-boundary-"));
  try {
    await cp(join(root, "scripts", "seed"), join(temporaryRoot, "scripts", "seed"), { recursive: true });
    await cp(
      join(root, "fixtures", "synthetic", "seed_data"),
      join(temporaryRoot, "fixtures", "synthetic", "seed_data"),
      { recursive: true },
    );
    await cp(
      join(root, "fixtures", "synthetic", "authoritative-source-manifest.json"),
      join(temporaryRoot, "fixtures", "synthetic", "authoritative-source-manifest.json"),
    );

    const reset = join(temporaryRoot, "scripts", "seed", "reset-synthetic.mjs");
    execFileSync(process.execPath, [reset], { cwd: temporaryRoot, stdio: "pipe" });
    const first = await snapshot(join(temporaryRoot, "fixtures", "synthetic", "seed-output"));
    execFileSync(process.execPath, [reset], { cwd: temporaryRoot, stdio: "pipe" });
    assert.deepEqual(
      await snapshot(join(temporaryRoot, "fixtures", "synthetic", "seed-output")),
      first,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
