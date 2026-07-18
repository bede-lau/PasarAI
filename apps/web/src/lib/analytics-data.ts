import {
  type AnalyticsActivityResponse,
  type AnalyticsOverviewResponse
} from "@pasarai/contracts/v1";

import { shiftDashboardDate } from "@/lib/dashboard-date";
import type {
  DashboardAnalyticsState,
  DashboardData
} from "@/lib/dashboard-types";
import {
  syntheticDashboardDateRange,
  getSyntheticDashboardData
} from "@/lib/synthetic-preview";

function syntheticAnalytics(
  selectedDate: string,
  dashboard: DashboardData
): DashboardAnalyticsState {
  const dates: string[] = [];
  let date: string = syntheticDashboardDateRange.min;
  while (date <= selectedDate) {
    dates.push(date);
    date = shiftDashboardDate(date, 1);
  }
  const days = dates.map((day) => {
    const summary = getSyntheticDashboardData(day).summary;
    return {
      date: day,
      state: "complete" as const,
      quantity: String(Number(summary.revenue_rm) / 5),
      revenue_rm: summary.revenue_rm,
      cogs_rm: summary.cogs_rm,
      gross_profit_rm: summary.gross_profit_rm,
      gross_margin_pct: summary.gross_margin_pct,
      sold_out_state: "unknown" as const
    };
  });
  const overview: AnalyticsOverviewResponse = {
    merchant_id: dashboard.merchant.id,
    product_id: dashboard.merchant.productId,
    from: dates[0],
    to: selectedDate,
    generated_at: "2026-07-16T04:00:00.000Z",
    data_through: selectedDate,
    freshness: {
      state: "fresh",
      lag_seconds: 0,
      source_max_ingested_at: "2026-07-16T04:00:00.000Z",
      projection_version: `synthetic-v1:${selectedDate}`
    },
    completeness_coverage_pct: "100.00",
    quality_flags: [],
    days,
    alerts: Number(dashboard.summary.gross_margin_pct) < 40
      ? [{
          id: "margin-below-target",
          severity: "critical",
          title: "Gross margin is below target",
          message:
            "Today is below the 40.00% gross-margin target. Review the largest cost changes or test a price-volume scenario.",
          metric: "gross-margin",
          threshold: "40.00",
          evidence_id:
            "unavailableReason" in dashboard.costStack
              ? null
              : dashboard.costStack.components[0]?.evidenceId ?? null,
          action: "inspect_cost"
        }]
      : [],
    cost_waterfall:
      "unavailableReason" in dashboard.costStack
        ? null
        : {
            baseline_date: dashboard.costStack.baselineDate ?? null,
            baseline_unit_cogs_rm:
              dashboard.costStack.baselineUnitCogsRm,
            current_unit_cogs_rm:
              dashboard.costStack.currentUnitCogsRm,
            components: dashboard.costStack.components.map((component) => ({
              component_id: component.id,
              name: component.name,
              baseline_cost_rm_per_pack: "0.00",
              current_cost_rm_per_pack:
                Number(component.changeRmPerPack) > 0
                  ? Number(component.changeRmPerPack).toFixed(2)
                  : "0.00",
              change_rm_per_pack:
                Number(component.changeRmPerPack).toFixed(2),
              evidence_id: component.evidenceId
            }))
          }
  };
  const activity: AnalyticsActivityResponse = {
    merchant_id: dashboard.merchant.id,
    product_id: dashboard.merchant.productId,
    from: dates[0],
    to: selectedDate,
    items: [
      {
        event_id: `sale-${selectedDate}`,
        occurred_at: `${selectedDate}T12:00:00+08:00`,
        source: "telegram_text",
        type: "sale",
        state: "committed",
        title: "Sale recorded",
        evidence_uri: null,
        target_event_id: null
      },
      ...dashboard.evidence.map((record, index) => ({
        event_id: `receipt-${selectedDate}-${index + 1}`,
        occurred_at: `${selectedDate}T08:00:00+08:00`,
        source: "telegram_photo",
        type: "cost",
        state: "committed" as const,
        title: record.supplierName
          ? `Purchase from ${record.supplierName}`
          : "Purchase cost recorded",
        evidence_uri: record.imageUrl,
        target_event_id: null
      }))
    ]
  };
  return {
    overview: { status: "ready", data: overview },
    activity: { status: "ready", data: activity }
  };
}

export function initialAnalyticsState(
  dashboard: DashboardData
): DashboardAnalyticsState {
  if (dashboard.provenance === "synthetic") {
    return syntheticAnalytics(dashboard.summary.date, dashboard);
  }
  return {
    overview: { status: "loading" },
    activity: { status: "idle" }
  };
}
