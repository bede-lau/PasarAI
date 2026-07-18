import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { endpointManifest, schemas } from "./runtime.generated.js";

function schemaUrn(schemaId) {
  return `urn:pasarai:v1:${schemaId}`;
}

function normalizeReferences(value) {
  if (Array.isArray(value)) return value.map(normalizeReferences);
  if (value === null || typeof value !== "object") return value;

  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (key === "$id") return [key, schemaUrn(item)];
    if (key === "$ref" && schemas[item]) {
      return [key, schemaUrn(item)];
    }
    if (key === "$ref" && item.includes("shared/primitives.schema.json")) {
      return [key, `${schemaUrn("shared.primitives")}${item.slice(item.indexOf("#"))}`];
    }
    return [key, normalizeReferences(item)];
  }));
}

const ajv = new Ajv2020({
  allErrors: true,
  allowUnionTypes: true,
  strict: true,
  strictRequired: false,
});
addFormats(ajv);
ajv.addKeyword({ keyword: "x-typescript-name", schemaType: "string" });

for (const [schemaId, schema] of Object.entries(schemas)) {
  ajv.addSchema(normalizeReferences(schema), schemaUrn(schemaId));
}

function errorMessages(errors) {
  return (errors ?? []).map((error) =>
    `${error.instancePath || "$"} ${error.message ?? error.keyword}`
  );
}

export function validateContract(schemaId, payload) {
  const validator = ajv.getSchema(schemaUrn(schemaId));
  if (!validator) throw new Error(`Unknown public schema: ${schemaId}`);
  return validator(payload) ? [] : errorMessages(validator.errors);
}

export function validateEndpointInvocation({ endpoint_id, headers = {}, payload }) {
  const endpoint = endpointManifest.endpoints.find(({ id }) => id === endpoint_id);
  if (!endpoint) return [`Unknown endpoint: ${endpoint_id}`];

  const suppliedHeaders = new Set(Object.keys(headers).map((name) => name.toLowerCase()));
  const errors = endpoint.required_headers
    .filter((name) => !suppliedHeaders.has(name.toLowerCase()))
    .map((name) => `Missing required header: ${name}`);

  if (endpoint.request_schema) errors.push(...validateContract(endpoint.request_schema, payload));
  return errors;
}
