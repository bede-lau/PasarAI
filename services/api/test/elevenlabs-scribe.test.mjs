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
});
