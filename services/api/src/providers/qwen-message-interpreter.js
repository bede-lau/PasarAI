import {
  createMessageInterpreter as createLocalMessageInterpreter,
  loadMessageInterpreterCatalog,
} from "./local-message-interpreter.js";
import {
  buildSystemPrompt,
  buildTools,
  integerEnvironment,
  operationForToolUse,
  operationWithTrustedVoiceLanguage,
  sanitizeToolInput,
  selectOperations,
  validatesSchema,
} from "./message-interpreter-tooling.js";

const DEFAULT_BASE_URL =
  "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";
const DEFAULT_MODEL = "qwen3.7-plus";
const DEFAULT_FALLBACK_MODEL = "qwen-plus";
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_TOKENS = 1_200;

function qwenTools(tools) {
  return tools.map(({
    name,
    description,
    input_schema: parameters,
  }) => ({
    type: "function",
    function: {
      name,
      description,
      parameters,
    },
  }));
}

function toolCallsFromResponse(payload) {
  const calls = payload?.choices?.[0]?.message?.tool_calls;
  return Array.isArray(calls) ? calls : [];
}

function operationsFromToolCalls(toolCalls, {
  toolsByName,
  occurredAt,
  source,
  sourceLanguage,
}) {
  const operations = [];
  for (const toolCall of toolCalls) {
    const name = toolCall?.function?.name;
    const tool = toolsByName.get(name);
    if (!tool || typeof toolCall?.function?.arguments !== "string") {
      return null;
    }
    let parsedInput;
    try {
      parsedInput = JSON.parse(toolCall.function.arguments);
    } catch {
      return null;
    }
    const input = sanitizeToolInput(name, parsedInput);
    if (!validatesSchema(tool.input_schema, input)) return null;
    const operation = operationWithTrustedVoiceLanguage(
      operationForToolUse({ name, input }, {
        occurredAt,
        source,
      }),
      { source, sourceLanguage },
    );
    if (!operation) return null;
    operations.push(operation);
  }
  return operations;
}

const MAX_SALE_QUANTITY = 100_000;
const MAX_UNIT_PRICE_RM = 10_000;

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function plausibleSaleLines(lines) {
  return Array.isArray(lines)
    && lines.length > 0
    && lines.every((line) => {
      const quantity = Number.parseFloat(line?.quantity);
      const unitPrice = Number.parseFloat(line?.unit_price_rm);
      return Number.isFinite(quantity)
        && Number.isFinite(unitPrice)
        && quantity > 0
        && quantity <= MAX_SALE_QUANTITY
        && unitPrice > 0
        && unitPrice <= MAX_UNIT_PRICE_RM;
    });
}

function namesCatalogEntry(text, entries, entryId) {
  const entry = entries.find(({ id }) => id === entryId);
  if (!entry) return false;
  return [entry.name, ...(entry.aliases ?? [])]
    .filter(Boolean)
    .some((alias) =>
      new RegExp(
        `\b${alias.trim().split(/\s+/).map(escapeRegex).join("\s+")}\b`,
        "iu",
      ).test(text)
    );
}

function groundedOperations(selected, { text, source, products }) {
  const operations = Array.isArray(selected) ? selected : [selected];
  for (const operation of operations) {
    if (operation?.endpoint_id === "sales.create") {
      const lines = operation.payload?.lines;
      if (!plausibleSaleLines(lines)) return null;
      if (
        source === "telegram_text"
        && !lines.every(({ product_id: productId }) =>
          namesCatalogEntry(text, products, productId)
        )
      ) {
        return null;
      }
    }
    if (operation?.endpoint_id === "cost-changes.create") {
      const increase = Number.parseFloat(operation.payload?.increase_rm);
      if (!Number.isFinite(increase) || increase <= 0) return null;
    }
  }
  return selected;
}

function isDeterministicRetrieval(operation) {
  return (
    !Array.isArray(operation)
    && (
      operation?.endpoint_id === "daily-summary.get"
      || operation?.endpoint_id === "business-trend.get"
    )
  );
}

function hasCompleteSale(operation) {
  return operation?.endpoint_id === "sales.create"
    && operation.payload?.lines?.length > 0
    && operation.payload.lines.every((line) =>
      line.product_id && line.quantity && line.unit_price_rm
    );
}

function hasClearCostChange(operation) {
  return operation?.endpoint_id === "cost-changes.create"
    && operation.payload?.component_id
    && operation.payload?.increase_rm;
}

