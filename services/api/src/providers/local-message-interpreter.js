export const DEFAULT_PRODUCTS = [
  {
    id: "p_nla_001",
    name: "Nasi Lemak Ayam",
    aliases: ["nasi lemak ayam"],
  },
  {
    id: "p_nlb_001",
    name: "Nasi Lemak Biasa",
    aliases: ["nasi lemak biasa", "nasi lemak"],
  },
  {
    id: "p_tehais_001",
    name: "Teh Ais",
    aliases: ["teh ais", "iced tea"],
  },
];

export const DEFAULT_COMPONENTS = [
  { id: "c_rice", name: "Beras", aliases: ["beras", "rice"] },
  {
    id: "c_coconut",
    name: "Santan",
    aliases: ["santan", "coconut milk"],
  },
  { id: "c_egg", name: "Telur", aliases: ["telur", "egg", "eggs"] },
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
    aliases: [
      "bekas makanan",
      "bekas",
      "packaging",
      "container",
      "containers",
    ],
  },
  {
    id: "c_fuel",
    name: "Gas + Condiments",
    aliases: ["gas", "condiments"],
  },
];

const NUMBER_REPLACEMENTS = [
  ["tiga puluh lapan", "38"],
  ["empat puluh", "40"],
  ["tiga puluh lima", "35"],
  ["thirty eight", "38"],
  ["thirty five", "35"],
  ["forty", "40"],
  ["thirty", "30"],
  ["twenty", "20"],
  ["eighteen", "18"],
  ["twelve", "12"],
  ["ten", "10"],
  ["nine", "9"],
  ["eight", "8"],
  ["seven", "7"],
  ["six", "6"],
  ["five", "5"],
  ["four", "4"],
  ["three", "3"],
  ["two", "2"],
  ["one", "1"],
  ["sepuluh", "10"],
  ["sembilan", "9"],
  ["lapan", "8"],
  ["tujuh", "7"],
  ["enam", "6"],
  ["lima", "5"],
  ["empat", "4"],
  ["tiga", "3"],
  ["dua", "2"],
  ["satu", "1"],
];

const MALAY_TERMS = /\b(?:hari ni|habis|bungkus|jual|naik|telur|bekas|santan|beras|timun)\b/i;
const ENGLISH_TERMS = /\b(?:today|sold|packaging|cost|ringgit|bought|customer|at|each)\b/i;
const BUSINESS_QUERY_CUES =
  /\b(?:how|what|show|tell|looking|today|now|current|berapa|bagaimana|macam mana|hari ini|sekarang)\b|(?:怎样|怎么样|如何|多少|情况|现在|今天|目前)|[?？]/iu;
const BUSINESS_SCOPE_TERMS =
  /\b(?:business|shop|store|product|performance|figures?|numbers?|perniagaan|kedai|produk|prestasi)\b|(?:生意|业务|产品|表现)/iu;
const TREND_QUERY_CUES =
  /\b(?:trends?|trending|over time|this week|last week|past week|minggu ini|trend)\b|(?:趋势|这周|本周)/iu;
const SIMULATION_CUES =
  /\b(?:what if|if i|suppose|simulate|simulation|scenario|kalau|jika|andaikan)\b|(?:如果|假如)/iu;
const BUSINESS_METRICS = [
  {
    id: "cost_drivers",
    pattern:
      /\b(?:cost drivers?|biggest costs?|highest costs?|main costs?|costs?\s+(?:are|is)\s+(?:the\s+)?(?:biggest|highest|largest)|pemacu kos|kos terbesar)\b|(?:主要成本|最大成本)/iu,
  },
  {
    id: "gross_margin",
    pattern:
      /\b(?:gross margin|margin kasar|profit margin)\b|(?:毛利率)/iu,
  },
  {
    id: "gross_profit",
    pattern:
      /\b(?:gross profit|untung kasar)\b|(?:毛利)/iu,
  },
  {
    id: "revenue",
    pattern:
      /\b(?:revenue|sales?|turnover|jualan|hasil|pendapatan)\b|(?:营业额|营收|销售额)/iu,
  },
  {
    id: "cogs",
    pattern:
      /\b(?:cogs|expenses?|costs?|spending|belanja|perbelanjaan|kos)\b|(?:开支|支出|成本|费用|花费)/iu,
  },
];

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeNumbers(text) {
  let normalized = text;
  for (const [phrase, value] of NUMBER_REPLACEMENTS) {
    const pattern = phrase
      .split(/\s+/)
      .map(escapeRegex)
      .join("\\s+");
    normalized = normalized.replace(
      new RegExp(`\\b${pattern}\\b`, "gi"),
      value,
    );
  }
  return normalized;
}

