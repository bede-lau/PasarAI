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

async function localFallback(local, input) {
  return local.interpret(input);
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
      if (!apiKey) return localFallback(local, input);

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
        if (selected) return selected;
      }

      return localFallback(local, input);
    },
  };
}
