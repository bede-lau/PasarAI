import assert from "node:assert/strict";
import { test } from "node:test";

test("consumer can import committed canonical v1 contracts without generation side effects", async () => {
  const contracts = await import("@pasarai/contracts/v1");

  assert.equal(contracts.contractVersion, "v1");
  assert.equal(contracts.endpointManifest.version, "v1");
  assert.equal(contracts.endpointManifest.endpoints[0].id, "sales.create");
  assert.ok(contracts.schemas["sales.request"]);
});
