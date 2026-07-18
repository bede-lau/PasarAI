import { readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const excludedTopLevel = new Set([
  ".claude",
  ".git",
  ".omc",
  ".omx",
  ".pasarai-evidence",
  ".tmp",
  "node_modules",
  "PasarAI_Handoff_Package",
  "skills",
]);
const allowedRootFiles = new Set([
  ".env.example",
  ".gitignore",
  ".npmrc",
  "DESIGN.md",
  "PRODUCT.md",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.json",
]);
const allowedImplementationRoots = [
  ".github/workflows/",
  "apps/web/",
  "databricks/",
  "docs/",
  "fixtures/",
  "packages/contracts/",
  "packages/elevenlabs-agent/",
  "packages/finance/",
  "scripts/config/",
  "scripts/quality/",
  "scripts/security/",
  "scripts/seed/",
  "services/api/",
  "tests/ci/",
  "tests/config/",
  "tests/contracts/",
  "tests/docs/",
  "tests/integration/",
  "tests/scaffold/",
  "tests/scope/",
  "tests/security/",
  "tests/types/",
];
const excludedDirectoryNames = new Set([
  ".next",
  "__pycache__",
  "coverage",
  "dist",
  "node_modules",
]);
const violations = [];

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory() && excludedDirectoryNames.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(path));
    else files.push(path);
  }
  return files;
}

for (const entry of await readdir(root, { withFileTypes: true })) {
  if (excludedTopLevel.has(entry.name)) continue;
  if (entry.isFile()) {
    if (!allowedRootFiles.has(entry.name)) violations.push(`${entry.name} is outside the implementation allowlist`);
    continue;
  }
  for (const file of await listFiles(join(root, entry.name))) {
    const path = relative(root, file).replaceAll("\\", "/");
    if (!allowedImplementationRoots.some((prefix) => path.startsWith(prefix))) {
      violations.push(`${path} is outside the implementation allowlist`);
    }
  }
}

if (violations.length) {
  console.error(`Scope violation: file is outside the active implementation allowlist.\n${violations.map((path) => `- ${path}`).join("\n")}`);
  process.exitCode = 1;
} else {
  console.log("Scope guard: PASS (active workstreams remain inside owned roots)");
}
