import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { extname } from "node:path";
import { test } from "node:test";

const packageRoot = new URL("../../packages/contracts/", import.meta.url);
const forbiddenSegments = ["apps/", "services/", "databricks/", "packages/finance", "@pasarai/finance", "@pasarai/api", "@pasarai/web"];
const importPattern = /\b(?:from\s+|import\s*\(|require\s*\()\s*["']([^"']+)["']/g;

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const url = new URL(entry.name, directory);
    if (entry.isDirectory()) files.push(...await sourceFiles(new URL(`${entry.name}/`, directory)));
    else if ([".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"].includes(extname(entry.name))) files.push(url);
  }
  return files;
}

test("contracts source and generators do not import specialist workspaces", async () => {
  const violations = [];
  for (const directory of ["src/", "scripts/"]) {
    for (const file of await sourceFiles(new URL(directory, packageRoot))) {
      const contents = await readFile(file, "utf8");
      for (const match of contents.matchAll(importPattern)) {
        if (forbiddenSegments.some((segment) => match[1].includes(segment))) {
          violations.push(`${file.pathname}: ${match[1]}`);
        }
      }
    }
  }
  assert.deepEqual(violations, []);
});

test("contracts package dependencies do not depend on specialist workspaces", async () => {
  const packageJson = JSON.parse(await readFile(new URL("package.json", packageRoot), "utf8"));
  const dependencies = {
    ...packageJson.dependencies,
    ...packageJson.devDependencies,
    ...packageJson.peerDependencies,
    ...packageJson.optionalDependencies,
  };
  const forbidden = Object.keys(dependencies).filter((name) =>
    ["@pasarai/finance", "@pasarai/api", "@pasarai/web"].includes(name),
  );
  assert.deepEqual(forbidden, []);
});
