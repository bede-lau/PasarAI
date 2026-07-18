import { schemas } from "@pasarai/contracts/v1";

const descriptionByPath = {
  merchant_id: "Exact merchant identifier supplied by the conversation context.",
  occurred_at: "ISO 8601 date-time for the merchant event.",
  source: "PasarAI source channel.",
  source_language: "Use en, ms, zh, or ms-en for Manglish.",
  product_id: "Exact product identifier. Never invent or fuzzy-match a product.",
  component_id: "Exact known recipe component identifier.",
  quantity: "Non-negative decimal string. Never calculate or guess it.",
  unit_price_rm: "Exact MYR amount with two decimal places.",
  proposed_unit_price_rm: "Proposed MYR amount with two decimal places.",
  as_of: "Scenario date in YYYY-MM-DD format.",
  supplier_name: "Supplier name exactly as stated or returned by evidence.",
  uom: "Exact unit of measure such as unit, kg, tray, or bundle.",
  pack_size: "Number of items or base units in one pack or bundle.",
  total_price_rm: "Total purchase price in MYR with two decimal places, not an unexpanded price increase.",
  confidence: "Confidence decimal string between 0 and 1.",
  evidence: "Source evidence. Include at least one canonical evidence field.",
  transcript: "Verbatim merchant statement supporting this event.",
  external_message_id: "Stable source event identifier for idempotency and traceability.",
  target_event_id: "Original event identifier being corrected.",
  reason: "Short reason for the append-only correction.",
  replacement_payload: "Canonical replacement changes; the original event remains immutable.",
  changes: "One or more typed field corrections.",
  kind: "Correction value kind.",
  field: "Canonical field name being corrected.",
  previous_value: "Previous value when known.",
  corrected_value: "Corrected value stated by the merchant.",
};

function dereference(schema) {
  if (!schema?.$ref) return schema;
  const [file, pointer = ""] = schema.$ref.split("#");
  if (file && !file.endsWith("shared/primitives.schema.json")) {
    throw new Error(`Unsupported contract reference: ${schema.$ref}`);
  }

  return pointer
    .split("/")
    .filter(Boolean)
    .reduce((value, segment) => value[segment.replaceAll("~1", "/").replaceAll("~0", "~")], schemas["shared.primitives"]);
}

function mergeAlternatives(alternatives, path) {
  const compiled = alternatives.map((alternative) => compileSchema(alternative, path));
  if (!compiled.every(({ type }) => type === "object")) {
    const enumValues = [...new Set(compiled.flatMap(({ enum: values = [] }) => values))];
    return enumValues.length ? { type: "string", enum: enumValues } : compiled[0];
  }

  const required = compiled
    .map(({ required: fields = [] }) => fields)
    .reduce((intersection, fields) => intersection.filter((field) => fields.includes(field)));
  const properties = {};

  for (const candidate of compiled) {
    for (const [name, property] of Object.entries(candidate.properties ?? {})) {
      if (!properties[name]) {
        properties[name] = property;
        continue;
      }
      if (properties[name].enum || property.enum) {
        properties[name] = {
          ...properties[name],
          enum: [...new Set([...(properties[name].enum ?? []), ...(property.enum ?? [])])],
        };
      }
    }
  }

  return {
    type: "object",
    ...(required.length ? { required } : {}),
    properties,
  };
}

export function compileSchema(input, path = "") {
  const schema = dereference(input);
  if (schema.oneOf) return mergeAlternatives(schema.oneOf, path);

  if (schema.type === "object" || schema.properties) {
    const properties = Object.fromEntries(
      Object.entries(schema.properties ?? {}).map(([name, property]) => [
        name,
        compileSchema(property, path ? `${path}.${name}` : name),
      ]),
    );
    return {
      type: "object",
      ...(schema.required ? { required: [...schema.required] } : {}),
      ...(Object.keys(properties).length ? { properties } : {}),
      ...(schema.description ? { description: schema.description } : {}),
    };
  }

  if (schema.type === "array") {
    return {
      type: "array",
      ...(schema.items ? { items: compileSchema(schema.items, `${path}[]`) } : {}),
      ...(schema.description ? { description: schema.description } : {}),
    };
  }

  const leafName = path.replace(/\[\]$/, "").split(".").at(-1);
  return {
    type: Array.isArray(schema.type) ? schema.type.find((type) => type !== "null") : (schema.type ?? "string"),
    ...(schema.enum ? { enum: [...schema.enum] } : {}),
    ...(Object.hasOwn(schema, "const") ? { enum: [String(schema.const)] } : {}),
    description: schema.description ?? descriptionByPath[leafName] ?? `Canonical ${leafName} value.`,
  };
}
