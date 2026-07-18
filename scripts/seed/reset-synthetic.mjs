import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { validateSyntheticSnapshot } from "./validate-snapshot.mjs";

const defaultWorkspaceRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const commandVersion = "1";
const transientFilesystemErrors = new Set(["EPERM", "EBUSY", "ENOTEMPTY", "EACCES"]);
const retryDelaysMs = [10, 20, 40, 80, 160, 320, 500];
const pidStagingPattern = /^\.seed-output\.tmp-(\d+)$/;

export function defaultPidProbe(pid) {
  process.kill(pid, 0);
}

export async function discoverPidStagingCandidates(syntheticRoot) {
  const entries = await readdir(syntheticRoot, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const match = pidStagingPattern.exec(entry.name);
      return match
        ? { name: entry.name, path: join(syntheticRoot, entry.name), pid: Number(match[1]) }
        : null;
    })
    .filter(Boolean)
    .sort((left, right) => left.name.localeCompare(right.name));
}

function assertSafeTarget(path, syntheticRoot, expectedName) {
  if (dirname(path) !== syntheticRoot || basename(path) !== expectedName) {
    throw new Error(`Refusing unsafe synthetic seed target: ${path}`);
  }
}

function assertSafeTemporaryTarget(path, syntheticRoot) {
  const name = basename(path);
  if (dirname(path) !== syntheticRoot || (name !== ".seed-output.tmp" && !pidStagingPattern.test(name))) {
    throw new Error(`Refusing unsafe synthetic seed temporary target: ${path}`);
  }
}

async function retryTransient(operation, description) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const retryDelay = retryDelaysMs[attempt];
      if (!transientFilesystemErrors.has(error?.code) || retryDelay === undefined) {
        throw new Error(`${description} failed${error?.code ? ` (${error.code})` : ""}`, { cause: error });
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, retryDelay));
    }
  }
}

async function removeSyntheticPath(path, description, syntheticRoot, targetRoot) {
  if (path === targetRoot) assertSafeTarget(path, syntheticRoot, "seed-output");
  else assertSafeTemporaryTarget(path, syntheticRoot);
  await retryTransient(
    () => rm(path, { recursive: true, force: true }),
    description,
  );
}

async function cleanDeadPidStagingCandidates({ syntheticRoot, targetRoot, pidProbe }) {
  for (const candidate of await discoverPidStagingCandidates(syntheticRoot)) {
    try {
      await pidProbe(candidate.pid);
    } catch (error) {
      if (error?.code === "EPERM") continue;
      if (error?.code === "ESRCH") {
        await removeSyntheticPath(
          candidate.path,
          `Removing dead synthetic seed staging candidate ${candidate.path}`,
          syntheticRoot,
          targetRoot,
        );
        continue;
      }
      const code = error?.code ?? "UNKNOWN";
      throw new Error(`Unable to probe synthetic seed staging candidate ${candidate.path} (${code})`, {
        cause: error,
      });
    }
  }
}

function workspacePath(workspaceRoot, path) {
  return relative(workspaceRoot, path).split(sep).join("/");
}

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function normalize(name, contents) {
  if (name.endsWith(".json")) {
    return Buffer.from(`${JSON.stringify(JSON.parse(contents.toString("utf8")), null, 2)}\n`);
  }
  return Buffer.from(`${contents.toString("utf8").replace(/\r\n?/g, "\n").trimEnd()}\n`);
}

