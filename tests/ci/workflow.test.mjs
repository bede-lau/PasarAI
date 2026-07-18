import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const workflowUrl = new URL("../../.github/workflows/ci.yml", import.meta.url);

test("GitHub Actions runs the pinned, secret-free foundation CI command", async () => {
  const workflow = await readFile(workflowUrl, "utf8");

  assert.match(workflow, /actions\/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5\s+# v4/);
  assert.match(workflow, /pnpm\/action-setup@f40ffcd9367d9f12939873eb1018b921a783ffaa\s+# v4/);
  assert.match(workflow, /actions\/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020\s+# v4/);
  assert.match(workflow, /version:\s*10\.29\.3/);
  assert.match(workflow, /node-version:\s*24/);
  assert.match(workflow, /pnpm install --frozen-lockfile/);
  assert.match(workflow, /pnpm ci:check/);
  assert.match(workflow, /permissions:\s*\n\s*contents:\s*read/);
  assert.doesNotMatch(workflow, /\bsecrets\./i);
  assert.doesNotMatch(workflow, /\bdeploy\b/i);
});
