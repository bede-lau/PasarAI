const REPLY_LANGUAGES = ["en", "ms", "zh"];
const SOURCE_LANGUAGES = ["en", "ms", "zh", "ms-en"];

const nonNegativeDecimal = {
  type: "string",
  pattern: "^\\d+(?:\\.\\d+)?$",
};
const positiveDecimal = {
  type: "string",
  pattern: "^(?:0*[1-9]\\d*)(?:\\.\\d+)?$|^0*\\.\\d*[1-9]\\d*$",
};
const money = {
  type: "string",
  pattern: "^\\d+(?:\\.\\d{1,2})?$",
};
const signedMoney = {
  type: "string",
  pattern: "^-?\\d+(?:\\.\\d{1,2})?$",
};
const IDENTIFIER_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._:-]*$";
const IDENTIFIER_REGEXP = new RegExp(IDENTIFIER_PATTERN);
const identifier = {
  type: "string",
  pattern: IDENTIFIER_PATTERN,
};
const replyLanguage = {
  type: "string",
  enum: REPLY_LANGUAGES,
};

export function trustedVoiceLanguage({ source, sourceLanguage }) {
  if (source !== "telegram_voice") return null;
  const normalized = String(sourceLanguage ?? "").trim().toLowerCase();
  if (!normalized) return null;
  if (
    normalized === "en"
    || normalized === "eng"
    || normalized.startsWith("en-")
  ) {
    return { replyLanguage: "en", sourceLanguage: "en" };
  }
  if (
    normalized === "ms-en"
    || normalized.startsWith("ms-en-")
  ) {
    return { replyLanguage: "ms", sourceLanguage: "ms-en" };
  }
  if (
    normalized === "ms"
    || normalized === "may"
    || normalized === "msa"
    || normalized === "zsm"
    || normalized === "id"
    || normalized === "ind"
    || normalized.startsWith("ms-")
    || normalized.startsWith("id-")
  ) {
    return { replyLanguage: "ms", sourceLanguage: "ms" };
  }
  if (
    normalized === "zh"
    || normalized === "zho"
    || normalized === "chi"
    || normalized === "cmn"
    || normalized.startsWith("zh-")
  ) {
    return { replyLanguage: "zh", sourceLanguage: "zh" };
  }
  return null;
}

export function operationWithTrustedVoiceLanguage(
  operation,
  { source, sourceLanguage },
) {
  const trusted = trustedVoiceLanguage({ source, sourceLanguage });
  if (!trusted || !operation?.payload) return operation;
  const hasSourceLanguage = Object.hasOwn(
    operation.payload,
    "source_language",
  );
  return {
    ...operation,
    payload: {
      ...operation.payload,
      ...(hasSourceLanguage
        ? { source_language: trusted.sourceLanguage }
        : {}),
      reply_language: trusted.replyLanguage,
    },
  };
}

