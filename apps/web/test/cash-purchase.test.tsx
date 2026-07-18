import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CashPurchaseFlow } from "@/components/cash-purchase-flow";
import { cashPurchaseStorageKey } from "@/lib/cash-purchase-storage";

const catalog = {
  merchant_id: "m_kak_lina_001",
  components: [
    { component_id: "c_egg", name: "Telur" },
    { component_id: "c_coconut", name: "Santan" }
  ]
};

const reviewResponse = {
  state: "ready_for_confirmation" as const,
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
    payment_method: "cash" as const,
    note: "Morning stock"
  }
};

async function completeForm(user: ReturnType<typeof userEvent.setup>) {
  await user.selectOptions(screen.getByLabelText("Component"), "c_egg");
  await user.type(screen.getByLabelText("Supplier"), "Pasar Pagi");
  await user.type(screen.getByLabelText("Quantity bought"), "3");
  await user.type(screen.getByLabelText("Purchase unit"), "tray");
  await user.type(screen.getByLabelText("One unit contains"), "30");
  await user.type(screen.getByLabelText("Total paid"), "49.5");
  await user.type(screen.getByLabelText("Note"), "Morning stock");
}

describe("cash purchase flow", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("persists review and confirms the exact server version and token", async () => {
    const user = userEvent.setup();
    const upsertPurchase = vi.fn().mockResolvedValue(reviewResponse);
    const confirmPurchase = vi.fn().mockResolvedValue({
      state: "committed",
      event_id: "cost_event_001"
    });

    render(
      <CashPurchaseFlow
        locale="en"
        merchantId="m_kak_lina_001"
        summaryDate="2026-07-12"
        catalog={catalog}
        upsertPurchase={upsertPurchase}
        confirmPurchase={confirmPurchase}
      />
    );
    await completeForm(user);
    await user.click(screen.getByRole("button", { name: "Review purchase" }));

    expect(upsertPurchase).toHaveBeenCalledWith(
      {
        merchant_id: "m_kak_lina_001",
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
      },
      expect.any(String)
    );
    expect(
      await screen.findByRole("heading", { name: "Review cash purchase" })
    ).toBeInTheDocument();
    expect(screen.getByText("RM49.50")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Confirm purchase" }));
    expect(confirmPurchase).toHaveBeenCalledWith(
      {
        merchant_id: "m_kak_lina_001",
        intake_id: "purchase_intake_001",
        expected_version: 4,
        confirmation_token: "confirmation_004"
      },
      expect.any(String)
    );
    expect(
      await screen.findByRole("heading", { name: "Purchase recorded" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "View dashboard for this date" })
    ).toHaveAttribute("href", "/?lang=en&date=2026-07-12");
    expect(
      window.localStorage.getItem(cashPurchaseStorageKey("m_kak_lina_001"))
    ).toBeNull();
  });

  it("reuses an unchanged failed upsert key and rotates it after editing", async () => {
    const user = userEvent.setup();
    const upsertPurchase = vi.fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(reviewResponse)
      .mockResolvedValueOnce({
        ...reviewResponse,
        version: 5,
        confirmation_token: "confirmation_005",
        summary: {
          ...reviewResponse.summary,
          supplier_name: "Pasar Petang"
        }
      });

    const first = render(
      <CashPurchaseFlow
        locale="en"
        merchantId="m_kak_lina_001"
        summaryDate="2026-07-12"
        catalog={catalog}
        upsertPurchase={upsertPurchase}
      />
    );
    await completeForm(user);
    await user.click(screen.getByRole("button", { name: "Review purchase" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Your draft is unchanged"
    );
    expect(screen.getByLabelText("Supplier")).toHaveValue("Pasar Pagi");
    const failedKey = upsertPurchase.mock.calls[0][1];

    first.unmount();
    render(
      <CashPurchaseFlow
        locale="en"
        merchantId="m_kak_lina_001"
        summaryDate="2026-07-12"
        catalog={catalog}
        upsertPurchase={upsertPurchase}
      />
    );
    expect(await screen.findByLabelText("Supplier")).toHaveValue("Pasar Pagi");
    await user.click(screen.getByRole("button", { name: "Review purchase" }));
    expect(upsertPurchase.mock.calls[1][1]).toBe(failedKey);

    await screen.findByRole("heading", { name: "Review cash purchase" });
    await user.click(screen.getByRole("button", { name: "Edit" }));
    await user.clear(screen.getByLabelText("Supplier"));
    await user.type(screen.getByLabelText("Supplier"), "Pasar Petang");
    await user.click(screen.getByRole("button", { name: "Review purchase" }));

    expect(upsertPurchase.mock.calls[2][1]).not.toBe(failedKey);
    expect(upsertPurchase.mock.calls[2][0]).toMatchObject({
      intake_id: "purchase_intake_001",
      expected_version: 4,
      supplier_name: "Pasar Petang"
    });
  });

  it("restores review state and retries confirm with the same key", async () => {
    const user = userEvent.setup();
    const uncertainConfirm = vi.fn().mockRejectedValue(new Error("offline"));
    const first = render(
      <CashPurchaseFlow
        locale="en"
        merchantId="m_kak_lina_001"
        summaryDate="2026-07-12"
        catalog={catalog}
        upsertPurchase={vi.fn().mockResolvedValue(reviewResponse)}
        confirmPurchase={uncertainConfirm}
      />
    );
    await completeForm(user);
    await user.click(screen.getByRole("button", { name: "Review purchase" }));
    await screen.findByRole("heading", { name: "Review cash purchase" });
    await user.click(screen.getByRole("button", { name: "Confirm purchase" }));
    await screen.findByRole("alert");
    const confirmKey = uncertainConfirm.mock.calls[0][1];

    first.unmount();
    const recoveredConfirm = vi.fn().mockResolvedValue({
      state: "committed",
      event_id: "cost_event_001"
    });
    render(
      <CashPurchaseFlow
        locale="en"
        merchantId="m_kak_lina_001"
        summaryDate="2026-07-12"
        catalog={catalog}
        confirmPurchase={recoveredConfirm}
      />
    );
    await screen.findByRole("heading", { name: "Review cash purchase" });
    await user.click(screen.getByRole("button", { name: "Confirm purchase" }));

    expect(recoveredConfirm.mock.calls[0][1]).toBe(confirmKey);
    await screen.findByRole("heading", { name: "Purchase recorded" });
    expect(
      window.localStorage.getItem(cashPurchaseStorageKey("m_kak_lina_001"))
    ).toBeNull();
  });

  it("keeps recovery scoped to the merchant", async () => {
    const user = userEvent.setup();
    const first = render(
      <CashPurchaseFlow
        locale="en"
        merchantId="m_kak_lina_001"
        summaryDate="2026-07-12"
        catalog={catalog}
      />
    );
    await user.type(screen.getByLabelText("Supplier"), "Pasar Pagi");
    await waitFor(() => {
      expect(
        window.localStorage.getItem(cashPurchaseStorageKey("m_kak_lina_001"))
      ).not.toBeNull();
    });

    first.unmount();
    render(
      <CashPurchaseFlow
        locale="en"
        merchantId="m_other_merchant"
        summaryDate="2026-07-12"
        catalog={{ ...catalog, merchant_id: "m_other_merchant" }}
      />
    );
    expect(await screen.findByLabelText("Supplier")).toHaveValue("");
  });

  it("shows a clear localized state for an authoritative empty catalog", () => {
    const first = render(
      <CashPurchaseFlow
        locale="en"
        merchantId="m_kak_lina_001"
        summaryDate="2026-07-12"
        catalog={{ ...catalog, components: [] }}
      />
    );
    expect(
      screen.getByRole("heading", { name: "No components available" })
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Review purchase" }))
      .not.toBeInTheDocument();

    first.unmount();
    const second = render(
      <CashPurchaseFlow
        locale="ms"
        merchantId="m_kak_lina_001"
        summaryDate="2026-07-12"
        catalog={{ ...catalog, components: [] }}
      />
    );
    expect(
      screen.getByRole("heading", { name: "Tiada komponen tersedia" })
    ).toBeInTheDocument();

    second.unmount();
    render(
      <CashPurchaseFlow
        locale="zh"
        merchantId="m_kak_lina_001"
        summaryDate="2026-07-12"
        catalog={{ ...catalog, components: [] }}
      />
    );
    expect(
      screen.getByRole("heading", { name: "没有可用的原料项目" })
    ).toBeInTheDocument();
  });

  it("provides complete Malay and Chinese cash purchase labels", () => {
    const first = render(
      <CashPurchaseFlow
        locale="ms"
        merchantId="m_kak_lina_001"
        summaryDate="2026-07-12"
        catalog={catalog}
      />
    );
    expect(
      screen.getByRole("heading", { name: "Rekod pembelian tunai" })
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Satu unit mengandungi")).toBeInTheDocument();

    first.unmount();
    render(
      <CashPurchaseFlow
        locale="zh"
        merchantId="m_kak_lina_001"
        summaryDate="2026-07-12"
        catalog={catalog}
      />
    );
    expect(
      screen.getByRole("heading", { name: "记录现金采购" })
    ).toBeInTheDocument();
    expect(screen.getByLabelText("每个单位包含")).toBeInTheDocument();
    expect(screen.queryByText("MarketAI")).not.toBeInTheDocument();
  });
});