function normalizeText(text) {
  return normalizeNumbers(
    text
      .normalize("NFKC")
      .replace(/[’‘]/g, "'")
      .toLowerCase(),
  );
}

function aliasesFor(entry, additionalAliases = []) {
  return [...new Set([
    entry.name,
    ...(entry.aliases ?? []),
    ...additionalAliases,
  ].map((alias) => alias.trim().toLowerCase()).filter(Boolean))];
}

function parseCatalog(raw, defaults) {
  if (!raw?.trim()) return defaults;

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Catalog environment value must be valid JSON");
  }
  if (!Array.isArray(parsed) || !parsed.length) {
    throw new Error("Catalog environment value must be a non-empty array");
  }

  const defaultsById = new Map(defaults.map((entry) => [entry.id, entry]));
  return parsed.map((entry) => {
    if (!entry?.id || !entry?.name) {
      throw new Error("Catalog entries require id and name");
    }
    const fallback = defaultsById.get(entry.id);
    return {
      id: entry.id,
      name: entry.name,
      aliases: aliasesFor(entry, fallback?.aliases),
    };
  });
}

export function loadMessageInterpreterCatalog({
  environment = process.env,
} = {}) {
  return {
    products: parseCatalog(
      environment.PASARAI_PRODUCT_CATALOG_JSON,
      DEFAULT_PRODUCTS,
    ),
    components: parseCatalog(
      environment.PASARAI_COMPONENT_CATALOG_JSON,
      DEFAULT_COMPONENTS,
    ),
  };
}

const MAX_SALE_QUANTITY = 100_000;
const MAX_UNIT_PRICE_RM = 10_000;

function plausibleSaleLine(quantity, unitPriceRm) {
  const quantityValue = Number.parseFloat(quantity);
  const priceValue = Number.parseFloat(unitPriceRm);
  return Number.isFinite(quantityValue)
    && Number.isFinite(priceValue)
    && quantityValue > 0
    && quantityValue <= MAX_SALE_QUANTITY
    && priceValue > 0
    && priceValue <= MAX_UNIT_PRICE_RM;
}

function decimalString(value) {
  const match = String(value).match(/^(\d+)(?:\.(\d+))?$/);
  if (!match) return null;
  const integer = match[1].replace(/^0+(?=\d)/, "");
  const fraction = match[2]?.replace(/0+$/, "");
  return fraction ? `${integer}.${fraction}` : integer;
}

function myrString(value) {
  const match = String(value).match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!match) return null;
  const integer = match[1].replace(/^0+(?=\d)/, "");
  return `${integer}.${(match[2] ?? "").padEnd(2, "0")}`;
}

function myrCents(value) {
  const formatted = myrString(value);
  if (!formatted) return null;
  const [integer, fraction] = formatted.split(".");
  return (BigInt(integer) * 100n) + BigInt(fraction);
}

function formatCents(value) {
  const integer = value / 100n;
  const fraction = String(value % 100n).padStart(2, "0");
  return `${integer}.${fraction}`;
}

function normalizeUnit(value) {
  const lower = value.toLowerCase();
  if (lower.endsWith("ies")) return `${lower.slice(0, -3)}y`;
  if (lower.endsWith("s") && lower !== "gas") return lower.slice(0, -1);
  return lower;
}

function aliasPattern(alias) {
  return alias
    .split(/\s+/)
    .map(escapeRegex)
    .join("\\s+");
}

