import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Dashboard } from "@/components/dashboard";
import { goldenDashboardFixture } from "./fixtures";

describe("merchant dashboard", () => {
  it("shows the golden daily margin state without demo or data-quality banners", () => {
    render(<Dashboard initialData={goldenDashboardFixture} locale="en" />);

    expect(
      screen.getByRole("heading", { name: "Today’s gross margin" })
    ).toBeInTheDocument();
    expect(screen.getAllByText("36.40%")).toHaveLength(2);
    expect(
      screen.getByText(
        "The red bar and marker show today's gross margin. The baseline value is listed below."
      )
    ).toBeInTheDocument();
    expect(
      screen.getByRole("img", {
        name: "Today: 36.40%. Baseline: 42.00%."
      })
    ).toBeInTheDocument();
    expect(
      document.querySelector(".track-current-marker")
    ).toHaveStyle({ left: "72.8%" });
    expect(
      document.querySelector(".track-baseline-marker")
    ).not.toBeInTheDocument();
    expect(
      document.querySelector(".baseline-label--end")
    ).toHaveTextContent("Baseline42.00%");
    expect(screen.getByLabelText("Proposed price")).toHaveValue("0.00");
    expect(screen.getByLabelText("Expected quantity")).toHaveValue("0");
    expect(screen.getByText("RM72.80")).toBeInTheDocument();
    expect(screen.getByText("RM3.18")).toBeInTheDocument();
    expect(
      screen.getByText("Baseline date", {
        selector: ".cost-snapshot-date span"
      })
    ).toBeInTheDocument();
    expect(screen.getByText("11 Jul 2026")).toBeInTheDocument();
    expect(screen.queryByText("Data quality")).not.toBeInTheDocument();
    expect(screen.queryByText("Synthetic demo data")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Live Advisor")).not.toBeInTheDocument();
    expect(document.querySelector("elevenlabs-convai")).toBeNull();
  });

  it("renders previous-day cost decreases with the correct sign", () => {
    render(
      <Dashboard
        initialData={{
          ...goldenDashboardFixture,
          costStack: {
            baselineDate: "2026-07-11",
            baselineUnitCogsRm: "3.24",
            currentUnitCogsRm: "3.18",
            components: [{
              id: "c_egg",
              name: "Telur",
              changeRmPerPack: "-0.06",
              tone: "egg",
              evidenceId: null
            }]
          }
        }}
        locale="en"
      />
    );

    expect(screen.getByText("-RM0.06")).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "Cost segment: Telur, -RM0.06"
      })
    ).toHaveClass("stack-increment--decrease");
  });

  it("localizes navigation and labels while keeping the recipe title and PasarAI brand", async () => {
    const user = userEvent.setup();

    render(<Dashboard initialData={goldenDashboardFixture} locale="en" />);

    expect(
      screen.getByRole("heading", { level: 1, name: "Nasi Lemak Biasa" })
    ).toBeInTheDocument();
    expect(
      document.querySelector(".brand-lockup strong")
    ).toHaveTextContent("PasarAI");
    expect(screen.getByText("Talk. Snap. Know your profit.")).toBeInTheDocument();
    expect(screen.getByText("Revenue")).toBeInTheDocument();
    expect(screen.getByText("Cost of sales")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "BM" }));
    expect(
      screen.getByRole("heading", { level: 1, name: "Nasi Lemak Biasa" })
    ).toBeInTheDocument();
    expect(screen.getByText("Cakap. Snap. Tahu untung.")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Papan pemuka" })
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Resit" })).toBeInTheDocument();
    expect(screen.getByText("Hasil jualan")).toBeInTheDocument();
    expect(screen.getByText("Kos jualan")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "中文" }));
    expect(
      screen.getByRole("heading", { level: 1, name: "Nasi Lemak Biasa" })
    ).toBeInTheDocument();
    expect(screen.getByText("说一说。拍一拍。看清利润。")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "仪表板" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "收据" })).toBeInTheDocument();
    expect(screen.getByText("销售收入")).toBeInTheDocument();
    expect(screen.getByText("销售成本")).toBeInTheDocument();
  });

  it("switches products and adds a session-only recipe without API work", async () => {
    const user = userEvent.setup();
    const simulatePrice = vi.fn();

    render(
      <Dashboard
        initialData={goldenDashboardFixture}
        locale="en"
        simulatePrice={simulatePrice}
      />
    );

    const menuTrigger = screen.getByRole("button", {
      name: "Choose product"
    });
    expect(
      document.querySelector(".page-intro-title")?.firstElementChild
    ).toBe(menuTrigger);
    await user.click(menuTrigger);

    expect(
      screen.getByRole("dialog", { name: "Products sold here" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "Nasi Lemak Biasa, Connected, Selected"
      })
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.getByRole("button", {
        name: "Nasi Lemak Ayam Goreng"
      })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "Nasi Lemak Rendang Daging"
      })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "Nasi Lemak Sambal Sotong"
      })
    ).toBeInTheDocument();
    expect(screen.queryByText("Demo")).not.toBeInTheDocument();

    await user.click(
      screen.getByRole("button", {
        name: "Nasi Lemak Ayam Goreng"
      })
    );

    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "Nasi Lemak Ayam Goreng"
      })
    ).toBeInTheDocument();
    expect(document.querySelector(".demo-preview-chip")).toBeNull();
    expect(screen.getAllByText("35.00%")).toHaveLength(2);
    expect(screen.getByText("RM100.80")).toBeInTheDocument();
    expect(screen.getByText("RM4.30")).toBeInTheDocument();
    expect(screen.getByText("RM4.50")).toBeInTheDocument();
    expect(
      screen.getByText("Placeholder metrics for demonstration only")
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Add purchase" })
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("Proposed price")).toBeDisabled();
    expect(screen.getByLabelText("Expected quantity")).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Run simulation" })
    ).toBeDisabled();
    expect(simulatePrice).not.toHaveBeenCalled();

    await user.click(menuTrigger);
    await user.click(screen.getByRole("button", { name: "Add recipe" }));
    await user.type(
      screen.getByLabelText("Recipe name"),
      "Nasi Lemak Ikan Keli"
    );
    await user.click(screen.getByRole("button", { name: "Add recipe" }));

    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "Nasi Lemak Ikan Keli"
      })
    ).toBeInTheDocument();
    expect(screen.getByText("RM75.60")).toBeInTheDocument();
    expect(screen.getByText("RM3.90")).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Add purchase" })
    ).not.toBeInTheDocument();
    expect(simulatePrice).not.toHaveBeenCalled();

    await user.click(menuTrigger);
    expect(
      screen.getByRole("button", {
        name: "Nasi Lemak Ikan Keli, Selected"
      })
    ).toHaveAttribute("aria-pressed", "true");
    await user.keyboard("{Escape}");
    expect(
      screen.queryByRole("dialog", { name: "Products sold here" })
    ).not.toBeInTheDocument();
    expect(menuTrigger).toHaveFocus();

    await user.click(menuTrigger);
    await user.click(
      screen.getByRole("button", {
        name: "Nasi Lemak Biasa, Connected"
      })
    );
    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "Nasi Lemak Biasa"
      })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Add purchase" })
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Proposed price")).toBeEnabled();
  });

  it("closes the product picker with Escape and restores focus", async () => {
    const user = userEvent.setup();

    render(<Dashboard initialData={goldenDashboardFixture} locale="en" />);

    const menuTrigger = screen.getByRole("button", {
      name: "Choose product"
    });
    await user.click(menuTrigger);
    await user.keyboard("{Escape}");
    expect(
      screen.queryByRole("dialog", { name: "Products sold here" })
    ).not.toBeInTheDocument();
    expect(menuTrigger).toHaveFocus();

  });

  it("localizes the missing cost data prompt for every supported language", async () => {
    const user = userEvent.setup();
    const unavailableFixture = {
      ...goldenDashboardFixture,
      costStack: {
        unavailableReason:
          "Please upload an item with its price, or a receipt"
      }
    };

    render(<Dashboard initialData={unavailableFixture} locale="en" />);

    expect(
      screen.getByText("Please upload an item with its price, or a receipt")
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "BM" }));
    expect(
      screen.getByText("Sila muat naik item berserta harganya, atau resit")
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "中文" }));
    expect(
      screen.getByText("请上传带有价格的商品，或上传收据")
    ).toBeInTheDocument();
  });

  it("runs a read-only price simulation through the API boundary", async () => {
    const user = userEvent.setup();
    const simulatePrice = vi.fn().mockResolvedValue({
      revenue_rm: "192.50",
      cogs_rm: "111.30",
      gross_profit_rm: "81.20",
      gross_margin_pct: "42.18",
      incremental_gross_profit_vs_today_rm: "8.40",
      assumption: "constant_demand"
    });

    render(
      <Dashboard
        initialData={goldenDashboardFixture}
        locale="en"
        simulatePrice={simulatePrice}
      />
    );

    await user.clear(screen.getByLabelText("Proposed price"));
    await user.type(screen.getByLabelText("Proposed price"), "5.50");
    await user.clear(screen.getByLabelText("Expected quantity"));
    await user.type(screen.getByLabelText("Expected quantity"), "35");
    await user.click(screen.getByRole("button", { name: "Run simulation" }));

    expect(simulatePrice).toHaveBeenCalledWith({
      merchant_id: "m_kak_lina_001",
      product_id: "p_nlb_001",
      quantity: "35",
      proposed_unit_price_rm: "5.50",
      as_of: "2026-07-12"
    });
    expect(await screen.findByText("RM81.20")).toBeInTheDocument();
    expect(screen.getByText("Assumes demand stays constant")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /save|commit/i })
    ).not.toBeInTheDocument();
  });

  it("opens the exact receipt evidence for a changed cost component", async () => {
    const user = userEvent.setup();

    render(<Dashboard initialData={goldenDashboardFixture} locale="en" />);

    await user.click(
      screen.getByRole("button", { name: "View evidence for Telur" })
    );

    expect(
      screen.getByRole("dialog", { name: "Sinar Borong Jaya receipt" })
    ).toBeInTheDocument();
    expect(screen.getByText("SBR-120726-184")).toBeInTheDocument();
    expect(
      screen.getByText("Telur Gred B 30 biji x 3 tray")
    ).toBeInTheDocument();
    expect(
      screen.getByRole("img", {
        name: "Sinar Borong Jaya receipt: Source evidence"
      })
    ).toHaveAttribute(
      "src",
      "/evidence/receipt_001_sinar_borong.jpg"
    );
    expect(
      screen.getByRole("link", { name: "Open receipt SBR-120726-184" })
    ).toHaveAttribute("href", "/evidence/receipt_001_sinar_borong.jpg");
  });

  it("keeps shared receipt evidence aligned with the clicked cost item", async () => {
    const user = userEvent.setup();
    const sharedReceiptFixture = {
      ...goldenDashboardFixture,
      costStack: {
        baselineUnitCogsRm: "2.90",
        currentUnitCogsRm: "3.18",
        components: [
          {
            id: "c_anchovy",
            name: "Ikan Bilis",
            changeRmPerPack: "0.00",
            tone: "egg" as const,
            evidenceId: "receipt-pasar"
          },
          {
            id: "c_peanut",
            name: "Kacang Tanah",
            changeRmPerPack: "0.00",
            tone: "sambal" as const,
            evidenceId: "receipt-pasar"
          }
        ]
      },
      evidence: [{
        id: "receipt-pasar",
        title: "Pasar Pagi SS2 receipt",
        imageUrl: "/evidence/receipt_003_pasar_pagi.jpg",
        receiptId: "PPSS2-1207",
        supplierName: "Pasar Pagi SS2",
        transcript: null,
        lineItems: [
          {
            rawName: "Kacang 2kg",
            componentId: "c_peanut",
            totalPriceRm: "24.00",
            confidence: "1.00"
          },
          {
            rawName: "Ikan bilis 1kg",
            componentId: "c_anchovy",
            totalPriceRm: "28.50",
            confidence: "1.00"
          }
        ]
      }]
    };

    render(
      <Dashboard initialData={sharedReceiptFixture} locale="en" />
    );

    await user.click(
      screen.getByRole("button", { name: "View evidence for Ikan Bilis" })
    );
    expect(screen.getByText("Ikan bilis 1kg")).toBeInTheDocument();
    expect(screen.getByText("RM28.50")).toBeInTheDocument();
    expect(screen.queryByText("Kacang 2kg")).not.toBeInTheDocument();

    await user.click(
      screen.getAllByRole("button", { name: "Close evidence" })[0]
    );
    await user.click(
      screen.getByRole("button", { name: "View evidence for Kacang Tanah" })
    );
    expect(screen.getByText("Kacang 2kg")).toBeInTheDocument();
    expect(screen.getByText("RM24.00")).toBeInTheDocument();
    expect(screen.queryByText("Ikan bilis 1kg")).not.toBeInTheDocument();
  });

  it("never substitutes another receipt line when the clicked item is missing", async () => {
    const user = userEvent.setup();
    const mismatchedReceiptFixture = {
      ...goldenDashboardFixture,
      costStack: {
        baselineUnitCogsRm: "2.90",
        currentUnitCogsRm: "3.18",
        components: [{
          id: "c_anchovy",
          name: "Ikan Bilis",
          changeRmPerPack: "0.00",
          tone: "egg" as const,
          evidenceId: "receipt-pasar"
        }]
      },
      evidence: [{
        id: "receipt-pasar",
        title: "Pasar Pagi SS2 receipt",
        imageUrl: "/evidence/receipt_003_pasar_pagi.jpg",
        receiptId: "PPSS2-1207",
        supplierName: "Pasar Pagi SS2",
        transcript: null,
        lineItems: [{
          rawName: "Kacang 2kg",
          componentId: "c_peanut",
          totalPriceRm: "24.00",
          confidence: "1.00"
        }]
      }]
    };

    render(
      <Dashboard initialData={mismatchedReceiptFixture} locale="en" />
    );

    await user.click(
      screen.getByRole("button", { name: "View evidence for Ikan Bilis" })
    );

    expect(screen.getByText("Evidence projection unavailable")).toBeInTheDocument();
    expect(screen.queryByText("Kacang 2kg")).not.toBeInTheDocument();
  });

  it("localizes dashboard labels without changing merchant financial tokens", () => {
    render(<Dashboard initialData={goldenDashboardFixture} locale="zh" />);

    expect(
      screen.getByRole("heading", { name: "今日毛利率" })
    ).toBeInTheDocument();
    expect(screen.getByText("价格与销量模拟")).toBeInTheDocument();
    expect(screen.getAllByText("36.40%")).toHaveLength(2);
    expect(screen.getByText("RM72.80")).toBeInTheDocument();
    expect(
      screen.getByText(/Nasi Lemak Biasa/u, {
        selector: ".merchant-context small"
      })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 1, name: "Nasi Lemak Biasa" })
    ).toBeInTheDocument();
  });

  it("renders the selected summary date instead of a hardcoded rehearsal date", () => {
    render(
      <Dashboard
        initialData={{
          ...goldenDashboardFixture,
          summary: {
            ...goldenDashboardFixture.summary,
            date: "2026-07-10"
          }
        }}
        locale="en"
      />
    );

    const date = screen.getByLabelText("Reporting date");
    expect(date).toHaveAttribute("type", "date");
    expect(date).toHaveValue("2026-07-10");
    expect(date).toHaveAttribute("min", "2026-07-05");
    expect(date).toHaveAttribute("max", "2026-07-12");
    expect(
      screen.getByRole("link", { name: "Previous day" })
    ).toHaveAttribute("href", "/?lang=en&date=2026-07-09");
    expect(
      screen.getByRole("link", { name: "Next day" })
    ).toHaveAttribute("href", "/?lang=en&date=2026-07-11");
    expect(
      screen.getByRole("link", { name: "Receipts" })
    ).toHaveAttribute("href", "/receipts?lang=en&date=2026-07-10");
    expect(
      screen.getByRole("link", { name: "Integrations" })
    ).toHaveAttribute(
      "href",
      "/settings/integrations?lang=en&date=2026-07-10"
    );
    expect(screen.queryByText(/Read only/i)).not.toBeInTheDocument();
  });

  it("links the purchase action to the selected date and language", () => {
    render(<Dashboard initialData={goldenDashboardFixture} locale="en" />);

    expect(
      screen.getByRole("link", { name: "Add purchase" })
    ).toHaveAttribute(
      "href",
      "/receipts?lang=en&date=2026-07-12&entry=cash"
    );
  });
});
