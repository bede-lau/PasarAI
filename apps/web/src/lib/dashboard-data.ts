import {
  validateContract,
  type DailySummaryResponse
} from "@pasarai/contracts/v1";

import {
  configuredDashboardDate,
  resolveDashboardDate
} from "@/lib/dashboard-date";
import type { DashboardState } from "@/lib/dashboard-types";
import {
  syntheticPreviewEnabled,
  type MerchantContext
} from "@/lib/merchant";

const tones = ["egg", "sambal", "coconut", "pandan"] as const;

function dashboardLoadErrorMessage(error: unknown) {
  if (
    error instanceof TypeError
    && /fetch failed|failed to fetch|network error/i.test(error.message)
  ) {
    return "The verified data service could not be reached. "
      + "It may be offline or still starting; please retry shortly.";
  }
  if (
    error instanceof DOMException
    && (error.name === "TimeoutError" || error.name === "AbortError")
  ) {
    return "The verified data service took too long to respond. "
      + "Please retry shortly.";
  }
  return error instanceof Error
    ? error.message
    : "Daily summary could not be loaded.";
}

export async function loadDashboardState(
  merchant?: MerchantContext,
  requestedDate?: string
): Promise<DashboardState> {
  if (syntheticPreviewEnabled()) {
    const {
      getSyntheticDashboardData,
      syntheticDashboardDateRange
    } = await import("@/lib/synthetic-preview");
    const selectedDate = resolveDashboardDate(
      requestedDate,
      configuredDashboardDate(process.env.PASARAI_DASHBOARD_DATE),
      syntheticDashboardDateRange
    );
    return {
      status: "ready",
      data: getSyntheticDashboardData(selectedDate)
    };
  }

  if (!merchant) {
    return {
      status: "error",
      message: "An authenticated merchant session is required."
    };
  }

  const apiBaseUrl = process.env.PASARAI_API_BASE_URL;
  const apiBearerToken = process.env.PASARAI_API_BEARER_TOKEN;
  if (!apiBaseUrl || !apiBearerToken) {
    return {
      status: "error",
      message:
        "PASARAI_API_BASE_URL and PASARAI_API_BEARER_TOKEN are required for verified dashboard data."
    };
  }

  try {
    const reportingDate = configuredDashboardDate(
      process.env.PASARAI_DASHBOARD_DATE
    );
    const dateRange = { max: reportingDate };
    const selectedDate = resolveDashboardDate(
      requestedDate,
      reportingDate,
      dateRange
    );
    const url = new URL("/api/v1/summary/daily", apiBaseUrl);
    url.searchParams.set("merchant_id", merchant.id);
    url.searchParams.set("date", selectedDate);
    url.searchParams.set("product_id", merchant.productId);

    const response = await fetch(url, {
      cache: "no-store",
      signal: AbortSignal.timeout(60_000),
      headers: {
        accept: "application/json",
        authorization: `Bearer ${apiBearerToken}`
      }
    });

    if (response.status === 429 || response.status === 503) {
      return { status: "quota", retryAfter: "after the service resets" };
    }

    if (!response.ok) {
      return {
        status: "error",
        message: `Daily summary returned HTTP ${response.status}.`
      };
    }

    const payload: unknown = await response.json();
    const errors = validateContract("daily-summary.response", payload);
    if (errors.length > 0) {
      return {
        status: "error",
        message: "Daily summary did not match the shared v1 contract."
      };
    }
    const summary = payload as DailySummaryResponse;
    const costStack = summary.cost_stack;

    return {
      status: "ready",
      data: {
        merchant,
        summary,
        costStack: costStack
          ? {
              baselineDate:
                costStack.baseline_comparison_date
                ?? costStack.baseline_effective_date
                ?? null,
              baselineUnitCogsRm: costStack.baseline_unit_cogs_rm,
              currentUnitCogsRm: costStack.current_unit_cogs_rm,
              components: costStack.components.map((component, index) => ({
                    id: component.component_id,
                    name: component.name,
                    changeRmPerPack: component.change_rm_per_pack,
                    tone: tones[index % tones.length],
                    evidenceId: component.evidence_id
                  }))
            }
          : {
              unavailableReason:
                "Please upload an item with its price, or a receipt"
        },
        evidence: summary.evidence.map((record) => ({
          id: record.evidence_id,
          title: record.title,
          imageUrl: record.asset_uri?.startsWith("pasarai-evidence:")
            ? `/api/pasarai/evidence?uri=${encodeURIComponent(record.asset_uri)}`
            : record.asset_uri,
          receiptId: record.receipt_id,
          supplierName: record.supplier_name,
          transcript: record.transcript,
          lineItems: record.line_items.map((line) => ({
            rawName: line.raw_name,
            componentId: line.component_id,
            totalPriceRm: line.total_price_rm,
            confidence: line.confidence
          }))
        })),
        dateRange,
        provenance: "live"
      }
    };
  } catch (error) {
    return {
      status: "error",
      message: dashboardLoadErrorMessage(error)
    };
  }
}
