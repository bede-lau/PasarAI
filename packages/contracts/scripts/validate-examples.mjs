import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateContract, validateEndpointInvocation } from "../src/v1/validator.js";

const packageRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const fixtureRoot = resolve(packageRoot, "..", "..", "fixtures", "contracts", "v1");

async function fixtures(kind) {
  return Promise.all(
    (await readdir(join(fixtureRoot, kind)))
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map(async (name) => ({
        name,
        document: JSON.parse(await readFile(join(fixtureRoot, kind, name), "utf8")),
      })),
  );
}

function errorsFor(document) {
  return document.validation_kind === "endpoint_invocation"
    ? validateEndpointInvocation(document.invocation)
    : validateContract(document.schema_id, document.payload);
}

for (const { name, document } of await fixtures("valid")) {
  assert.equal(document.synthetic, true, `${name} must be visibly synthetic`);
  assert.equal(errorsFor(document).length, 0, `${name} must validate`);
}

for (const { name, document } of await fixtures("invalid")) {
  assert.equal(document.synthetic, true, `${name} must be visibly synthetic`);
  assert.ok(document.expected_failure, `${name} must document its intended failure`);
  assert.ok(errorsFor(document).length > 0, `${name} must fail validation`);
}
