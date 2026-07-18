import { readFileSync } from "node:fs";

function readCsv(relativePath) {
  const lines = readFileSync(new URL(relativePath, import.meta.url), "utf8").trim().split(/\r?\n/);
  const headers = lines[0].split(",");
  return lines.slice(1).map((line) =>
    Object.fromEntries(line.split(",").map((value, index) => [headers[index], value]))
  );
}

function configuredCatalog(name, fallback) {
  const value = process.env[name];
  if (!value) return fallback;
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${name} must be valid JSON`);
  }
  if (
    !Array.isArray(parsed)
    || parsed.some((entry) =>
      !entry
      || typeof entry.id !== "string"
      || !entry.id
      || typeof entry.name !== "string"
      || !entry.name)
  ) {
    throw new Error(`${name} must be an array of non-empty {id, name} objects`);
  }
  return parsed;
}

const products = readCsv(
  "../../../fixtures/synthetic/seed_data/products.csv",
);
const recipeComponents = readCsv(
  "../../../fixtures/synthetic/seed_data/recipe_components.csv",
);
const fallbackProducts = products
  .map(({ product_id: id, name }) => ({ id, name }));
const fallbackComponents = [
  ...new Map(
    recipeComponents.map(({
      component_id: id,
      component_name: name,
    }) => [id, { id, name }]),
  ).values(),
];
const nonDemoMerchantConfigured =
  Boolean(process.env.PASARAI_MERCHANT_ID)
  && process.env.PASARAI_MERCHANT_ID !== "m_kak_lina_001";
if (
  nonDemoMerchantConfigured
  && (
    !process.env.PASARAI_PRODUCT_CATALOG_JSON
    || !process.env.PASARAI_COMPONENT_CATALOG_JSON
  )
) {
  throw new Error(
    "Non-demo merchants require PASARAI_PRODUCT_CATALOG_JSON and PASARAI_COMPONENT_CATALOG_JSON",
  );
}

export const productCatalog = configuredCatalog(
  "PASARAI_PRODUCT_CATALOG_JSON",
  fallbackProducts,
)
  .sort((left, right) => left.id.localeCompare(right.id));

export const componentCatalog = configuredCatalog(
  "PASARAI_COMPONENT_CATALOG_JSON",
  fallbackComponents,
).sort((left, right) => left.id.localeCompare(right.id));
