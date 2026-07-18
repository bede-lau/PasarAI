import {
  validateEndpointInvocation,
} from "@pasarai/contracts/v1";

function json(body, status = 200) {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
    },
  });
}

async function requestJson(request) {
  try {
    return await request.json();
  } catch {
    throw new TypeError("Request body must be valid JSON");
  }
}

async function googleSheetsMutation(request, endpointId) {
  const payload = await requestJson(request);
  const headers = Object.fromEntries(request.headers);
  const errors = validateEndpointInvocation({
    endpoint_id: endpointId,
    headers,
    payload,
  });
  const idempotencyKey = request.headers.get("idempotency-key")?.trim();
  if (request.headers.has("idempotency-key") && !idempotencyKey) {
    errors.unshift("Idempotency-Key must not be empty");
  }
  if (errors.length) {
    throw new TypeError(errors.join("; "));
  }
  return { payload, idempotencyKey };
}

async function dependencyHealth(dependencies) {
  const states = {};
  let healthy = true;

  for (const [name, dependency] of Object.entries(dependencies)) {
    try {
      const result = await dependency.healthCheck();
      const status = result?.status === "ok" ? "ok" : "unavailable";
      states[name] = status;
      if (status !== "ok") healthy = false;
    } catch {
      states[name] = "unavailable";
      healthy = false;
    }
  }
  return {
    status: healthy ? "ok" : "degraded",
    dependencies: states,
  };
}

async function authenticateRequest(request, authenticate) {
  if (typeof authenticate !== "function") {
    return {
      response: json({
        error: "auth_not_configured",
        message: "API authentication is not configured.",
      }, 503),
    };
  }
  const result = await authenticate(request);
  if (!result?.authenticated || !result.merchantId) {
    return {
      response: json({
        error: "unauthorized",
        message: "A valid bearer credential is required.",
      }, 401),
    };
  }
  return { merchantId: result.merchantId };
}

function merchantGuard(authorizedMerchantId, suppliedMerchantId) {
  if (authorizedMerchantId === suppliedMerchantId) return null;
  return json({
    error: "forbidden",
    message: "The authenticated credential cannot access this merchant.",
  }, 403);
}

