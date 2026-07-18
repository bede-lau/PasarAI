import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type {
  AnalyticsActivityResponse,
  AnalyticsOverviewResponse
} from "@pasarai/contracts/v1";

import { Dashboard } from "@/components/dashboard";
import { goldenDashboardFixture } from "./fixtures";

const overview: AnalyticsOverviewResponse = {
  merchant_id: "m_kak_lina_001",
  product_id: "p_nlb_001",
  from: "2026-06-15",
  to: "2026-07-12",
  generated_at: "2026-07-12T13:05:00+08:00",
  data_through: "2026-07-12",
  freshness: {
    state: "fresh",
    lag_seconds: 45,
    source_max_ingested_at: "2026-07-12T13:04:15+08:00",
    projection_version: "analytics-v1:2026-07-12"
  },
  completeness_coverage_pct: "100.00",
  quality_flags: [],
  days: [],
  alerts: [
    {
      id: "deferred-alert",
      severity: "warning",
      title: "Deferred analytics loaded",
      message: "The overview arrived after the financial summary.",
      metric: "gross-margin",
      threshold: "40.00",
      evidence_id: null,
      action: "inspect_cost"
    }
  ],
  cost_waterfall: null
};

const activity: AnalyticsActivityResponse = {
  merchant_id: "m_kak_lina_001",
  product_id: "p_nlb_001",
  from: "2026-06-15",
  to: "2026-07-12",
  items: [
    {
      event_id: "deferred-sale",
      occurred_at: "2026-07-12T12:00:00+08:00",
      source: "telegram_text",
      type: "sale",
      state: "committed",
      title: "Deferred sale loaded",
      evidence_uri: null,
      target_event_id: null
    }
  ]
};

describe("deferred dashboard analytics", () => {
  it("renders the summary first and loads activity when its tab opens", async () => {
    const user = userEvent.setup();
    let resolveOverview: ((response: Response) => void) | undefined;
    const overviewResponse = new Promise<Response>((resolve) => {
      resolveOverview = resolve;
    });
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/pasarai/analytics/overview?")) {
        return overviewResponse;
      }
      if (url.startsWith("/api/pasarai/analytics/activity?")) {
        return Promise.resolve(Response.json(activity));
      }
      return Promise.reject(new Error(`Unexpected request: ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <Dashboard
        initialData={{
          ...goldenDashboardFixture,
          provenance: "live"
        }}
        initialAnalytics={{
          overview: { status: "loading" },
          activity: { status: "idle" }
        }}
        locale="en"
      />
    );

    expect(
      screen.getByRole("heading", { name: "Nasi Lemak Biasa" })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("status", { name: "Loading analytics" })
    ).not.toBeInTheDocument();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).includes("/analytics/overview?")
      )
    ).toBe(true);
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).includes("/analytics/activity?")
      )
    ).toBe(false);

    await act(async () => {
      resolveOverview?.(Response.json(overview));
      await overviewResponse;
    });
    expect(
      screen.queryByText("Deferred analytics loaded")
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Activity" }));
    expect(
      await screen.findByText("Deferred sale loaded")
    ).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).includes("/analytics/activity?")
      )
    ).toBe(true);
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).includes("/analytics/forecast")
      )
    ).toBe(false);
  });

  it("retries overview when a dependent tab opens after an initial failure", async () => {
    const user = userEvent.setup();
    let overviewAttempts = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (!url.startsWith("/api/pasarai/analytics/overview?")) {
        return Promise.reject(new Error(`Unexpected request: ${url}`));
      }
      overviewAttempts += 1;
      return overviewAttempts === 1
        ? Promise.reject(new Error("Overview request timed out."))
        : Promise.resolve(Response.json(overview));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <Dashboard
        initialData={{
          ...goldenDashboardFixture,
          provenance: "live"
        }}
        initialAnalytics={{
          overview: { status: "loading" },
          activity: { status: "idle" }
        }}
        locale="en"
      />
    );

    expect(
      screen.getByRole("heading", { name: "Nasi Lemak Biasa" })
    ).toBeInTheDocument();
    await waitFor(() => expect(overviewAttempts).toBe(1));
    expect(
      screen.queryByText("Analytics are temporarily unavailable.")
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Trends" }));

    expect(
      await screen.findByRole("heading", {
        name: "Performance trend"
      })
    ).toBeInTheDocument();
    expect(overviewAttempts).toBe(2);
  });

  it("does not schedule periodic full-page refreshes", () => {
    const interval = vi.spyOn(window, "setInterval");

    render(
      <Dashboard
        initialData={{
          ...goldenDashboardFixture,
          provenance: "live"
        }}
        initialAnalytics={{
          overview: { status: "ready", data: overview },
          activity: { status: "ready", data: activity }
        }}
        locale="en"
      />
    );

    expect(interval).not.toHaveBeenCalled();
  });
});
