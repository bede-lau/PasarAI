const TELEGRAM_DOWNLOAD_LIMIT_BYTES = 20 * 1024 * 1024;
const DEFAULT_TELEGRAM_TIMEOUT_MS = 10_000;

function downloadedContentType({ bytes, filePath, headerValue }) {
  const headerType = headerValue
    ?.split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (headerType && headerType !== "application/octet-stream") {
    return headerType;
  }

  const buffer = Buffer.from(bytes);
  if (
    buffer.length >= 4
    && buffer[0] === 0xff
    && buffer[1] === 0xd8
    && buffer.at(-2) === 0xff
    && buffer.at(-1) === 0xd9
  ) {
    return "image/jpeg";
  }
  if (
    buffer.length >= 8
    && buffer.subarray(0, 8).equals(
      Buffer.from("89504e470d0a1a0a", "hex"),
    )
  ) {
    return "image/png";
  }

  const normalizedPath = filePath.toLowerCase();
  if (normalizedPath.endsWith(".jpg") || normalizedPath.endsWith(".jpeg")) {
    return "image/jpeg";
  }
  if (normalizedPath.endsWith(".png")) return "image/png";

  return headerType ?? "application/octet-stream";
}

async function responseJson(response, operation) {
  if (!response.ok) {
    throw new Error(`${operation} failed with HTTP ${response.status}`);
  }
  const payload = await response.json();
  if (!payload.ok) {
    throw new Error(`${operation} was rejected by Telegram`);
  }
  return payload.result;
}

export function createTelegramBotClient({
  botToken,
  fetchImpl = fetch,
  apiBaseUrl = "https://api.telegram.org",
  timeoutMs = DEFAULT_TELEGRAM_TIMEOUT_MS,
}) {
  if (!botToken) throw new Error("botToken is required");
  if (typeof fetchImpl !== "function") throw new Error("fetchImpl is required");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("timeoutMs must be a positive integer");
  }

  return {
    async sendMessage({ chatId, text, replyToMessageId }) {
      if (chatId === undefined || chatId === null) {
        throw new Error("chatId is required");
      }
      if (!text?.trim()) throw new Error("text is required");

      const response = await fetchImpl(
        `${apiBaseUrl}/bot${botToken}/sendMessage`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text,
            ...(replyToMessageId === undefined
              ? {}
              : {
                  reply_parameters: {
                    message_id: replyToMessageId,
                  },
              }),
          }),
          signal: AbortSignal.timeout(timeoutMs),
        },
      );
      return responseJson(response, "Telegram sendMessage");
    },

    async downloadFile(fileId) {
      if (!fileId) throw new Error("fileId is required");

      const metadataResponse = await fetchImpl(
        `${apiBaseUrl}/bot${botToken}/getFile`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ file_id: fileId }),
          signal: AbortSignal.timeout(timeoutMs),
        },
      );
      const metadata = await responseJson(metadataResponse, "Telegram getFile");
      if (!metadata.file_path) {
        throw new Error("Telegram getFile returned no file_path");
      }
      if (
        Number.isFinite(metadata.file_size)
        && metadata.file_size > TELEGRAM_DOWNLOAD_LIMIT_BYTES
      ) {
        throw new Error("Telegram file exceeds the 20 MB download limit");
      }

      const fileResponse = await fetchImpl(
        `${apiBaseUrl}/file/bot${botToken}/${metadata.file_path}`,
        { signal: AbortSignal.timeout(timeoutMs) },
      );
      if (!fileResponse.ok) {
        throw new Error(`Telegram file download failed with HTTP ${fileResponse.status}`);
      }
      const bytes = Buffer.from(await fileResponse.arrayBuffer());
      if (bytes.length > TELEGRAM_DOWNLOAD_LIMIT_BYTES) {
        throw new Error("Telegram file exceeds the 20 MB download limit");
      }

      return {
        bytes,
        contentType: downloadedContentType({
          bytes,
          filePath: metadata.file_path,
          headerValue: fileResponse.headers.get("content-type"),
        }),
      };
    },
  };
}
