import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function cents(value) {
  return Math.round(Number(value) * 100);
}

export async function validateSyntheticSnapshot(sourceRoot, manifestPath) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const expectedNames = manifest.files.map(({ name }) => name).sort();
  const actualNames = (await readdir(sourceRoot)).sort();
  assert.deepEqual(actualNames, expectedNames, "Synthetic seed snapshot file inventory changed");

  for (const expected of manifest.files) {
    const path = resolve(sourceRoot, expected.name);
    assert.equal(dirname(path), sourceRoot, `Unsafe snapshot path: ${expected.name}`);
    const contents = await readFile(path);
    assert.equal(contents.byteLength, expected.size_bytes, `${expected.name} size drift`);
    assert.equal(sha256(contents), expected.sha256, `${expected.name} hash drift`);
    if (expected.name.endsWith(".json")) JSON.parse(contents.toString("utf8"));
    else assert.ok(contents.toString("utf8").includes(","), `${expected.name} must remain CSV data`);
  }

  const merchant = JSON.parse(await readFile(join(sourceRoot, "merchant.json"), "utf8"));
  assert.equal(merchant.currency, "MYR");

  const receipts = JSON.parse(await readFile(join(sourceRoot, "receipt_ground_truth.json"), "utf8"));
  for (const receipt of Object.values(receipts)) assert.equal(receipt.currency, "MYR");

  const expected = JSON.parse(await readFile(join(sourceRoot, "expected_metrics.json"), "utf8"));
  assert.equal(cents(expected.today.revenue_rm), 40 * 500);
  assert.equal(cents(expected.today.cogs_rm), 40 * 318);
  assert.equal(cents(expected.today.gross_profit_rm), (40 * 500) - (40 * 318));
  assert.equal(cents(expected.scenario_35_at_5_50.revenue_rm), 35 * 550);
  assert.equal(cents(expected.scenario_35_at_5_50.cogs_rm), 35 * 318);

  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  await validateSyntheticSnapshot(
    resolve(workspaceRoot, "fixtures", "synthetic", "seed_data"),
    resolve(workspaceRoot, "fixtures", "synthetic", "authoritative-source-manifest.json"),
  );
  console.log("Synthetic source snapshot validation: PASS");
}
