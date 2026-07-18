import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createFileEvidenceStore } from "../../services/api/src/index.js";

test("file evidence store writes immutable media inside its configured root", async () => {
  const rootDirectory = await mkdtemp(join(tmpdir(), "pasarai-evidence-"));
  const store = createFileEvidenceStore({ rootDirectory });
  const bytes = Buffer.from("synthetic receipt");

  try {
    const stored = await store.put({
      key: "telegram/42/receipt.jpg",
      bytes,
      contentType: "image/jpeg",
    });

    assert.match(stored.uri, /^file:/);
    assert.deepEqual(
      await readFile(join(rootDirectory, "telegram", "42", "receipt.jpg")),
      bytes,
    );
    assert.deepEqual(await store.healthCheck(), { status: "ok" });
    assert.deepEqual(
      await store.put({
        key: "telegram/42/receipt.jpg",
        bytes,
        contentType: "image/jpeg",
      }),
      stored,
    );
    await assert.rejects(
      store.put({
        key: "telegram/42/receipt.jpg",
        bytes: Buffer.from("replacement"),
        contentType: "image/jpeg",
      }),
      {
        code: "EVIDENCE_CONTENT_CONFLICT",
        message:
          "Evidence key already exists with different content: "
          + "telegram/42/receipt.jpg",
      },
    );
    await assert.rejects(
      store.put({
        key: "../outside.txt",
        bytes,
        contentType: "text/plain",
      }),
      /inside the evidence root/,
    );
  } finally {
    await rm(rootDirectory, { recursive: true, force: true });
  }
});

test("portable evidence URIs resolve back to authenticated binary storage", async () => {
  const rootDirectory = await mkdtemp(join(tmpdir(), "pasarai-evidence-"));
  const store = createFileEvidenceStore({
    rootDirectory,
    portableUris: true,
  });
  const bytes = Buffer.from("synthetic receipt");

  try {
    const stored = await store.put({
      key: "web/m_kak_lina_001/receipt.jpg",
      bytes,
      contentType: "image/jpeg",
    });
    assert.match(stored.uri, /^pasarai-evidence:/);
    assert.deepEqual(await store.get({
      uri: stored.uri,
      merchantId: "m_kak_lina_001",
    }), {
      bytes,
      contentType: "image/jpeg",
    });
    await assert.rejects(
      store.get({
        uri: stored.uri,
        merchantId: "m_other",
      }),
      /authenticated merchant/,
    );
    await assert.rejects(
      store.get({
        uri: "file:///outside",
        merchantId: "m_kak_lina_001",
      }),
      /Unsupported evidence URI/,
    );
  } finally {
    await rm(rootDirectory, { recursive: true, force: true });
  }
});

test("concurrent identical evidence writes converge on one immutable file", async () => {
  const rootDirectory = await mkdtemp(join(tmpdir(), "pasarai-evidence-"));
  const store = createFileEvidenceStore({ rootDirectory });
  const key = "telegram/42/concurrent-update.json";
  const bytes = Buffer.from('{"update_id":42}');

  try {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => store.put({
        key,
        bytes,
        contentType: "application/json",
      })),
    );

    assert.equal(new Set(results.map(({ uri }) => uri)).size, 1);
    assert.deepEqual(
      await readFile(
        join(rootDirectory, "telegram", "42", "concurrent-update.json"),
      ),
      bytes,
    );
  } finally {
    await rm(rootDirectory, { recursive: true, force: true });
  }
});
