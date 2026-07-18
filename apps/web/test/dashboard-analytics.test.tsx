import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Dashboard } from "@/components/dashboard";
import type { DashboardAnalyticsState } from "@/lib/dashboard-types";
import { goldenDashboardFixture } from "./fixtures";

const analyticsFixture = {
  overview: {
    status: "ready",
    data: {
      merchant_id: "m_kak_lina_001",
      product_id: "p_nlb_001",
      from: "2026-07-09",
      to: "2026-07-12",
      generated_at: "2026-07-12T13:05:00+08:00",
      data_through: "2026-07-12",
      freshness: {
        state: "fresh",
        lag_seconds: 45,
        source_max_ingested_at: "2026-07-12T13:04:15+08:00",
        projection_version: "analytics-v1:2026-07-12"
      },
      completeness_coverage_pct: "75.00",
      quality_flags: ["missing_day:2026-07-10"],
      days: [
        {
          date: "2026-07-09",
          state: "complete",
          quantity: "38",
          revenue_rm: "190.00",
          cogs_rm: "118.00",
          gross_profit_rm: "72.00",
          gross_margin_pct: "37.89",
          sold_out_state: "no"
        },
        {
          date: "2026-07-10",
          state: "missing",
          quantity: null,
          revenue_rm: null,
          cogs_rm: null,
          gross_profit_rm: null,
          gross_margin_pct: null,
          sold_out_state: "unknown"
        },
        {
          date: "2026-07-11",
          state: "partial",
          quantity: "22",
          revenue_rm: "110.00",
          cogs_rm: null,
          gross_profit_rm: null,
          gross_margin_pct: null,
          sold_out_state: "unknown"
        },
        {
          date: "2026-07-12",
          state: "complete",
          quantity: "40",
          revenue_rm: "200.00",
          cogs_rm: "127.20",
          gross_profit_rm: "72.80",
          gross_margin_pct: "36.40",
          sold_out_state: "no"
        }
      ],
      alerts: [
        {
          id: "margin-below-target",
          severity: "critical",
          title: "Gross margin is below target",
          message: "Review the largest cost changes.",
          metric: "gross-margin",
          threshold: "40.00",
          evidence_id: "receipt-sinar",
          action: "inspect_cost"
        }
      ],
      cost_waterfall: {
        baseline_date: "2026-07-11",
        baseline_unit_cogs_rm: "2.90",
        current_unit_cogs_rm: "3.18",
        components: [
          {
            component_id: "c_egg",
            name: "Telur",
            baseline_cost_rm_per_pack: "0.42",
            current_cost_rm_per_pack: "0.52",
            change_rm_per_pack: "0.10",
            evidence_id: "receipt-sinar"
          },
          {
            component_id: "c_packaging",
            name: "Bekas Makanan",
            baseline_cost_rm_per_pack: "0.30",
            current_cost_rm_per_pack: "0.34",
            change_rm_per_pack: "0.04",
            evidence_id: "receipt-packpro"
          }
        ]
      }
    }
  },
  activity: {
    status: "ready",
    data: {
      merchant_id: "m_kak_lina_001",
      product_id: "p_nlb_001",
      from: "2026-07-09",
      to: "2026-07-12",
      items: [
        {
          event_id: "evt-sale-1",
          occurred_at: "2026-07-12T12:00:00+08:00",
          source: "telegram_text",
          type: "sale",
          state: "committed",
          title: "Sale recorded",
          evidence_uri: null,
          target_event_id: null
        },
        {
          event_id: "evt-cost-1",
          occurred_at: "2026-07-12T08:00:00+08:00",
          source: "telegram_photo",
          type: "cost",
          state: "committed",
          title: "Purchase from Sinar Borong Jaya",
          evidence_uri: "/evidence/receipt_001_sinar_borong.jpg",
          target_event_id: null
        }
      ]
    }
  }
} satisfies DashboardAnalyticsState;

