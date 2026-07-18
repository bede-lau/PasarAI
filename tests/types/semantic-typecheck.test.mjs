import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const tsc = join(root, "node_modules", "typescript", "bin", "tsc");

test("real TypeScript compilation accepts public types and rejects primitive evidence", async () => {
  execFileSync(process.execPath, [tsc, "--noEmit", "-p", "tsconfig.json"], {
    cwd: root,
    stdio: "pipe",
  });

  const directory = await mkdtemp(join(tmpdir(), "pasarai-types-"));
  const probe = join(directory, "negative.ts");
  try {
    await writeFile(
      probe,
      [
        `import type { Evidence } from ${JSON.stringify(join(root, "packages/contracts/src/v1/index.ts").replaceAll("\\", "/"))};`,
        "const primitive: Evidence = 42;",
        "const unknownValue: unknown = {};",
        "const unknownEvidence: Evidence = unknownValue;",
        "void primitive;",
        "void unknownEvidence;",
      ].join("\n"),
    );

    const result = spawnSync(process.execPath, [
      tsc,
      "--noEmit",
      "--ignoreConfig",
      "--strict",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--target",
      "ES2022",
      probe,
    ], { cwd: root, encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /not assignable to type 'Evidence'/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