function findCatalogMatch(text, catalog) {
  const candidates = [];
  for (const entry of catalog) {
    for (const alias of aliasesFor(entry)) {
      const match = new RegExp(`\\b${aliasPattern(alias)}\\b`, "i").exec(text);
      if (match) {
        candidates.push({
          entry,
          alias,
          index: match.index,
          length: match[0].length,
        });
      }
    }
  }
  return candidates.sort(
    (left, right) =>
      left.index - right.index || right.length - left.length,
  )[0] ?? null;
}

function detectLanguage(text, supplied) {
  if (/[\u3400-\u9fff]/u.test(text)) return "zh";
  const hasMalay = MALAY_TERMS.test(text);
  const hasEnglish = ENGLISH_TERMS.test(text);
  if (hasMalay && hasEnglish) return "ms-en";
  if (hasMalay) return "ms";

  const normalized = supplied?.toLowerCase();
  if (["ms", "msa", "may"].includes(normalized)) return "ms";
  if (["zh", "zho", "chi", "cmn"].includes(normalized)) return "zh";
  if (normalized?.startsWith("ms-")) return normalized;
  return "en";
}

function dateInTimeZone(value, timeZone) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(
    parts.map(({ type, value: partValue }) => [type, partValue]),
  );
  return `${values.year}-${values.month}-${values.day}`;
}

function shiftCalendarDate(date, days) {
  const match = /^(20\d{2})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return null;
  const shifted = new Date(Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]) + days,
  ));
  return shifted.toISOString().slice(0, 10);
}

function requestedBusinessMetric(text) {
  return BUSINESS_METRICS.find(({ pattern }) => pattern.test(text))?.id
    ?? null;
}

export function detectReplyLanguage(text, sourceLanguage) {
  return replyLanguage(text, sourceLanguage);
}

function replyLanguage(text, sourceLanguage) {
  const detected = detectLanguage(text, sourceLanguage);
  if (detected === "zh") return "zh";
  return detected.startsWith("ms") ? "ms" : "en";
}

function dailySummaryOperation({
  text,
  products,
  occurredAt,
  sourceLanguage,
  timeZone,
}) {
  if (SIMULATION_CUES.test(text)) return null;
  const queryText = text.replace(/\bssi\b/gi, "expenses");
  const requestedMetric = requestedBusinessMetric(queryText);
  const trendRequested = TREND_QUERY_CUES.test(queryText);
  if (
    !requestedMetric
    && !BUSINESS_SCOPE_TERMS.test(queryText)
  ) {
    return null;
  }
  if (!trendRequested && !BUSINESS_QUERY_CUES.test(queryText)) return null;

  const explicitDate = /\b(20\d{2}-\d{2}-\d{2})\b/.exec(text)?.[1];
  const currentDate = dateInTimeZone(occurredAt, timeZone);
  const date = explicitDate
    ?? (/\b(?:yesterday|semalam)\b/i.test(queryText)
      ? shiftCalendarDate(currentDate, -1)
      : currentDate);
  if (!date) return null;

  const language = replyLanguage(text, sourceLanguage);
  const product = findCatalogMatch(queryText, products);
  if (trendRequested) {
    const requestedDays = Number.parseInt(
      /\b(?:last|past)\s+(\d{1,2})\s+days?\b/i.exec(queryText)?.[1] ?? "7",
      10,
    );
    const days = Math.min(31, Math.max(2, requestedDays));
    const from = shiftCalendarDate(date, -(days - 1));
    if (!from) return null;
    return {
      endpoint_id: "business-trend.get",
      payload: {
        from,
        to: date,
        requested_metric: requestedMetric ?? "overview",
        ...(product ? { product_id: product.entry.id } : {}),
        reply_language: language,
      },
    };
  }

  return {
    endpoint_id: "daily-summary.get",
    payload: {
      date,
      requested_metric: requestedMetric ?? "overview",
      ...(product ? { product_id: product.entry.id } : {}),
      reply_language: language,
    },
  };
}

