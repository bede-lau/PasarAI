import { afterEach, describe, expect, it, vi } from "vitest";

import { postPriceSimulation } from "@/lib/simulate-price";

const validRequest = {
  merchant_id: "m_kak_lina_001",
  product_id: "p_nlb_001",
  quantity: "40",
  proposed_unit_price_rm: "5.00",
  as_of: "2026-07-12"
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("price simulation client", () => {
  it("normalizes ordinary numeric input to the API contract", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        revenue_rm: "220.00",
        cogs_rm: "127.20",
        gross_profit_rm: "92.80",
        gross_margin_pct: "42.18",
        incremental_gross_profit_vs_today_rm: "20.00",
        assumption: "constant_demand"
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await postPriceSimulation({
      ...validRequest,
      quantity: " 40 ",
      proposed_unit_price_rm: "5.5"
    });

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      ...validRequest,
      quantity: "40",
      proposed_unit_price_rm: "5.50"
    });
  });

  it("explains invalid price and quantity values without calling the API", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      postPriceSimulation({
        ...validRequest,
        quantity: "",
        proposed_unit_price_rm: "RM5"
      })
    ).rejects.toThrow(
      "Enter a non-negative quantity and a price with two decimal places, such as 40 and 5.00."
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the server's plain-English explanation for failed simulations", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json(
          {
            error:
              "The simulation service is temporarily unreachable. Try again in a moment."
          },
          { status: 503 }
        )
      )
    );

    await expect(postPriceSimulation(validRequest)).rejects.toThrow(
      "The simulation service is temporarily unreachable. Try again in a moment."
    );
  });

  it("explains browser-to-server connection failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("Failed to fetch"))
    );

    await expect(postPriceSimulation(validRequest)).rejects.toThrow(
      "The simulation service could not be reached. Check your connection and try again."
    );
  });
});
