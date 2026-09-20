import { readFile, readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { basename, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const scanRoot = process.argv.includes("--path")
  ? resolve(process.argv[process.argv.indexOf("--path") + 1])
  : repositoryRoot;
const excludedDirectories = new Set([
  ".git",
  ".next",
  ".omx",
  ".tmp",
  "__pycache__",
  "coverage",
  "dist",
  "node_modules",
  "PasarAI_Handoff_Package",
  "skills",
]);
const excludedFileNames = new Set([
  "next-env.d.ts",
]);
const placeholderValues = new Set(["", "PLACEHOLDER", "<PLACEHOLDER>", "[PLACEHOLDER]", "__PLACEHOLDER__"]);
const reviewedActionShas = new Set([
  "34e114876b0b11c390a56381ad16ebd13914f8d5",
  "49933ea5288caeca8642d1e84afbd3f7d6820020",
  "f40ffcd9367d9f12939873eb1018b921a783ffaa",
]);
const secretPatterns = [
  /\bsk-proj-[A-Za-z0-9_-]{12,}\b/g,
  /\bsk_[A-Za-z0-9_-]{12,}\b/g,
  /\bxoxb-[A-Za-z0-9-]{12,}\b/g,
  /\bAKIA[A-Z0-9]{16}\b/g,
  /\bdapi[A-Za-z0-9]{16,}\b/g,
  /\bghp_[A-Za-z0-9]{20,}\b/g,
  /\b[A-Za-z0-9_-]{20,}:[A-Za-z0-9_-]{20,}\b/g,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
];
const urlPattern = /\b(?:https?|postgres(?:ql)?):\/\/[^\s"'`<>]+/g;
const allowedUrls = [
  /^http:\/\/pasarai\.test(?:\/|$)/,
  /^https:\/\/api\.elevenlabs\.io\/v1\/speech-to-text$/,
  /^https:\/\/api\.telegram\.org(?:\/|$)/,
  /^https:\/\/accounts\.google\.com(?:\/|$)/,
  /^https:\/\/docs\.google\.com(?:\/|$)/,
  /^https:\/\/json-schema\.org\/draft\/2020-12\/schema$/,
  /^https:\/\/oauth2\.googleapis\.com(?:\/|$)/,
  /^https:\/\/registry\.npmjs\.org(?:\/|$)/,
  /^https:\/\/sheets\.googleapis\.com(?:\/|$)/,
  /^https:\/\/unpkg\.com\/@elevenlabs\/convai-widget-embed@0\.14\.10$/,
  /^https:\/\/www\.googleapis\.com(?:\/|$)/,
  /^https:\/\/dashscope-intl\.aliyuncs\.com(?:\/|$)/,
  /^https:\/\/www\.loom\.com\/share\/[A-Za-z0-9]+$/,
  /^https:\/\/github\.com\/bede-lau(?:\/|$)/,
  /^https:\/\/bede-lau\.github\.io(?:\/|$)/,
  /^https?:\/\/localhost(?::\d+)?(?:\/|$)/,
  /^https?:\/\/127\.0\.0\.1(?::\d+)?(?:\/|$)/,
  /^https?:\/\/(?:[A-Za-z0-9-]+\.)*example(?:\/|$)/,
  /^https?:\/\/(?:[A-Za-z0-9-]+\.)*test(?:\/|$)/,
];
const allowedSchemes = ["synthetic://"];
const secretSuffix = /(?:TOKEN|KEY|SECRET|PASSWORD|DATABASE_URL)$/;
const configSuffix = /(?:HOST|URL|ENDPOINT|MODEL(?:_ID)?|WORKSPACE(?:_ID)?|CATALOG|SCHEMA)$/;
const providerPrefix = /^(?:databricks|elevenlabs|telegram|railway|lakebase|provider|receipt|database)[_.-]/i;
const codeExtensions = new Set([".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".mts", ".cts", ".py"]);
const testFilePattern = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const assignmentPatterns = [
  /\b([A-Z][A-Z0-9_]*)[ \t]*=[ \t]*([^\r\n#]*)/g,
  /"([^"]+)"\s*:\s*"([^"]*)"/g,
  /^\s*([A-Za-z0-9_.-]+)\s*:\s*([^#\r\n]*)$/gm,
];

async function listFiles(path) {
  const entries = await readdir(path, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOTDIR") return null;
    throw error;
  });
  if (entries === null) return [path];

  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory() && excludedDirectories.has(entry.name)) continue;
    if (entry.isFile() && excludedFileNames.has(entry.name)) continue;
    const entryPath = join(path, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(entryPath));
    else if (entry.isFile()) files.push(entryPath);
  }
  return files;
}

function isAllowedUrl(value) {
  return allowedUrls.some((pattern) => pattern.test(value))
    || allowedSchemes.some((scheme) => value.startsWith(scheme));
}

function normalizeValue(value) {
  return value
    .trim()
    .replace(/[;,]+$/, "")
    .trim()
    .replace(/^["'`]|["'`]$/g, "")
    .trim();
}

function allowedValue(value) {
  const normalized = normalizeValue(value);
  return placeholderValues.has(normalized)
    || /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(normalized)
    || reviewedActionShas.has(normalized)
    || isAllowedUrl(normalized);
}

function sensitiveTier(name) {
  const uppercase = name.replaceAll("-", "_").toUpperCase();
  if (name !== uppercase && !providerPrefix.test(name)) return null;
  if (secretSuffix.test(uppercase)) return "secret";
  if (configSuffix.test(uppercase)) return "config";
  return null;
}

function assignmentFindings(contents, displayPath) {
  if (testFilePattern.test(displayPath)) return [];

  const sourceFile = codeExtensions.has(extname(displayPath));
  const findings = [];

  for (const pattern of assignmentPatterns) {
    for (const match of contents.matchAll(pattern)) {
      const [, name, value] = match;
      const tier = sensitiveTier(name);
      if (tier === null) continue;
      if (tier === "config" && sourceFile) continue;
      if (allowedValue(value)) continue;
      findings.push(`${displayPath}: unsafe configured value for ${name}`);
    }
  }
  return findings;
}

function includedPath(file) {
  const relativePath = relative(scanRoot, file);
  if (!relativePath) return true;
  const segments = relativePath.replaceAll("\\", "/").split("/");
  if (segments.some((segment) => excludedDirectories.has(segment))) return false;
  return !excludedFileNames.has(segments.at(-1));
}

function repositoryFiles(path) {
  const result = spawnSync(
    "git",
    ["-C", path, "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.status !== 0 || typeof result.stdout !== "string") return null;
  return result.stdout.split("\0").filter(Boolean).map((entry) => join(path, entry));
}

const files = (repositoryFiles(scanRoot) ?? await listFiles(scanRoot)).filter(includedPath);
const findings = [];
let scannedFiles = 0;

for (const file of files) {
  const buffer = await readFile(file).catch((error) => {
    if (error.code === "ENOENT" || error.code === "EISDIR") return null;
    throw error;
  });
  if (buffer === null) continue;
  if (buffer.includes(0)) continue;
  const contents = buffer.toString("utf8");
  if (contents.includes("\uFFFD")) continue;
  scannedFiles += 1;
  const displayPath = relative(scanRoot, file).replaceAll("\\", "/") || basename(file);

  for (const pattern of secretPatterns) {
    for (const match of contents.matchAll(pattern)) findings.push(`${displayPath}: secret-like value ${match[0].slice(0, 8)}...`);
  }
  for (const match of contents.matchAll(urlPattern)) {
    const value = match[0].replace(/[),.;]+$/, "");
    if (isAllowedUrl(value)) continue;
    findings.push(`${displayPath}: unsafe URL ${value}`);
  }
  findings.push(...assignmentFindings(contents, displayPath));
}

if (findings.length) {
  console.error(`Unsafe repository values found:\n${findings.map((finding) => `- ${finding}`).join("\n")}`);
  process.exitCode = 1;
} else {
  console.log(`Repository unsafe-value scan: PASS (${scannedFiles} text files)`);
}