export function createApiApp({
  service,
  dependencies = {},
  authenticate,
  telegramIngestion,
  receiptIngestion,
  evidenceStore,
  googleSheetsIntegration,
}) {
  if (!service) throw new Error("service is required");

  return {
    async fetch(request) {
      const url = new URL(request.url);

      try {
        if (request.method === "GET" && url.pathname === "/healthz") {
          const body = await dependencyHealth(dependencies);
          return json(body, body.status === "ok" ? 200 : 503);
        }

        if (
          request.method === "POST"
          && url.pathname === "/webhooks/telegram"
        ) {
          if (!telegramIngestion) {
            return json({
              error: "integration_unavailable",
              message: "Telegram ingestion is not configured.",
            }, 503);
          }
          const result = await telegramIngestion.handleWebhook({
            headers: request.headers,
            body: await requestJson(request),
          });
          return json(result.body, result.status);
        }

        if (
          request.method === "POST"
          && url.pathname === "/webhooks/google-drive"
        ) {
          if (!googleSheetsIntegration?.handleDriveNotification) {
            return json({
              error: "integration_unavailable",
              message: "Google Sheets synchronization is not configured.",
            }, 503);
          }
          const result = await googleSheetsIntegration.handleDriveNotification({
            headers: request.headers,
          });
          if (result.status === 204) {
            return new Response(null, { status: 204 });
          }
          return json(result.body, result.status);
        }

        const auth = url.pathname.startsWith("/api/v1/")
          ? await authenticateRequest(request, authenticate)
          : null;
        if (auth?.response) return auth.response;

        if (
          request.method === "GET"
          && url.pathname === "/api/v1/evidence"
        ) {
          if (!evidenceStore?.get) {
            return json({
              error: "integration_unavailable",
              message: "Evidence retrieval is not configured.",
            }, 503);
          }
          const uri = url.searchParams.get("uri");
          if (!uri) {
            return json({
              error: "invalid_request",
              message: "uri query parameter is required.",
            }, 400);
          }
          try {
            const evidence = await evidenceStore.get({
              uri,
              merchantId: auth.merchantId,
            });
            return new Response(evidence.bytes, {
              headers: {
                "cache-control": "private, no-store",
                "content-type": evidence.contentType,
              },
            });
          } catch {
            return json({ error: "evidence_not_found" }, 404);
          }
        }

        if (
          request.method === "GET"
          && url.pathname === "/api/v1/integrations/google-sheets"
        ) {
          if (!googleSheetsIntegration) {
            return json({
              error: "integration_unavailable",
              message: "Google Sheets integration is not configured.",
            }, 503);
          }
          return json(await googleSheetsIntegration.status({
            merchantId: auth.merchantId,
          }));
        }

        if (
          request.method === "POST"
          && url.pathname
            === "/api/v1/integrations/google-sheets/oauth/start"
        ) {
          if (!googleSheetsIntegration) {
            return json({
              error: "integration_unavailable",
              message: "Google Sheets integration is not configured.",
            }, 503);
          }
          const { payload, idempotencyKey } = await googleSheetsMutation(
            request,
            "google-sheets.oauth-start",
          );
          return json(await googleSheetsIntegration.startOAuth({
            merchantId: auth.merchantId,
            redirectUri: payload.redirect_uri,
            spreadsheetId: payload.spreadsheet_id,
          }, { idempotencyKey }));
        }

        if (
          request.method === "POST"
          && url.pathname
            === "/api/v1/integrations/google-sheets/oauth/complete"
        ) {
          if (!googleSheetsIntegration) {
            return json({
              error: "integration_unavailable",
              message: "Google Sheets integration is not configured.",
            }, 503);
          }
          const { payload, idempotencyKey } = await googleSheetsMutation(
            request,
            "google-sheets.oauth-complete",
          );
          return json(await googleSheetsIntegration.completeOAuth({
            merchantId: auth.merchantId,
            code: payload.code,
            state: payload.state,
            redirectUri: payload.redirect_uri,
          }, { idempotencyKey }));
        }

        if (
          request.method === "POST"
          && url.pathname === "/api/v1/integrations/google-sheets/export"
        ) {
          if (!googleSheetsIntegration) {
            return json({
              error: "integration_unavailable",
              message: "Google Sheets integration is not configured.",
            }, 503);
          }
          const { payload, idempotencyKey } = await googleSheetsMutation(
            request,
            "google-sheets.export",
          );
          return json(await googleSheetsIntegration.exportMetrics({
            merchantId: auth.merchantId,
            dates: payload.dates,
          }, { idempotencyKey }));
        }

        if (
          request.method === "POST"
          && url.pathname === "/api/v1/integrations/google-sheets/import"
        ) {
          if (!googleSheetsIntegration) {
            return json({
              error: "integration_unavailable",
              message: "Google Sheets integration is not configured.",
            }, 503);
          }
          const { idempotencyKey } = await googleSheetsMutation(
            request,
            "google-sheets.import",
          );
          return json(await googleSheetsIntegration.importInputs({
            merchantId: auth.merchantId,
          }, { idempotencyKey }));
        }

        if (
          request.method === "POST"
          && url.pathname === "/api/v1/integrations/google-sheets/reconcile"
        ) {
          if (!googleSheetsIntegration) {
            return json({
              error: "integration_unavailable",
              message: "Google Sheets integration is not configured.",
            }, 503);
          }
          const { idempotencyKey } = await googleSheetsMutation(
            request,
            "google-sheets.reconcile",
          );
          return json(await googleSheetsIntegration.reconcile({
            merchantId: auth.merchantId,
          }, { idempotencyKey }));
        }

        if (
          request.method === "POST"
          && url.pathname === "/api/v1/integrations/google-sheets/sync-mode"
        ) {
          if (!googleSheetsIntegration) {
            return json({
              error: "integration_unavailable",
              message: "Google Sheets integration is not configured.",
            }, 503);
          }
          const { payload, idempotencyKey } = await googleSheetsMutation(
            request,
            "google-sheets.sync-mode",
          );
          return json(await googleSheetsIntegration.configureSyncMode({
            merchantId: auth.merchantId,
            syncMode: payload.sync_mode,
          }, { idempotencyKey }));
        }

        if (
          request.method === "POST"
          && url.pathname
            === "/api/v1/integrations/google-sheets/disconnect"
        ) {
          if (!googleSheetsIntegration) {
            return json({
              error: "integration_unavailable",
              message: "Google Sheets integration is not configured.",
            }, 503);
          }
          const { idempotencyKey } = await googleSheetsMutation(
            request,
            "google-sheets.disconnect",
          );
          return json(await googleSheetsIntegration.disconnect({
            merchantId: auth.merchantId,
          }, { idempotencyKey }));
        }

        if (request.method === "POST" && url.pathname === "/api/v1/sales") {
          const payload = await requestJson(request);
          const forbidden = merchantGuard(auth.merchantId, payload.merchant_id);
          if (forbidden) return forbidden;
          const body = await service.recordSale(payload, {
            idempotencyKey: request.headers.get("idempotency-key"),
          });
          return json(body, body.state === "rejected" ? 400 : 200);
        }

        if (request.method === "POST" && url.pathname === "/api/v1/costs") {
          const payload = await requestJson(request);
          const forbidden = merchantGuard(auth.merchantId, payload.merchant_id);
          if (forbidden) return forbidden;
          const body = await service.recordCost(payload, {
            idempotencyKey: request.headers.get("idempotency-key"),
          });
          return json(body, body.state === "rejected" ? 400 : 200);
        }

        if (
          request.method === "POST"
          && url.pathname === "/api/v1/purchase-intakes"
        ) {
          const payload = await requestJson(request);
          const forbidden = merchantGuard(auth.merchantId, payload.merchant_id);
          if (forbidden) return forbidden;
          const body = await service.upsertPurchaseIntake(payload, {
            idempotencyKey: request.headers.get("idempotency-key"),
          });
          return json(body, body.state === "rejected" ? 400 : 200);
        }

        if (
          request.method === "POST"
          && url.pathname === "/api/v1/purchase-intakes/confirm"
        ) {
          const payload = await requestJson(request);
          const forbidden = merchantGuard(auth.merchantId, payload.merchant_id);
          if (forbidden) return forbidden;
          const body = await service.confirmPurchaseIntake(payload, {
            idempotencyKey: request.headers.get("idempotency-key"),
          });
          return json(body, body.state === "rejected" ? 400 : 200);
        }

        if (
          request.method === "POST"
          && url.pathname === "/api/v1/cost-changes"
        ) {
          const payload = await requestJson(request);
          const forbidden = merchantGuard(auth.merchantId, payload.merchant_id);
          if (forbidden) return forbidden;
          const body = await service.recordCostChange(payload, {
            idempotencyKey: request.headers.get("idempotency-key"),
          });
          return json(body, body.state === "rejected" ? 400 : 200);
        }

        if (
          request.method === "POST"
          && url.pathname === "/api/v1/simulations/price"
        ) {
          const payload = await requestJson(request);
          const forbidden = merchantGuard(auth.merchantId, payload.merchant_id);
          if (forbidden) return forbidden;
          return json(await service.simulatePrice(payload));
        }

        if (
          request.method === "POST"
          && url.pathname === "/api/v1/scenarios/price-volume"
        ) {
          const payload = await requestJson(request);
          const forbidden = merchantGuard(auth.merchantId, payload.merchant_id);
          if (forbidden) return forbidden;
          return json(await service.simulatePriceVolume(payload));
        }

        if (
          request.method === "POST"
          && url.pathname === "/api/v1/analytics/day-status"
        ) {
          const payload = await requestJson(request);
          const forbidden = merchantGuard(auth.merchantId, payload.merchant_id);
          if (forbidden) return forbidden;
          const body = await service.recordAnalyticsDayStatus(payload, {
            idempotencyKey: request.headers.get("idempotency-key"),
          });
          return json(body, body.state === "rejected" ? 400 : 200);
        }

        if (
          request.method === "POST"
          && url.pathname === "/api/v1/corrections"
        ) {
          const payload = await requestJson(request);
          const forbidden = merchantGuard(auth.merchantId, payload.merchant_id);
          if (forbidden) return forbidden;
          const body = await service.recordCorrection(
            payload,
            {
              idempotencyKey: request.headers.get("idempotency-key"),
            },
          );
          return json(body, body.state === "rejected" ? 400 : 200);
        }

        if (
          request.method === "POST"
          && url.pathname === "/api/v1/receipts/extract"
        ) {
          if (!receiptIngestion) {
            return json({
              error: "integration_unavailable",
              message: "Receipt extraction is not configured.",
            }, 503);
          }
          const payload = await requestJson(request);
          const forbidden = merchantGuard(auth.merchantId, payload.merchant_id);
          if (forbidden) return forbidden;
          const body = await receiptIngestion.extract(payload, {
            idempotencyKey: request.headers.get("idempotency-key"),
          });
          return json(body, body.state === "rejected" ? 422 : 200);
        }

        if (
          request.method === "POST"
          && url.pathname === "/api/v1/receipts/confirm"
        ) {
          const payload = await requestJson(request);
          const forbidden = merchantGuard(auth.merchantId, payload.merchant_id);
          if (forbidden) return forbidden;
          const body = await service.confirmReceipt(payload, {
            idempotencyKey: request.headers.get("idempotency-key"),
          });
          return json(body, body.state === "rejected" ? 400 : 200);
        }

        if (
          request.method === "POST"
          && url.pathname === "/api/v1/receipts/reviews"
        ) {
          const payload = await requestJson(request);
          const forbidden = merchantGuard(auth.merchantId, payload.merchant_id);
          if (forbidden) return forbidden;
          const body = await service.saveReceiptReview(payload, {
            idempotencyKey: request.headers.get("idempotency-key"),
          });
          return json(body, body.state === "rejected" ? 400 : 200);
        }

        if (
          request.method === "GET"
          && url.pathname === "/api/v1/receipts/reviews"
        ) {
          const merchantId = url.searchParams.get("merchant_id");
          if (!merchantId) {
            return json({
              error: "invalid_request",
              message: "merchant_id query parameter is required",
            }, 400);
          }
          const forbidden = merchantGuard(auth.merchantId, merchantId);
          if (forbidden) return forbidden;
          return json(await service.getReceiptReviews({ merchantId }));
        }

        if (
          request.method === "GET"
          && url.pathname === "/api/v1/summary/daily"
        ) {
          const merchantId = url.searchParams.get("merchant_id");
          const date = url.searchParams.get("date");
          const productId = url.searchParams.get("product_id") ?? undefined;
          if (!merchantId || !date) {
            return json({
              error: "invalid_request",
              message: "merchant_id and date query parameters are required",
            }, 400);
          }
          const forbidden = merchantGuard(auth.merchantId, merchantId);
          if (forbidden) return forbidden;
          return json(await service.getDailySummary({
            merchantId,
            date,
            productId,
          }));
        }

        if (
          request.method === "GET"
          && url.pathname === "/api/v1/analytics/overview"
        ) {
          const merchantId = url.searchParams.get("merchant_id");
          const productId = url.searchParams.get("product_id");
          const from = url.searchParams.get("from");
          const to = url.searchParams.get("to");
          if (!merchantId || !productId || !from || !to) {
            return json({
              error: "invalid_request",
              message:
                "merchant_id, product_id, from and to query parameters are required",
            }, 400);
          }
          const forbidden = merchantGuard(auth.merchantId, merchantId);
          if (forbidden) return forbidden;
          return json(await service.getAnalyticsOverview({
            merchantId,
            productId,
            from,
            to,
          }));
        }

        if (
          request.method === "GET"
          && url.pathname === "/api/v1/analytics/activity"
        ) {
          const merchantId = url.searchParams.get("merchant_id");
          const productId = url.searchParams.get("product_id");
          const from = url.searchParams.get("from");
          const to = url.searchParams.get("to");
          if (!merchantId || !productId || !from || !to) {
            return json({
              error: "invalid_request",
              message:
                "merchant_id, product_id, from and to query parameters are required",
            }, 400);
          }
          const forbidden = merchantGuard(auth.merchantId, merchantId);
          if (forbidden) return forbidden;
          return json(await service.getAnalyticsActivity({
            merchantId,
            productId,
            from,
            to,
          }));
        }

        if (
          request.method === "GET"
          && url.pathname === "/api/v1/analytics/forecast"
        ) {
          const merchantId = url.searchParams.get("merchant_id");
          const productId = url.searchParams.get("product_id");
          const asOf = url.searchParams.get("as_of");
          if (!merchantId || !productId || !asOf) {
            return json({
              error: "invalid_request",
              message:
                "merchant_id, product_id and as_of query parameters are required",
            }, 400);
          }
          const forbidden = merchantGuard(auth.merchantId, merchantId);
          if (forbidden) return forbidden;
          return json(await service.getAnalyticsForecast({
            merchantId,
            productId,
            asOf,
          }));
        }

        if (
          request.method === "GET"
          && url.pathname === "/api/v1/catalog/components"
        ) {
          const merchantId = url.searchParams.get("merchant_id");
          const asOfDate = url.searchParams.get("as_of") ?? undefined;
          if (!merchantId) {
            return json({
              error: "invalid_request",
              message: "merchant_id query parameter is required",
            }, 400);
          }
          const forbidden = merchantGuard(auth.merchantId, merchantId);
          if (forbidden) return forbidden;
          return json(await service.getComponentCatalog({
            merchantId,
            asOfDate,
          }));
        }

        return json({ error: "not_found" }, 404);
      } catch (error) {
        if (error instanceof TypeError) {
          return json({ error: "invalid_request", message: error.message }, 400);
        }
        if (error?.public === true && Number.isInteger(error.status)) {
          return json({
            error: error.code,
            message: error.message,
          }, error.status);
        }
        return json({ error: "internal_error" }, 500);
      }
    },
  };
}
