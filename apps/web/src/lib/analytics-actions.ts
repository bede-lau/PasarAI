"use client";

import type {
  AnalyticsActivityResponse,
  AnalyticsDayStatusRequest,
  AnalyticsDayStatusResponse,
  AnalyticsOverviewResponse,
  PriceVolumeScenarioRequest,
  PriceVolumeScenarioResponse
} from "@pasarai/contracts/v1";

async function responsePayload<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => null) as {
    error?: unknown;
    message?: unknown;
  } | null;
  if (!response.ok) {
    const message =
      typeof payload?.message === "string"
        ? payload.message
        : typeof payload?.error === "string"
          ? payload.error
          : `Request returned HTTP ${response.status}.`;
    throw new Error(message);
  }
  return payload as T;
}

export async function getAnalyticsOverview({
  from,
  signal,
  to
}: {
  from: string;
  signal?: AbortSignal;
  to: string;
}): Promise<AnalyticsOverviewResponse> {
  const params = new URLSearchParams({ from, to });
  const response = await fetch(
    `/api/pasarai/analytics/overview?${params.toString()}`,
    { signal }
  );
  return responsePayload<AnalyticsOverviewResponse>(response);
}

export async function getAnalyticsActivity({
  from,
  signal,
  to
}: {
  from: string;
  signal?: AbortSignal;
  to: string;
}): Promise<AnalyticsActivityResponse> {
  const params = new URLSearchParams({ from, to });
  const response = await fetch(
    `/api/pasarai/analytics/activity?${params.toString()}`,
    { signal }
  );
  return responsePayload<AnalyticsActivityResponse>(response);
}

export async function postPriceVolumeScenario(
  request: PriceVolumeScenarioRequest
): Promise<PriceVolumeScenarioResponse> {
  const response = await fetch("/api/pasarai/scenarios/price-volume", {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(request)
  });
  return responsePayload<PriceVolumeScenarioResponse>(response);
}

export async function postAnalyticsDayStatus(
  request: AnalyticsDayStatusRequest
): Promise<AnalyticsDayStatusResponse> {
  const response = await fetch("/api/pasarai/analytics/day-status", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key":
        `day-status:${request.product_id}:${request.date}:${request.business_day_state}:${request.sold_out_state}`
    },
    body: JSON.stringify(request)
  });
  return responsePayload<AnalyticsDayStatusResponse>(response);
}
