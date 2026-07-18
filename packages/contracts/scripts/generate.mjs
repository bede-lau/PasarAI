import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = join(packageRoot, "src", "v1");
const outputRoot = resolve(
  packageRoot,
  process.argv.includes("--out-dir")
    ? process.argv[process.argv.indexOf("--out-dir") + 1]
    : join("src", "v1"),
);

async function listJsonFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listJsonFiles(path));
    else if (entry.name.endsWith(".schema.json")) files.push(path);
  }
  return files;
}

const schemaTypeNames = new Map();

function refName(ref) {
  if (schemaTypeNames.has(ref)) return schemaTypeNames.get(ref);
  return ref.split("/").at(-1);
}

function objectType(schema, indent) {
  const required = new Set(schema.required ?? []);
  const spacing = " ".repeat(indent + 2);
  const properties = Object.entries(schema.properties ?? {}).map(([name, value]) =>
    `${spacing}readonly ${JSON.stringify(name)}${required.has(name) ? "" : "?"}: ${toType(value, indent + 2)};`
  );
  if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
    properties.push(`${spacing}readonly [key: string]: ${toType(schema.additionalProperties, indent + 2)};`);
  }
  return `{\n${properties.join("\n")}\n${" ".repeat(indent)}}`;
}

function combinatorType(schema, keyword, indent) {
  return schema[keyword].map((branch) => {
    if (branch.required && !branch.properties && schema.properties) {
      const properties = Object.fromEntries(
        branch.required.map((name) => [name, schema.properties[name] ?? {}]),
      );
      return toType({ ...branch, type: "object", properties }, indent);
    }
    return toType(branch, indent);
  }).join(" | ");
}

function toType(schema, indent = 0) {
  if (schema.$ref) return refName(schema.$ref);
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  if (schema.enum) return schema.enum.map((value) => JSON.stringify(value)).join(" | ");
  const object = schema.type === "object" || schema.properties ? objectType(schema, indent) : null;
  if (schema.anyOf) {
    const combinator = combinatorType(schema, "anyOf", indent);
    return object ? `(${object} & (${combinator}))` : combinator;
  }
  if (schema.oneOf) {
    const combinator = combinatorType(schema, "oneOf", indent);
    return object ? `(${object} & (${combinator}))` : combinator;
  }
  if (Array.isArray(schema.type)) return schema.type.map((type) => toType({ ...schema, type }, indent)).join(" | ");
  if (schema.type === "array") return `ReadonlyArray<${toType(schema.items ?? {}, indent)}>`;
  if (object) return object;
  if (schema.type === "string") return "string";
  if (schema.type === "integer" || schema.type === "number") return "number";
  if (schema.type === "boolean") return "boolean";
  if (schema.type === "null") return "null";
  return "unknown";
}

function toLiteralType(value, indent = 0) {
  if (Array.isArray(value)) {
    if (value.length === 0) return "ReadonlyArray<never>";
    return `ReadonlyArray<${[...new Set(value.map((item) => toLiteralType(item, indent)))].join(" | ")}>`;
  }
  if (value !== null && typeof value === "object") {
    const spacing = " ".repeat(indent + 2);
    const properties = Object.entries(value).map(
      ([name, item]) => `${spacing}readonly ${JSON.stringify(name)}: ${toLiteralType(item, indent + 2)};`,
    );
    return `{\n${properties.join("\n")}\n${" ".repeat(indent)}}`;
  }
  return JSON.stringify(value);
}

const schemaFiles = await listJsonFiles(join(sourceRoot, "schemas"));
const schemas = {};
const declarations = [];

for (const file of schemaFiles) {
  const schema = JSON.parse(await readFile(file, "utf8"));
  if (!schema.$id) throw new Error(`${relative(packageRoot, file)} is missing $id`);
  if (schema["x-typescript-name"]) {
    schemaTypeNames.set(schema.$id, schema["x-typescript-name"]);
  }
}

for (const file of schemaFiles) {
  const schema = JSON.parse(await readFile(file, "utf8"));
  const key = schema.$id;
  if (!key) throw new Error(`${relative(packageRoot, file)} is missing $id`);
  schemas[key] = schema;

  for (const [name, definition] of Object.entries(schema.$defs ?? {})) {
    declarations.push(`export type ${name} = ${toType(definition)};`);
  }
  if (schema["x-typescript-name"]) {
    declarations.push(`export type ${schema["x-typescript-name"]} = ${toType(schema)};`);
  }
}

const endpointManifest = JSON.parse(await readFile(join(sourceRoot, "endpoint-manifest.json"), "utf8"));
declarations.push(`export type EndpointManifest = ${toLiteralType(endpointManifest)};`);

const banner = "// Generated from canonical JSON Schemas. Do not edit manually.\n";
const bundle = `${JSON.stringify({ version: "v1", schemas }, null, 2)}\n`;
const runtime = `${banner}export const contractVersion = "v1";\nexport const endpointManifest = ${JSON.stringify(endpointManifest, null, 2)};\nexport const schemas = ${JSON.stringify(schemas, null, 2)};\n`;
const types = `${banner}${declarations.join("\n\n")}\n`;

for (const [path, contents] of [
  [join(outputRoot, "schema-bundle.generated.json"), bundle],
  [join(outputRoot, "runtime.generated.js"), runtime],
  [join(outputRoot, "types", "generated.ts"), types],
]) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
}