function salesOperation({
  text,
  products,
  occurredAt,
  source,
  sourceLanguage,
}) {
  if (SIMULATION_CUES.test(text)) return null;
  const candidates = [];
  const unitPattern = "(?:bungkus|packs?|packets?|cups?|units?)";
  const priceCue = "(?:at|@|pada|semua|for|harga(?:nya)?|each)";

  for (const product of products) {
    for (const alias of aliasesFor(product)) {
      const pattern = new RegExp(
        `(?<![\\d.,\\-])(\\d+(?:\\.\\d+)?)(?!\\d)(?![.,]\\d)(?![eE][+-]?\\d)\\s*`
        + `(?:${unitPattern}\\s*)?`
        + `${aliasPattern(alias)}\\b`
        + `[\\s,]*(?:${priceCue}\\s*)?`
        + `(?:rm\\s*)?(?<![\\d.,\\-])(\\d+(?:\\.\\d+)?)(?!\\d)(?![.,]\\d)(?![eE][+-]?\\d)`
        + `(?:\\s*(?:ringgit|each))?`,
        "i",
      );
      const match = pattern.exec(text);
      if (!match) continue;
      const quantity = decimalString(match[1]);
      const unitPriceRm = myrString(match[2]);
      if (!quantity || !unitPriceRm) continue;
      if (!plausibleSaleLine(quantity, unitPriceRm)) continue;
      candidates.push({
        index: match.index,
        aliasLength: alias.length,
        line: {
          product_id: product.id,
          quantity,
          unit_price_rm: unitPriceRm,
        },
      });
    }
  }

  const selected = [];
  const productIds = new Set();
  for (const candidate of candidates.sort(
    (left, right) =>
      left.index - right.index || right.aliasLength - left.aliasLength,
  )) {
    if (productIds.has(candidate.line.product_id)) continue;
    productIds.add(candidate.line.product_id);
    selected.push(candidate);
  }
  if (!selected.length) return null;

  return {
    endpoint_id: "sales.create",
    payload: {
      occurred_at: occurredAt,
      source,
      source_language: detectLanguage(text, sourceLanguage),
      lines: selected.map(({ line }) => line),
    },
  };
}

