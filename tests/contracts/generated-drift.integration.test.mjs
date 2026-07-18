import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";

const packageRoot = new URL("../../packages/contracts/", import.meta.url);

test("documented drift command passes for committed artifacts without generation side effects", () => {
  assert.ok(process.env.npm_execpath, "test must be launched through the documented pnpm command");
  execFileSync(process.execPath, [process.env.npm_execpath, "contracts:check"], { stdio: "pipe" });
});

test("drift check fails when a canonical schema changes without regeneration", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "pasarai-g003-drift-"));
  const copiedPackage = join(tempRoot, "contracts");
  await cp(packageRoot, copiedPackage, {
    recursive: true,
    filter: (source) => basename(source) !== "node_modules",
  });

  try {
    const schemaPath = join(copiedPackage, "src", "v1", "schemas", "sales", "request.schema.json");
    const schema = JSON.parse(await readFile(schemaPath, "utf8"));
    schema.title = "Intentional stale-artifact probe";
    await writeFile(schemaPath, `${JSON.stringify(schema, null, 2)}\n`);

    const result = spawnSync(process.execPath, ["scripts/check-generated.mjs"], {
      cwd: copiedPackage,
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /stale|AssertionError/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
