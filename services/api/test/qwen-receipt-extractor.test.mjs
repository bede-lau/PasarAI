import assert from "node:assert/strict";
import test from "node:test";

import {
  createReceiptExtractor,
} from "../src/providers/qwen-receipt-extractor.js";

const environment = {
  DASHSCOPE_API_KEY: "test-dashscope-key",
  DASHSCOPE_BASE_URL: "https://dashscope.example/compatible-mode/v1",
  DASHSCOPE_RECEIPT_MODEL: "qwen3.7-plus-2026-05-26",
  DASHSCOPE_VISION_FALLBACK_MODEL: "qwen3.5-plus-2026-04-20",
};

function qwenResponse(content) {
  return new Response(JSON.stringify({
    choices: [{ message: { content } }],
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("Qwen receipt extractor sends an inline image and normalizes contract fields", async () => {
  const requests = [];
  const extractor = createReceiptExtractor({
    environment,
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return qwenResponse(`\`\`\`json
        {
          "receipt_id": "INV-100",
          "supplier_name": "Sinar Borong",
          "date": "12/07/2026",
          "line_items": [{
            "raw_name": "Beras 10kg",
            "normalized_component_id": "unknown",
            "quantity": 2,
            "uom": "bag",
            "pack_size": 10,
            "unit_price_rm": "RM 30",
            "total_price_rm": 60,
            "confidence": "98%"
          }],
          "total_rm": "RM 60",
          "overall_confidence": 0.96,
          "ambiguities": []
        }
      \`\`\``);
    },
  });

  const result = await extractor.extract({
    bytes: Buffer.from("receipt"),
    contentType: "image/jpeg",
  });

  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].url,
    "https://dashscope.example/compatible-mode/v1/chat/completions",
  );
  assert.equal(
    requests[0].init.headers.authorization,
    "Bearer test-dashscope-key",
  );
  const body = JSON.parse(requests[0].init.body);
  assert.equal(body.model, "qwen3.7-plus-2026-05-26");
  assert.match(
    body.messages[0].content[0].image_url.url,
    /^data:image\/jpeg;base64,/,
  );
  assert.deepEqual(result, {
    receipt_id: "INV-100",
    supplier_name: "Sinar Borong",
    date: "2026-07-12",
    currency: "MYR",
    line_items: [{
      raw_name: "Beras 10kg",
      normalized_component_id: "c_rice",
      quantity: "2",
      uom: "bag",
      pack_size: "10",
      unit_price_rm: "30.00",
      total_price_rm: "60.00",
      confidence: "0.98",
    }],
    total_rm: "60.00",
    overall_confidence: "0.96",
    ambiguities: [],
  });
});

test("Qwen receipt extractor falls back when the primary model is unavailable", async () => {
  const models = [];
  const extractor = createReceiptExtractor({
    environment,
    fetchImpl: async (_url, init) => {
      const model = JSON.parse(init.body).model;
      models.push(model);
      if (model === "qwen3.7-plus-2026-05-26") {
        return new Response(JSON.stringify({
          error: { code: "model_not_found" },
        }), { status: 404 });
      }
      return qwenResponse(JSON.stringify({
        receipt_id: null,
        supplier_name: "Fallback Supplier",
        date: null,
        currency: "MYR",
        line_items: [],
        total_rm: null,
        overall_confidence: "0.75",
        ambiguities: [{
          field: "date",
          question: "Please confirm the receipt date.",
          options: [],
        }],
      }));
    },
  });

  const result = await extractor.extract({
    bytes: Buffer.from("receipt"),
    contentType: "image/png",
  });

  assert.deepEqual(models, [
    "qwen3.7-plus-2026-05-26",
    "qwen3.5-plus-2026-04-20",
  ]);
  assert.equal(result.supplier_name, "Fallback Supplier");
});

test("Qwen receipt extractor rejects missing credentials", () => {
  assert.throws(
    () => createReceiptExtractor({ environment: {} }),
    /DASHSCOPE_API_KEY is required/,
  );
});
