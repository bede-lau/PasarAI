import { validateContract } from "@pasarai/contracts/v1";

const DEFAULT_BASE_URL =
  "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";
const DEFAULT_RECEIPT_MODEL = "qwen3.7-plus-2026-05-26";
const DEFAULT_TIMEOUT_MS = 60_000;

const COMPONENTS = [
  {
    id: "c_rice",
    name: "Beras",
    aliases: ["beras", "rice"],
  },
  {
    id: "c_coconut",
    name: "Santan",
    aliases: ["santan", "coconut milk"],
  },
  {
    id: "c_egg",
    name: "Telur",
    aliases: ["telur", "egg", "eggs"],
  },
  {
    id: "c_anchovy",
    name: "Ikan Bilis",
    aliases: ["ikan bilis", "anchovy", "anchovies"],
  },
  {
    id: "c_peanut",
    name: "Kacang Tanah",
    aliases: ["kacang tanah", "peanut", "peanuts"],
  },
  {
    id: "c_sambal",
    name: "Sambal + Minyak",
    aliases: ["sambal", "minyak", "oil"],
  },
  {
    id: "c_cucumber",
    name: "Timun",
    aliases: ["timun", "cucumber"],
  },
  {
    id: "c_packaging",
    name: "Bekas Makanan",
    aliases: ["bekas makanan", "bekas", "packaging", "container"],
  },
  {
    id: "c_fuel",
    name: "Gas + Condiments",
    aliases: ["gas", "condiments"],
  },
];

function required(value, name) {
  if (!value || value === "<PLACEHOLDER>") {
    throw new Error(`${name} is required`);
  }
  return value;
}

function prompt() {
  const componentList = COMPONENTS
    .map(({ id, name, aliases }) =>
      `- ${id}: ${name}; aliases: ${aliases.join(", ")}`
    )
    .join("\n");

  return `Extract this Malaysian supplier receipt into the exact JSON shape below.
Return only valid JSON. Do not use Markdown or add commentary.
Never invent unreadable or absent information; use null instead.
All monetary values must be strings with exactly two decimal places.
Quantity and pack_size must be non-negative decimal strings or null.
Confidence values must be strings from 0 to 1.
Use currency "MYR".
Dates must use YYYY-MM-DD.
For normalized_component_id, choose only one ID from this catalog when the
line clearly matches; otherwise use null:
${componentList}

Required JSON shape:
{
  "receipt_id": "string or null",
  "supplier_name": "string or null",
  "date": "YYYY-MM-DD or null",
  "currency": "MYR",
  "line_items": [
    {
      "raw_name": "text exactly as shown",
      "normalized_component_id": "catalog ID or null",
      "quantity": "decimal string or null",
      "uom": "string or null",
      "pack_size": "decimal string or null",
      "unit_price_rm": "0.00 or null",
      "total_price_rm": "0.00 or null",
      "confidence": "0.00 to 1.00"
    }
  ],
  "total_rm": "0.00 or null",
  "overall_confidence": "0.00 to 1.00",
  "ambiguities": [
    {
      "field": "JSON field path",
      "question": "short confirmation question",
      "options": ["possible value"]
    }
  ]
}`;
}

