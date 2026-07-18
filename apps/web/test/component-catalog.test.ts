import { afterEach, describe, expect, it, vi } from "vitest";

import { loadComponentCatalog } from "@/lib/component-catalog";
import { goldenDashboardFixture } from "./fixtures";

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.PASARAI_SYNTHETIC_PREVIEW;
  delete process.env[["PASARAI", "API", "BASE", "URL"].join("_")];
  delete process.env[["PASARAI", "API", "BEARER", "TOKEN"].join("_")];
});

describe("component catalog loading", () => {
  it("derives preview components from the ready dashboard cost stack", async () => {
    process.env.PASARAI_SYNTHETIC_PREVIEW = "1";

    const result = await loadComponentCatalog(
      goldenDashboardFixture.merchant,
      goldenDashboardFixture.summary.date,
      { status: "ready", data: goldenDashboardFixture }
    );

    expect(result.unavailable).toBe(false);
    expect(result.catalog).toEqual({
      merchant_id: "m_kak_lina_001",
      components: [
        { component_id: "c_egg", name: "Telur" },
        { component_id: "c_sambal", name: "Sambal + Minyak" },
        { component_id: "c_coconut", name: "Santan" },
        { component_id: "c_packaging", name: "Bekas Makanan" }
      ]
    });
  });

  it("loads and validates the merchant catalog from the API", async () => {
    process.env.PASARAI_SYNTHETIC_PREVIEW = "0";
    process.env[["PASARAI", "API", "BASE", "URL"].join("_")] =
      ["http", "://", "pasarai.test"].join("");
    process.env[["PASARAI", "API", "BEARER", "TOKEN"].join("_")] =
      "PLACEHOLDER";
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        merchant_id: "m_kak_lina_001",
        components: [{ component_id: "c_egg", name: "Telur" }]
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await loadComponentCatalog(
      goldenDashboardFixture.merchant,
      "2026-07-12",
      { status: "ready", data: goldenDashboardFixture }
    );

    expect(result.unavailable).toBe(false);
    expect(result.catalog.components).toEqual([
      { component_id: "c_egg", name: "Telur" }
    ]);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url.toString()).toBe(
      "http://pasarai.test/api/v1/catalog/components?merchant_id=m_kak_lina_001&as_of=2026-07-12"
    );
    expect(options.headers.authorization).toBe("Bearer PLACEHOLDER");
  });

  it("treats an empty successful API catalog as authoritative", async () => {
    process.env.PASARAI_SYNTHETIC_PREVIEW = "0";
    process.env[["PASARAI", "API", "BASE", "URL"].join("_")] =
      ["http", "://", "pasarai.test"].join("");
    process.env[["PASARAI", "API", "BEARER", "TOKEN"].join("_")] =
      "PLACEHOLDER";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      Response.json({
        merchant_id: "m_kak_lina_001",
        components: []
      })
    ));

    const result = await loadComponentCatalog(
      goldenDashboardFixture.merchant,
      "2026-07-12",
      { status: "ready", data: goldenDashboardFixture }
    );

    expect(result.unavailable).toBe(false);
    expect(result.catalog.components).toEqual([]);
  });
});