describe("dashboard analytics views", () => {
  it("moves from today into trends and activity without rendering alerts or planning", async () => {
    const user = userEvent.setup();
    render(
      <Dashboard
        initialData={{
          ...goldenDashboardFixture,
          provenance: "live"
        }}
        initialAnalytics={analyticsFixture}
        locale="en"
      />
    );

    expect(screen.queryByText("Fresh")).not.toBeInTheDocument();
    expect(screen.queryByText("Data through")).not.toBeInTheDocument();
    expect(screen.queryByText("Complete days")).not.toBeInTheDocument();
    expect(screen.queryByText("Updated")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Needs attention")
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Gross margin is below target")
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("tab", { name: "Plan" })
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Trends" }));
    expect(
      screen.getByRole("heading", { name: "Performance trend" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "What changed unit cost" })
    ).toBeInTheDocument();
    expect(
      document.querySelector(".trend-gap--missing")
    ).toBeInTheDocument();
    expect(document.querySelector(".trend-chart")).toHaveAttribute(
      "data-source",
      "analytics"
    );
    expect(document.querySelector(".trend-line")).toBeInTheDocument();
    expect(screen.queryByText("Synthetic demo")).not.toBeInTheDocument();
    expect(document.querySelector(".trend-legend")).not.toBeInTheDocument();
    expect(document.querySelectorAll(".trend-y-tick")).toHaveLength(5);
    expect(document.querySelectorAll(".trend-axis time")).toHaveLength(4);

    const firstTrendPoint = screen.getByRole("button", {
      name: "09 Jul 2026, Gross profit RM72.00"
    });
    await user.hover(firstTrendPoint);
    const tooltipId = firstTrendPoint.getAttribute("aria-describedby");
    expect(tooltipId).toBeTruthy();
    expect(document.getElementById(tooltipId!)).toHaveTextContent(
      "09 Jul 2026"
    );
    expect(document.getElementById(tooltipId!)).toHaveTextContent(
      "Gross profit"
    );
    expect(document.getElementById(tooltipId!)).toHaveTextContent("RM72.00");

    await user.click(screen.getByRole("tab", { name: "Activity" }));
    expect(
      screen.getByRole("heading", { name: "Source activity" })
    ).toBeInTheDocument();
    expect(screen.getByText("Sale recorded")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "View receipt" })
    ).toHaveAttribute("href", "/evidence/receipt_001_sinar_borong.jpg");
  });

  it("renders a synthetic performance line when analytics history has no usable values", async () => {
    const user = userEvent.setup();
    const emptyHistory: DashboardAnalyticsState = {
      ...analyticsFixture,
      overview: {
        ...analyticsFixture.overview,
        data: {
          ...analyticsFixture.overview.data,
          from: "2026-06-15",
          quality_flags: ["no_usable_history"],
          completeness_coverage_pct: "0.00",
          days: []
        }
      }
    };

    render(
      <Dashboard
        initialData={{
          ...goldenDashboardFixture,
          provenance: "live"
        }}
        initialAnalytics={emptyHistory}
        locale="en"
      />
    );

    await user.click(screen.getByRole("tab", { name: "Trends" }));

    expect(screen.queryByText("Synthetic demo")).not.toBeInTheDocument();
    expect(document.querySelector(".trend-chart")).toHaveAttribute(
      "data-source",
      "synthetic"
    );
    expect(document.querySelectorAll(".trend-line")).toHaveLength(1);
    expect(document.querySelectorAll(".trend-point")).toHaveLength(14);
    expect(
      document.querySelectorAll('.trend-point[data-edge="start"]')
    ).toHaveLength(3);
    expect(
      document.querySelectorAll('.trend-point[data-edge="end"]')
    ).toHaveLength(5);
    expect(document.querySelectorAll(".trend-y-tick")).toHaveLength(5);
    expect(document.querySelectorAll(".trend-axis time")).toHaveLength(7);
    expect(
      document.querySelector(".trend-line")?.getAttribute("points")
    ).not.toBe("");
  });

  it("renders the synthetic performance line when analytics is unavailable", async () => {
    const user = userEvent.setup();

    render(
      <Dashboard
        initialData={{
          ...goldenDashboardFixture,
          provenance: "live"
        }}
        initialAnalytics={{
          overview: {
            status: "error",
            message: "/api/v1/analytics/overview returned HTTP 500."
          },
          activity: { status: "idle" }
        }}
        locale="en"
      />
    );

    await user.click(screen.getByRole("tab", { name: "Trends" }));

    expect(screen.queryByText("Synthetic demo")).not.toBeInTheDocument();
    expect(document.querySelector(".trend-chart")).toHaveAttribute(
      "data-source",
      "synthetic"
    );
    expect(document.querySelectorAll(".trend-line")).toHaveLength(1);
    expect(document.querySelectorAll(".trend-point")).toHaveLength(14);
    expect(
      screen.queryByText("/api/v1/analytics/overview returned HTTP 500.")
    ).not.toBeInTheDocument();
  });
});