export function integerEnvironment(environment, name, fallback) {
  const parsed = Number.parseInt(environment[name] ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
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

function catalogPrompt(title, catalog) {
  return [
    `${title}:`,
    ...catalog.map(({ id, name, aliases = [] }) => {
      const aliasText = aliases.length
        ? `; aliases: ${aliases.join(", ")}`
        : "";
      return `- ${name} -> ${id}${aliasText}`;
    }),
  ].join("\n");
}

export function buildSystemPrompt({
  products,
  components,
  occurredAt,
  timeZone,
  source,
  sourceLanguage,
  purchaseIntake,
}) {
  const currentDate = dateInTimeZone(occurredAt, timeZone) ?? "unknown";
  return [
    "You are the intent and tool-routing layer for PasarAI, a Malaysian food micro-vendor gross-margin copilot.",
    "Sound like a capable, friendly shop assistant. Match the merchant's language and level of formality.",
    "For conversational replies, use one or two short natural sentences. Acknowledge greetings and availability questions directly, and ask only one clear question at a time.",
    "Never mention internal terms such as tools, endpoints, payloads, ledgers, or databases.",
    "Do not sound like a form, policy, or system status message.",
    "Interpret English, Bahasa Melayu, Simplified Chinese, and natural Manglish, including plausible speech-to-text errors.",
    "Use speech-to-text similarity only to recover intent words. Never use it to invent an entity, amount, quantity, date, supplier, pack size, event ID, or price.",
    "Call one or more tools when the transcript contains a business request. If information is insufficient for non-purchase requests or the message is conversational, call respond_to_merchant with one concise helpful reply.",
    "Do not call respond_to_merchant in the same turn as a business tool.",
    "Never calculate money, percentages, totals, price floors, or differences. Copy exact merchant-stated inputs into tools; PasarAI performs all calculations and validation.",
    "Use only catalog IDs listed below. Ask for clarification when an entity is not an exact or unambiguous alias match.",
    "For current revenue, costs, expenses, COGS, gross profit, gross margin, cost drivers, or business performance, call get_daily_summary.",
    "Use capture_purchase for every cash purchase message, including partial details and corrections to the active draft. Include only values explicitly stated in this message.",
    "When a purchase draft is active, do not call capture_purchase for an unrelated question, greeting, or conversation that contains no purchase detail.",
    "Use record_cost_change for a relative component cost increase. Omit pack_size when the denominator is unknown so the business service can request it.",
    "For record_cost_change, clarification_source is an opaque PasarAI identifier. Include it only when an exact identifier was provided; never describe the clarification in that field.",
    "Use simulate_price for every what-if price or quantity question.",
    "Use record_correction only when the transcript includes the target event ID and the exact corrected value.",
    "respond_to_merchant must not contain merchant-specific financial results, calculations, or claims. It is only for greetings, scope, or clarification.",
    `Merchant-local date: ${currentDate}`,
    `Merchant time zone: ${timeZone}`,
    `Message source: ${source ?? "unknown"}`,
    `Transcriber language hint: ${sourceLanguage ?? "unknown"}`,
    "For Telegram voice, a recognized transcriber language hint is "
      + "authoritative for source_language and reply_language. "
      + "Map en/eng to en, ms/may/msa/id/ind to ms, and zh/zho/chi/cmn to zh.",
    `Active purchase intake: ${purchaseIntake
      ? JSON.stringify({
          state: purchaseIntake.state,
          version: purchaseIntake.version,
          supplier_name: purchaseIntake.request?.supplier_name ?? null,
          item: purchaseIntake.request?.item ?? {},
        })
      : "none"}`,
    catalogPrompt("Allowed products", products),
    catalogPrompt("Allowed recipe components", components),
  ].join("\n\n");
}

function objectSchema(properties, required) {
  return {
    type: "object",
    additionalProperties: false,
    required,
    properties,
  };
}

function canonicalMoney(value) {
  if (typeof value !== "string") return value;
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) return value;
  const integer = match[2].replace(/^0+(?=\d)/, "");
  const decimals = (match[3] ?? "").padEnd(2, "0");
  return `${match[1]}${integer}.${decimals}`;
}

export function buildTools({ products, components }) {
  const productIds = products.map(({ id }) => id);
  const componentIds = components.map(({ id }) => id);
  const sourceLanguage = {
    type: "string",
    enum: SOURCE_LANGUAGES,
  };
  const productId = { type: "string", enum: productIds };
  const componentId = componentIds.length
    ? { type: "string", enum: componentIds }
    : { type: "string", pattern: "a^" };
  const correctionChange = {
    oneOf: [
      objectSchema({
        kind: { type: "string", const: "money" },
        field: { type: "string", const: "unit_price_rm" },
        line_index: { type: "integer", minimum: 0 },
        previous_value: {
          anyOf: [signedMoney, { type: "null" }],
        },
        corrected_value: signedMoney,
      }, ["kind", "field", "corrected_value"]),
      objectSchema({
        kind: { type: "string", const: "decimal" },
        field: { type: "string", const: "quantity" },
        line_index: { type: "integer", minimum: 0 },
        previous_value: {
          anyOf: [nonNegativeDecimal, { type: "null" }],
        },
        corrected_value: nonNegativeDecimal,
      }, ["kind", "field", "corrected_value"]),
      objectSchema({
        kind: { type: "string", const: "identifier" },
        field: { type: "string", const: "product_id" },
        line_index: { type: "integer", minimum: 0 },
        previous_value: {
          anyOf: [{ type: "string" }, { type: "null" }],
        },
        corrected_value: productId,
      }, ["kind", "field", "corrected_value"]),
      objectSchema({
        kind: { type: "string", const: "text" },
        field: { type: "string", const: "source_language" },
        previous_value: {
          anyOf: [{ type: "string" }, { type: "null" }],
        },
        corrected_value: { type: "string", minLength: 1 },
      }, ["kind", "field", "corrected_value"]),
    ],
  };

  return [
    {
      name: "record_sales",
      description:
        "Record complete sales lines using exact catalog product IDs, quantities, and merchant-stated unit prices.",
      strict: true,
      input_schema: objectSchema({
        source_language: sourceLanguage,
        reply_language: replyLanguage,
        lines: {
          type: "array",
          minItems: 1,
          items: objectSchema({
            product_id: productId,
            quantity: positiveDecimal,
            unit_price_rm: money,
          }, ["product_id", "quantity", "unit_price_rm"]),
        },
      }, ["source_language", "reply_language", "lines"]),
    },
    {
      name: "capture_purchase",
      description:
        "Capture explicitly stated fields for a new or active cash purchase draft. Partial input is expected and will be clarified by PasarAI.",
      strict: true,
      input_schema: objectSchema({
        supplier_name: { type: "string", minLength: 1 },
        source_language: sourceLanguage,
        reply_language: replyLanguage,
        component_id: componentId,
        raw_name: { type: "string", minLength: 1 },
        quantity: positiveDecimal,
        uom: { type: "string", minLength: 1 },
        pack_size: positiveDecimal,
        total_price_rm: money,
        note: { type: "string", minLength: 1, maxLength: 500 },
      }, ["source_language", "reply_language"]),
    },
    {
      name: "record_cost",
      description:
        "Legacy complete-purchase capture. PasarAI still creates a confirmation draft and does not commit immediately.",
      strict: true,
      input_schema: objectSchema({
        supplier_name: { type: "string", minLength: 1 },
        reply_language: replyLanguage,
        lines: {
          type: "array",
          minItems: 1,
          items: objectSchema({
            component_id: componentId,
            raw_name: { type: "string", minLength: 1 },
            quantity: positiveDecimal,
            uom: { type: "string", minLength: 1 },
            pack_size: positiveDecimal,
            total_price_rm: money,
          }, [
            "component_id",
            "quantity",
            "uom",
            "pack_size",
            "total_price_rm",
          ]),
        },
      }, ["supplier_name", "reply_language", "lines"]),
    },
    {
      name: "record_cost_change",
      description:
        "Record a merchant-stated relative component cost increase. Leave pack_size absent when the denominator is unknown. Omit clarification_source unless PasarAI supplied its exact identifier.",
      strict: true,
      input_schema: objectSchema({
        component_id: componentId,
        increase_rm: money,
        pack_size: positiveDecimal,
        clarification_source: identifier,
        reply_language: replyLanguage,
      }, ["component_id", "increase_rm", "reply_language"]),
    },
    {
      name: "simulate_price",
      description:
        "Run a read-only price and quantity scenario. PasarAI calculates all returned financial values.",
      strict: true,
      input_schema: objectSchema({
        product_id: productId,
        quantity: nonNegativeDecimal,
        proposed_unit_price_rm: money,
        as_of: {
          type: "string",
          pattern: "^20\\d{2}-\\d{2}-\\d{2}$",
        },
        reply_language: replyLanguage,
      }, [
        "product_id",
        "quantity",
        "proposed_unit_price_rm",
        "as_of",
        "reply_language",
      ]),
    },
    {
      name: "record_correction",
      description:
        "Append a correction to an existing sale event. Requires the exact target event ID and corrected value.",
      strict: true,
      input_schema: objectSchema({
        target_event_id: { type: "string", minLength: 1 },
        reason: { type: "string", minLength: 1 },
        changes: {
          type: "array",
          minItems: 1,
          items: correctionChange,
        },
        reply_language: replyLanguage,
      }, ["target_event_id", "reason", "changes", "reply_language"]),
    },
    {
      name: "get_daily_summary",
      description:
        "Fetch the authoritative daily revenue, recorded COGS, gross profit, gross margin, completeness, and cost drivers.",
      strict: true,
      input_schema: objectSchema({
        date: {
          type: "string",
          pattern: "^20\\d{2}-\\d{2}-\\d{2}$",
        },
        reply_language: replyLanguage,
      }, ["date", "reply_language"]),
    },
    {
      name: "respond_to_merchant",
      description:
        "Reply naturally with a concise greeting, scope statement, availability acknowledgement, or clarification question. Never include a financial result or calculation.",
      strict: true,
      input_schema: objectSchema({
        text: { type: "string", minLength: 1, maxLength: 500 },
        reply_language: replyLanguage,
      }, ["text", "reply_language"]),
    },
  ];
}

export function sanitizeToolInput(name, input) {
  if (
    name !== "record_cost_change"
    || !input
    || typeof input !== "object"
    || !Object.hasOwn(input, "clarification_source")
    || IDENTIFIER_REGEXP.test(input.clarification_source)
  ) {
    return input;
  }
  const { clarification_source: _ignored, ...sanitized } = input;
  return sanitized;
}

export function operationForToolUse(block, {
  occurredAt,
  source,
}) {
  const input = block.input ?? {};
  if (block.name === "record_sales") {
    return {
      endpoint_id: "sales.create",
      payload: {
        occurred_at: occurredAt,
        source,
        source_language: input.source_language,
        reply_language: input.reply_language,
        lines: input.lines?.map((line) => ({
          ...line,
          unit_price_rm: canonicalMoney(line.unit_price_rm),
        })),
      },
    };
  }
  if (block.name === "capture_purchase") {
    return {
      endpoint_id: "purchase-intake.upsert",
      payload: {
        occurred_at: occurredAt,
        source,
        source_language: input.source_language,
        reply_language: input.reply_language,
        ...(input.supplier_name
          ? { supplier_name: input.supplier_name }
          : {}),
        metadata: {
          payment_method: "cash",
          ...(input.note ? { note: input.note } : {}),
        },
        item: {
          ...(input.component_id
            ? { component_id: input.component_id }
            : {}),
          ...(input.raw_name ? { raw_name: input.raw_name } : {}),
          ...(input.quantity ? { quantity: input.quantity } : {}),
          ...(input.uom ? { uom: input.uom } : {}),
          ...(input.pack_size ? { pack_size: input.pack_size } : {}),
          ...(input.total_price_rm
            ? { total_price_rm: canonicalMoney(input.total_price_rm) }
            : {}),
        },
      },
    };
  }
  if (block.name === "record_cost") {
    const line = input.lines?.[0] ?? {};
    return {
      endpoint_id: "purchase-intake.upsert",
      payload: {
        occurred_at: occurredAt,
        source,
        reply_language: input.reply_language,
        supplier_name: input.supplier_name,
        metadata: { payment_method: "cash" },
        item: {
          component_id: line.component_id,
          ...(line.raw_name ? { raw_name: line.raw_name } : {}),
          quantity: line.quantity,
          uom: line.uom,
          pack_size: line.pack_size,
          total_price_rm: canonicalMoney(line.total_price_rm),
        },
      },
    };
  }
  if (block.name === "record_cost_change") {
    return {
      endpoint_id: "cost-changes.create",
      payload: {
        occurred_at: occurredAt,
        component_id: input.component_id,
        increase_rm: canonicalMoney(input.increase_rm),
        ...(input.pack_size ? { pack_size: input.pack_size } : {}),
        ...(input.clarification_source
          ? { clarification_source: input.clarification_source }
          : {}),
        reply_language: input.reply_language,
      },
    };
  }
  if (block.name === "simulate_price") {
    return {
      endpoint_id: "price-simulation.create",
      payload: {
        ...input,
        proposed_unit_price_rm: canonicalMoney(
          input.proposed_unit_price_rm,
        ),
      },
    };
  }
  if (block.name === "record_correction") {
    return {
      endpoint_id: "corrections.create",
      payload: {
        target_event_id: input.target_event_id,
        occurred_at: occurredAt,
        reason: input.reason,
        replacement_payload: {
          changes: input.changes?.map((change) => {
            if (change.kind !== "money") return change;
            return {
              ...change,
              previous_value: change.previous_value === null
                ? null
                : canonicalMoney(change.previous_value),
              corrected_value: canonicalMoney(change.corrected_value),
            };
          }),
        },
        reply_language: input.reply_language,
      },
    };
  }
  if (block.name === "get_daily_summary") {
    return {
      endpoint_id: "daily-summary.get",
      payload: input,
    };
  }
  if (block.name === "respond_to_merchant") {
    return {
      endpoint_id: "agent.reply",
      payload: input,
    };
  }
  return null;
}

export function safeAgentReply(operation) {
  if (operation?.endpoint_id !== "agent.reply") return true;
  const text = operation.payload?.text?.trim();
  if (!text || text.length > 500) return false;
  return !(
    /\bRM\s*-?\d/i.test(text)
    || /-?\d+(?:\.\d+)?\s*(?:%|ringgit)\b/i.test(text)
  );
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function validatesSchema(schema, value) {
  if (schema.anyOf) {
    return schema.anyOf.some((candidate) => validatesSchema(candidate, value));
  }
  if (schema.oneOf) {
    return schema.oneOf.filter((candidate) =>
      validatesSchema(candidate, value)
    ).length === 1;
  }
  if (schema.const !== undefined && value !== schema.const) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;

  if (Array.isArray(schema.type)) {
    return schema.type.some((type) =>
      validatesSchema({ ...schema, type }, value)
    );
  }
  if (schema.type === "null") return value === null;
  if (schema.type === "string") {
    if (typeof value !== "string") return false;
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      return false;
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      return false;
    }
    return !schema.pattern || new RegExp(schema.pattern).test(value);
  }
  if (schema.type === "integer") {
    return Number.isInteger(value)
      && (schema.minimum === undefined || value >= schema.minimum);
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) return false;
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      return false;
    }
    return !schema.items
      || value.every((item) => validatesSchema(schema.items, item));
  }
  if (schema.type === "object") {
    if (!isObject(value)) return false;
    if ((schema.required ?? []).some((name) => value[name] === undefined)) {
      return false;
    }
    const properties = schema.properties ?? {};
    if (
      schema.additionalProperties === false
      && Object.keys(value).some((name) => properties[name] === undefined)
    ) {
      return false;
    }
    return Object.entries(properties).every(([name, propertySchema]) =>
      value[name] === undefined
      || validatesSchema(propertySchema, value[name])
    );
  }
  return true;
}

export function selectOperations(operations) {
  if (
    !operations.length
    || operations.some((operation) => !safeAgentReply(operation))
  ) {
    return null;
  }
  const businessOperations = operations.filter(
    ({ endpoint_id: endpointId }) => endpointId !== "agent.reply",
  );
  const selected = businessOperations.length
    ? businessOperations
    : operations.slice(0, 1);
  return selected.length === 1 ? selected[0] : selected;
}
