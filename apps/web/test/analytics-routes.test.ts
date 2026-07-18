import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET as readActivity } from "../app/api/pasarai/analytics/activity/route";
import { GET as readForecast } from "../app/api/pasarai/analytics/forecast/route";
import { GET as readOverview } from "../app/api/pasarai/analytics/overview/route";

const origin = "http://pasarai.test";

const routes = [
  {
    handler: readOverview,
    path:
      "/api/pasarai/analytics/overview?from=2026-06-15&to=2026-07-12",
    timeoutMs: 30_000
  },
  {
    handler: readActivity,
    path:
      "/api/pasarai/analytics/activity?from=2026-06-15&to=2026-07-12",
    timeoutMs: 5_000
  },
  {
    handler: readForecast,
    path: "/api/pasarai/analytics/forecast?as_of=2026-07-12",
    timeoutMs: 5_000
  }
];

beforeEach(() => {
  process.env.PASARAI_WEB_AUTH_REQUIRED = "0";
  process.env.PASARAI_MERCHANT_ID = "m_production_001";
  process.env.PASARAI_MERCHANT_NAME = "Warung Production";
  process.env.PASARAI_MERCHANT_LOCATION = "Shah Alam";
  process.env.PASARAI_PRODUCT_ID = "p_production_001";
  process.env.PASARAI_PRODUCT_NAME = "Nasi Lemak Production";
  process.env.PASARAI_API_BASE_URL = "http://upstream.test";
  process.env.PASARAI_API_BEARER_TOKEN = "SERVER_ONLY_TOKEN";
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const name of [
    "PASARAI_WEB_AUTH_REQUIRED",
    "PASARAI_MERCHANT_ID",
    "PASARAI_MERCHANT_NAME",
    "PASARAI_MERCHANT_LOCATION",
    "PASARAI_PRODUCT_ID",
    "PASARAI_PRODUCT_NAME",
    "PASARAI_API_BASE_URL",
    "PASARAI_API_BEARER_TOKEN"
  ]) {
    delete process.env[name];
  }
});

describe("analytics BFF timeouts", () => {
  for (const { handler, path, timeoutMs } of routes) {
    it(`bounds ${path.split("?")[0]} upstream work`, async () => {
      const signal = new AbortController().signal;
      const timeout = vi
        .spyOn(AbortSignal, "timeout")
        .mockReturnValue(signal);
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(null, { status: 503 })
      );
      vi.stubGlobal("fetch", fetchMock);

      const response = await handler(new Request(`${origin}${path}`));

      expect(response.status).toBe(503);
      expect(timeout).toHaveBeenCalledWith(timeoutMs);
      expect(fetchMock).toHaveBeenCalledWith(
        expect.any(URL),
        expect.objectContaining({ signal })
      );
    });
  }
});
