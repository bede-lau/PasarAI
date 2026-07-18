import { afterEach, describe, expect, it, vi } from "vitest";

import {
  confirmPurchaseIntake,
  postPurchaseIntake
} from "@/lib/purchase-intake";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("purchase intake client", () => {
  it("sends the caller's explicit idempotency keys", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ intake_id: "intake_001" }))
      .mockResolvedValueOnce(Response.json({
        state: "committed",
        event_id: "event_001"
      }));
    vi.stubGlobal("fetch", fetchMock);

    await postPurchaseIntake(
      {
        merchant_id: "m_kak_lina_001",
        occurred_at: "2026-07-12T04:00:00.000Z",
        source: "web_manual",
        source_language: "en",
        supplier_name: "Pasar Pagi",
        metadata: { payment_method: "cash", note: null },
        item: {
          component_id: "c_egg",
          raw_name: "Telur",
          quantity: "3",
          uom: "tray",
          pack_size: "30",
          total_price_rm: "49.50"
        },
        evidence: { transcript: "Cash purchase without a receipt" }
      },
      "upsert-stable-key"
    );
    await confirmPurchaseIntake(
      {
        merchant_id: "m_kak_lina_001",
        intake_id: "intake_001",
        expected_version: 4,
        confirmation_token: "confirmation_004"
      },
      "confirm-stable-key"
    );

    expect(fetchMock.mock.calls[0][1].headers["idempotency-key"]).toBe(
      "upsert-stable-key"
    );
    expect(fetchMock.mock.calls[1][1].headers["idempotency-key"]).toBe(
      "confirm-stable-key"
    );
  });
});
