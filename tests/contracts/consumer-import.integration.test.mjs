import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { test } from "node:test";

const consumerRoot = new URL("../../.tmp/g003-contract-consumer/", import.meta.url);

test("a synthetic workspace consumer imports only the public contracts v1 export", async () => {
  await rm(consumerRoot, { recursive: true, force: true });
  await mkdir(consumerRoot, { recursive: true });
  await writeFile(
    new URL("consumer.mjs", consumerRoot),
    [
      'import { contractVersion, endpointManifest, schemas } from "@pasarai/contracts/v1";',
      'console.log(JSON.stringify({ contractVersion, endpointCount: endpointManifest.endpoints.length, hasSales: Boolean(schemas["sales.request"]) }));',
      "",
    ].join("\n"),
  );

  try {
    const output = execFileSync(process.execPath, ["consumer.mjs"], {
      cwd: consumerRoot,
      encoding: "utf8",
    });
    assert.deepEqual(JSON.parse(output), {
      contractVersion: "v1",
      endpointCount: 27,
      hasSales: true,
    });
    assert.doesNotMatch(await readFile(new URL("consumer.mjs", consumerRoot), "utf8"), /apps\/|services\/|databricks\/|packages\/finance/);
  } finally {
    await rm(consumerRoot, { recursive: true, force: true });
  }
});
