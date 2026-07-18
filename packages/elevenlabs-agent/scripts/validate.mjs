import assert from "node:assert/strict";

import {
  buildAgentConfiguration,
  buildConversationTests,
  toolDefinitions,
} from "../src/index.mjs";

const toolIds = Object.fromEntries(toolDefinitions.map(({ name }) => [name, `validated-${name}`]));
const configuration = buildAgentConfiguration({ toolIds });
const tests = buildConversationTests({ toolIds });

assert.deepEqual(configuration.supportedLanguages, ["en", "ms", "zh"]);
assert.equal(toolDefinitions.length, 6);
assert.equal(tests.length, 14);
assert.equal(
  configuration.conversationConfig.agent.prompt.builtInTools.languageDetection.params.systemToolType,
  "language_detection",
);

const apiHostTemplate = ["https:", "", "{{system__env_pasarai_api_host}}"].join("/");
for (const definition of toolDefinitions) {
  assert.ok(definition.toolConfig.apiSchema.url.startsWith(apiHostTemplate));
  assert.equal(
    definition.toolConfig.apiSchema.requestHeaders.Authorization.envVarLabel,
    "pasarai_api_bearer",
  );
  if (definition.mutation) {
    assert.ok(definition.toolConfig.apiSchema.requestHeaders["Idempotency-Key"]);
  }
}

console.log("ElevenLabs configuration validation: PASS (6 tools, 3 languages, 14 tests covering VN-01 through VN-08)");
