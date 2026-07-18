const TELEGRAM_DOWNLOAD_LIMIT_BYTES = 20 * 1024 * 1024;

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
}) {
  if (!botToken) throw new Error("botToken is required");
  if (typeof fetchImpl !== "function") throw new Error("fetchImpl is required");

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
        contentType: fileResponse.headers.get("content-type")
          ?.split(";", 1)[0]
          .trim()
          ?? "application/octet-stream",
      };
    },
  };
}
