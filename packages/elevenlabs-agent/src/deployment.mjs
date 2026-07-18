import {
  buildAgentConfiguration,
  toolDefinitions,
} from "./config.mjs";
import { buildConversationTests } from "./conversation-tests.mjs";

const defaultApiBase = ["https:", "", "api.elevenlabs.io"].join("/");

function snakeCase(key) {
  return key.replace(/[A-Z]/g, (character) => `_${character.toLowerCase()}`);
}

export function toWire(value) {
  if (Array.isArray(value)) return value.map(toWire);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [snakeCase(key), toWire(item)]),
  );
}

function deepMerge(current, desired) {
  if (Array.isArray(desired)) return [...desired];
  if (desired === null || typeof desired !== "object") return desired;

  const merged = {
    ...(current && typeof current === "object" && !Array.isArray(current) ? current : {}),
  };
  for (const [key, value] of Object.entries(desired)) {
    merged[key] = deepMerge(merged[key], value);
  }
  return merged;
}

function mergeAgentConversationConfig(current, desired) {
  return deepMerge(current, desired);
}

function toolName(tool) {
  return tool.tool_config?.name ?? tool.toolConfig?.name;
}

async function requestJson({ fetchImpl, apiBase, apiKey, path, method = "GET", body }) {
  const response = await fetchImpl(`${apiBase}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "xi-api-key": apiKey,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(`ElevenLabs ${method} ${path} failed (${response.status}): ${text}`);
  }
  return parsed;
}

async function listAll(context, path, itemKey) {
  const items = [];
  let cursor;

  do {
    const query = new URLSearchParams({ page_size: "100" });
    if (cursor) query.set("cursor", cursor);
    const page = await requestJson({
      ...context,
      path: `${path}?${query}`,
    });
    items.push(...(page[itemKey] ?? []));
    cursor = page.has_more ? page.next_cursor : undefined;
  } while (cursor);

  return items;
}

async function upsertTools(context) {
  const listed = await listAll(context, "/v1/convai/tools", "tools");
  const existingByName = new Map(listed.map((tool) => [toolName(tool), tool]));
  const toolIds = {};

  for (const definition of toolDefinitions) {
    const existing = existingByName.get(definition.name);
    const desiredToolConfig = toWire(definition.toolConfig);
    const current = existing
      ? await requestJson({
          ...context,
          path: `/v1/convai/tools/${encodeURIComponent(existing.id)}`,
        })
      : undefined;
    const payload = {
      tool_config: existing
        ? deepMerge(current.tool_config ?? current.toolConfig, desiredToolConfig)
        : desiredToolConfig,
    };
    const saved = await requestJson({
      ...context,
      path: existing
        ? `/v1/convai/tools/${encodeURIComponent(existing.id)}`
        : "/v1/convai/tools",
      method: existing ? "PATCH" : "POST",
      body: payload,
    });
    toolIds[definition.name] = saved.id;
  }
  return toolIds;
}

async function patchAgent(context, agentId, toolIds) {
  const currentAgent = await requestJson({
    ...context,
    path: `/v1/convai/agents/${encodeURIComponent(agentId)}`,
  });
  const desired = toWire(buildAgentConfiguration({ toolIds }).conversationConfig);
  const conversationConfig = mergeAgentConversationConfig(
    currentAgent.conversation_config ?? {},
    desired,
  );

  await requestJson({
    ...context,
    path: `/v1/convai/agents/${encodeURIComponent(agentId)}`,
    method: "PATCH",
    body: {
      name: "PasarAI Live Advisor",
      conversation_config: conversationConfig,
      version_description: "PasarAI multilingual prompt, contract-derived tools, and VN-01 to VN-08 acceptance tests",
    },
  });
}

async function upsertTests(context, toolIds) {
  const listed = await listAll(context, "/v1/convai/agent-testing", "tests");
  const existingByName = new Map(listed.map((item) => [item.name, item]));
  const testIds = [];

  for (const blueprint of buildConversationTests({ toolIds })) {
    const request = toWire(blueprint.request);
    const existing = existingByName.get(blueprint.request.name);
    const saved = await requestJson({
      ...context,
      path: existing
        ? `/v1/convai/agent-testing/${encodeURIComponent(existing.id)}`
        : "/v1/convai/agent-testing/create",
      method: existing ? "PUT" : "POST",
      body: request,
    });
    testIds.push(saved.id ?? existing.id);
  }

  return testIds;
}

export async function deployAgentConfiguration({
  apiKey,
  agentId,
  fetchImpl = fetch,
  apiBase = defaultApiBase,
}) {
  if (!apiKey || apiKey === "<PLACEHOLDER>") {
    throw new Error("ELEVENLABS_API_KEY is required");
  }
  if (!agentId || agentId === "<PLACEHOLDER>") {
    throw new Error("ELEVENLABS_AGENT_ID is required; this package never invents or creates one");
  }

  const context = { fetchImpl, apiBase, apiKey };
  const toolIds = await upsertTools(context);
  await patchAgent(context, agentId, toolIds);
  const testIds = await upsertTests(context, toolIds);

  return {
    agentId,
    toolIds,
    testIds,
  };
}

export async function runAgentTests({
  apiKey,
  agentId,
  testIds,
  repeatCount = 1,
  fetchImpl = fetch,
  apiBase = defaultApiBase,
}) {
  if (!Array.isArray(testIds) || testIds.length === 0) {
    throw new Error("At least one ElevenLabs test ID is required");
  }
  return requestJson({
    fetchImpl,
    apiBase,
    apiKey,
    path: `/v1/convai/agents/${encodeURIComponent(agentId)}/run-tests`,
    method: "POST",
    body: {
      tests: testIds.map((testId) => ({ test_id: testId })),
      repeat_count: repeatCount,
    },
  });
}

export async function waitForAgentTests({
  apiKey,
  invocationId,
  fetchImpl = fetch,
  apiBase = defaultApiBase,
  pollIntervalMs = 2_000,
  maxPolls = 120,
}) {
  for (let poll = 0; poll < maxPolls; poll += 1) {
    const result = await requestJson({
      fetchImpl,
      apiBase,
      apiKey,
      path: `/v1/convai/test-invocations/${encodeURIComponent(invocationId)}`,
    });
    const runs = result.test_runs ?? [];
    if (runs.length > 0 && runs.every(({ status }) => status === "passed" || status === "failed")) {
      return result;
    }
    if (pollIntervalMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }

  throw new Error(`ElevenLabs test invocation ${invocationId} did not finish within the polling limit`);
}
