import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const rootUrl = new URL("../../", import.meta.url);

async function readRootFile(path) {
  return readFile(new URL(path, rootUrl), "utf8");
}

test("root exposes the pnpm workspace and active architecture packages", async () => {
  const packageJson = JSON.parse(await readRootFile("package.json"));
  const workspace = await readRootFile("pnpm-workspace.yaml");

  assert.equal(packageJson.private, true);
  assert.equal(packageJson.packageManager, "pnpm@10.29.3");
  assert.equal(packageJson.engines.node, ">=22 <25");
  assert.equal(packageJson.engines.pnpm, ">=10 <11");
  assert.equal(
    packageJson.scripts.dev,
    "pnpm --parallel --filter @pasarai/api --filter @pasarai/web run dev",
  );
  assert.equal(packageJson.scripts["test:scaffold"], "node --test tests/scaffold/workspace-scaffold.test.mjs");

  for (const workspacePattern of ["apps/*", "services/*", "packages/*"]) {
    assert.match(workspace, new RegExp(`- '${workspacePattern.replace("*", "\\*")}'`));
  }

  const contractsPackage = JSON.parse(await readRootFile("packages/contracts/package.json"));
  assert.equal(contractsPackage.private, true);
  assert.deepEqual(contractsPackage.exports["./v1"], {
    types: "./src/v1/index.ts",
    default: "./src/v1/index.js",
  });

  const contracts = await import(new URL("../../packages/contracts/src/v1/index.js", import.meta.url));
  assert.equal(contracts.contractVersion, "v1");
  assert.equal(contracts.endpointManifest.version, "v1");
  assert.ok(contracts.schemas["shared.primitives"]);

  const apiPackage = JSON.parse(await readRootFile("services/api/package.json"));
  assert.equal(apiPackage.private, true);
  assert.equal(apiPackage.type, "module");
  assert.equal(apiPackage.exports["."], "./src/index.js");
  assert.equal(apiPackage.exports["./backend"], "./src/backend/index.js");
  assert.equal(apiPackage.dependencies["@pasarai/contracts"], "workspace:*");
  assert.equal(apiPackage.dependencies["@pasarai/finance"], "workspace:*");
  assert.equal(
    apiPackage.scripts.dev,
    "node --env-file-if-exists=.env src/server.js",
  );
  assert.equal(
    apiPackage.scripts.start,
    "node --env-file-if-exists=.env src/server.js",
  );

  const financePackage = JSON.parse(await readRootFile("packages/finance/package.json"));
  assert.equal(financePackage.private, true);
  assert.equal(financePackage.type, "module");
  assert.equal(financePackage.exports, "./src/index.js");

  const webPackage = JSON.parse(await readRootFile("apps/web/package.json"));
  assert.equal(webPackage.private, true);
  assert.equal(webPackage.dependencies["@pasarai/contracts"], "workspace:*");
  assert.equal(webPackage.dependencies.next, "16.2.10");
  assert.equal(webPackage.scripts.test, "vitest run");
  assert.equal(webPackage.scripts.build, "next build");
  assert.match(await readRootFile("apps/web/README.md"), /Next\.js dashboard/i);
  assert.match(await readRootFile("apps/web/app/page.tsx"), /loadDashboardState/);

  const agentPackage = JSON.parse(
    await readRootFile("packages/elevenlabs-agent/package.json"),
  );
  assert.equal(agentPackage.private, true);
  assert.equal(agentPackage.exports["."], "./src/index.mjs");

  const fixturesReadme = await readRootFile("fixtures/README.md");
  assert.match(fixturesReadme, /synthetic\/seed_data/);
  assert.match(fixturesReadme, /local-only/i);
});
