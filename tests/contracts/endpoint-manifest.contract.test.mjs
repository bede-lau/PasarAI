import assert from "node:assert/strict";
import { test } from "node:test";
import { endpointManifest, schemas } from "@pasarai/contracts/v1";

const endpoints = Object.fromEntries(endpointManifest.endpoints.map((endpoint) => [endpoint.id, endpoint]));

test("locks merchant-bound API and Telegram webhook authentication boundaries", () => {
  assert.deepEqual(endpointManifest.authentication, {
    scheme: "bearer",
    merchant_bound: true,
    required_for_prefix: "/api/v1/",
    telegram_webhook_path: "/webhooks/telegram",
    telegram_authentication: "X-Telegram-Bot-Api-Secret-Token",
    google_drive_webhook_path: "/webhooks/google-drive",
    google_drive_authentication: "X-Goog-Channel-Token",
  });
});

test("locks the public endpoint identity, path, and method", () => {
  assert.deepEqual(
    endpointManifest.endpoints.map(({ id, path, method }) => ({ id, path, method })),
    [
      { id: "sales.create", path: "/api/v1/sales", method: "POST" },
      { id: "costs.create", path: "/api/v1/costs", method: "POST" },
      { id: "purchase-intake.upsert", path: "/api/v1/purchase-intakes", method: "POST" },
      { id: "purchase-intake.confirm", path: "/api/v1/purchase-intakes/confirm", method: "POST" },
      { id: "cost-changes.create", path: "/api/v1/cost-changes", method: "POST" },
      { id: "price-simulation.create", path: "/api/v1/simulations/price", method: "POST" },
      { id: "price-volume-scenario.create", path: "/api/v1/scenarios/price-volume", method: "POST" },
      { id: "corrections.create", path: "/api/v1/corrections", method: "POST" },
      { id: "receipt-upload.create", path: "/api/v1/receipts/extract", method: "POST" },
      { id: "receipt-confirm.create", path: "/api/v1/receipts/confirm", method: "POST" },
      { id: "receipt-review.upsert", path: "/api/v1/receipts/reviews", method: "POST" },
      { id: "receipt-reviews.get", path: "/api/v1/receipts/reviews", method: "GET" },
      { id: "daily-summary.get", path: "/api/v1/summary/daily", method: "GET" },
      { id: "analytics-overview.get", path: "/api/v1/analytics/overview", method: "GET" },
      { id: "analytics-activity.get", path: "/api/v1/analytics/activity", method: "GET" },
      { id: "analytics-forecast.get", path: "/api/v1/analytics/forecast", method: "GET" },
      { id: "analytics-day-status.create", path: "/api/v1/analytics/day-status", method: "POST" },
      { id: "component-catalog.get", path: "/api/v1/catalog/components", method: "GET" },
      { id: "evidence.get", path: "/api/v1/evidence", method: "GET" },
      { id: "google-sheets.status", path: "/api/v1/integrations/google-sheets", method: "GET" },
      { id: "google-sheets.oauth-start", path: "/api/v1/integrations/google-sheets/oauth/start", method: "POST" },
      { id: "google-sheets.oauth-complete", path: "/api/v1/integrations/google-sheets/oauth/complete", method: "POST" },
      { id: "google-sheets.export", path: "/api/v1/integrations/google-sheets/export", method: "POST" },
      { id: "google-sheets.import", path: "/api/v1/integrations/google-sheets/import", method: "POST" },
      { id: "google-sheets.reconcile", path: "/api/v1/integrations/google-sheets/reconcile", method: "POST" },
      { id: "google-sheets.sync-mode", path: "/api/v1/integrations/google-sheets/sync-mode", method: "POST" },
      { id: "google-sheets.disconnect", path: "/api/v1/integrations/google-sheets/disconnect", method: "POST" },
    ],
  );
});

test("requires idempotency for every mutating endpoint", () => {
  const mutations = endpointManifest.endpoints.filter(({ mutation }) => mutation);
  assert.ok(mutations.length > 0);
  for (const endpoint of mutations) {
    assert.equal(endpoint.read_only, false, endpoint.id);
    assert.equal(endpoint.idempotency_required, true, endpoint.id);
    assert.deepEqual(endpoint.required_headers, ["Idempotency-Key"], endpoint.id);
  }
  for (const id of ["sales.create", "costs.create", "purchase-intake.upsert", "cost-changes.create", "corrections.create", "receipt-upload.create", "receipt-confirm.create", "receipt-review.upsert"]) {
    assert.equal(endpoints[id].evidence_required, true, id);
  }
  assert.equal(endpoints["purchase-intake.confirm"].evidence_required, false);
  assert.equal(endpoints["analytics-day-status.create"].evidence_required, false);
});

test("identifies a missing Idempotency-Key on mutating requests", () => {
  for (const { id, required_headers: requiredHeaders } of endpointManifest.endpoints.filter(({ mutation }) => mutation)) {
    const suppliedHeaders = new Set();
    const missingHeaders = requiredHeaders.filter((header) => !suppliedHeaders.has(header));
    assert.deepEqual(missingHeaders, ["Idempotency-Key"], id);
  }
});

test("keeps simulation and reporting reads non-idempotent", () => {
  const reads = endpointManifest.endpoints.filter(({ mutation }) => !mutation);
  assert.ok(reads.length > 0);
  for (const endpoint of reads) {
    assert.equal(endpoint.read_only, true, endpoint.id);
    assert.equal(endpoint.idempotency_required, false, endpoint.id);
    assert.deepEqual(endpoint.required_headers, [], endpoint.id);
  }
});

