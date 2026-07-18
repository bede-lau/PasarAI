import assert from "node:assert/strict";
import { test } from "node:test";

import { endpointManifest } from "@pasarai/contracts/v1";
import {
  buildAgentConfiguration,
  toolDefinitions,
} from "../src/index.mjs";

test("agent configuration derives conversation tools from canonical contracts", () => {
  const toolIds = Object.fromEntries(toolDefinitions.map(({ name }) => [name, `tool-${name}`]));
  const configuration = buildAgentConfiguration({ toolIds });
  const canonicalEndpoints = endpointManifest.endpoints
    .filter(({ conversation_tool: conversationTool }) => conversationTool)
    .map(({ id, method, path }) => ({
      id,
      method,
      path,
    }));

  assert.deepEqual(
    toolDefinitions.map(({ endpointId, method, path }) => ({
      id: endpointId,
      method,
      path,
    })),
    canonicalEndpoints,
  );
  assert.deepEqual(configuration.supportedLanguages, ["en", "ms", "zh"]);
  assert.equal(configuration.primaryLanguage, "en");
  assert.equal(configuration.conversationConfig.agent.language, "en");
  assert.equal(
    configuration.conversationConfig.agent.prompt.builtInTools.languageDetection.params.systemToolType,
    "language_detection",
  );
  assert.deepEqual(
    Object.keys(configuration.conversationConfig.languagePresets).sort(),
    ["ms", "zh"],
  );
  assert.deepEqual(
    configuration.conversationConfig.agent.prompt.toolIds,
    toolDefinitions.map(({ name }) => toolIds[name]),
  );
  assert.match(configuration.conversationConfig.agent.prompt.prompt, /Products:/);
  assert.match(
    configuration.conversationConfig.agent.prompt.prompt,
    /Nasi Lemak Biasa.*p_nlb_001/,
  );
  const dailySummaryTool = toolDefinitions.find(({ name }) => name === "get_daily_summary");
  const expectedApiHost = ["https:", "", "{{system__env_pasarai_api_host}}"].join("/");
  assert.ok(toolDefinitions.every(({ toolConfig }) =>
    toolConfig.apiSchema.url.startsWith(`${expectedApiHost}/api/v1/`)
  ));
  assert.ok(toolDefinitions.every(({ toolConfig }) =>
    toolConfig.apiSchema.requestHeaders.Authorization.envVarLabel
      === "pasarai_api_bearer"
  ));
  assert.deepEqual(dailySummaryTool.toolConfig.apiSchema.queryParamsSchema, {
    required: ["merchant_id", "date"],
    properties: {
      merchant_id: {
        type: "string",
        dynamicVariable: "merchant_id",
      },
      date: {
        type: "string",
        description: "Merchant-local calendar date in YYYY-MM-DD format. Use the explicit requested date or the current date supplied in the agent system context.",
      },
    },
  });
  assert.doesNotMatch(JSON.stringify(configuration), /api[_-]?key|voice[_-]?id/i);
  assert.doesNotMatch(JSON.stringify(configuration.supportedLanguages), /manglish/i);

  const salesProduct = toolDefinitions
    .find(({ name }) => name === "record_sales")
    .toolConfig.apiSchema.requestBodySchema.properties.lines.items.properties.product_id;
  const costComponent = toolDefinitions
    .find(({ name }) => name === "record_cost")
    .toolConfig.apiSchema.requestBodySchema.properties.lines.items.properties.component_id;
  assert.deepEqual(salesProduct.enum, ["p_nla_001", "p_nlb_001", "p_tehais_001"]);
  assert.ok(costComponent.enum.includes("c_packaging"));
  const costChange = toolDefinitions
    .find(({ name }) => name === "record_cost_change")
    .toolConfig.apiSchema.requestBodySchema;
  assert.ok(costChange.properties.component_id.enum.includes("c_packaging"));
  assert.match(
    costChange.properties.evidence.properties.external_message_id.constantValue,
    /system__conversation_id.*system__agent_turns.*record_cost_change/,
  );
});

test("deployment catalogs can replace synthetic entity mappings explicitly", async () => {
  process.env.PASARAI_PRODUCT_CATALOG_JSON = JSON.stringify([
    { id: "p_live_001", name: "Live Product" },
  ]);
  process.env.PASARAI_COMPONENT_CATALOG_JSON = JSON.stringify([
    { id: "c_live_001", name: "Live Component" },
  ]);
  try {
    const configured = await import(
      `../src/entity-catalog.mjs?configured=${Date.now()}`
    );
    assert.deepEqual(configured.productCatalog, [
      { id: "p_live_001", name: "Live Product" },
    ]);
    assert.deepEqual(configured.componentCatalog, [
      { id: "c_live_001", name: "Live Component" },
    ]);
  } finally {
    delete process.env.PASARAI_PRODUCT_CATALOG_JSON;
    delete process.env.PASARAI_COMPONENT_CATALOG_JSON;
  }
});

test("non-demo agent deployment fails closed without explicit catalogs", async () => {
  process.env.PASARAI_MERCHANT_ID = "m_live_001";
  try {
    await assert.rejects(
      import(`../src/entity-catalog.mjs?missing=${Date.now()}`),
      /Non-demo merchants require/,
    );
  } finally {
    delete process.env.PASARAI_MERCHANT_ID;
  }
});
