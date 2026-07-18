import { readFile, readdir } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
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
  /^https?:\/\/(?:[A-Za-z0-9-]+\.)*example(?:\/|$)/,
  /^https?:\/\/(?:[A-Za-z0-9-]+\.)*test(?:\/|$)/,
];
const allowedSchemes = ["synthetic://"];
const sensitiveSuffix = /(?:HOST|URL|ENDPOINT|MODEL(?:_ID)?|WORKSPACE(?:_ID)?|CATALOG|SCHEMA|TOKEN|KEY|SECRET|PASSWORD|DATABASE_URL)$/;
const providerPrefix = /^(?:databricks|elevenlabs|telegram|railway|lakebase|provider|receipt|database)[_.-]/i;
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

function allowedValue(value) {
  const normalized = value.trim().replace(/^["']|["']$/g, "");
  return placeholderValues.has(normalized)
    || /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(normalized)
    || reviewedActionShas.has(normalized)
    || isAllowedUrl(normalized);
}

function sensitiveName(name) {
  const normalized = name.replaceAll("-", "_");
  const uppercase = normalized.toUpperCase();
  return (name === uppercase && sensitiveSuffix.test(uppercase))
    || (providerPrefix.test(name) && sensitiveSuffix.test(uppercase));
}

function assignmentFindings(contents, displayPath) {
  const findings = [];

  for (const pattern of assignmentPatterns) {
    for (const match of contents.matchAll(pattern)) {
      const [, name, value] = match;
      if (sensitiveName(name) && !allowedValue(value)) {
        findings.push(`${displayPath}: unsafe configured value for ${name}`);
      }
    }
  }
  return findings;
}

const files = await listFiles(scanRoot);
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
