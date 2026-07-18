import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

import { createProductionRuntime } from "./runtime.js";

export const NORMAL_JSON_BODY_LIMIT = 1024 * 1024;
export const RECEIPT_UPLOAD_BODY_LIMIT = 30 * 1024 * 1024;

export class PayloadTooLargeError extends Error {}

export async function requestBody(request, limit) {
  const contentLength = Number(request.headers["content-length"]);
  if (Number.isFinite(contentLength) && contentLength > limit) {
    throw new PayloadTooLargeError();
  }

  const chunks = [];
  let total = 0;
  for await (
    const chunk of request.iterator({ destroyOnReturn: false })
  ) {
    const bytes = Buffer.from(chunk);
    total += bytes.length;
    if (total > limit) {
      request.resume();
      throw new PayloadTooLargeError();
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

function requestUrl(request) {
  const protocol = request.socket.encrypted ? "https" : "http";
  const host = request.headers.host ?? "localhost";
  return `${protocol}://${host}${request.url}`;
}

function bodyLimit(request) {
  return request.url?.startsWith("/api/v1/receipts/extract")
    ? RECEIPT_UPLOAD_BODY_LIMIT
    : NORMAL_JSON_BODY_LIMIT;
}

export function createPublicServer(runtime) {
  return createServer(async (incoming, outgoing) => {
    try {
      const body = ["GET", "HEAD"].includes(incoming.method ?? "GET")
        ? undefined
        : await requestBody(incoming, bodyLimit(incoming));
      const response = await runtime.app.fetch(new Request(
        requestUrl(incoming),
        {
          method: incoming.method,
          headers: incoming.headers,
          ...(body?.length ? { body } : {}),
        },
      ));
      outgoing.statusCode = response.status;
      for (const [name, value] of response.headers) {
        outgoing.setHeader(name, value);
      }
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      outgoing.statusCode = error instanceof PayloadTooLargeError ? 413 : 500;
      outgoing.setHeader("content-type", "application/json");
      outgoing.end(JSON.stringify({
        error: error instanceof PayloadTooLargeError
          ? "payload_too_large"
          : "internal_error",
      }));
    }
  });
}

export async function startPublicServer({
  environment = process.env,
  createRuntime = createProductionRuntime,
} = {}) {
  const runtime = await createRuntime({ environment });
  const server = createPublicServer(runtime);
  const port = Number(environment.PORT ?? 3001);
  server.listen(port, "0.0.0.0", () => {
    console.log(`PasarAI API listening on port ${port}`);
  });

  async function shutdown() {
    server.close(async () => {
      await runtime.close();
      process.exit(0);
    });
  }

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  return { runtime, server };
}

if (
  process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await startPublicServer();
}
