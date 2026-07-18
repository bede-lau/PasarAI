import { readFileSync } from "node:fs";

import { endpointManifest, schemas } from "@pasarai/contracts/v1";

import {
  componentCatalog,
  productCatalog,
} from "./entity-catalog.mjs";
import { compileSchema } from "./schema-compiler.mjs";

const systemPromptTemplate = readFileSync(
  new URL("./system-prompt.md", import.meta.url),
  "utf8",
).trim();
const firstMessages = JSON.parse(readFileSync(new URL("./first-messages.json", import.meta.url), "utf8"));
const apiHostTemplate = ["https:", "", "{{system__env_pasarai_api_host}}"].join("/");

function catalogSection(title, catalog) {
  return [
    `${title}:`,
    ...catalog.map(({ id, name }) => `- \`${name}\` -> \`${id}\``),
  ].join("\n");
}

const systemPrompt = [
  systemPromptTemplate,
  catalogSection("Products", productCatalog),
  catalogSection("Recipe components", componentCatalog),
].join("\n\n");

const toolNames = {
  "sales.create": "record_sales",
  "costs.create": "record_cost",
  "cost-changes.create": "record_cost_change",
  "price-simulation.create": "simulate_price",
  "corrections.create": "record_correction",
  "daily-summary.get": "get_daily_summary",
};

const toolDescriptions = {
  "sales.create": "Commit a merchant-confirmed sales event. Requires exact product, quantity, unit price, source language, and evidence. Do not call for incomplete or ambiguous sales.",
  "costs.create": "Commit a complete merchant cost event. Never convert a relative increase into a total price yourself; ask for missing unit, denominator, pack size, supplier, or total.",
  "cost-changes.create": "Record a stated relative component-cost increase. Omit pack_size to persist a denominator clarification; call again with the returned clarification_source and the merchant-confirmed pack size to commit exactly once.",
  "price-simulation.create": "Run a read-only price and quantity scenario using deterministic finance calculations. Use the returned values and assumption verbatim.",
  "corrections.create": "Append a correction linked to an existing event. Never overwrite or delete the original evidence.",
  "daily-summary.get": "Fetch the authoritative daily revenue, COGS, gross profit, gross margin, completeness, baseline comparison, assumptions, and cost drivers.",
};

function injectRuntimeValues(endpointId, schema, toolName) {
  if (!schema?.properties) return schema;
  const properties = structuredClone(schema.properties);

  if (properties.merchant_id) properties.merchant_id = { type: "string", dynamicVariable: "merchant_id" };
  if (properties.occurred_at) properties.occurred_at = { type: "string", dynamicVariable: "system__time_utc" };
  if (properties.source) properties.source = { type: "string", constantValue: "voice_agent" };
  if (properties.evidence?.properties?.external_message_id) {
    properties.evidence.properties.external_message_id = {
      type: "string",
      constantValue:
        `pasarai-{{system__conversation_id}}-{{system__agent_turns}}-${toolName}`,
    };
  }
  if (endpointId === "sales.create") {
    properties.lines.items.properties.product_id = {
      ...properties.lines.items.properties.product_id,
      enum: productCatalog.map(({ id }) => id),
      description: "Canonical product ID from the PasarAI product catalog. Use only the exact name-to-ID mapping in the system prompt.",
    };
  }
  if (endpointId === "costs.create" || endpointId === "cost-changes.create") {
    const componentProperty = endpointId === "costs.create"
      ? properties.lines.items.properties.component_id
      : properties.component_id;
    const configured = {
      ...componentProperty,
      enum: componentCatalog.map(({ id }) => id),
      description: "Canonical component ID from the PasarAI recipe-component catalog. Use only the exact name-to-ID mapping in the system prompt.",
    };
    if (endpointId === "costs.create") {
      properties.lines.items.properties.component_id = configured;
    } else {
      properties.component_id = configured;
    }
  }

  return {
    ...schema,
    properties,
    description: `Canonical request body for ${endpointId}.`,
  };
}

function buildToolDefinition(endpoint) {
  const name = toolNames[endpoint.id];
  const requestSchema = endpoint.request_schema
    ? injectRuntimeValues(
        endpoint.id,
        compileSchema(schemas[endpoint.request_schema]),
        name,
      )
    : undefined;
  const responseSchema = endpoint.response_schema
    ? compileSchema(schemas[endpoint.response_schema])
    : undefined;
  const requestHeaders = {
    Authorization: { envVarLabel: "pasarai_api_bearer" },
    ...(endpoint.idempotency_required
    ? {
        "Idempotency-Key": `pasarai-{{system__conversation_id}}-{{system__agent_turns}}-${name}`,
      }
    : {}),
  };
  const queryParamsSchema = endpoint.id === "daily-summary.get"
    ? {
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
      }
    : undefined;

  return {
    name,
    endpointId: endpoint.id,
    method: endpoint.method,
    path: endpoint.path,
    mutation: endpoint.mutation,
    toolConfig: {
      type: "webhook",
      name,
      description: toolDescriptions[endpoint.id],
      responseTimeoutSecs: 20,
      interruptionMode: "disable_during_tool",
      preToolSpeech: endpoint.mutation ? "force" : "auto",
      toolErrorHandlingMode: "summarized",
      apiSchema: {
        url: `${apiHostTemplate}${endpoint.path}`,
        method: endpoint.method,
        requestHeaders,
        ...(queryParamsSchema ? { queryParamsSchema } : {}),
        ...(requestSchema ? { requestBodySchema: requestSchema } : {}),
        ...(responseSchema ? { responseBodySchema: responseSchema } : {}),
        contentType: "application/json",
      },
    },
  };
}

export const toolDefinitions = endpointManifest.endpoints
  .filter(({ conversation_tool: conversationTool }) => conversationTool)
  .map(buildToolDefinition);

export function buildAgentConfiguration({ toolIds }) {
  const missingToolIds = toolDefinitions
    .map(({ name }) => name)
    .filter((name) => !toolIds[name]);
  if (missingToolIds.length) {
    throw new Error(`Missing ElevenLabs tool IDs: ${missingToolIds.join(", ")}`);
  }

  return {
    supportedLanguages: ["en", "ms", "zh"],
    primaryLanguage: "en",
    conversationConfig: {
      agent: {
        firstMessage: firstMessages.en,
        language: "en",
        prompt: {
          prompt: systemPrompt,
          timezone: "Asia/Kuala_Lumpur",
          toolIds: toolDefinitions.map(({ name }) => toolIds[name]),
          builtInTools: {
            languageDetection: {
              type: "system",
              name: "language_detection",
              description: "Call when the user speaks a different supported language or explicitly requests a language switch. Use en, ms, or zh; Manglish remains ms/en code-mixing.",
              params: {
                systemToolType: "language_detection",
              },
            },
          },
        },
      },
      languagePresets: {
        ms: {
          overrides: {
            agent: {
              firstMessage: firstMessages.ms,
              language: "ms",
            },
          },
        },
        zh: {
          overrides: {
            agent: {
              firstMessage: firstMessages.zh,
              language: "zh",
            },
          },
        },
      },
    },
  };
}

export { firstMessages, systemPrompt };