export async function resetSyntheticSeed({
  workspaceRoot = defaultWorkspaceRoot,
  processId = process.pid,
  pidProbe = defaultPidProbe,
} = {}) {
  if (!Number.isSafeInteger(processId) || processId <= 0) {
    throw new Error(`Invalid synthetic seed process ID: ${processId}`);
  }

  const resolvedWorkspaceRoot = resolve(workspaceRoot);
  const syntheticRoot = resolve(resolvedWorkspaceRoot, "fixtures", "synthetic");
  const sourceRoot = resolve(syntheticRoot, "seed_data");
  const sourceManifestPath = resolve(syntheticRoot, "authoritative-source-manifest.json");
  const targetRoot = resolve(syntheticRoot, "seed-output");
  const legacyStagingRoot = resolve(syntheticRoot, ".seed-output.tmp");
  const stagingRoot = resolve(syntheticRoot, `.seed-output.tmp-${processId}`);

  assertSafeTarget(targetRoot, syntheticRoot, "seed-output");
  assertSafeTemporaryTarget(legacyStagingRoot, syntheticRoot);
  assertSafeTemporaryTarget(stagingRoot, syntheticRoot);

  const sourceManifest = await validateSyntheticSnapshot(sourceRoot, sourceManifestPath);
  await mkdir(syntheticRoot, { recursive: true });

  await removeSyntheticPath(
    legacyStagingRoot,
    "Removing legacy synthetic seed staging directory",
    syntheticRoot,
    targetRoot,
  );
  await cleanDeadPidStagingCandidates({ syntheticRoot, targetRoot, pidProbe });

  await mkdir(stagingRoot);

  try {
    const provenanceFiles = [];
    for (const expectedSource of sourceManifest.files) {
      const { name } = expectedSource;
      const sourcePath = resolve(sourceRoot, name);
      if (dirname(sourcePath) !== sourceRoot) throw new Error(`Unsafe source fixture path: ${sourcePath}`);
      const sourceContents = await readFile(sourcePath);
      const sourceSha256 = sha256(sourceContents);
      const outputContents = normalize(name, sourceContents);
      const outputPath = resolve(stagingRoot, name);
      await writeFile(outputPath, outputContents);

      provenanceFiles.push({
        name,
        source_path: workspacePath(resolvedWorkspaceRoot, sourcePath),
        authoritative_source_path: `${sourceManifest.authoritative_source_directory}/${name}`,
        output_path: `fixtures/synthetic/seed-output/${name}`,
        source_sha256: sourceSha256,
        source_size_bytes: sourceContents.byteLength,
        authoritative_source_sha256: expectedSource.sha256,
        authoritative_source_size_bytes: expectedSource.size_bytes,
        output_sha256: sha256(outputContents),
        output_size_bytes: outputContents.byteLength,
      });
    }

    const provenance = {
      version: commandVersion,
      synthetic: true,
      local_only: true,
      network_access: false,
      disclaimer: "SYNTHETIC TEST DATA - LOCAL-ONLY. Never use this output as production or live-provider data.",
      source_directory: workspacePath(resolvedWorkspaceRoot, sourceRoot),
      authoritative_source_directory: sourceManifest.authoritative_source_directory,
      authoritative_source_manifest: workspacePath(resolvedWorkspaceRoot, sourceManifestPath),
      validation: {
        command: "node scripts/seed/validate-snapshot.mjs",
        result: "PASS",
      },
      receipt_image_handling: "Receipt images are not copied; receipt_ground_truth.json identifies the handoff images for future local test adapters.",
      files: provenanceFiles,
    };

    await writeFile(
      join(stagingRoot, "provenance.json"),
      `${JSON.stringify(provenance, null, 2)}\n`,
    );

    await removeSyntheticPath(
      targetRoot,
      "Removing prior synthetic seed output",
      syntheticRoot,
      targetRoot,
    );
    await retryTransient(async () => {
      try {
        await rename(stagingRoot, targetRoot);
      } catch (error) {
        if (transientFilesystemErrors.has(error?.code)) {
          await removeSyntheticPath(
            targetRoot,
            "Clearing transient synthetic seed target",
            syntheticRoot,
            targetRoot,
          );
        }
        throw error;
      }
    }, "Publishing synthetic seed output");

    return { fixtureCount: sourceManifest.files.length, targetRoot };
  } finally {
    await removeSyntheticPath(
      stagingRoot,
      "Cleaning synthetic seed staging directory",
      syntheticRoot,
      targetRoot,
    );
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await resetSyntheticSeed();
  console.log(`Synthetic local seed reset: PASS (${result.fixtureCount} fixtures)`);
}
