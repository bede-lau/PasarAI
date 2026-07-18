import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const syntheticRoot = join(root, "fixtures", "synthetic");
const outputRoot = join(syntheticRoot, "seed-output");
const preservedSibling = join(syntheticRoot, "do-not-delete.txt");

async function snapshot(directory) {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
  return Object.fromEntries(
    await Promise.all(files.map(async (file) => [
      file.slice(directory.length + 1).replaceAll("\\", "/"),
      await readFile(file, "utf8"),
    ])),
  );
}

function resetSeed() {
  execFileSync(process.execPath, ["scripts/seed/reset-synthetic.mjs"], {
    cwd: root,
    stdio: "pipe",
  });
}

test("synthetic reset validates, replaces only its local target, and is repeatable", async () => {
  try {
    const rootPackage = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    assert.equal(rootPackage.scripts["seed:synthetic:reset"], "node scripts/seed/reset-synthetic.mjs");

    await mkdir(syntheticRoot, { recursive: true });
    await writeFile(preservedSibling, "preserve me\n", { flag: "w" });

    resetSeed();
    const first = await snapshot(outputRoot);
    const provenance = JSON.parse(first["provenance.json"]);

    assert.equal(provenance.synthetic, true);
    assert.equal(provenance.local_only, true);
    assert.equal(provenance.network_access, false);
    assert.match(provenance.disclaimer, /synthetic.*local-only/i);
    assert.equal(provenance.files.length, 8);
    assert.equal(provenance.source_directory, "fixtures/synthetic/seed_data");
    assert.equal(provenance.authoritative_source_directory, "PasarAI_Handoff_Package/demo_data/seed_data");
    assert.ok(provenance.files.every((file) =>
      file.source_sha256 === file.authoritative_source_sha256
      && file.source_size_bytes === file.authoritative_source_size_bytes
    ));
    assert.equal(provenance.authoritative_source_manifest, "fixtures/synthetic/authoritative-source-manifest.json");
    assert.match(provenance.validation.command, /validate-snapshot\.mjs/);
    assert.match(provenance.receipt_image_handling, /not copied/i);
    assert.equal(await readFile(preservedSibling, "utf8"), "preserve me\n");

    for (let run = 0; run < 10; run += 1) {
      resetSeed();
      assert.deepEqual(
        await snapshot(outputRoot),
        first,
        `rapid reset ${run + 1} must remain deterministic`,
      );
      assert.equal(await readFile(preservedSibling, "utf8"), "preserve me\n");
    }
  } finally {
    await rm(preservedSibling, { force: true });
  }
});
