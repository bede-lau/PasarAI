import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";
import { validateContract, validateEndpointInvocation } from "@pasarai/contracts/validator";
import { schemas } from "@pasarai/contracts/v1";

const fixtureRoot = new URL("../../fixtures/contracts/v1/", import.meta.url);

async function readFixtures(kind) {
  const directory = new URL(`${kind}/`, fixtureRoot);
  return Promise.all(
    (await readdir(directory))
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map(async (name) => ({
        name,
        document: JSON.parse(await readFile(new URL(name, directory), "utf8")),
      })),
  );
}

for (const { name, document } of await readFixtures("valid")) {
  test(`accepts valid public contract example ${name}`, () => {
    assert.equal(document.synthetic, true);
    assert.ok(schemas[document.schema_id], `${document.schema_id} must be publicly exported`);
    assert.deepEqual(validateContract(document.schema_id, document.payload), []);
  });
}

for (const { name, document } of await readFixtures("invalid")) {
  test(`rejects invalid public contract example ${name}`, () => {
    assert.equal(document.synthetic, true);
    assert.ok(document.expected_failure);
    const errors = document.validation_kind === "endpoint_invocation"
      ? validateEndpointInvocation(document.invocation)
      : validateContract(document.schema_id, document.payload);
    assert.ok(errors.length > 0);
  });
}
