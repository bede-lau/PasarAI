import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const checker = fileURLToPath(new URL("../../scripts/config/check-env-example.mjs", import.meta.url));

test("public env check accepts placeholders and rejects real-looking configuration", async () => {
  execFileSync(process.execPath, [checker], {
    cwd: root,
    stdio: "pipe",
  });
  const example = await readFile(join(root, ".env.example"), "utf8");
  for (const name of [
    "DASHSCOPE_API_KEY",
    "DASHSCOPE_BASE_URL",
    "DASHSCOPE_ORCHESTRATOR_MODEL",
    "DASHSCOPE_ORCHESTRATOR_FALLBACK_MODEL",
    "ELEVENLABS_AGENT_ID",
    "ELEVENLABS_SCRIBE_KEYTERMS",
    "NEXT_PUBLIC_ELEVENLABS_AGENT_ID",
    "PASARAI_API_BASE_URL",
    "PASARAI_API_BEARER_TOKEN",
    "PASARAI_DASHBOARD_DATE",
    "PASARAI_MERCHANT_ID",
    "PASARAI_MERCHANT_NAME",
    "PASARAI_PRODUCT_ID",
    "PASARAI_PRODUCT_NAME",
    "PASARAI_PRODUCT_CATALOG_JSON",
    "PASARAI_COMPONENT_CATALOG_JSON",
    "PASARAI_LLM_TIMEOUT_MS",
    "PASARAI_MESSAGE_INTERPRETER_MODULE",
    "PASARAI_SYNTHETIC_PREVIEW",
    "PASARAI_TELEGRAM_PROCESSING_LEASE_MS",
    "PASARAI_WEB_ACCESS_CODE",
    "PASARAI_WEB_SESSION_SECRET",
  ]) {
    assert.match(example, new RegExp(`^${name}=`, "m"));
  }

  const temporaryDirectory = await mkdtemp(join(tmpdir(), "pasarai-env-"));
  const unsafeFile = join(temporaryDirectory, ".env.example");
  const hostileKey = ["sk", "proj", "A".repeat(24)].join("-");
  const hostileUrl = ["https", "://", ["workspace", "invalid"].join(".")].join("");
  const hostileCatalog = ["merchant", "analytics"].join("_");
  await writeFile(
    unsafeFile,
    [
      ["ELEVENLABS_API_KEY", hostileKey].join("="),
      `# fake example: ${hostileUrl}`,
      ["DATABRICKS_CATALOG", hostileCatalog].join("="),
    ].join("\n"),
  );

  const result = spawnSync(process.execPath, [checker, "--file", unsafeFile], {
    cwd: root,
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /unsafe environment example/i);
});
