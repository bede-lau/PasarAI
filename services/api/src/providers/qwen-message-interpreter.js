import {
  createMessageInterpreter as createLocalMessageInterpreter,
  detectReplyLanguage,
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
  reject,
}) {
  const operations = [];
  for (const toolCall of toolCalls) {
    const name = toolCall?.function?.name;
    const tool = toolsByName.get(name);
    if (!tool || typeof toolCall?.function?.arguments !== "string") {
      reject("unknown_tool", { tool: typeof name === "string" ? name : null });
      return null;
    }
    let parsedInput;
    try {
      parsedInput = JSON.parse(toolCall.function.arguments);
    } catch {
      reject("invalid_tool_arguments", { tool: name });
      return null;
    }
    const input = sanitizeToolInput(name, parsedInput);
    if (!validatesSchema(tool.input_schema, input)) {
      reject("schema_invalid", { tool: name });
      return null;
    }
    const operation = operationWithTrustedVoiceLanguage(
      operationForToolUse({ name, input }, {
        occurredAt,
        source,
      }),
      { source, sourceLanguage },
    );
    if (!operation) {
      reject("unsupported_operation", { tool: name });
      return null;
    }
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

const CJK_CHARACTER = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

function aliasExpression(alias) {
  const words = alias.trim().split(/\s+/).filter(Boolean).map(escapeRegex);
  if (!words.length) return null;
  // Latin aliases need word boundaries so "egg" does not match "eggplant".
  // Chinese aliases have no word boundaries to anchor to, so they match on
  // containment instead.
  return CJK_CHARACTER.test(alias)
    ? new RegExp(words.join("\\s*"), "iu")
    : new RegExp(`\\b${words.join("\\s+")}\\b`, "iu");
}

function namesCatalogEntry(text, entries, entryId) {
  const entry = (entries ?? []).find(({ id }) => id === entryId);
  if (!entry) return false;
  return [entry.name, ...(entry.aliases ?? [])]
    .filter(Boolean)
    .some((alias) => aliasExpression(alias)?.test(text) ?? false);
}

const SPELLED_NUMBER =
  /\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|dozen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|satu|dua|tiga|empat|lima|enam|tujuh|lapan|sembilan|sepuluh|belas|puluh|ratus)\b|[一二三四五六七八九十百]/iu;

function statedNumbers(text) {
  return [...text.matchAll(/\d+(?:\.\d+)?/gu)]
    .map((match) => Number.parseFloat(match[0]))
    .filter(Number.isFinite);
}

// A proposal may only carry a number the merchant actually stated. When the
// message spells the number out we cannot match it digit for digit, so we
// accept it and let the confirmation gate show the merchant what we heard.
function valueStatedInText(proposedValue, text) {
  const value = Number.parseFloat(proposedValue);
  if (!Number.isFinite(value)) return false;
  const numbers = statedNumbers(text);
  if (numbers.length) return numbers.includes(value);
  return SPELLED_NUMBER.test(text);
}

function groundedCorrectionTarget(eventId, { text, recentSales }) {
  if (typeof eventId !== "string" || !eventId) return false;
  if (text.includes(eventId)) return true;
  return (recentSales ?? []).some((sale) => sale.event_id === eventId);
}

function correctionRejection(payload, { text, recentSales, products }) {
  if (!groundedCorrectionTarget(payload?.target_event_id, {
    text,
    recentSales,
  })) {
    return "unknown_correction_target";
  }
  const changes = payload?.replacement_payload?.changes ?? [];
  if (!changes.length) return "correction_value_unstated";
  for (const change of changes) {
    if (change.kind === "identifier") {
      if (!namesCatalogEntry(text, products, change.corrected_value)) {
        return "unnamed_product";
      }
      continue;
    }
    if (change.kind === "money" || change.kind === "decimal") {
      if (!valueStatedInText(change.corrected_value, text)) {
        return "correction_value_unstated";
      }
    }
  }
  return null;
}

function groundingRejection(selected, {
  text,
  source,
  products,
  recentSales,
}) {
  const operations = Array.isArray(selected) ? selected : [selected];
  for (const operation of operations) {
    if (operation?.endpoint_id === "sales.create") {
      const lines = operation.payload?.lines;
      if (!plausibleSaleLines(lines)) return "implausible_sale_numbers";
      if (
        source === "telegram_text"
        && !lines.every(({ product_id: productId }) =>
          namesCatalogEntry(text, products, productId)
        )
      ) {
        return "unnamed_product";
      }
      // A typed message says exactly what the merchant meant, so every
      // number in the proposal has to come from it. A voice transcript is
      // lossy, and the confirmation gate is what guards those numbers.
      if (
        source === "telegram_text"
        && !lines.every((line) =>
          valueStatedInText(line.quantity, text)
          && valueStatedInText(line.unit_price_rm, text)
        )
      ) {
        return "unstated_sale_numbers";
      }
    }
    if (operation?.endpoint_id === "cost-changes.create") {
      const increase = Number.parseFloat(operation.payload?.increase_rm);
      if (!Number.isFinite(increase) || increase <= 0) {
        return "non_positive_cost_change";
      }
      if (
        source === "telegram_text"
        && !valueStatedInText(operation.payload?.increase_rm, text)
      ) {
        return "unstated_cost_change_amount";
      }
    }
    if (operation?.endpoint_id === "corrections.create") {
      const rejection = correctionRejection(operation.payload, {
        text,
        recentSales,
        products,
      });
      if (rejection) return rejection;
    }
  }
  return null;
}

// A discarded correction is the one rejection the merchant can act on, so it
// answers with a question instead of the generic "I did not catch that".
const CORRECTION_CLARIFICATIONS = new Set([
  "unknown_correction_target",
  "correction_value_unstated",
]);

// "Correct the sale from last Tuesday" reads to the model like a question
// about last Tuesday, and it answers with a summary the merchant did not ask
// for. An instruction that opens with a correction verb is never answered
// with a read-only lookup.
const CORRECTION_IMPERATIVE =
  /^\s*(?:(?:please|pls|tolong|sila)\s+)?(?:(?:correct|fix|amend|edit|betulkan|pinda|ubah|tukar)\b|请?\s*(?:更正|改正|纠正|修改))/iu;

function onlyReadOnlyRetrieval(selected) {
  const operations = Array.isArray(selected) ? selected : [selected];
  return operations.length > 0
    && operations.every(({ endpoint_id: endpointId }) =>
      endpointId === "daily-summary.get"
      || endpointId === "business-trend.get"
    );
}

function clarificationOperation(rejection, selected, input) {
  const operations = Array.isArray(selected) ? selected : [selected];
  const stated = operations
    .map((operation) => operation?.payload?.reply_language)
    .find(Boolean);
  return {
    endpoint_id: "agent.reply",
    payload: {
      clarification: rejection,
      reply_language:
        stated ?? detectReplyLanguage(input.text, input.sourceLanguage),
    },
  };
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

function defaultRejectionLogger(reason, detail) {
  console.warn("Telegram interpretation rejected", { reason, ...detail });
}

export function createMessageInterpreter({
  environment = process.env,
  fetchImpl = fetch,
  now = () => new Date().toISOString(),
  onRejection = defaultRejectionLogger,
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
      const reject = (reason, detail = {}) => {
        try {
          onRejection(reason, { source: input.source ?? null, ...detail });
        } catch {
          // Diagnostics must never block interpretation.
        }
      };
      // A correction instruction answered with a lookup is a miss, whichever
      // layer produced it, so the check wraps every exit from interpret.
      const grounded = (operations) => {
        if (
          !operations
          || !CORRECTION_IMPERATIVE.test(input.text)
          || !onlyReadOnlyRetrieval(operations)
        ) {
          return operations;
        }
        reject("correction_answered_with_retrieval");
        return clarificationOperation(
          "unknown_correction_target",
          operations,
          input,
        );
      };
      const localResult = await local.interpret(input);
      if (
        isDeterministicRetrieval(localResult)
        || isHighConfidenceTextFastPath(localResult, input.source)
        || !apiKey
      ) {
        return grounded(localResult);
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
                    recentSales: input.recentSales,
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
          reject("request_failed", { model });
          continue;
        }
        if (!response.ok) {
          reject("http_error", { model, status: response.status });
          continue;
        }

        let payload;
        try {
          payload = await response.json();
        } catch {
          reject("invalid_response_body", { model });
          continue;
        }
        const operations = operationsFromToolCalls(
          toolCallsFromResponse(payload),
          {
            toolsByName,
            occurredAt,
            source: input.source,
            sourceLanguage: input.sourceLanguage,
            reject: (reason, detail) => reject(reason, { model, ...detail }),
          },
        );
        const selected = operations ? selectOperations(operations) : null;
        if (operations && !selected) {
          reject("unsafe_selection", { model });
          continue;
        }
        if (!selected) continue;
        const rejection = groundingRejection(selected, {
          text: input.text,
          source: input.source,
          products: activeCatalog.products,
          recentSales: input.recentSales,
        });
        if (!rejection) return grounded(selected);
        reject(rejection, { model });
        if (CORRECTION_CLARIFICATIONS.has(rejection)) {
          return clarificationOperation(rejection, selected, input);
        }
      }

      reject("no_verified_operation", {
        fallback: localResult ? "deterministic" : "none",
      });
      return grounded(localResult);
    },
  };
}
