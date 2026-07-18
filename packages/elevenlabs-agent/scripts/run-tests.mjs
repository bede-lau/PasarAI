import { readFile } from "node:fs/promises";

import {
  runAgentTests,
  waitForAgentTests,
} from "../src/index.mjs";

const deployment = JSON.parse(
  await readFile(new URL("../../../.tmp/elevenlabs-deployment.json", import.meta.url), "utf8"),
);
const invocation = await runAgentTests({
  apiKey: process.env.ELEVENLABS_API_KEY,
  agentId: process.env.ELEVENLABS_AGENT_ID,
  testIds: deployment.testIds,
  repeatCount: Number(process.env.ELEVENLABS_TEST_REPEAT_COUNT ?? "1"),
});
const result = await waitForAgentTests({
  apiKey: process.env.ELEVENLABS_API_KEY,
  invocationId: invocation.id,
});
const failed = (result.test_runs ?? []).filter(({ status }) => status === "failed");

console.log(JSON.stringify({
  invocationId: invocation.id,
  testRunCount: result.test_runs?.length ?? 0,
  bucketingStatus: result.bucketing_status ?? null,
  failed: failed.map(({ test_id: testId, test_name: testName }) => ({ testId, testName })),
}, null, 2));

if (failed.length) process.exitCode = 1;