function purchaseOperation({
  text,
  originalText,
  components,
  occurredAt,
  sourceLanguage,
  purchaseIntake,
}) {
  const hasPurchaseCue =
    /\b(?:bought|purchased|buy|beli|purchase|cash purchase)\b/i.test(text);
  if (!hasPurchaseCue && !purchaseIntake) return null;
  const component = findCatalogMatch(text, components);
  const unitPattern =
    "(trays?|bundles?|packs?|bags?|sacks?|boxes?|units?|kg|g|litres?|liters?|bottles?)";
  const unitPrice = new RegExp(
    `(?:rm\\s*)?(?<![\\d.,\\-])(\\d+(?:\\.\\d+)?)(?!\\d)(?![.,]\\d)(?![eE][+-]?\\d)\\s*`
    + `(?:ringgit\\s*)?(?:per|\\/)\\s*${unitPattern}`
    + `(?:\\s*(?:of|isi|contains?)\\s*(?<![\\d.,\\-])(\\d+(?:\\.\\d+)?)(?!\\d)(?![.,]\\d)(?![eE][+-]?\\d))?`,
    "i",
  ).exec(text);
  const purchased = new RegExp(
    `(?:\\b(?:bought|purchased|buy|beli)\\s*)?`
    + `(?<![\\d.,\\-])(\\d+(?:\\.\\d+)?)(?!\\d)(?![.,]\\d)(?![eE][+-]?\\d)\\s*${unitPattern}\\b`,
    "i",
  ).exec(text);
  const packSize =
    /(?:of|isi|contains?|each has|setiap)\s*(?<![\d.,\-])(\d+(?:\.\d+)?)(?!\d)(?![.,]\d)(?![eE][+-]?\d)/i.exec(text)
    ?? /(?<![\d.,\-])(\d+(?:\.\d+)?)(?!\d)(?![.,]\d)(?![eE][+-]?\d)\s*(?:each|setiap)\b/i.exec(text);
  const supplier = /\b(?:from|daripada|dari)\s+([^.!?]+?)(?:[.!?]|$)/i.exec(
    originalText,
  );
  const markedTotal =
    /(?:total|jumlah|for|harga(?:nya)?)\s*(?:rm\s*)?(?<![\d.,\-])(\d+(?:\.\d+)?)(?!\d)(?![.,]\d)(?![eE][+-]?\d)/i
      .exec(text)
    ?? /rm\s*(?<![\d.,\-])(\d+(?:\.\d+)?)(?!\d)(?![.,]\d)(?![eE][+-]?\d)\s*(?:total|jumlah)/i.exec(text);
  const explicitTotal = markedTotal
    ?? (
      unitPrice
        ? null
        : /rm\s*(?<![\d.,\-])(\d+(?:\.\d+)?)(?!\d)(?![.,]\d)(?![eE][+-]?\d)/i.exec(text)
    );

  const item = {};
  if (component) {
    item.component_id = component.entry.id;
    item.raw_name = component.alias;
  }
  if (purchased) {
    item.quantity = decimalString(purchased[1]);
    item.uom = normalizeUnit(purchased[2]);
  }
  const normalizedPackSize = decimalString(
    packSize?.[1] ?? unitPrice?.[3] ?? "",
  );
  if (normalizedPackSize) item.pack_size = normalizedPackSize;
  if (
    !item.pack_size
    && ["kg", "g", "litre", "liter"].includes(item.uom)
  ) {
    item.pack_size = "1";
  }
  const explicitTotalRm = explicitTotal ? myrString(explicitTotal[1]) : null;
  if (explicitTotalRm) {
    item.total_price_rm = explicitTotalRm;
  } else if (unitPrice && purchased) {
    const priceCents = myrCents(unitPrice[1]);
    const quantity = decimalString(purchased[1]);
    const priceUnit = normalizeUnit(unitPrice[2]);
    const purchaseUnit = normalizeUnit(purchased[2]);
    if (
      priceCents !== null
      && quantity
      && priceUnit === purchaseUnit
      && /^\d+$/.test(quantity)
    ) {
      item.total_price_rm =
        formatCents(priceCents * BigInt(quantity));
    }
  }
  const hasExplicitUpdate = Boolean(
    hasPurchaseCue
    || component
    || purchased
    || packSize
    || explicitTotal
    || supplier,
  );
  if (!hasExplicitUpdate) return null;

  return {
    endpoint_id: "purchase-intake.upsert",
    payload: {
      occurred_at: occurredAt,
      source_language: detectLanguage(text, sourceLanguage),
      reply_language:
        detectLanguage(text, sourceLanguage) === "zh"
          ? "zh"
          : detectLanguage(text, sourceLanguage).startsWith("ms")
            ? "ms"
            : "en",
      ...(supplier ? { supplier_name: supplier[1].trim() } : {}),
      metadata: { payment_method: "cash" },
      item,
    },
  };
}

function nearestMoney(text, index) {
  const matches = [];
  const pattern = /(?:rm\s*(?<![\d.,\-])(\d+(?:\.\d+)?)(?!\d)(?![.,]\d)(?![eE][+-]?\d)|(?<![\d.,\-])(\d+(?:\.\d+)?)(?!\d)(?![.,]\d)(?![eE][+-]?\d)\s*ringgit)/gi;
  for (const match of text.matchAll(pattern)) {
    matches.push({
      value: match[1] ?? match[2],
      distance: Math.abs(match.index - index),
    });
  }
  return matches.sort((left, right) => left.distance - right.distance)[0]?.value
    ?? null;
}