function cleanNumeric(value) {
  if (value === null || value === undefined || value === "") return null;
  const cleaned = String(value)
    .trim()
    .replace(/^RM\s*/i, "")
    .replace(/,/g, "")
    .replace(/\s+/g, "");
  if (!/^\d+(?:\.\d+)?$/.test(cleaned)) return null;
  const number = Number(cleaned);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function decimalString(value) {
  const number = cleanNumeric(value);
  return number === null ? null : String(number);
}

function moneyString(value) {
  const number = cleanNumeric(value);
  return number === null ? null : number.toFixed(2);
}

function confidenceString(value, fallback = 0.75) {
  if (value === null || value === undefined || value === "") {
    return String(fallback);
  }
  const text = String(value).trim();
  let number = Number(text.replace(/%$/, ""));
  if (text.endsWith("%")) number /= 100;
  if (!Number.isFinite(number)) return String(fallback);
  return String(Math.min(1, Math.max(0, number)));
}

function dateString(value) {
  if (value === null || value === undefined || value === "") return null;
  const text = String(value).trim();
  const iso = /^(20\d{2})-(\d{2})-(\d{2})$/.exec(text);
  if (iso) return text;
  const local = /^(\d{1,2})[/-](\d{1,2})[/-](20\d{2})$/.exec(text);
  if (!local) return null;
  return `${local[3]}-${local[2].padStart(2, "0")}-${local[1].padStart(2, "0")}`;
}

function receiptId(value) {
  if (value === null || value === undefined || value === "") return null;
  const text = String(value).trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(text) ? text : null;
}

function inferComponentId(rawName, supplied) {
  const validIds = new Set(COMPONENTS.map(({ id }) => id));
  if (validIds.has(supplied)) return supplied;
  const normalized = String(rawName).toLowerCase();
  return COMPONENTS.find(({ name, aliases }) =>
    [name, ...aliases].some((alias) =>
      normalized.includes(alias.toLowerCase())
    )
  )?.id ?? null;
}

function ambiguity(value) {
  if (typeof value === "string" && value.trim()) {
    return {
      field: "receipt",
      question: value.trim(),
      options: [],
    };
  }
  if (!value || typeof value !== "object") return null;
  const question = String(value.question ?? "").trim();
  if (!question) return null;
  return {
    field: String(value.field ?? "receipt").trim() || "receipt",
    question,
    options: Array.isArray(value.options)
      ? value.options.map(String).filter(Boolean)
      : [],
  };
}

function normalizeExtraction(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const lineItems = Array.isArray(source.line_items)
    ? source.line_items
    : Array.isArray(source.items)
      ? source.items
      : [];
  const normalizedLines = lineItems.flatMap((line) => {
    if (!line || typeof line !== "object") return [];
    const rawName = String(
      line.raw_name ?? line.name ?? line.description ?? "",
    ).trim();
    if (!rawName) return [];
    return [{
      raw_name: rawName,
      normalized_component_id: inferComponentId(
        rawName,
        line.normalized_component_id,
      ),
      quantity: decimalString(line.quantity),
      uom: line.uom === null || line.uom === undefined
        ? null
        : String(line.uom).trim() || null,
      pack_size: decimalString(line.pack_size),
      unit_price_rm: moneyString(line.unit_price_rm ?? line.unit_price),
      total_price_rm: moneyString(line.total_price_rm ?? line.total_price),
      confidence: confidenceString(line.confidence),
    }];
  });
  const ambiguities = Array.isArray(source.ambiguities)
    ? source.ambiguities.map(ambiguity).filter(Boolean)
    : [];
  if (source.overall_confidence === null
      || source.overall_confidence === undefined) {
    ambiguities.push({
      field: "overall_confidence",
      question: "Please verify the extracted receipt details.",
      options: [],
    });
  }

  return {
    receipt_id: receiptId(source.receipt_id),
    supplier_name:
      source.supplier_name === null || source.supplier_name === undefined
        ? null
        : String(source.supplier_name).trim() || null,
    date: dateString(source.date),
    currency: "MYR",
    line_items: normalizedLines,
    total_rm: moneyString(source.total_rm ?? source.total),
    overall_confidence: confidenceString(source.overall_confidence),
    ambiguities,
  };
}

function responseText(payload) {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      typeof part === "string"
        ? part
        : part?.text ?? part?.output_text ?? ""
    )
    .join("\n");
}

function parseJsonResponse(payload) {
  const text = responseText(payload)
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("Qwen receipt extraction returned no JSON object");
  }
  return JSON.parse(text.slice(start, end + 1));
}

async function responseError(response) {
  try {
    const payload = await response.json();
    return payload?.error?.code ?? payload?.code ?? `HTTP ${response.status}`;
  } catch {
    return `HTTP ${response.status}`;
  }
}

export function createReceiptExtractor({
  environment = process.env,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const apiKey = required(
    environment.DASHSCOPE_API_KEY,
    "DASHSCOPE_API_KEY",
  );
  const baseUrl = (
    environment.DASHSCOPE_BASE_URL ?? DEFAULT_BASE_URL
  ).replace(/\/+$/, "");
  const models = [
    environment.DASHSCOPE_RECEIPT_MODEL ?? DEFAULT_RECEIPT_MODEL,
    environment.DASHSCOPE_VISION_FALLBACK_MODEL,
  ].filter((model, index, all) => model && all.indexOf(model) === index);

  if (typeof fetchImpl !== "function") throw new Error("fetchImpl is required");

  return {
    async healthCheck() {
      return { status: "ok" };
    },

    async extract({ bytes, contentType }) {
      const image = Buffer.from(bytes);
      if (!image.length) throw new Error("Receipt image is empty");
      const dataUri =
        `data:${contentType};base64,${image.toString("base64")}`;
      const errors = [];

      for (const model of models) {
        try {
          const response = await fetchImpl(`${baseUrl}/chat/completions`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${apiKey}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              model,
              messages: [{
                role: "user",
                content: [
                  {
                    type: "image_url",
                    image_url: { url: dataUri },
                  },
                  { type: "text", text: prompt() },
                ],
              }],
              temperature: 0,
              enable_thinking: false,
              stream: false,
            }),
            signal: AbortSignal.timeout(timeoutMs),
          });
          if (!response.ok) {
            throw new Error(
              `${model} failed with ${await responseError(response)}`,
            );
          }

          const extraction = normalizeExtraction(
            parseJsonResponse(await response.json()),
          );
          const contractErrors = validateContract(
            "receipt-extraction",
            extraction,
          );
          if (contractErrors.length) {
            throw new Error(
              `${model} returned invalid receipt data: ${
                contractErrors.join("; ")
              }`,
            );
          }
          return extraction;
        } catch (error) {
          errors.push(error);
        }
      }

      throw new AggregateError(errors, "Qwen receipt extraction failed");
    },
  };
}
