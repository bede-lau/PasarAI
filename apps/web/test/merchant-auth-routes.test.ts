import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST as confirmPurchaseIntake } from "../app/api/pasarai/purchase-intakes/confirm/route";
import { POST as upsertPurchaseIntake } from "../app/api/pasarai/purchase-intakes/route";
import { POST as confirmReceipt } from "../app/api/pasarai/receipts/confirm/route";
import { POST as extractReceipt } from "../app/api/pasarai/receipts/extract/route";
import {
  GET as readReceiptReviews,
  POST as saveReceiptReview
} from "../app/api/pasarai/receipts/reviews/route";
import {
  GET as readSession,
  POST as createSession
} from "../app/api/pasarai/session/route";
import { POST as simulatePrice } from "../app/api/pasarai/simulations/price/route";
import { safeInternalPath } from "../src/lib/safe-redirect";

const origin = "http://pasarai.test";

const simulationRequest = {
  product_id: "p_production_001",
  quantity: "35",
  proposed_unit_price_rm: "5.50",
  as_of: "2026-07-12"
};

const simulationResponse = {
  revenue_rm: "192.50",
  cogs_rm: "111.30",
  gross_profit_rm: "81.20",
  gross_margin_pct: "42.18",
  incremental_gross_profit_vs_today_rm: "8.40",
  assumption: "constant_demand"
};

const confirmationRequest = {
  receipt_event_id: "receipt_event_001",
  occurred_at: "2026-07-12T12:00:00.000Z",
  extraction: {
    receipt_id: "receipt_001",
    supplier_name: "Supplier",
    date: "2026-07-12",
    currency: "MYR",
    line_items: [
      {
        raw_name: "Eggs",
        normalized_component_id: "c_egg",
        quantity: "1",
        uom: "tray",
        pack_size: "30",
        unit_price_rm: "15.00",
        total_price_rm: "15.00",
        confidence: "0.99"
      }
    ],
    total_rm: "15.00",
    overall_confidence: "0.99",
    ambiguities: []
  }
};

const purchaseIntakeRequest = {
  occurred_at: "2026-07-12T04:00:00.000Z",
  source: "web_manual",
  source_language: "en",
  supplier_name: "Pasar Pagi",
  metadata: {
    payment_method: "cash",
    note: "Morning stock"
  },
  item: {
    component_id: "c_egg",
    raw_name: "Telur",
    quantity: "3",
    uom: "tray",
    pack_size: "30",
    total_price_rm: "49.50"
  },
  evidence: {
    transcript: "Cash purchase without a receipt"
  }
};

const purchaseIntakeResponse = {
  state: "ready_for_confirmation",
  intake_id: "purchase_intake_001",
  version: 4,
  missing_fields: [],
  confirmation_token: "confirmation_004",
  summary: {
    supplier_name: "Pasar Pagi",
    component_id: "c_egg",
    item_name: "Telur",
    quantity: "3",
    uom: "tray",
    pack_size: "30",
    total_price_rm: "49.50",
    occurred_at: "2026-07-12T04:00:00.000Z",
    payment_method: "cash",
    note: "Morning stock"
  }
};

