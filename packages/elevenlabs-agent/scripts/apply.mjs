import {
  mkdir,
  open,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";

import { deployAgentConfiguration } from "../src/index.mjs";

const stateDirectory = new URL("../../../.tmp/", import.meta.url);
await mkdir(stateDirectory, { recursive: true });
const lockUrl = new URL("elevenlabs-apply.lock", stateDirectory);
const stateUrl = new URL("elevenlabs-deployment.json", stateDirectory);
const temporaryStateUrl = new URL(`elevenlabs-deployment.${process.pid}.tmp`, stateDirectory);
let lock;

try {
  lock = await open(lockUrl, "wx");
} catch (error) {
  if (error.code === "EEXIST") {
    throw new Error("Another local ElevenLabs apply is already running");
  }
  throw error;
}

try {
  const result = await deployAgentConfiguration({
    apiKey: process.env.ELEVENLABS_API_KEY,
    agentId: process.env.ELEVENLABS_AGENT_ID,
  });
  await writeFile(temporaryStateUrl, `${JSON.stringify(result, null, 2)}\n`);
  await rename(temporaryStateUrl, stateUrl);

  console.log(`ElevenLabs configuration applied to ${result.agentId}`);
  console.log(`Upserted ${Object.keys(result.toolIds).length} tools and ${result.testIds.length} tests`);
  console.log("Deployment IDs saved under .tmp for the remote test command");
} finally {
  await lock.close();
  await unlink(lockUrl).catch(() => {});
  await unlink(temporaryStateUrl).catch(() => {});
}