function costChangeOperation({ text, components, occurredAt }) {
  const cue = /\b(?:naik|increase(?:d)?|extra|rose|up)\b/i.exec(text);
  if (!cue) return null;
  const component = findCatalogMatch(text, components);
  if (!component) return null;
  const increaseRm = myrString(nearestMoney(text, cue.index));
  if (!increaseRm) return null;

  const packSize = /(?:per|for|untuk)\s*(?:1\s*)?(?:bundle|pack|pek|tray)?\s*(?:of|isi)?\s*(?<![\d.,\-])(\d+(?:\.\d+)?)(?!\d)(?![.,]\d)(?![eE][+-]?\d)/i.exec(text)
    ?? /(?:bundle|pack|pek|tray)\s*(?:of|isi)?\s*(?<![\d.,\-])(\d+(?:\.\d+)?)(?!\d)(?![.,]\d)(?![eE][+-]?\d)/i.exec(text);
  const normalizedPackSize = packSize ? decimalString(packSize[1]) : null;

  return {
    endpoint_id: "cost-changes.create",
    payload: {
      occurred_at: occurredAt,
      component_id: component.entry.id,
      increase_rm: increaseRm,
      ...(normalizedPackSize ? { pack_size: normalizedPackSize } : {}),
    },
  };
}

export function createMessageInterpreter({
  environment = process.env,
  now = () => new Date().toISOString(),
} = {}) {
  const { products, components } = loadMessageInterpreterCatalog({
    environment,
  });

  return {
    async healthCheck() {
      return { status: "ok" };
    },

    async interpret({
      text,
      source,
      sourceLanguage,
      occurredAt,
      purchaseIntake,
      componentCatalog,
    }) {
      if (typeof text !== "string" || !text.trim()) return null;
      const originalText = text.trim();
      const normalized = normalizeText(originalText);
      const timestamp = occurredAt ?? now();
      const activeComponents = Array.isArray(componentCatalog)
        ? componentCatalog.map((component) => {
            const configured = components.find(
              ({ id }) => id === component.id,
            );
            return {
              ...component,
              aliases: aliasesFor(component, configured?.aliases),
            };
          })
        : components;
      if (purchaseIntake) {
        const summary = dailySummaryOperation({
          text: normalized,
          products,
          occurredAt: timestamp,
          sourceLanguage,
          timeZone: environment.PASARAI_TIME_ZONE
            ?? "Asia/Kuala_Lumpur",
        });
        if (summary) return summary;
        const purchase = purchaseOperation({
          text: normalized,
          originalText,
          components: activeComponents,
          occurredAt: timestamp,
          sourceLanguage,
          purchaseIntake,
        });
        if (purchase) return purchase;
        const language = detectLanguage(originalText, sourceLanguage);
        const replyLanguage = language === "zh"
          ? "zh"
          : language.startsWith("ms")
            ? "ms"
            : "en";
        const replies = {
          en:
            "You still have a cash purchase awaiting completion. "
            + "Reply with a missing detail, confirm, or cancel.",
          ms:
            "Anda masih mempunyai pembelian tunai yang belum lengkap. "
            + "Balas dengan maklumat yang hilang, sahkan, atau batal.",
          zh:
            "\u60a8\u4ecd\u6709\u4e00\u7b14\u5f85\u5b8c\u6210\u7684"
            + "\u73b0\u91d1\u91c7\u8d2d\u3002\u8bf7\u56de\u590d"
            + "\u7f3a\u5c11\u7684\u8d44\u6599\u3001\u786e\u8ba4"
            + "\u6216\u53d6\u6d88\u3002",
        };
        return {
          endpoint_id: "agent.reply",
          payload: {
            reply_language: replyLanguage,
            text: replies[replyLanguage],
          },
        };
      }
      const operations = [
        salesOperation({
          text: normalized,
          products,
          occurredAt: timestamp,
          source,
          sourceLanguage,
        }),
        purchaseOperation({
          text: normalized,
          originalText,
          components: activeComponents,
          occurredAt: timestamp,
          sourceLanguage,
          purchaseIntake,
        }),
        costChangeOperation({
          text: normalized,
          components: activeComponents,
          occurredAt: timestamp,
        }),
      ].filter(Boolean);

      if (!operations.length) {
        return dailySummaryOperation({
          text: normalized,
          products,
          occurredAt: timestamp,
          sourceLanguage,
          timeZone: environment.PASARAI_TIME_ZONE
            ?? "Asia/Kuala_Lumpur",
        });
      }
      return operations.length === 1 ? operations[0] : operations;
    },
  };
}