beforeEach(() => {
  process.env.PASARAI_WEB_SESSION_SECRET =
    "test-only-session-secret-with-sufficient-entropy";
  process.env.PASARAI_WEB_ACCESS_CODE = "correct horse battery staple";
  process.env.PASARAI_MERCHANT_ID = "m_production_001";
  process.env.PASARAI_MERCHANT_NAME = "Warung Production";
  process.env.PASARAI_MERCHANT_LOCATION = "Shah Alam";
  process.env.PASARAI_PRODUCT_ID = "p_production_001";
  process.env.PASARAI_PRODUCT_NAME = "Nasi Lemak Production";
  process.env[["PASARAI", "API", "BASE", "URL"].join("_")] =
    "http://pasarai.test";
  process.env[["PASARAI", "API", "BEARER", "TOKEN"].join("_")] =
    "PLACEHOLDER";
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const name of [
    "PASARAI_WEB_SESSION_SECRET",
    "PASARAI_WEB_ACCESS_CODE",
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

async function sessionCookie() {
  const response = await createSession(
    new Request(`${origin}/api/pasarai/session`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin
      },
      body: JSON.stringify({
        access_code: "correct horse battery staple"
      })
    })
  );
  expect(response.status).toBe(200);
  const setCookie = response.headers.get("set-cookie");
  expect(setCookie).toContain("HttpOnly");
  return setCookie?.split(";")[0] ?? "";
}

describe("merchant BFF authentication boundary", () => {
  it("opens a trusted demo without a session while preserving merchant binding", async () => {
    process.env.PASARAI_WEB_AUTH_REQUIRED = "0";
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json(simulationResponse)
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await simulatePrice(
      new Request(`${origin}/api/pasarai/simulations/price`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin
        },
        body: JSON.stringify(simulationRequest)
      })
    );

    expect(response.status).toBe(200);
    const [, options] = fetchMock.mock.calls[0];
    expect(JSON.parse(options.body)).toEqual({
      ...simulationRequest,
      merchant_id: "m_production_001"
    });
  });

  it("rejects backslash and cross-origin login redirects", async () => {
    const externalHost = ["evil", "example"].join(".");
    const backslashPath = `/\\\\${externalHost}`;
    expect(safeInternalPath(backslashPath, origin)).toBe("/");
    expect(safeInternalPath(`/%5C%5C${externalHost}`, origin)).toBe("/");
    expect(safeInternalPath(`//${externalHost}`, origin)).toBe("/");
    expect(safeInternalPath("/receipts?lang=en", origin)).toBe(
      "/receipts?lang=en"
    );

    const response = await createSession(
      new Request(`${origin}/api/pasarai/session`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin
        },
        body: new URLSearchParams({
          access_code: "correct horse battery staple",
          next: backslashPath
        })
      })
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${origin}/`);
  });

  it("rejects unauthenticated privileged requests", async () => {
    const response = await simulatePrice(
      new Request(`${origin}/api/pasarai/simulations/price`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin
        },
        body: JSON.stringify(simulationRequest)
      })
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: "Authentication required."
    });
  });

  it("rejects a foreign merchant payload even with a valid session", async () => {
    const response = await simulatePrice(
      new Request(`${origin}/api/pasarai/simulations/price`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: await sessionCookie(),
          origin
        },
        body: JSON.stringify({
          ...simulationRequest,
          merchant_id: "m_foreign_001"
        })
      })
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "Merchant does not match the authenticated session."
    });
  });

  it("rejects mutation requests from a different origin", async () => {
    const response = await extractReceipt(
      new Request(`${origin}/api/pasarai/receipts/extract`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: await sessionCookie(),
          origin: ["https", "://", "attacker.test"].join("")
        },
        body: JSON.stringify({})
      })
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "Request origin is not allowed."
    });
  });

  it("uses the signed session merchant for valid upstream requests", async () => {
    const cookie = await sessionCookie();
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json(simulationResponse)
    );
    vi.stubGlobal("fetch", fetchMock);

    const sessionResponse = await readSession(
      new Request(`${origin}/api/pasarai/session`, {
        headers: { cookie }
      })
    );
    expect(sessionResponse.status).toBe(200);
    expect(await sessionResponse.json()).toEqual({
      merchant: {
        id: "m_production_001",
        name: "Warung Production",
        location: "Shah Alam",
        productId: "p_production_001",
        productName: "Nasi Lemak Production"
      }
    });

    const response = await simulatePrice(
      new Request(`${origin}/api/pasarai/simulations/price`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie,
          origin
        },
        body: JSON.stringify(simulationRequest)
      })
    );

    expect(response.status).toBe(200);
    const [, options] = fetchMock.mock.calls[0];
    expect(JSON.parse(options.body)).toEqual({
      ...simulationRequest,
      merchant_id: "m_production_001"
    });
  });

  it("explains when the simulation API cannot be reached", async () => {
    process.env.PASARAI_WEB_AUTH_REQUIRED = "0";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("fetch failed"))
    );

    const response = await simulatePrice(
      new Request(`${origin}/api/pasarai/simulations/price`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin
        },
        body: JSON.stringify(simulationRequest)
      })
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error:
        "The simulation service is temporarily unreachable. Try again in a moment."
    });
  });

  it("rejects an invalid successful receipt-confirm response", async () => {
    const cookie = await sessionCookie();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ state: "committed" }))
    );

    const response = await confirmReceipt(
      new Request(`${origin}/api/pasarai/receipts/confirm`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie,
          origin
        },
        body: JSON.stringify(confirmationRequest)
      })
    );

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: "PasarAI API returned an invalid costs response."
    });
  });

  it("binds receipt review history reads and saves to the signed merchant", async () => {
    const cookie = await sessionCookie();
    const historyResponse = {
      merchant_id: "m_production_001",
      receipts: []
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json(historyResponse))
      .mockResolvedValueOnce(Response.json({
        state: "saved",
        receipt_event_id: "receipt_event_001",
        review_event_id: "receipt_review_001",
        version: 1
      }));
    vi.stubGlobal("fetch", fetchMock);

    const history = await readReceiptReviews(
      new Request(`${origin}/api/pasarai/receipts/reviews`, {
        headers: { cookie }
      })
    );
    expect(history.status).toBe(200);
    expect(await history.json()).toEqual(historyResponse);
    expect(fetchMock.mock.calls[0][0].toString()).toBe(
      "http://pasarai.test/api/v1/receipts/reviews?merchant_id=m_production_001"
    );

    const saved = await saveReceiptReview(
      new Request(`${origin}/api/pasarai/receipts/reviews`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie,
          origin,
          "idempotency-key": "receipt-review-web-001"
        },
        body: JSON.stringify({
          receipt_event_id: confirmationRequest.receipt_event_id,
          occurred_at: confirmationRequest.occurred_at,
          review_state: "draft",
          extraction: confirmationRequest.extraction
        })
      })
    );
    expect(saved.status).toBe(200);
    const [, options] = fetchMock.mock.calls[1];
    expect(options.headers["idempotency-key"]).toBe(
      "receipt-review-web-001"
    );
    expect(JSON.parse(options.body)).toEqual({
      merchant_id: "m_production_001",
      receipt_event_id: confirmationRequest.receipt_event_id,
      occurred_at: confirmationRequest.occurred_at,
      review_state: "draft",
      extraction: confirmationRequest.extraction
    });
  });

  it("binds purchase intake review to the signed session merchant", async () => {
    const cookie = await sessionCookie();
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json(purchaseIntakeResponse)
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await upsertPurchaseIntake(
      new Request(`${origin}/api/pasarai/purchase-intakes`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie,
          origin,
          "idempotency-key": "web-review-001"
        },
        body: JSON.stringify(purchaseIntakeRequest)
      })
    );

    expect(response.status).toBe(200);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url.toString()).toBe("http://pasarai.test/api/v1/purchase-intakes");
    expect(options.headers["idempotency-key"]).toBe("web-review-001");
    expect(JSON.parse(options.body)).toEqual({
      ...purchaseIntakeRequest,
      merchant_id: "m_production_001"
    });
  });

  it("forwards the exact purchase intake version and confirmation token", async () => {
    const cookie = await sessionCookie();
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        state: "committed",
        event_id: "cost_event_001"
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await confirmPurchaseIntake(
      new Request(`${origin}/api/pasarai/purchase-intakes/confirm`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie,
          origin
        },
        body: JSON.stringify({
          intake_id: "purchase_intake_001",
          expected_version: 4,
          confirmation_token: "confirmation_004"
        })
      })
    );

    expect(response.status).toBe(200);
    const [, options] = fetchMock.mock.calls[0];
    expect(JSON.parse(options.body)).toEqual({
      merchant_id: "m_production_001",
      intake_id: "purchase_intake_001",
      expected_version: 4,
      confirmation_token: "confirmation_004"
    });
  });

  it("rejects unauthenticated purchase intake mutations", async () => {
    const response = await upsertPurchaseIntake(
      new Request(`${origin}/api/pasarai/purchase-intakes`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin
        },
        body: JSON.stringify(purchaseIntakeRequest)
      })
    );

    expect(response.status).toBe(401);
  });
});
