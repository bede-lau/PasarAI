import assert from "node:assert/strict";
import { request } from "node:http";
import { test } from "node:test";

import {
  NORMAL_JSON_BODY_LIMIT,
  RECEIPT_UPLOAD_BODY_LIMIT,
  createPublicServer,
} from "../src/server.js";

async function withServer(run) {
  let fetchCalls = 0;
  const server = createPublicServer({
    app: {
      async fetch() {
        fetchCalls += 1;
        return Response.json({ state: "accepted" }, { status: 202 });
      },
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await run({
      port: server.address().port,
      fetchCalls: () => fetchCalls,
    });
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()));
  }
}

function send({ port, path, headers, chunks = [] }) {
  return new Promise((resolve, reject) => {
    const outgoing = request({
      host: "127.0.0.1",
      port,
      path,
      method: "POST",
      headers: {
        connection: "close",
        ...headers,
      },
    }, (incoming) => {
      const responseChunks = [];
      incoming.on("data", (chunk) => responseChunks.push(chunk));
      incoming.on("end", () => resolve({
        status: incoming.statusCode,
        body: JSON.parse(Buffer.concat(responseChunks).toString()),
      }));
    });
    outgoing.on("error", reject);
    for (const chunk of chunks) outgoing.write(chunk);
    outgoing.end();
  });
}

test("public server rejects oversized normal JSON from content-length", async () => {
  await withServer(async ({ port, fetchCalls }) => {
    const response = await send({
      port,
      path: "/api/v1/sales",
      headers: {
        "content-type": "application/json",
        "content-length": String(NORMAL_JSON_BODY_LIMIT + 1),
      },
    });

    assert.deepEqual(response, {
      status: 413,
      body: { error: "payload_too_large" },
    });
    assert.equal(fetchCalls(), 0);
  });
});

test("public server stops buffering chunked JSON at the normal limit", async () => {
  await withServer(async ({ port, fetchCalls }) => {
    const response = await send({
      port,
      path: "/webhooks/telegram",
      headers: { "content-type": "application/json" },
      chunks: [
        Buffer.alloc(NORMAL_JSON_BODY_LIMIT, 0x20),
        Buffer.from("x"),
      ],
    });

    assert.equal(response.status, 413);
    assert.equal(response.body.error, "payload_too_large");
    assert.equal(fetchCalls(), 0);
  });
});

test("receipt upload has a larger but bounded request limit", async () => {
  await withServer(async ({ port, fetchCalls }) => {
    const accepted = await send({
      port,
      path: "/api/v1/receipts/extract",
      headers: {
        "content-type": "application/json",
        "content-length": String(NORMAL_JSON_BODY_LIMIT + 1),
      },
      chunks: [Buffer.alloc(NORMAL_JSON_BODY_LIMIT + 1, 0x20)],
    });
    const rejected = await send({
      port,
      path: "/api/v1/receipts/extract",
      headers: {
        "content-type": "application/json",
        "content-length": String(RECEIPT_UPLOAD_BODY_LIMIT + 1),
      },
    });

    assert.equal(accepted.status, 202);
    assert.equal(rejected.status, 413);
    assert.equal(fetchCalls(), 1);
  });
});
