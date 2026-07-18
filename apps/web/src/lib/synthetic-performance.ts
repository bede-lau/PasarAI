import type { AnalyticsOverviewResponse } from "@pasarai/contracts/v1";

import { shiftDashboardDate } from "@/lib/dashboard-date";

type PerformanceDay = AnalyticsOverviewResponse["days"][number];

const trendMetrics = [
  "quantity",
  "revenue_rm",
  "cogs_rm",
  "gross_profit_rm",
  "gross_margin_pct"
] as const;

const syntheticPerformanceTemplate = [
  { quantity: 38, unitPriceRm: 5.0, unitCogsRm: 2.88 },
  { quantity: 42, unitPriceRm: 5.0, unitCogsRm: 2.89 },
  { quantity: 46, unitPriceRm: 5.0, unitCogsRm: 2.9 },
  { quantity: 31, unitPriceRm: 5.0, unitCogsRm: 2.88 },
  { quantity: 35, unitPriceRm: 5.0, unitCogsRm: 2.91 },
  { quantity: 39, unitPriceRm: 5.0, unitCogsRm: 2.92 },
  { quantity: 44, unitPriceRm: 5.0, unitCogsRm: 2.9 },
  { quantity: 41, unitPriceRm: 5.0, unitCogsRm: 2.94 },
  { quantity: 45, unitPriceRm: 5.0, unitCogsRm: 2.96 },
  { quantity: 49, unitPriceRm: 5.0, unitCogsRm: 2.98 },
  { quantity: 33, unitPriceRm: 5.0, unitCogsRm: 2.97 },
  { quantity: 37, unitPriceRm: 5.0, unitCogsRm: 3.0 },
  { quantity: 43, unitPriceRm: 5.0, unitCogsRm: 3.01 },
  { quantity: 47, unitPriceRm: 5.0, unitCogsRm: 3.02 },
  { quantity: 40, unitPriceRm: 5.1, unitCogsRm: 3.05 },
  { quantity: 44, unitPriceRm: 5.1, unitCogsRm: 3.06 },
  { quantity: 50, unitPriceRm: 5.1, unitCogsRm: 3.08 },
  { quantity: 34, unitPriceRm: 5.1, unitCogsRm: 3.07 },
  { quantity: 39, unitPriceRm: 5.1, unitCogsRm: 3.1 },
  { quantity: 45, unitPriceRm: 5.1, unitCogsRm: 3.11 },
  { quantity: 48, unitPriceRm: 5.1, unitCogsRm: 3.12 },
  { quantity: 42, unitPriceRm: 5.2, unitCogsRm: 3.18 },
  { quantity: 47, unitPriceRm: 5.2, unitCogsRm: 3.17 },
  { quantity: 52, unitPriceRm: 5.2, unitCogsRm: 3.16 },
  { quantity: 36, unitPriceRm: 5.2, unitCogsRm: 3.18 },
  { quantity: 41, unitPriceRm: 5.2, unitCogsRm: 3.15 },
  { quantity: 46, unitPriceRm: 5.2, unitCogsRm: 3.17 },
  { quantity: 50, unitPriceRm: 5.2, unitCogsRm: 3.18 }
] as const;

export function hasUsablePerformanceTrend(
  days: AnalyticsOverviewResponse["days"]
) {
  return days.filter((day) =>
    trendMetrics.every((metric) => day[metric] !== null)
  ).length >= 2;
}

export function getSyntheticPerformanceDays(
  endDate: string
): ReadonlyArray<PerformanceDay> {
  return syntheticPerformanceTemplate.map((entry, index) => {
    const revenue = entry.quantity * entry.unitPriceRm;
    const cogs = entry.quantity * entry.unitCogsRm;
    const grossProfit = revenue - cogs;
    const grossMargin = revenue === 0
      ? 0
      : (grossProfit / revenue) * 100;

    return {
      date: shiftDashboardDate(
        endDate,
        index - syntheticPerformanceTemplate.length + 1
      ),
      state: "complete",
      quantity: entry.quantity.toFixed(0),
      revenue_rm: revenue.toFixed(2),
      cogs_rm: cogs.toFixed(2),
      gross_profit_rm: grossProfit.toFixed(2),
      gross_margin_pct: grossMargin.toFixed(2),
      sold_out_state: entry.quantity >= 50 ? "yes" : "no"
    };
  });
}

export function resolvePerformanceTrend(
  overview: AnalyticsOverviewResponse | null,
  endDate: string
) {
  if (overview && hasUsablePerformanceTrend(overview.days)) {
    return {
      source: "analytics" as const,
      days: overview.days
    };
  }

  return {
    source: "synthetic" as const,
    days: getSyntheticPerformanceDays(endDate)
  };
}
