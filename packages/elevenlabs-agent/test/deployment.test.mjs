import assert from "node:assert/strict";
import { test } from "node:test";

import {
  deployAgentConfiguration,
  waitForAgentTests,
} from "../src/index.mjs";

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("deployment upserts tools and tests while preserving existing agent model and voices", async () => {
  const calls = [];
  let createdTool = 0;
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    const method = options.method ?? "GET";
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ path: parsed.pathname, method, body, headers: options.headers });

    if (method === "GET" && parsed.pathname === "/v1/convai/tools") {
      return response({
        tools: [{
          id: "tool-record-sales",
          tool_config: {
            name: "record_sales",
            type: "webhook",
            api_schema: {
              request_headers: {
                authorization: { secret_id: "secret-existing" },
              },
              auth_connection: { auth_connection_id: "auth-existing" },
            },
          },
        }],
      });
    }
    if (method === "PATCH" && parsed.pathname === "/v1/convai/tools/tool-record-sales") {
      return response({ id: "tool-record-sales", tool_config: body.tool_config });
    }
    if (method === "GET" && parsed.pathname === "/v1/convai/tools/tool-record-sales") {
      return response({
        id: "tool-record-sales",
        tool_config: {
          name: "record_sales",
          type: "webhook",
          api_schema: {
            request_headers: {
              authorization: { secret_id: "secret-existing" },
            },
            auth_connection: { auth_connection_id: "auth-existing" },
          },
        },
      });
    }
    if (method === "POST" && parsed.pathname === "/v1/convai/tools") {
      createdTool += 1;
      return response({
        id: `tool-created-${createdTool}`,
        tool_config: body.tool_config,
      });
    }
    if (method === "GET" && parsed.pathname === "/v1/convai/agents/agent-test") {
      return response({
        agent_id: "agent-test",
        conversation_config: {
          tts: { voice_id: "voice-existing" },
          agent: {
            prompt: {
              llm: "existing-llm",
              temperature: 0,
              tool_ids: ["tool-unrelated"],
            },
          },
          language_presets: {
            ms: {
              overrides: {
                tts: { voice_id: "voice-ms-existing" },
              },
            },
          },
        },
      });
    }
    if (method === "PATCH" && parsed.pathname === "/v1/convai/agents/agent-test") {
      return response({ agent_id: "agent-test", conversation_config: body.conversation_config });
    }
    if (method === "GET" && parsed.pathname === "/v1/convai/agent-testing") {
      return response({ tests: [], has_more: false });
    }
    if (method === "POST" && parsed.pathname === "/v1/convai/agent-testing/create") {
      return response({ id: `test-${calls.filter((call) => call.path.endsWith("/create")).length}` });
    }

    return response({ error: "unexpected request" }, 500);
  };

  const result = await deployAgentConfiguration({
    apiKey: "test-key",
    agentId: "agent-test",
    fetchImpl,
  });

  assert.equal(result.agentId, "agent-test");
  assert.equal(Object.keys(result.toolIds).length, 6);
  assert.equal(result.testIds.length, 14);

  const agentPatch = calls.find(
    ({ method, path }) => method === "PATCH" && path === "/v1/convai/agents/agent-test",
  );
  assert.equal(agentPatch.body.conversation_config.tts.voice_id, "voice-existing");
  assert.equal(agentPatch.body.conversation_config.agent.prompt.llm, "existing-llm");
  assert.equal(agentPatch.body.conversation_config.agent.prompt.temperature, 0);
  assert.equal(
    agentPatch.body.conversation_config.language_presets.ms.overrides.tts.voice_id,
    "voice-ms-existing",
  );
  assert.deepEqual(
    agentPatch.body.conversation_config.agent.prompt.tool_ids,
    Object.values(result.toolIds),
  );
  assert.equal(agentPatch.body.conversation_config.agent.prompt.tool_ids.length, 6);
  assert.equal(agentPatch.body.conversation_config.agent.prompt.tool_ids.includes("tool-unrelated"), false);
  assert.equal(
    agentPatch.body.conversation_config.agent.prompt.built_in_tools.language_detection.params.system_tool_type,
    "language_detection",
  );
  const toolPatch = calls.find(
    ({ method, path }) => method === "PATCH" && path === "/v1/convai/tools/tool-record-sales",
  );
  assert.deepEqual(
    toolPatch.body.tool_config.api_schema.request_headers.authorization,
    { secret_id: "secret-existing" },
  );
  assert.deepEqual(
    toolPatch.body.tool_config.api_schema.auth_connection,
    { auth_connection_id: "auth-existing" },
  );
  assert.equal(
    calls.some(({ method, path }) => method === "POST" && path === "/v1/convai/agents"),
    false,
  );
  assert.ok(calls.every(({ headers }) => headers["xi-api-key"] === "test-key"));
});

test("remote test polling waits for terminal VN results", async () => {
  let polls = 0;
  const fetchImpl = async () => {
    polls += 1;
    return response({
      id: "invocation-test",
      test_runs: polls === 1
        ? [{ test_run_id: "run-1", test_id: "test-1", status: "pending" }]
        : [{ test_run_id: "run-1", test_id: "test-1", status: "passed" }],
    });
  };

  const result = await waitForAgentTests({
    apiKey: "test-key",
    invocationId: "invocation-test",
    fetchImpl,
    pollIntervalMs: 0,
  });

  assert.equal(polls, 2);
  assert.equal(result.test_runs[0].status, "passed");
});
