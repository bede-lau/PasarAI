import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));

test("root exposes real quality and CI commands with drift checked before generation", async () => {
  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));

  for (const command of [
    "lint",
    "typecheck",
    "test:unit",
    "test:databricks",
    "test:contract",
    "test:integration",
    "test:qa",
    "test:web:browser",
    "contracts:generate",
    "contracts:check",
    "config:check",
    "seed:synthetic:reset",
    "demo:reset",
    "demo:rehearse",
    "scope:check",
    "security:check",
    "ci:check",
  ]) {
    assert.ok(packageJson.scripts[command], `${command} must be a real root command`);
    assert.doesNotMatch(packageJson.scripts[command], /\b(?:echo|exit 0|true)\b/i);
  }

  assert.ok(packageJson.scripts["ci:check"].startsWith("pnpm contracts:check"));
  assert.doesNotMatch(packageJson.scripts["ci:check"], /contracts:generate/);
  assert.match(
    packageJson.scripts["ci:check"],
    /pnpm test:web:browser && pnpm scope:check/
  );
  assert.match(packageJson.scripts["test:web:browser"], /^pnpm build:web && /);

  execFileSync(process.execPath, ["scripts/quality/lint.mjs"], { cwd: root, stdio: "pipe" });
  execFileSync(process.execPath, ["node_modules/typescript/bin/tsc", "--noEmit", "-p", "tsconfig.json"], {
    cwd: root,
    stdio: "pipe",
  });
});
