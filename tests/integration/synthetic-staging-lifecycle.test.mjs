import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  discoverPidStagingCandidates,
  resetSyntheticSeed,
} from "../../scripts/seed/reset-synthetic.mjs";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));

async function prepareBoundary() {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "pasarai-staging-"));
  await cp(
    join(root, "fixtures", "synthetic", "seed_data"),
    join(workspaceRoot, "fixtures", "synthetic", "seed_data"),
    { recursive: true },
  );
  await cp(
    join(root, "fixtures", "synthetic", "authoritative-source-manifest.json"),
    join(workspaceRoot, "fixtures", "synthetic", "authoritative-source-manifest.json"),
  );
  return workspaceRoot;
}

async function exists(path) {
  return access(path).then(() => true, () => false);
}

async function snapshot(directory) {
  const names = (await readdir(directory)).sort();
  return Object.fromEntries(await Promise.all(
    names.map(async (name) => [name, await readFile(join(directory, name), "utf8")]),
  ));
}

function probeError(code) {
  return Object.assign(new Error(code), { code });
}

test("PID candidate discovery includes only direct numeric staging directories", async () => {
  const workspaceRoot = await prepareBoundary();
  const syntheticRoot = join(workspaceRoot, "fixtures", "synthetic");
  try {
    await mkdir(join(syntheticRoot, ".seed-output.tmp-101"));
    await mkdir(join(syntheticRoot, ".seed-output.tmp"));
    await mkdir(join(syntheticRoot, ".seed-output.tmp-abc"));
    await mkdir(join(syntheticRoot, ".seed-output.tmp-202-extra"));
    await writeFile(join(syntheticRoot, ".seed-output.tmp-303"), "not a directory\n");
    await mkdir(join(syntheticRoot, "nested", ".seed-output.tmp-404"), { recursive: true });

    assert.deepEqual(
      await discoverPidStagingCandidates(syntheticRoot),
      [{ name: ".seed-output.tmp-101", path: join(syntheticRoot, ".seed-output.tmp-101"), pid: 101 }],
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("injected PID probe preserves live and EPERM candidates and removes ESRCH candidates", async () => {
  const workspaceRoot = await prepareBoundary();
  const syntheticRoot = join(workspaceRoot, "fixtures", "synthetic");
  try {
    for (const pid of [111, 222, 333]) await mkdir(join(syntheticRoot, `.seed-output.tmp-${pid}`));
    await resetSyntheticSeed({
      workspaceRoot,
      processId: 900001,
      pidProbe(pid) {
        if (pid === 111) return;
        if (pid === 222) throw probeError("EPERM");
        throw probeError("ESRCH");
      },
    });

    assert.equal(await exists(join(syntheticRoot, ".seed-output.tmp-111")), true);
    assert.equal(await exists(join(syntheticRoot, ".seed-output.tmp-222")), true);
    assert.equal(await exists(join(syntheticRoot, ".seed-output.tmp-333")), false);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("unknown probe errors preserve candidate and prior output and publish nothing", async () => {
  const workspaceRoot = await prepareBoundary();
  const syntheticRoot = join(workspaceRoot, "fixtures", "synthetic");
  const candidate = join(syntheticRoot, ".seed-output.tmp-444");
  try {
    await resetSyntheticSeed({ workspaceRoot, processId: 900002, pidProbe: () => {} });
    const baseline = await snapshot(join(syntheticRoot, "seed-output"));
    await mkdir(candidate);
    await writeFile(join(candidate, "marker.txt"), "preserve candidate\n");

    await assert.rejects(
      resetSyntheticSeed({
        workspaceRoot,
        processId: 900003,
        pidProbe() {
          throw probeError("EIO");
        },
      }),
      (error) => error.message.includes(candidate) && error.message.includes("EIO"),
    );

    assert.equal(await readFile(join(candidate, "marker.txt"), "utf8"), "preserve candidate\n");
    assert.deepEqual(await snapshot(join(syntheticRoot, "seed-output")), baseline);
    assert.equal(await exists(join(syntheticRoot, ".seed-output.tmp-900003")), false);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("legacy cleanup remains exact while malformed and nested variants remain untouched", async () => {
  const workspaceRoot = await prepareBoundary();
  const syntheticRoot = join(workspaceRoot, "fixtures", "synthetic");
  const retained = [
    ".seed-output.tmp-abc",
    ".seed-output.tmp-505-extra",
    "nested/.seed-output.tmp-606",
  ];
  try {
    await mkdir(join(syntheticRoot, ".seed-output.tmp"));
    await mkdir(join(syntheticRoot, ".seed-output.tmp-707"));
    for (const path of retained) await mkdir(join(syntheticRoot, path), { recursive: true });

    await resetSyntheticSeed({
      workspaceRoot,
      processId: 900004,
      pidProbe() {
        throw probeError("ESRCH");
      },
    });

    assert.equal(await exists(join(syntheticRoot, ".seed-output.tmp")), false);
    assert.equal(await exists(join(syntheticRoot, ".seed-output.tmp-707")), false);
    for (const path of retained) assert.equal(await exists(join(syntheticRoot, path)), true, path);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("real old live staging is preserved until its helper PID exits", async () => {
  const workspaceRoot = await prepareBoundary();
  const syntheticRoot = join(workspaceRoot, "fixtures", "synthetic");
  const helper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
    windowsHide: true,
  });
  const candidate = join(syntheticRoot, `.seed-output.tmp-${helper.pid}`);
  try {
    await resetSyntheticSeed({ workspaceRoot, processId: 900005, pidProbe: () => {} });
    const baseline = await snapshot(join(syntheticRoot, "seed-output"));
    await mkdir(candidate);
    const old = new Date("2000-01-01T00:00:00Z");
    await utimes(candidate, old, old);

    await resetSyntheticSeed({ workspaceRoot, processId: 900006 });
    assert.equal(await exists(candidate), true);
    assert.deepEqual(await snapshot(join(syntheticRoot, "seed-output")), baseline);

    const exited = new Promise((resolveExit) => helper.once("exit", resolveExit));
    helper.kill();
    await exited;

    await resetSyntheticSeed({ workspaceRoot, processId: 900007 });
    assert.equal(await exists(candidate), false);
    assert.deepEqual(await snapshot(join(syntheticRoot, "seed-output")), baseline);
  } finally {
    if (helper.exitCode === null) helper.kill();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("concurrent callable resets preserve deterministic publication and path safety", async () => {
  const workspaceRoot = await prepareBoundary();
  const syntheticRoot = join(workspaceRoot, "fixtures", "synthetic");
  try {
    await resetSyntheticSeed({ workspaceRoot, processId: 910000, pidProbe: () => {} });
    const baseline = await snapshot(join(syntheticRoot, "seed-output"));

    await Promise.all([
      resetSyntheticSeed({ workspaceRoot, processId: 910001, pidProbe: () => {} }),
      resetSyntheticSeed({ workspaceRoot, processId: 910002, pidProbe: () => {} }),
    ]);

    assert.deepEqual(await snapshot(join(syntheticRoot, "seed-output")), baseline);
    assert.deepEqual(await discoverPidStagingCandidates(syntheticRoot), []);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
