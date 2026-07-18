"use client";

import type {
  PriceSimulationRequest,
  PriceSimulationResponse
} from "@pasarai/contracts/v1";

type ErrorPayload = {
  error?: unknown;
  message?: unknown;
};

const invalidInputMessage =
  "Enter a non-negative quantity and a price with two decimal places, such as 40 and 5.00.";

function normalizeRequest(
  request: PriceSimulationRequest
): PriceSimulationRequest {
  const quantity = request.quantity.trim();
  const price = request.proposed_unit_price_rm.trim();
  const priceMatch = /^(0|[1-9][0-9]*)(?:\.([0-9]{0,2}))?$/.exec(price);

  if (
    !/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(quantity)
    || !priceMatch
  ) {
    throw new Error(invalidInputMessage);
  }

  return {
    ...request,
    quantity,
    proposed_unit_price_rm: `${priceMatch[1]}.${(priceMatch[2] ?? "").padEnd(2, "0")}`
  };
}

function readableText(value: unknown) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || /^[a-z0-9]+(?:_[a-z0-9]+)+$/.test(text)) return null;
  return text;
}

function failureMessage(status: number, payload: ErrorPayload | null) {
  const serverExplanation =
    readableText(payload?.message) ?? readableText(payload?.error);

  switch (status) {
    case 400:
      return invalidInputMessage;
    case 401:
      return "Your session is missing or expired. Refresh the page and sign in again.";
    case 403:
      return serverExplanation
        ?? "This simulation request was blocked because it did not match your merchant session.";
    case 404:
      return serverExplanation
        ?? "The product or cost profile needed for this simulation could not be found.";
    case 429:
      return "Too many simulations were requested. Wait a moment and try again.";
    case 500:
      return serverExplanation
        ?? "The simulation service encountered an internal problem. Try again in a moment.";
    case 502:
      return serverExplanation
        ?? "The simulation service returned data that PasarAI could not verify.";
    case 503:
      return serverExplanation
        ?? "The simulation service is temporarily unavailable. Try again in a moment.";
    default:
      return serverExplanation
        ?? `The simulation failed because the service returned HTTP ${status}.`;
  }
}

export async function postPriceSimulation(
  request: PriceSimulationRequest
): Promise<PriceSimulationResponse> {
  const normalizedRequest = normalizeRequest(request);
  let response: Response;
  try {
    response = await fetch("/api/pasarai/simulations/price", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify(normalizedRequest)
    });
  } catch {
    throw new Error(
      "The simulation service could not be reached. Check your connection and try again."
    );
  }

  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      failureMessage(response.status, payload as ErrorPayload | null)
    );
  }
  if (!payload) {
    throw new Error(
      "The simulation service returned a response that the browser could not read."
    );
  }

  return payload as PriceSimulationResponse;
}
