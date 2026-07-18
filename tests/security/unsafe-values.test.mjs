import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const scanner = join(root, "scripts", "security", "check-unsafe-values.mjs");

test("repository scan permits canonical schema and synthetic URIs but rejects hostile values", async () => {
  execFileSync(process.execPath, [scanner], { cwd: root, stdio: "pipe" });

  const directory = await mkdtemp(join(tmpdir(), "pasarai-security-"));
  try {
    const generatedDirectory = join(directory, ".next", "server");
    await mkdir(generatedDirectory, { recursive: true });
    await writeFile(
      join(generatedDirectory, "generated.js"),
      `export const generated = '${["https", "://", "generated.invalid", "/runtime"].join("")}';\n`,
    );
    execFileSync(process.execPath, [scanner, "--path", directory], {
      cwd: root,
      stdio: "pipe",
    });

    const secret = ["sk", "live", "A".repeat(24)].join("_");
    const unsafeUrl = ["https", "://", "invented.invalid", "/workspace"].join("");
    await writeFile(join(directory, "hostile.txt"), `${secret}\n${unsafeUrl}\n`);

    const result = spawnSync(process.execPath, [scanner, "--path", directory], {
      cwd: root,
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /unsafe repository values/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