function hasCompletePurchase(operation) {
  const item = operation?.payload?.item;
  return operation?.endpoint_id === "purchase-intake.upsert"
    && operation.payload?.supplier_name
    && item?.component_id
    && item.quantity
    && item.uom
    && item.pack_size
    && item.total_price_rm;
}

function isHighConfidenceTextFastPath(operation, source) {
  if (source !== "telegram_text" || !operation) return false;
  const operations = Array.isArray(operation) ? operation : [operation];
  return operations.length > 0 && operations.every((candidate) =>
    hasCompleteSale(candidate)
    || hasClearCostChange(candidate)
    || hasCompletePurchase(candidate)
  );
}

export function createMessageInterpreter({
  environment = process.env,
  fetchImpl = fetch,
  now = () => new Date().toISOString(),
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("fetchImpl is required");
  }
  const apiKey = environment.DASHSCOPE_API_KEY?.trim();
  const baseUrl = (
    environment.DASHSCOPE_BASE_URL ?? DEFAULT_BASE_URL
  ).replace(/\/+$/, "");
  const models = [
    environment.DASHSCOPE_ORCHESTRATOR_MODEL ?? DEFAULT_MODEL,
    environment.DASHSCOPE_ORCHESTRATOR_FALLBACK_MODEL
      ?? DEFAULT_FALLBACK_MODEL,
  ]
    .map((model) => model?.trim())
    .filter((model, index, all) =>
      model && all.indexOf(model) === index
    );
  const timeoutMs = integerEnvironment(
    environment,
    "PASARAI_LLM_TIMEOUT_MS",
    DEFAULT_TIMEOUT_MS,
  );
  const maxTokens = integerEnvironment(
    environment,
    "PASARAI_LLM_MAX_TOKENS",
    DEFAULT_MAX_TOKENS,
  );
  const timeZone = environment.PASARAI_TIME_ZONE
    ?? "Asia/Kuala_Lumpur";
  const catalog = loadMessageInterpreterCatalog({ environment });
  const local = createLocalMessageInterpreter({ environment, now });

  return {
    async healthCheck() {
      return { status: "ok" };
    },

    async interpret(input) {
      if (typeof input?.text !== "string" || !input.text.trim()) return null;
      const localResult = await local.interpret(input);
      if (
        isDeterministicRetrieval(localResult)
        || isHighConfidenceTextFastPath(localResult, input.source)
        || !apiKey
      ) {
        return localResult;
      }

      const occurredAt = input.occurredAt ?? now();
      const activeCatalog = Array.isArray(input.componentCatalog)
        ? {
            ...catalog,
            components: input.componentCatalog.map((component) => {
              const configured = catalog.components.find(
                ({ id }) => id === component.id,
              );
              return {
                ...component,
                aliases: configured?.aliases ?? [],
              };
            }),
          }
        : catalog;
      const tools = buildTools(activeCatalog);
      const toolsByName = new Map(
        tools.map((tool) => [tool.name, tool]),
      );
      const openAiTools = qwenTools(tools);
      for (const model of models) {
        let response;
        try {
          response = await fetchImpl(`${baseUrl}/chat/completions`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${apiKey}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              model,
              messages: [
                {
                  role: "system",
                  content: buildSystemPrompt({
                    ...activeCatalog,
                    occurredAt,
                    timeZone,
                    source: input.source,
                    sourceLanguage: input.sourceLanguage,
                    purchaseIntake: input.purchaseIntake,
                  }),
                },
                {
                  role: "user",
                  content: input.text.trim(),
                },
              ],
              tools: openAiTools,
              tool_choice: "required",
              parallel_tool_calls: true,
              enable_thinking: false,
              max_completion_tokens: maxTokens,
              temperature: 0,
              stream: false,
            }),
            signal: AbortSignal.timeout(timeoutMs),
          });
        } catch {
          continue;
        }
        if (!response.ok) continue;

        let payload;
        try {
          payload = await response.json();
        } catch {
          continue;
        }
        const operations = operationsFromToolCalls(
          toolCallsFromResponse(payload),
          {
            toolsByName,
            occurredAt,
            source: input.source,
            sourceLanguage: input.sourceLanguage,
          },
        );
        const selected = operations ? selectOperations(operations) : null;
        const grounded = selected
          ? groundedOperations(selected, {
              text: input.text,
              source: input.source,
              products: activeCatalog.products,
            })
          : null;
        if (grounded) return grounded;
      }

      return localResult;
    },
  };
}
