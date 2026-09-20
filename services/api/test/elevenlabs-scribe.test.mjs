import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createElevenLabsScribeTranscriber,
} from "../src/providers/elevenlabs-scribe.js";

test("Scribe always receives Malay confirmation command hints", async () => {
  const transcriber = createElevenLabsScribeTranscriber({
    apiKey: "test-key",
    keyterms: ["nasi lemak", "sahkan"],
    fetchImpl: async (_url, options) => {
      assert.deepEqual(options.body.getAll("keyterms"), [
        "sahkan",
        "batal",
        "nasi lemak",
      ]);
      return new Response(JSON.stringify({
        text: "Sahkan",
        language_code: "msa",
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  assert.deepEqual(
    await transcriber.transcribe({
      bytes: Buffer.from("voice"),
      contentType: "audio/ogg",
    }),
    {
      text: "Sahkan",
      languageCode: "msa",
      languageProbability: null,
    },
  );
  assert.deepEqual(await transcriber.healthCheck(), { status: "ok" });
});

test("Scribe retains safe provider failure details and degrades health", async () => {
  const transcriber = createElevenLabsScribeTranscriber({
    apiKey: "test-key",
    fetchImpl: async () =>
      new Response(JSON.stringify({
        detail: {
          type: "payment_required",
          code: "payment_issue",
          message: "Sensitive provider message",
        },
      }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
  });

  await assert.rejects(
    transcriber.transcribe({
      bytes: Buffer.from("voice"),
      contentType: "audio/ogg",
    }),
    (error) => {
      assert.equal(error.name, "ElevenLabsScribeError");
      assert.equal(error.status, 401);
      assert.equal(error.providerCode, "payment_issue");
      assert.equal(error.providerType, "payment_required");
      assert.doesNotMatch(error.message, /Sensitive provider message/);
      return true;
    },
  );
  assert.deepEqual(await transcriber.healthCheck(), {
    status: "unavailable",
    reason: "payment_issue",
  });
});
