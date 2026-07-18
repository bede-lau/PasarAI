import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { endpointManifest, schemas } from "@pasarai/contracts/v1";

test("fixture-derived examples satisfy or intentionally violate canonical schemas", () => {
  execFileSync(process.execPath, ["scripts/validate-examples.mjs"], {
    cwd: new URL("..", import.meta.url),
    stdio: "pipe",
  });
});

test("endpoint manifest locks mutation, evidence, state, and read-only semantics", () => {
  const endpoints = Object.fromEntries(endpointManifest.endpoints.map((endpoint) => [endpoint.id, endpoint]));

  for (const id of [
    "sales.create",
    "costs.create",
    "purchase-intake.upsert",
    "cost-changes.create",
    "corrections.create",
    "receipt-upload.create",
    "receipt-confirm.create",
    "receipt-review.upsert",
  ]) {
    assert.equal(endpoints[id].mutation, true);
    assert.equal(endpoints[id].idempotency_required, true);
    assert.equal(endpoints[id].evidence_required, true);
    assert.deepEqual(endpoints[id].required_headers, ["Idempotency-Key"]);
  }
  assert.equal(endpoints["purchase-intake.confirm"].mutation, true);
  assert.equal(endpoints["purchase-intake.confirm"].idempotency_required, true);
  assert.equal(endpoints["purchase-intake.confirm"].evidence_required, false);
  assert.deepEqual(
    endpoints["purchase-intake.confirm"].required_headers,
    ["Idempotency-Key"],
  );

  assert.equal(endpoints["corrections.create"].append_only, true);
  assert.equal(endpoints["price-simulation.create"].read_only, true);
  assert.equal(endpoints["price-simulation.create"].mutation, false);
  assert.equal(endpoints["daily-summary.get"].read_only, true);
  assert.equal(endpoints["receipt-reviews.get"].read_only, true);
  assert.equal(endpoints["component-catalog.get"].read_only, true);
  assert.equal(endpointManifest.openapi_status, "deferred_non_canonical");

  for (const endpoint of endpointManifest.endpoints) {
    if (endpoint.request_schema) assert.ok(schemas[endpoint.request_schema]);
    if (endpoint.response_schema) assert.ok(schemas[endpoint.response_schema]);
  }
  assert.ok(schemas["receipt-extraction"]);
});