test("locks public response states per endpoint", () => {
  assert.deepEqual(endpoints["sales.create"].response_states, ["committed", "clarification_required", "rejected"]);
  assert.deepEqual(endpoints["costs.create"].response_states, ["committed", "clarification_required", "rejected"]);
  assert.deepEqual(endpoints["purchase-intake.upsert"].response_states, ["clarification_required", "ready_for_confirmation"]);
  assert.deepEqual(endpoints["purchase-intake.confirm"].response_states, ["committed", "clarification_required", "rejected"]);
  assert.deepEqual(endpoints["cost-changes.create"].response_states, ["committed", "clarification_required", "rejected"]);
  assert.deepEqual(endpoints["corrections.create"].response_states, ["committed"]);
  assert.deepEqual(endpoints["receipt-upload.create"].response_states, ["ready_for_review", "clarification_required", "review_required", "rejected"]);
  assert.deepEqual(endpoints["receipt-confirm.create"].response_states, ["committed", "clarification_required", "rejected"]);
  assert.deepEqual(endpoints["receipt-review.upsert"].response_states, ["saved", "archived"]);
  assert.deepEqual(endpoints["receipt-reviews.get"].response_states, []);
  assert.deepEqual(endpoints["price-simulation.create"].response_states, []);
  assert.deepEqual(endpoints["price-volume-scenario.create"].response_states, []);
  assert.deepEqual(endpoints["daily-summary.get"].response_states, []);
  assert.deepEqual(endpoints["analytics-overview.get"].response_states, []);
  assert.deepEqual(endpoints["analytics-activity.get"].response_states, []);
  assert.deepEqual(endpoints["analytics-forecast.get"].response_states, ["unavailable", "shadow", "ready"]);
  assert.deepEqual(endpoints["analytics-day-status.create"].response_states, ["committed"]);
  assert.deepEqual(endpoints["component-catalog.get"].response_states, []);
  assert.deepEqual(endpoints["google-sheets.status"].response_states, ["not_connected", "connected", "error"]);
  assert.deepEqual(endpoints["google-sheets.oauth-start"].response_states, []);
  assert.deepEqual(endpoints["google-sheets.oauth-complete"].response_states, ["connected", "error"]);
  assert.deepEqual(endpoints["google-sheets.export"].response_states, ["completed"]);
  assert.deepEqual(endpoints["google-sheets.import"].response_states, ["completed"]);
  assert.deepEqual(endpoints["google-sheets.reconcile"].response_states, ["completed"]);
  assert.deepEqual(endpoints["google-sheets.sync-mode"].response_states, ["connected", "error"]);
  assert.deepEqual(endpoints["google-sheets.disconnect"].response_states, ["disconnected"]);
});

test("references only schemas exposed by the public v1 contract entry point", () => {
  for (const endpoint of endpointManifest.endpoints) {
    if (endpoint.request_schema) assert.ok(schemas[endpoint.request_schema], endpoint.request_schema);
    if (endpoint.response_schema) {
      assert.ok(schemas[endpoint.response_schema], endpoint.response_schema);
    }
  }
});

test("keeps corrections append-only", () => {
  assert.equal(endpoints["corrections.create"].append_only, true);
});

test("keeps browser receipt upload out of the ElevenLabs tool catalog", () => {
  assert.equal(endpoints["receipt-upload.create"].conversation_tool, false);
  assert.equal(endpoints["receipt-confirm.create"].conversation_tool, false);
  assert.equal(endpoints["receipt-review.upsert"].conversation_tool, false);
  assert.equal(endpoints["receipt-reviews.get"].conversation_tool, false);
  assert.equal(endpoints["purchase-intake.upsert"].conversation_tool, false);
  assert.equal(endpoints["purchase-intake.confirm"].conversation_tool, false);
  assert.equal(endpoints["component-catalog.get"].conversation_tool, false);
  assert.equal(endpoints["price-volume-scenario.create"].conversation_tool, false);
  assert.equal(endpoints["analytics-overview.get"].conversation_tool, false);
  assert.equal(endpoints["analytics-activity.get"].conversation_tool, false);
  assert.equal(endpoints["analytics-forecast.get"].conversation_tool, false);
  assert.equal(endpoints["analytics-day-status.create"].conversation_tool, false);
  assert.equal(endpoints["evidence.get"].conversation_tool, false);
  assert.equal(endpoints["google-sheets.status"].conversation_tool, false);
  assert.equal(endpoints["google-sheets.oauth-start"].conversation_tool, false);
  assert.equal(endpoints["google-sheets.oauth-complete"].conversation_tool, false);
  assert.equal(endpoints["google-sheets.export"].conversation_tool, false);
  assert.equal(endpoints["google-sheets.import"].conversation_tool, false);
  assert.equal(endpoints["google-sheets.reconcile"].conversation_tool, false);
  assert.equal(endpoints["google-sheets.sync-mode"].conversation_tool, false);
  assert.equal(endpoints["google-sheets.disconnect"].conversation_tool, false);
  for (const id of [
    "sales.create",
    "costs.create",
    "cost-changes.create",
    "price-simulation.create",
    "corrections.create",
    "daily-summary.get",
  ]) {
    assert.equal(endpoints[id].conversation_tool, true, id);
  }
});
