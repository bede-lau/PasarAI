import { afterEach, describe, expect, it, vi } from "vitest";

import { loadDashboardState } from "@/lib/dashboard-data";
import { getDeploymentMerchant } from "@/lib/merchant";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.PASARAI_API_BASE_URL;
  delete process.env.PASARAI_API_BEARER_TOKEN;
  delete process.env.PASARAI_DASHBOARD_DATE;
  delete process.env.PASARAI_SYNTHETIC_PREVIEW;
  delete process.env.PASARAI_MERCHANT_ID;
  delete process.env.PASARAI_MERCHANT_NAME;
  delete process.env.PASARAI_MERCHANT_LOCATION;
  delete process.env.PASARAI_PRODUCT_ID;
  delete process.env.PASARAI_PRODUCT_NAME;
});

describe("live dashboard integration", () => {
  it("maps authenticated summary cost-stack and evidence contracts into the UI", async () => {
    process.env.PASARAI_SYNTHETIC_PREVIEW = "0";
    process.env["PASARAI_API_BASE_URL"] = "http://pasarai.test";
    process.env["PASARAI_API_BEARER_TOKEN"] = "PLACEHOLDER";
    process.env.PASARAI_DASHBOARD_DATE = "2026-07-12";
    process.env.PASARAI_MERCHANT_ID = "m_production_001";
    process.env.PASARAI_MERCHANT_NAME = "Warung Production";
    process.env.PASARAI_MERCHANT_LOCATION = "Shah Alam";
    process.env.PASARAI_PRODUCT_ID = "p_production_001";
    process.env.PASARAI_PRODUCT_NAME = "Nasi Lemak Production";
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      merchant_id: "m_production_001",
      date: "2026-07-10",
      revenue_rm: "200.00",
      cogs_rm: "127.20",
      gross_profit_rm: "72.80",
      gross_margin_pct: "36.40",
      data_completeness: {
        state: "complete",
        missing_inputs: []
      },
      top_cost_drivers: [
        { name: "Telur", contribution_rm_per_pack: "0.10" }
      ],
      baseline_comparison: {
        baseline_margin_pct: "42.00",
        margin_change_percentage_points: "-5.60"
      },
      price_floor: {
        target_gross_margin_pct: "40.00",
        price_floor_rm: "5.30",
        assumption: "current_unit_cogs"
      },
      cost_stack: {
        baseline_comparison_date: "2026-07-11",
        baseline_effective_date: "2026-07-11",
        baseline_unit_cogs_rm: "2.90",
        current_unit_cogs_rm: "3.18",
        components: [
          {
            component_id: "c_egg",
            name: "Telur",
            baseline_cost_rm_per_pack: "0.45",
            current_cost_rm_per_pack: "0.55",
            change_rm_per_pack: "0.10",
            evidence_id: "receipt-sinar"
          }
        ]
      },
      evidence: [
        {
          evidence_id: "receipt-sinar",
          title: "Sinar Borong Jaya receipt",
          asset_uri: "pasarai-evidence:dGVzdA",
          receipt_id: "SBR-120726-184",
          supplier_name: "Sinar Borong Jaya",
          transcript: null,
          line_items: [
            {
              raw_name: "Telur Gred B 30 biji x 3 tray",
              component_id: "c_egg",
              total_price_rm: "49.50",
              confidence: "0.98"
            }
          ]
        }
      ],
      assumptions: ["Gross profit excludes operating expenses."]
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    }));
    const timeout = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(new AbortController().signal);
    vi.stubGlobal("fetch", fetchMock);

    const merchant = getDeploymentMerchant();
    expect(merchant).not.toBeNull();
    const state = await loadDashboardState(
      merchant ?? undefined,
      "2026-07-10"
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, options] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("date=2026-07-10");
    expect(String(url)).toContain("merchant_id=m_production_001");
    expect(String(url)).toContain("product_id=p_production_001");
    expect(options.headers.authorization).toBe("Bearer PLACEHOLDER");
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(timeout).toHaveBeenCalledWith(60_000);
    expect(state.status).toBe("ready");
    if (state.status !== "ready") return;
    expect(state.data.merchant).toEqual({
      id: "m_production_001",
      name: "Warung Production",
      location: "Shah Alam",
      productId: "p_production_001",
      productName: "Nasi Lemak Production"
    });
    expect(state.data.costStack).toMatchObject({
      baselineDate: "2026-07-11",
      baselineUnitCogsRm: "2.90",
      currentUnitCogsRm: "3.18"
    });
    expect(state.data.evidence[0]).toMatchObject({
      id: "receipt-sinar",
      imageUrl:
        "/api/pasarai/evidence?uri=pasarai-evidence%3AdGVzdA"
    });
    expect(state.data.dateRange.max).toBe("2026-07-12");
  });

  it("returns historical synthetic data for the requested preview date", async () => {
    process.env.PASARAI_SYNTHETIC_PREVIEW = "1";

    const state = await loadDashboardState(undefined, "2026-07-10");

    expect(state.status).toBe("ready");
    if (state.status !== "ready") return;
    expect(state.data.summary).toMatchObject({
      date: "2026-07-10",
      revenue_rm: "210.00",
      cogs_rm: "121.80",
      gross_profit_rm: "88.20",
      gross_margin_pct: "42.00"
    });
    expect(state.data.dateRange).toEqual({
      min: "2026-07-05",
      max: "2026-07-16"
    });
  });

  it("defaults the synthetic dashboard to the July 16 demo snapshot", async () => {
    process.env.PASARAI_SYNTHETIC_PREVIEW = "1";

    const state = await loadDashboardState();

    expect(state.status).toBe("ready");
    if (state.status !== "ready") return;
    expect(state.data.summary).toMatchObject({
      date: "2026-07-16",
      revenue_rm: "200.00",
      cogs_rm: "128.80",
      gross_profit_rm: "71.20",
      gross_margin_pct: "35.60"
    });
    expect(state.data.costStack).toMatchObject({
      baselineDate: "2026-07-15",
      baselineUnitCogsRm: "2.50",
      currentUnitCogsRm: "3.22"
    });
    if ("components" in state.data.costStack) {
      expect(state.data.costStack.components).toHaveLength(9);
      expect(
        state.data.costStack.components.every(
          (component) => Number(component.changeRmPerPack) > 0
        )
      ).toBe(true);
    }
  });

  it.each([429, 503])(
    "maps HTTP %s to a truthful quota state without financial output",
    async (status) => {
      process.env.PASARAI_SYNTHETIC_PREVIEW = "0";
      process.env["PASARAI_API_BASE_URL"] = "http://pasarai.test";
      process.env["PASARAI_API_BEARER_TOKEN"] = "PLACEHOLDER";
      process.env.PASARAI_MERCHANT_ID = "m_production_001";
      process.env.PASARAI_MERCHANT_NAME = "Warung Production";
      process.env.PASARAI_MERCHANT_LOCATION = "Shah Alam";
      process.env.PASARAI_PRODUCT_ID = "p_production_001";
      process.env.PASARAI_PRODUCT_NAME = "Nasi Lemak Production";
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(new Response(null, { status }))
      );

      const state = await loadDashboardState(getDeploymentMerchant() ?? undefined);

      expect(state).toEqual({
        status: "quota",
        retryAfter: "after the service resets"
      });
      expect(state).not.toHaveProperty("data");
    }
  );

  it("surfaces provider timeout and invalid contracts as review errors", async () => {
    process.env.PASARAI_SYNTHETIC_PREVIEW = "0";
    process.env["PASARAI_API_BASE_URL"] = "http://pasarai.test";
    process.env["PASARAI_API_BEARER_TOKEN"] = "PLACEHOLDER";
    process.env.PASARAI_MERCHANT_ID = "m_production_001";
    process.env.PASARAI_MERCHANT_NAME = "Warung Production";
    process.env.PASARAI_MERCHANT_LOCATION = "Shah Alam";
    process.env.PASARAI_PRODUCT_ID = "p_production_001";
    process.env.PASARAI_PRODUCT_NAME = "Nasi Lemak Production";
    const merchant = getDeploymentMerchant() ?? undefined;

    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("Summary provider timed out."))
    );
    expect(await loadDashboardState(merchant)).toEqual({
      status: "error",
      message: "Summary provider timed out."
    });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({
        gross_profit_rm: "999.99"
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      }))
    );
    expect(await loadDashboardState(merchant)).toEqual({
      status: "error",
      message: "Daily summary did not match the shared v1 contract."
    });
  });

  it("explains verified data connection failures without exposing fetch internals", async () => {
    process.env.PASARAI_SYNTHETIC_PREVIEW = "0";
    process.env["PASARAI_API_BASE_URL"] = "http://pasarai.test";
    process.env["PASARAI_API_BEARER_TOKEN"] = "PLACEHOLDER";
    process.env.PASARAI_MERCHANT_ID = "m_production_001";
    process.env.PASARAI_MERCHANT_NAME = "Warung Production";
    process.env.PASARAI_MERCHANT_LOCATION = "Shah Alam";
    process.env.PASARAI_PRODUCT_ID = "p_production_001";
    process.env.PASARAI_PRODUCT_NAME = "Nasi Lemak Production";
    const fetchError = Object.assign(new TypeError("fetch failed"), {
      cause: { code: "ECONNREFUSED" }
    });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(fetchError));

    expect(
      await loadDashboardState(getDeploymentMerchant() ?? undefined)
    ).toEqual({
      status: "error",
      message:
        "The verified data service could not be reached. It may be offline or still starting; please retry shortly."
    });
  });
});
