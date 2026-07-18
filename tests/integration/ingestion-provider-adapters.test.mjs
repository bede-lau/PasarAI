import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createElevenLabsScribeTranscriber,
  createTelegramBotClient,
} from "../../services/api/src/index.js";

test("Telegram client resolves file metadata and downloads the media bytes", async () => {
  const calls = [];
  const media = Buffer.from("OggS downloaded voice");
  const client = createTelegramBotClient({
    botToken: "123456:test-token",
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: String(url), options });
      if (calls.length === 1) {
        return new Response(JSON.stringify({
          ok: true,
          result: { file_path: "voice/file_1.oga", file_size: media.length },
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(media, {
        status: 200,
        headers: { "content-type": "audio/ogg" },
      });
    },
  });

  const downloaded = await client.downloadFile("voice-file-id");

  assert.deepEqual(downloaded, {
    bytes: media,
    contentType: "audio/ogg",
  });
  assert.equal(
    calls[0].url,
    "https://api.telegram.org/bot123456:test-token/getFile",
  );
  assert.equal(calls[0].options.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    file_id: "voice-file-id",
  });
  assert.equal(
    calls[1].url,
    "https://api.telegram.org/file/bot123456:test-token/voice/file_1.oga",
  );
});

test("Telegram client sends a reply to the source message", async () => {
  const calls = [];
  const client = createTelegramBotClient({
    botToken: "123456:test-token",
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return new Response(JSON.stringify({
        ok: true,
        result: { message_id: 99 },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  const sent = await client.sendMessage({
    chatId: 9001,
    text: "Done, I've saved those sales.",
    replyToMessageId: 1503,
  });

  assert.deepEqual(sent, { message_id: 99 });
  assert.equal(
    calls[0].url,
    "https://api.telegram.org/bot123456:test-token/sendMessage",
  );
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    chat_id: 9001,
    text: "Done, I've saved those sales.",
    reply_parameters: { message_id: 1503 },
  });
});

test("Scribe adapter posts multipart audio with scribe_v2 and returns transcript metadata", async () => {
  const calls = [];
  const transcriber = createElevenLabsScribeTranscriber({
    apiKey: "test-elevenlabs-key",
    keyterms: ["expenses", "PasarAI"],
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return new Response(JSON.stringify({
        text: "Hari ni habis forty bungkus.",
        language_code: "ms",
        language_probability: 0.97,
        words: [],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  const transcript = await transcriber.transcribe({
    bytes: Buffer.from("OggS voice"),
    contentType: "audio/ogg",
    evidenceUri: "memory://telegram/1/voice.ogg",
  });

  assert.deepEqual(transcript, {
    text: "Hari ni habis forty bungkus.",
    languageCode: "ms",
    languageProbability: "0.97",
  });
  assert.equal(calls[0].url, "https://api.elevenlabs.io/v1/speech-to-text");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers["xi-api-key"], "test-elevenlabs-key");
  assert.equal(calls[0].options.body.get("model_id"), "scribe_v2");
  assert.deepEqual(
    calls[0].options.body.getAll("keyterms"),
    ["sahkan", "batal", "expenses", "PasarAI"],
  );
  assert.equal(calls[0].options.body.get("file").type, "audio/ogg");
});
