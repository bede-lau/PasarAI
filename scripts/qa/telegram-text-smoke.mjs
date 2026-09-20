import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";

import { createMessageInterpreter } from "../../services/api/src/providers/qwen-message-interpreter.js";

const apiBaseUrl = (
  process.env.PASARAI_QA_API_BASE_URL ?? "http://127.0.0.1:3001"
).replace(/\/+$/u, "");
const merchantId = process.env.PASARAI_MERCHANT_ID;
const bearerToken = process.env.PASARAI_API_BEARER_TOKEN;
const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN;
const businessDate = process.env.PASARAI_DASHBOARD_DATE ?? "2026-07-16";
const productId = process.env.PASARAI_PRODUCT_ID ?? "p_nlb_001";
const timeoutMs = 15_000;
const samplesPerApiCall = 5;

function required(value, name) {
  if (!value || value === "<PLACEHOLDER>") {
    throw new Error(`${name} is required`);
  }
  return value;
}

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(
    0,
    Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1),
  );
  return Number(sorted[index].toFixed(1));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function timedJson(name, url, init = {}) {
  const startedAt = performance.now();
  const response = await fetch(url, {
    ...init,
    headers: {
      accept: "application/json",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const durationMs = performance.now() - startedAt;
  let body;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  assert(
    response.ok,
    `${name} returned HTTP ${response.status}: ${JSON.stringify(body)}`,
  );
  return { durationMs, body };
}

function apiUrl(path, query = {}) {
  const url = new URL(path, apiBaseUrl);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

async function sampleApi({
  name,
  method = "GET",
  path,
  query,
  payload,
  validate,
}) {
  const durations = [];
  let lastBody;
  for (let index = 0; index < samplesPerApiCall; index += 1) {
    const result = await timedJson(name, apiUrl(path, query), {
      method,
      headers: {
        authorization: `Bearer ${required(
          bearerToken,
          "PASARAI_API_BEARER_TOKEN",
        )}`,
      },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
    });
    durations.push(result.durationMs);
    lastBody = result.body;
    validate?.(result.body);
  }
  return {
    name,
    samples: samplesPerApiCall,
    p50_ms: percentile(durations, 0.5),
    p95_ms: percentile(durations, 0.95),
    max_ms: Number(Math.max(...durations).toFixed(1)),
    state: "passed",
    sample: lastBody,
  };
}

async function timeInterpretation(interpreter, {
  name,
  text,
  componentCatalog,
  ceilingMs,
  expectedEndpoint,
}) {
  const startedAt = performance.now();
  const result = await interpreter.interpret({
    merchantId,
    text,
    source: "telegram_text",
    sourceLanguage: null,
    evidenceUri: "qa://telegram-text-smoke",
    occurredAt: `${businessDate}T10:00:00+08:00`,
    componentCatalog,
  });
  const durationMs = Number((performance.now() - startedAt).toFixed(1));
  const operations = Array.isArray(result) ? result : [result];
  assert(
    operations.some(({ endpoint_id: endpointId }) =>
      endpointId === expectedEndpoint
    ),
    `${name} did not resolve to ${expectedEndpoint}`,
  );
  assert(
    durationMs <= ceilingMs,
    `${name} exceeded ${ceilingMs} ms: ${durationMs} ms`,
  );
  return {
    name,
    duration_ms: durationMs,
    ceiling_ms: ceilingMs,
    endpoint_ids: operations.map(({ endpoint_id: endpointId }) => endpointId),
    state: "passed",
  };
}

async function main() {
  required(merchantId, "PASARAI_MERCHANT_ID");
  required(telegramBotToken, "TELEGRAM_BOT_TOKEN");

  await timedJson("health warm-up", apiUrl("/healthz"));
  const healthDurations = [];
  let healthBody;
  for (let index = 0; index < samplesPerApiCall; index += 1) {
    const result = await timedJson("health", apiUrl("/healthz"));
    healthDurations.push(result.durationMs);
    healthBody = result.body;
  }
  assert(healthBody?.status === "ok", "health status is not ok");
  assert(
    Object.values(healthBody.dependencies ?? {}).every(
      (status) => status === "ok",
    ),
    "one or more configured dependencies are not ok",
  );
  const health = {
    name: "health",
    samples: samplesPerApiCall,
    p50_ms: percentile(healthDurations, 0.5),
    p95_ms: percentile(healthDurations, 0.95),
    max_ms: Number(Math.max(...healthDurations).toFixed(1)),
    state: "passed",
    sample: healthBody,
  };

  const catalog = await sampleApi({
    name: "component catalog",
    path: "/api/v1/catalog/components",
    query: {
      merchant_id: merchantId,
      as_of: businessDate,
    },
    validate(body) {
      assert(body?.components?.length > 0, "component catalog is empty");
    },
  });
  const componentCatalog = catalog.sample.components.map((component) => ({
    id: component.component_id,
    name: component.name,
  }));

  const apiCalls = [
    health,
    catalog,
    await sampleApi({
      name: "daily summary",
      path: "/api/v1/summary/daily",
      query: {
        merchant_id: merchantId,
        date: businessDate,
        product_id: productId,
      },
      validate(body) {
        assert(body?.date === businessDate, "daily summary date drifted");
      },
    }),
    await sampleApi({
      name: "receipt reviews",
      path: "/api/v1/receipts/reviews",
      query: { merchant_id: merchantId },
    }),
    await sampleApi({
      name: "analytics overview",
      path: "/api/v1/analytics/overview",
      query: {
        merchant_id: merchantId,
        product_id: productId,
        from: businessDate,
        to: businessDate,
      },
    }),
    await sampleApi({
      name: "analytics activity",
      path: "/api/v1/analytics/activity",
      query: {
        merchant_id: merchantId,
        product_id: productId,
        from: businessDate,
        to: businessDate,
      },
    }),
    await sampleApi({
      name: "analytics forecast",
      path: "/api/v1/analytics/forecast",
      query: {
        merchant_id: merchantId,
        product_id: productId,
        as_of: businessDate,
      },
    }),
    await sampleApi({
      name: "price simulation",
      method: "POST",
      path: "/api/v1/simulations/price",
      payload: {
        merchant_id: merchantId,
        product_id: productId,
        quantity: "35",
        proposed_unit_price_rm: "5.50",
        as_of: businessDate,
      },
      validate(body) {
        assert(body?.gross_profit_rm, "price simulation returned no result");
      },
    }),
    await sampleApi({
      name: "price-volume scenarios",
      method: "POST",
      path: "/api/v1/scenarios/price-volume",
      payload: {
        merchant_id: merchantId,
        product_id: productId,
        as_of: businessDate,
        center_price_rm: "5.00",
        center_quantity: "40",
        price_step_pct: "10",
        quantity_step_pct: "10",
      },
      validate(body) {
        assert(
          body?.scenarios?.length === 9,
          "price-volume scenario grid is incomplete",
        );
      },
    }),
  ];
  for (const call of apiCalls) {
    assert(call.p95_ms <= 5_000, `${call.name} exceeded the 5 s p95 gate`);
  }

  const telegramCalls = [];
  for (const method of ["getMe", "getWebhookInfo"]) {
    const result = await timedJson(
      `Telegram ${method}`,
      `https://api.telegram.org/bot${telegramBotToken}/${method}`,
    );
    assert(result.body?.ok === true, `Telegram ${method} returned ok=false`);
    telegramCalls.push({
      name: method,
      duration_ms: Number(result.durationMs.toFixed(1)),
      state: "passed",
      ...(method === "getMe"
        ? { bot_username: result.body.result?.username }
        : {
            pending_update_count:
              result.body.result?.pending_update_count ?? null,
            last_error_message:
              result.body.result?.last_error_message ?? null,
          }),
    });
  }

  const interpreter = createMessageInterpreter({ environment: process.env });
  const interpreterCalls = [
    await timeInterpretation(interpreter, {
      name: "clear sale fast path",
      text: "Today I sold 40 nasi lemak biasa at RM5 each.",
      componentCatalog,
      ceilingMs: 100,
      expectedEndpoint: "sales.create",
    }),
    await timeInterpretation(interpreter, {
      name: "clear cost-change fast path",
      text: "Packaging naik RM2 untuk 50 bekas.",
      componentCatalog,
      ceilingMs: 100,
      expectedEndpoint: "cost-changes.create",
    }),
    await timeInterpretation(interpreter, {
      name: "complete purchase fast path",
      text:
        "Bought 2 trays telur at RM12 per tray of 30 from Sinar Borong.",
      componentCatalog,
      ceilingMs: 100,
      expectedEndpoint: "purchase-intake.upsert",
    }),
    await timeInterpretation(interpreter, {
      name: "Qwen-backed price simulation",
      text: "What if I sell 35 nasi lemak biasa at RM5.50?",
      componentCatalog,
      ceilingMs: 15_000,
      expectedEndpoint: "price-simulation.create",
    }),
  ];

  const report = {
    generated_at: new Date().toISOString(),
    api_base_url: apiBaseUrl,
    business_date: businessDate,
    merchant_id: merchantId,
    product_id: productId,
    mutates_business_data: false,
    api_calls: apiCalls.map(({ sample, ...call }) => call),
    telegram_calls: telegramCalls,
    interpreter_calls: interpreterCalls,
    state: "passed",
  };
  const reportDirectory = resolve(".tmp/qa-demo");
  const reportPath = resolve(
    reportDirectory,
    "telegram-text-smoke-report.json",
  );
  await mkdir(reportDirectory, { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  console.table(apiCalls.map(({ name, p50_ms, p95_ms, max_ms }) => ({
    check: name,
    p50_ms,
    p95_ms,
    max_ms,
  })));
  console.table(telegramCalls.map(({ name, duration_ms: durationMs }) => ({
    check: `Telegram ${name}`,
    duration_ms: durationMs,
  })));
  console.table(interpreterCalls.map((call) => ({
    check: call.name,
    duration_ms: call.duration_ms,
    ceiling_ms: call.ceiling_ms,
  })));
  console.log(`QA report: ${reportPath}`);
}

await main();
