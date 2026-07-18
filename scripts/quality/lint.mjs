import { readFile, readdir } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const defaultScanRoots = [
  "apps/web",
  "scripts",
  "tests",
  "packages/contracts",
  "packages/elevenlabs-agent",
  "packages/finance",
  "services/api",
  "databricks",
  "docs",
  ".github",
];
const configuredScanRoots = process.argv.includes("--scan-root")
  ? process.argv
      .flatMap((argument, index) => argument === "--scan-root" ? [process.argv[index + 1]] : [])
      .filter(Boolean)
  : defaultScanRoots;
const sourceExtensions = new Set([".js", ".mjs", ".ts", ".py", ".sql", ".json", ".md", ".yml", ".yaml"]);
const excludedDirectoryNames = new Set([
  ".next",
  "__pycache__",
  "coverage",
  "dist",
  "node_modules",
]);
const errors = [];

async function filesUnder(path) {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    const files = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const entryPath = join(path, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (excludedDirectoryNames.has(entry.name)) continue;
        files.push(...await filesUnder(entryPath));
      }
      else if (sourceExtensions.has(extname(entry.name))) files.push(entryPath);
    }
    return files;
  } catch (error) {
    if (error.code === "ENOTDIR") return [path];
    if (error.code === "ENOENT") {
      throw new Error(`Configured lint scan root is missing: ${relative(root, path).replaceAll("\\", "/")}`);
    }
    throw error;
  }
}

const files = [
  resolve(root, "package.json"),
  ...await Promise.all(configuredScanRoots.map((path) => filesUnder(resolve(root, path)))).then((groups) => groups.flat()),
];

for (const file of files) {
  const displayPath = relative(root, file).replaceAll("\\", "/");
  const contents = await readFile(file, "utf8").catch((error) => {
    if (error.code === "ENOENT" || error.code === "EISDIR") return null;
    throw error;
  });
  if (contents === null) continue;

  if (contents.length && !contents.endsWith("\n")) errors.push(`${displayPath}: missing final newline`);
  contents.split(/\r?\n/).forEach((line, index) => {
    if (/[ \t]+$/.test(line)) errors.push(`${displayPath}:${index + 1}: trailing whitespace`);
  });

  if (extname(file) === ".json") {
    try {
      JSON.parse(contents);
    } catch (error) {
      errors.push(`${displayPath}: invalid JSON (${error.message})`);
    }
  }

  if ([".js", ".mjs"].includes(extname(file))) {
    const result = spawnSync(process.execPath, ["--check", file], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (result.status !== 0) errors.push(`${displayPath}: ${result.stderr.trim()}`);
  }

  if (extname(file) === ".py") {
    const result = spawnSync(
      "python",
      [
        "-c",
        "import pathlib, sys; compile(pathlib.Path(sys.argv[1]).read_text(encoding='utf-8'), sys.argv[1], 'exec')",
        file,
      ],
      {
        encoding: "utf8",
        windowsHide: true,
      },
    );
    if (result.status !== 0) {
      errors.push(`${displayPath}: ${result.stderr.trim() || "Python syntax check failed"}`);
    }
  }
}

if (errors.length) {
  console.error(`Lint/static checks failed:\n${errors.map((error) => `- ${error}`).join("\n")}`);
  process.exitCode = 1;
} else {
  console.log(`Lint/static checks: PASS (${files.length} files)`);
}
