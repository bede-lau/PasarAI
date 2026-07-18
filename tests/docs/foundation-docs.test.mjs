import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

async function document(path) {
  return readFile(new URL(`../../docs/${path}`, import.meta.url), "utf8");
}

test("integration documentation locks contracts-first ownership and breaking-change coordination", async () => {
  const integration = await document("integration-plan.md");
  const mergeOrder = await document("merge-order.md");
  const contractChanges = await document("contract-change-process.md");
  const manualActions = await document("manual-actions.md");

  assert.match(integration, /packages\/contracts.*sole canonical/i);
  for (const boundary of ["apps/web", "services/api", "packages/finance", "databricks/"]) {
    assert.match(integration, new RegExp(boundary.replace("/", "\\/"), "i"));
  }
  assert.match(mergeOrder, /contracts.*first/i);
  assert.match(mergeOrder, /01.*02.*03.*04.*05.*06/s);
  assert.match(contractChanges, /breaking/i);
  assert.match(contractChanges, /fixtures/i);
  assert.match(contractChanges, /notify/i);
  assert.match(manualActions, /credential/i);
  assert.match(manualActions, /not automated/i);
  assert.match(integration, /prompts? 01-05.*active owned implementation roots/i);
  assert.match(integration, /prompt 06 remains.*QA\/demo-hardening/i);
});

test("ADRs record the three foundation decisions", async () => {
  const jsonSchema = await document("adr/0001-json-schema-contract-authority.md");
  const manifest = await document("adr/0002-endpoint-manifest.md");
  const seed = await document("adr/0003-local-synthetic-seed-boundary.md");

  assert.match(jsonSchema, /JSON Schema.*canonical/i);
  assert.match(manifest, /endpoint manifest.*OpenAPI.*deferred/is);
  assert.match(seed, /synthetic.*local-only/is);
  for (const adr of [jsonSchema, manifest, seed]) {
    assert.match(adr, /Status:\s*Accepted/i);
    assert.match(adr, /Consequences/i);
  }
});
