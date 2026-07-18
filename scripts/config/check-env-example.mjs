import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const fileArgument = process.argv.includes("--file")
  ? process.argv[process.argv.indexOf("--file") + 1]
  : resolve(root, ".env.example");

if (!fileArgument) throw new Error("--file requires a path");

const allowedValues = new Set(["", "PLACEHOLDER", "<PLACEHOLDER>", "[PLACEHOLDER]"]);
const unsafeCommentPatterns = [
  /https?:\/\//i,
  /\b(?:sk|dapi|xoxb|ghp|pat)[-_][A-Za-z0-9_-]{6,}\b/i,
  /\b(?:token|secret|key|password|host|url|endpoint|model|workspace|catalog|schema)\s*[:=]\s*\S+/i,
  /\b(?:fake|dummy|sample|example)[-_ ]?(?:token|secret|key|url|id|endpoint)\b/i,
];

export function inspectEnvironmentExample(contents) {
  const errors = [];
  const names = new Set();

  for (const [index, originalLine] of contents.split(/\r?\n/).entries()) {
    const lineNumber = index + 1;
    const line = originalLine.trim();
    if (!line) continue;

    if (line.startsWith("#")) {
      for (const pattern of unsafeCommentPatterns) {
        if (pattern.test(line)) errors.push(`line ${lineNumber}: unsafe fake-real comment`);
      }
      continue;
    }

    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match) {
      errors.push(`line ${lineNumber}: expected NAME=value`);
      continue;
    }

    const [, name, value] = match;
    if (names.has(name)) errors.push(`line ${lineNumber}: duplicate ${name}`);
    names.add(name);

    if (!allowedValues.has(value)) {
      errors.push(`line ${lineNumber}: ${name} must be empty or an explicit PLACEHOLDER token`);
    }
  }

  return errors;
}

const contents = await readFile(resolve(fileArgument), "utf8");
const errors = inspectEnvironmentExample(contents);
if (errors.length) {
  console.error(`Unsafe environment example:\n${errors.map((error) => `- ${error}`).join("\n")}`);
  process.exitCode = 1;
} else {
  console.log("Environment example policy: PASS");
}
