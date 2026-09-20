const DEFAULT_KEYTERMS = ["sahkan", "batal"];

function providerFailure(response, payload) {
  const detail = payload?.detail;
  const providerCode = typeof detail?.code === "string"
    ? detail.code
    : null;
  const providerType = typeof detail?.type === "string"
    ? detail.type
    : null;
  const error = new Error(
    `ElevenLabs Scribe failed with HTTP ${response.status}`
      + (providerCode ? ` (${providerCode})` : ""),
  );
  error.name = "ElevenLabsScribeError";
  error.status = response.status;
  error.providerCode = providerCode;
  error.providerType = providerType;
  return error;
}

export function createElevenLabsScribeTranscriber({
  apiKey,
  fetchImpl = fetch,
  endpoint = "https://api.elevenlabs.io/v1/speech-to-text",
  timeoutMs = 20_000,
  keyterms = [],
}) {
  if (!apiKey) throw new Error("apiKey is required");
  if (typeof fetchImpl !== "function") throw new Error("fetchImpl is required");
  if (!Array.isArray(keyterms)) throw new Error("keyterms must be an array");
  const effectiveKeyterms = new Map();
  for (const keyterm of [...DEFAULT_KEYTERMS, ...keyterms]) {
    if (typeof keyterm !== "string" || !keyterm.trim()) continue;
    const trimmed = keyterm.trim();
    effectiveKeyterms.set(trimmed.toLowerCase(), trimmed);
  }
  let health = { status: "ok" };

  return {
    async healthCheck() {
      return structuredClone(health);
    },

    async transcribe({ bytes, contentType }) {
      try {
        const form = new FormData();
        form.set("model_id", "scribe_v2");
        for (const keyterm of effectiveKeyterms.values()) {
          form.append("keyterms", keyterm);
        }
        form.set(
          "file",
          new Blob([Buffer.from(bytes)], { type: contentType }),
          contentType === "audio/ogg" ? "voice.ogg" : "voice.bin",
        );

        const response = await fetchImpl(endpoint, {
          method: "POST",
          headers: { "xi-api-key": apiKey },
          body: form,
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) {
          let payload = null;
          try {
            payload = await response.json();
          } catch {
            // The HTTP status remains enough to diagnose an invalid response.
          }
          throw providerFailure(response, payload);
        }

        const payload = await response.json();
        if (typeof payload.text !== "string" || !payload.text.trim()) {
          throw new Error("ElevenLabs Scribe returned no transcript text");
        }

        health = { status: "ok" };
        return {
          text: payload.text,
          languageCode: payload.language_code ?? null,
          languageProbability: payload.language_probability === undefined
            ? null
            : String(payload.language_probability),
        };
      } catch (error) {
        health = {
          status: "unavailable",
          reason:
            error?.providerCode
            ?? (error?.name === "TimeoutError" ? "timeout" : "request_failed"),
        };
        throw error;
      }
    },
  };
}
