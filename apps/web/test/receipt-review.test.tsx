import {
  cleanup,
  render,
  screen,
  waitFor,
  within
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  CostsResponse,
  ReceiptReviewsResponse,
  ReceiptReviewUpsertResponse
} from "@pasarai/contracts/v1";

import { ReceiptReview } from "@/components/receipt-review";
import { ReceiptReviewScreen } from "@/components/receipt-review-screen";
import type { ReceiptReviewRecord } from "@/lib/dashboard-types";
import { receiptReviewRecords } from "@/lib/receipt-upload";
import {
  loadReceiptReviews,
  mergeReceiptReviewHistory,
  receiptReviewStorageKey,
  saveReceiptReviews
} from "@/lib/receipt-review-storage";
import { goldenDashboardFixture } from "./fixtures";

const receiptScreenContext = {
  merchant: goldenDashboardFixture.merchant,
  summaryDate: goldenDashboardFixture.summary.date,
  dateRange: goldenDashboardFixture.dateRange,
  componentCatalog: {
    merchant_id: goldenDashboardFixture.merchant.id,
    components: [
      { component_id: "c_anchovy", name: "Ikan Bilis" },
      { component_id: "c_cucumber", name: "Timun" },
      { component_id: "c_egg", name: "Telur" },
      { component_id: "c_peanut", name: "Kacang Tanah" }
    ]
  }
};

const translationReceipt: ReceiptReviewRecord = {
  id: "receipt-translation",
  title: "Pasar Pagi SS2",
  imageUrl: "/evidence/receipt_003_pasar_pagi.jpg",
  sourceEventId: "receipt-translation",
  extraction: {
    receipt_id: "PPSS2-1207",
    supplier_name: "Pasar Pagi SS2",
    date: "2026-07-12",
    currency: "MYR",
    line_items: [
      {
        raw_name: "Kacang",
        normalized_component_id: "c_peanut",
        quantity: "1",
        uom: "pack",
        pack_size: null,
        unit_price_rm: "8.00",
        total_price_rm: "8.00",
        confidence: "0.78"
      }
    ],
    total_rm: "8.00",
    overall_confidence: "0.78",
    ambiguities: [
      {
        field: "line_items[0].normalized_component_id",
        question: "Does Kacang refer to peanuts?",
        options: []
      }
    ]
  }
};

const confirmableReceipt: ReceiptReviewRecord = {
  ...translationReceipt,
  readyToConfirm: true,
  extraction: {
    ...translationReceipt.extraction,
    line_items: translationReceipt.extraction.line_items.map((line) => ({
      ...line,
      pack_size: "1"
    })),
    ambiguities: []
  }
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function receiptHistoryEntry(
  receipt: ReceiptReviewRecord,
  overrides: Partial<ReceiptReviewsResponse["receipts"][number]> = {}
): ReceiptReviewsResponse["receipts"][number] {
  return {
    receipt_event_id: receipt.id,
    review_state: receipt.confirmed ? "verified" : "draft",
    version: receipt.reviewVersion ?? 1,
    title: receipt.title,
    image_uri: receipt.evidenceUri ?? receipt.imageUrl,
    uploaded_at: "2026-07-16T08:00:00.000Z",
    updated_at: receipt.updatedAt ?? "2026-07-16T08:00:00.000Z",
    extraction: receipt.extraction,
    confirmed: Boolean(receipt.confirmed),
    cost_event_id: receipt.costEventId ?? null,
    verified_at: receipt.verifiedAt ?? null,
    material_changes: (receipt.materialChanges ?? []).map((change) => ({
      component_id: change.componentId,
      component_name: change.componentName,
      product_id: change.productId,
      quantity: change.quantity,
      uom: change.uom,
      pack_size: change.packSize,
      total_price_rm: change.totalPriceRm,
      previous_cost_rm_per_pack: change.previousCostRmPerPack,
      current_cost_rm_per_pack: change.currentCostRmPerPack,
      change_rm_per_pack: change.changeRmPerPack
    })),
    ...overrides
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe("receipt review", () => {
  it("keeps an ambiguous receipt in review and preserves the uploaded image", async () => {
    const user = userEvent.setup();
    const onUpload = vi.fn();
    const image = new File(["receipt"], "receipt_003_pasar_pagi.jpg", {
      type: "image/jpeg"
    });

    render(
      <ReceiptReview
        locale="en"
        onUpload={onUpload}
        receipt={{
          id: "receipt-pasar",
          title: "Pasar Pagi SS2 receipt",
          imageUrl: "/evidence/receipt_003_pasar_pagi.jpg",
          extraction: {
            receipt_id: "PPSS2-1207",
            supplier_name: "Pasar Pagi SS2",
            date: "2026-07-12",
            currency: "MYR",
            line_items: [
              {
                raw_name: "Ikan bilis 1kg",
                normalized_component_id: "c_anchovy",
                quantity: "1",
                uom: "kg",
                pack_size: null,
                unit_price_rm: "28.50",
                total_price_rm: "28.50",
                confidence: "0.72"
              }
            ],
            total_rm: "64.50",
            overall_confidence: "0.78",
            ambiguities: [
              {
                field: "line_items[0].quantity",
                question: "Confirm ikan bilis quantity and total?",
                options: ["1 kg, RM28.50", "Needs correction"]
              }
            ]
          }
        }}
      />
    );

    await user.upload(screen.getByLabelText("Upload receipt photo"), image);

    expect(onUpload).toHaveBeenCalledWith(image);
    expect(screen.getByText("Needs confirmation")).toBeInTheDocument();
    expect(
      screen.getByText("Confirm ikan bilis quantity and total?")
    ).toBeInTheDocument();
    expect(
      screen.getByRole("img", {
        name: "Pasar Pagi SS2 receipt source evidence"
      })
    ).toHaveAttribute("src", "/evidence/receipt_003_pasar_pagi.jpg");
    expect(
      screen.queryByRole("button", { name: /commit/i })
    ).not.toBeInTheDocument();
  });
});

describe("receipt confirmation integration", () => {
  it("opens the cash entry tab and supports arrow-key tab navigation", async () => {
    const user = userEvent.setup();

    render(
      <ReceiptReviewScreen
        {...receiptScreenContext}
        initialEntry="cash"
        locale="en"
      />
    );

    const cashTab = screen.getByRole("tab", { name: "Cash purchase" });
    const receiptTab = screen.getByRole("tab", { name: "Receipt image" });
    expect(cashTab).toHaveAttribute("aria-selected", "true");
    expect(
      screen.getByRole("heading", { name: "Record a cash purchase" })
    ).toBeInTheDocument();

    cashTab.focus();
    await user.keyboard("{ArrowLeft}");
    expect(receiptTab).toHaveFocus();
    expect(receiptTab).toHaveAttribute("aria-selected", "true");
    expect(
      screen.getByRole("heading", { name: "Receipt review" })
    ).toBeInTheDocument();
  });

  it("keeps the dashboard header visible with Receipts selected", async () => {
    const user = userEvent.setup();

    render(
      <ReceiptReviewScreen
        {...receiptScreenContext}
        locale="en"
        initialReceipt={translationReceipt}
      />
    );

    expect(document.querySelector(".topbar")).toBeInTheDocument();
    expect(screen.getByText("PasarAI")).toBeInTheDocument();
    expect(
      screen.getByText("Kedai Kak Lina Nasi Lemak")
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Reporting date")).toHaveValue(
      "2026-07-12"
    );
    expect(
      screen.getByRole("link", { name: "Dashboard" })
    ).toHaveAttribute("href", "/?lang=en&date=2026-07-12");
    expect(
      screen.queryByRole("link", { name: /← Dashboard/i })
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Receipts" })
    ).toHaveAttribute("aria-current", "page");
    expect(
      screen.getByRole("button", { name: "Next day" })
    ).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "BM" }));
    expect(
      screen.getByRole("link", { name: "Papan pemuka" })
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Resit" })).toHaveAttribute(
      "aria-current",
      "page"
    );
    expect(screen.getByLabelText("Tarikh laporan")).toHaveValue(
      "2026-07-12"
    );
    expect(
      screen.getByRole("heading", { name: "Semakan resit" })
    ).toBeInTheDocument();
    const malayReceiptPanel = screen.getByRole("tabpanel", {
      name: "Imej resit"
    });
    expect(
      within(malayReceiptPanel).getByText("PasarAI - KEMAS KINI HARIAN")
    ).toBeInTheDocument();
    expect(
      within(malayReceiptPanel).getByLabelText("Pembekal")
    ).toBeInTheDocument();
    expect(screen.getByText("Sebelum pengesahan")).toBeInTheDocument();
    expect(
      screen.getByText("Baris 1 memerlukan saiz pek positif.")
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Perlu pembetulan" })
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "中文" }));
    expect(
      screen.getByRole("heading", { name: "收据审核" })
    ).toBeInTheDocument();
    const chineseReceiptPanel = screen.getByRole("tabpanel", {
      name: "收据图片"
    });
    expect(
      within(chineseReceiptPanel).getByText("PasarAI - 每日更新")
    ).toBeInTheDocument();
    expect(
      within(chineseReceiptPanel).getByLabelText("供应商")
    ).toBeInTheDocument();
    expect(screen.getByText("确认前")).toBeInTheDocument();
    expect(
      screen.getByText("第 1 行 需要大于零的包装数量。")
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "需要更正" })
    ).toBeInTheDocument();
    expect(screen.queryByText("MarketAI")).not.toBeInTheDocument();
  });

  it("records a ready extraction only after the merchant confirms", async () => {
    const user = userEvent.setup();
    const extraction = {
      receipt_id: "SBR-120726-184",
      supplier_name: "Sinar Borong Jaya",
      date: "2026-07-12",
      currency: "MYR" as const,
      line_items: [
        {
          raw_name: "Telur Gred B 30 biji x 3 tray",
          normalized_component_id: "c_egg",
          quantity: "3",
          uom: "tray",
          pack_size: "30",
          unit_price_rm: "16.50",
          total_price_rm: "49.50",
          confidence: "0.98"
        }
      ],
      total_rm: "49.50",
      overall_confidence: "0.98",
      ambiguities: []
    };
    const extractReceipt = vi.fn().mockResolvedValue({
      state: "ready_for_review",
      event_id: "receipt-upload-001",
      evidence_uri: "synthetic://evidence/receipt-upload-001",
      extraction
    });
    const confirmReceipt = vi.fn().mockResolvedValue({
      state: "committed",
      event_id: "cost-receipt-001"
    });
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:receipt-upload-001")
    });
    const image = new File(["receipt"], "receipt_001.jpg", {
      type: "image/jpeg"
    });

    render(
      <ReceiptReviewScreen
        {...receiptScreenContext}
        locale="en"
        extractReceipt={extractReceipt}
        confirmReceipt={confirmReceipt}
      />
    );
    await user.upload(screen.getByLabelText("Upload receipt photo"), image);
    await user.click(
      await screen.findByRole("button", {
        name: "Confirm and record costs"
      })
    );

    expect(confirmReceipt).toHaveBeenCalledWith(expect.objectContaining({
      merchantId: "m_kak_lina_001",
      receiptEventId: "receipt-upload-001",
      extraction
    }));
    expect(
      await screen.findByRole("button", { name: "Verified costs recorded" })
    ).toBeInTheDocument();
  });

  it("edits and resolves receipt 003 before committing the confirmed extraction", async () => {
    const user = userEvent.setup();
    const extractReceipt = vi.fn().mockResolvedValue({
      state: "clarification_required",
      event_id: "receipt-upload-003",
      evidence_uri: "synthetic://evidence/receipt-upload-003",
      extraction: {
        receipt_id: "PPSS2-1207",
        supplier_name: "Pasar Pagi SS2",
        date: "2026-07-12",
        currency: "MYR",
        line_items: [
          {
            raw_name: "Timun 3kg",
            normalized_component_id: "c_cucumber",
            quantity: "3",
            uom: "kg",
            pack_size: null,
            unit_price_rm: "4.00",
            total_price_rm: "12.00",
            confidence: "0.95"
          },
          {
            raw_name: "Kacang 2kg",
            normalized_component_id: "c_peanut",
            quantity: "2",
            uom: "kg",
            pack_size: null,
            unit_price_rm: "12.00",
            total_price_rm: "24.00",
            confidence: "0.96"
          },
          {
            raw_name: "Ikan bilis 1kg",
            normalized_component_id: "c_anchovy",
            quantity: null,
            uom: null,
            pack_size: null,
            unit_price_rm: null,
            total_price_rm: null,
            confidence: "0.72"
          }
        ],
        total_rm: "64.50",
        overall_confidence: "0.78",
        ambiguities: [
          {
            field: "line_items[2].quantity",
            question: "Confirm ikan bilis quantity and total?",
            options: ["1 kg, RM28.50", "Needs correction"]
          }
        ]
      },
      clarifications: [
        {
          field: "line_items[2].quantity",
          question: "Confirm ikan bilis quantity and total?",
          options: ["1 kg, RM28.50", "Needs correction"]
        }
      ]
    });
    const confirmReceipt = vi.fn().mockResolvedValue({
      state: "committed",
      event_id: "cost-receipt-003"
    });
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:receipt-upload-003")
    });
    const image = new File(["receipt"], "receipt_003_pasar_pagi.jpg", {
      type: "image/jpeg"
    });

    render(
      <ReceiptReviewScreen
        {...receiptScreenContext}
        locale="en"
        extractReceipt={extractReceipt}
        confirmReceipt={confirmReceipt}
      />
    );

    await user.upload(screen.getByLabelText("Upload receipt photo"), image);
    const confirmButton = await screen.findByRole("button", {
      name: "Confirm and record costs"
    });
    expect(confirmButton).toBeDisabled();
    expect(
      screen.getByRole("img", {
        name: "Pasar Pagi SS2 receipt source evidence"
      })
    ).toHaveAttribute("src", "synthetic://evidence/receipt-upload-003");

    await user.type(screen.getByLabelText("Line 1 pack size"), "1");
    await user.type(screen.getByLabelText("Line 2 pack size"), "1");
    await user.type(screen.getByLabelText("Line 3 pack size"), "1");
    await user.click(
      screen.getByRole("button", { name: "1 kg, RM28.50" })
    );

    expect(
      screen.queryByText("Confirm ikan bilis quantity and total?")
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("Line 3 quantity")).toHaveValue("1");
    expect(screen.getByLabelText("Line 3 unit")).toHaveValue("kg");
    expect(screen.getByLabelText("Line 3 line total")).toHaveValue("28.50");
    expect(confirmButton).toBeEnabled();

    await user.click(confirmButton);

    expect(confirmReceipt).toHaveBeenCalledTimes(1);
    expect(confirmReceipt).toHaveBeenCalledWith(expect.objectContaining({
      merchantId: "m_kak_lina_001",
      receiptEventId: "receipt-upload-003",
      extraction: expect.objectContaining({
        receipt_id: "PPSS2-1207",
        supplier_name: "Pasar Pagi SS2",
        total_rm: "64.50",
        ambiguities: [],
        line_items: [
          expect.objectContaining({ pack_size: "1" }),
          expect.objectContaining({ pack_size: "1" }),
          expect.objectContaining({
            quantity: "1",
            uom: "kg",
            pack_size: "1",
            unit_price_rm: "28.50",
            total_price_rm: "28.50",
            confidence: "0.72"
          })
        ]
      })
    }));
    expect(
      await screen.findByRole("button", { name: "Verified costs recorded" })
    ).toBeInTheDocument();
  });

  it("does not commit receipt 003 while its clarification is unresolved", async () => {
    const user = userEvent.setup();
    const confirmReceipt = vi.fn();
    const extractReceipt = vi.fn().mockResolvedValue({
      state: "clarification_required",
      event_id: "receipt-upload-003-unresolved",
      evidence_uri: "synthetic://evidence/receipt-upload-003-unresolved",
      extraction: {
        receipt_id: "PPSS2-1207",
        supplier_name: "Pasar Pagi SS2",
        date: "2026-07-12",
        currency: "MYR",
        line_items: [
          {
            raw_name: "Ikan bilis 1kg",
            normalized_component_id: "c_anchovy",
            quantity: "1",
            uom: "kg",
            pack_size: "1",
            unit_price_rm: "28.50",
            total_price_rm: "28.50",
            confidence: "1"
          }
        ],
        total_rm: "28.50",
        overall_confidence: "0.78",
        ambiguities: [
          {
            field: "line_items[0].quantity",
            question: "Confirm ikan bilis quantity and total?",
            options: ["1 kg, RM28.50", "Needs correction"]
          }
        ]
      },
      clarifications: [
        {
          field: "line_items[0].quantity",
          question: "Confirm ikan bilis quantity and total?",
          options: ["1 kg, RM28.50", "Needs correction"]
        }
      ]
    });
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:receipt-upload-003-unresolved")
    });

    render(
      <ReceiptReviewScreen
        {...receiptScreenContext}
        locale="en"
        extractReceipt={extractReceipt}
        confirmReceipt={confirmReceipt}
      />
    );
    await user.upload(
      screen.getByLabelText("Upload receipt photo"),
      new File(["receipt"], "receipt_003_pasar_pagi.jpg", {
        type: "image/jpeg"
      })
    );

    const confirmButton = await screen.findByRole("button", {
      name: "Confirm and record costs"
    });
    expect(confirmButton).toBeDisabled();
    await user.click(confirmButton);
    expect(confirmReceipt).not.toHaveBeenCalled();
  });

  it("keeps receipt 003 blocked after requesting manual correction until the field is edited", async () => {
    const user = userEvent.setup();
    const confirmReceipt = vi.fn();
    const extractReceipt = vi.fn().mockResolvedValue({
      state: "clarification_required",
      event_id: "receipt-upload-003-manual",
      evidence_uri: "synthetic://evidence/receipt-upload-003-manual",
      extraction: {
        receipt_id: "PPSS2-1207",
        supplier_name: "Pasar Pagi SS2",
        date: "2026-07-12",
        currency: "MYR",
        line_items: [
          {
            raw_name: "Ikan bilis 1kg",
            normalized_component_id: "c_anchovy",
            quantity: "1",
            uom: "kg",
            pack_size: "1",
            unit_price_rm: "28.50",
            total_price_rm: "28.50",
            confidence: "1"
          }
        ],
        total_rm: "28.50",
        overall_confidence: "0.78",
        ambiguities: [
          {
            field: "line_items[0].quantity",
            question: "Confirm ikan bilis quantity and total?",
            options: ["1 kg, RM28.50", "Needs correction"]
          }
        ]
      },
      clarifications: [
        {
          field: "line_items[0].quantity",
          question: "Confirm ikan bilis quantity and total?",
          options: ["1 kg, RM28.50", "Needs correction"]
        }
      ]
    });
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:receipt-upload-003-manual")
    });

    render(
      <ReceiptReviewScreen
        {...receiptScreenContext}
        locale="en"
        extractReceipt={extractReceipt}
        confirmReceipt={confirmReceipt}
      />
    );
    await user.upload(
      screen.getByLabelText("Upload receipt photo"),
      new File(["receipt"], "receipt_003_pasar_pagi.jpg", {
        type: "image/jpeg"
      })
    );
    await user.click(
      await screen.findByRole("button", { name: "Needs correction" })
    );

    expect(
      screen.getByText(
        "Edit the highlighted field to resolve this question."
      )
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Confirm and record costs" })
    ).toBeDisabled();
    expect(confirmReceipt).not.toHaveBeenCalled();

    const quantity = screen.getByLabelText("Line 1 quantity");
    await user.clear(quantity);
    expect(
      screen.getByText("Confirm ikan bilis quantity and total?")
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Confirm and record costs" })
    ).toBeDisabled();

    await user.type(quantity, "1");
    expect(
      screen.queryByText("Confirm ikan bilis quantity and total?")
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Confirm and record costs" })
    ).toBeEnabled();
    expect(confirmReceipt).not.toHaveBeenCalled();
  });
});

describe("receipt upload integration", () => {
  it("sends the selected image to the receipt API and renders returned review data", async () => {
    const user = userEvent.setup();
    const extractReceipt = vi.fn().mockResolvedValue({
      state: "clarification_required",
      event_id: "receipt-upload-003",
      evidence_uri: "synthetic://evidence/receipt-upload-003",
      extraction: {
        receipt_id: "PPSS2-1207",
        supplier_name: "Pasar Pagi SS2",
        date: "2026-07-12",
        currency: "MYR",
        line_items: [
          {
            raw_name: "Ikan bilis 1kg",
            normalized_component_id: "c_anchovy",
            quantity: "1",
            uom: "kg",
            pack_size: null,
            unit_price_rm: "28.50",
            total_price_rm: "28.50",
            confidence: "0.72"
          }
        ],
        total_rm: "64.50",
        overall_confidence: "0.78",
        ambiguities: [
          {
            field: "line_items[0].quantity",
            question: "Confirm ikan bilis quantity and total?",
            options: ["1 kg, RM28.50", "Needs correction"]
          }
        ]
      },
      clarifications: [
        {
          field: "line_items[0].quantity",
          question: "Confirm ikan bilis quantity and total?",
          options: ["1 kg, RM28.50", "Needs correction"]
        }
      ]
    });
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:receipt-upload-003")
    });
    const image = new File(["receipt"], "receipt_003_pasar_pagi.jpg", {
      type: "image/jpeg"
    });

    render(
      <ReceiptReviewScreen
        {...receiptScreenContext}
        locale="en"
        extractReceipt={extractReceipt}
      />
    );
    await user.upload(screen.getByLabelText("Upload receipt photo"), image);

    expect(extractReceipt).toHaveBeenCalledWith({
      file: image,
      merchantId: "m_kak_lina_001"
    });
    expect(
      screen.queryByText(
        "Extraction completed with fields that require confirmation."
      )
    ).not.toBeInTheDocument();
    expect(screen.getByText("Pasar Pagi SS2")).toBeInTheDocument();
    expect(
      screen.getByText("Confirm ikan bilis quantity and total?")
    ).toBeInTheDocument();
  });

  it("shows a loading icon while extraction is pending without a completion pill", async () => {
    const user = userEvent.setup();
    let resolveExtraction:
      | ((value: Awaited<ReturnType<NonNullable<
          React.ComponentProps<typeof ReceiptReviewScreen>["extractReceipt"]
        >>>) => void)
      | undefined;
    const extractReceipt = vi.fn(
      () =>
        new Promise<Awaited<ReturnType<NonNullable<
          React.ComponentProps<typeof ReceiptReviewScreen>["extractReceipt"]
        >>>>((resolve) => {
          resolveExtraction = resolve;
        })
    );

    render(
      <ReceiptReviewScreen
        {...receiptScreenContext}
        locale="en"
        extractReceipt={extractReceipt}
      />
    );
    await user.upload(
      screen.getByLabelText("Upload receipt photo"),
      new File(["receipt"], "pending.jpg", { type: "image/jpeg" })
    );

    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent("Processing receipt");
    expect(status.querySelector("svg")).toBeInTheDocument();

    resolveExtraction?.({
      state: "ready_for_review",
      event_id: "receipt-upload-pending",
      evidence_uri: "synthetic://evidence/receipt-upload-pending",
      extraction: {
        receipt_id: "PENDING-001",
        supplier_name: "Pending Supplier",
        date: "2026-07-12",
        currency: "MYR",
        line_items: [
          {
            raw_name: "Eggs",
            normalized_component_id: "c_egg",
            quantity: "1",
            uom: "tray",
            pack_size: "30",
            unit_price_rm: "12.00",
            total_price_rm: "12.00",
            confidence: "0.99"
          }
        ],
        total_rm: "12.00",
        overall_confidence: "0.99",
        ambiguities: []
      }
    });

    expect(await screen.findByText("Pending Supplier")).toBeInTheDocument();
    expect(screen.queryByText("Processing receipt")).not.toBeInTheDocument();
    expect(screen.queryByText(/Extraction completed/u)).not.toBeInTheDocument();
  });

  it("restores uploaded receipt metadata after reload and deletes saved reviews", async () => {
    const user = userEvent.setup();
    const saveReceiptHistory = vi.fn().mockResolvedValue({
      state: "saved",
      receipt_event_id: "receipt-upload-persisted",
      review_event_id: "receipt-review-persisted",
      version: 1
    });
    const extractReceipt = vi.fn().mockResolvedValue({
      state: "clarification_required",
      event_id: "receipt-upload-persisted",
      evidence_uri: "synthetic://evidence/receipt-upload-persisted",
      extraction: {
        receipt_id: "PPSS2-1207",
        supplier_name: "Pasar Pagi SS2",
        date: "2026-07-12",
        currency: "MYR",
        line_items: [
          {
            raw_name: "Kacang",
            normalized_component_id: "c_peanut",
            quantity: "1",
            uom: "pack",
            pack_size: null,
            unit_price_rm: "8.00",
            total_price_rm: "8.00",
            confidence: "0.78"
          }
        ],
        total_rm: "8.00",
        overall_confidence: "0.78",
        ambiguities: [
          {
            field: "line_items[0].normalized_component_id",
            question: "Does Kacang refer to peanuts?",
            options: ["c_peanut", "Needs correction"]
          }
        ]
      },
      clarifications: [
        {
          field: "line_items[0].normalized_component_id",
          question: "Does Kacang refer to peanuts?",
          options: ["c_peanut", "Needs correction"]
        }
      ]
    });
    const firstRender = render(
      <ReceiptReviewScreen
        {...receiptScreenContext}
        locale="en"
        extractReceipt={extractReceipt}
        saveReceiptHistory={saveReceiptHistory}
      />
    );

    await user.upload(
      screen.getByLabelText("Upload receipt photo"),
      new File(["receipt"], "receipt-persisted.jpg", { type: "image/jpeg" })
    );
    expect(await screen.findByText("Pasar Pagi SS2")).toBeInTheDocument();
    await waitFor(() => {
      expect(window.localStorage.length).toBe(1);
    });

    firstRender.unmount();
    render(
      <ReceiptReviewScreen
        {...receiptScreenContext}
        locale="en"
        extractReceipt={extractReceipt}
        saveReceiptHistory={saveReceiptHistory}
      />
    );

    expect(await screen.findByText("Pasar Pagi SS2")).toBeInTheDocument();
    expect(screen.getByDisplayValue("c_peanut")).toBeInTheDocument();
    expect(
      screen.getByRole("img", {
        name: "Pasar Pagi SS2 receipt source evidence"
      })
    ).toHaveAttribute(
      "src",
      "synthetic://evidence/receipt-upload-persisted"
    );

    await user.click(
      screen.getByRole("button", {
        name: "Delete Pasar Pagi SS2 receipt"
      })
    );

    expect(screen.queryByText("Pasar Pagi SS2")).not.toBeInTheDocument();
    await waitFor(() => {
      expect(
        window.localStorage.getItem(
          receiptReviewStorageKey("m_kak_lina_001")
        )
      ).toBeNull();
    });
  });

  it("keeps a receipt recoverable when server deletion fails", async () => {
    const user = userEvent.setup();
    saveReceiptReviews(
      window.localStorage,
      "m_kak_lina_001",
      [translationReceipt]
    );
    const saveReceiptHistory = vi.fn().mockRejectedValue(
      new Error("offline")
    );

    render(
      <ReceiptReviewScreen
        {...receiptScreenContext}
        locale="en"
        loadReceiptHistory={vi.fn(
          () => new Promise<ReceiptReviewsResponse>(() => undefined)
        )}
        saveReceiptHistory={saveReceiptHistory}
      />
    );

    expect(await screen.findByText("Pasar Pagi SS2")).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", {
        name: "Delete Pasar Pagi SS2 receipt"
      })
    );

    expect(
      await screen.findByText(
        "The receipt could not be deleted. It remains saved."
      )
    ).toBeInTheDocument();
    expect(screen.getByText("Pasar Pagi SS2")).toBeInTheDocument();
    expect(
      window.localStorage.getItem(
        receiptReviewStorageKey("m_kak_lina_001")
      )
    ).toContain("receipt-translation");
  });

  it("blocks edits while a receipt archive is in flight", async () => {
    const user = userEvent.setup();
    saveReceiptReviews(
      window.localStorage,
      "m_kak_lina_001",
      [translationReceipt]
    );
    const archive = deferred<ReceiptReviewUpsertResponse>();
    const saveReceiptHistory = vi.fn(() => archive.promise);

    render(
      <ReceiptReviewScreen
        {...receiptScreenContext}
        locale="en"
        loadReceiptHistory={vi.fn(
          () => new Promise<ReceiptReviewsResponse>(() => undefined)
        )}
        saveReceiptHistory={saveReceiptHistory}
      />
    );

    const receiptPanel = await screen.findByRole("tabpanel", {
      name: "Receipt image"
    });
    const supplier = within(receiptPanel).getByLabelText("Supplier");
    await user.click(
      screen.getByRole("button", {
        name: "Delete Pasar Pagi SS2 receipt"
      })
    );
    await waitFor(() => {
      expect(saveReceiptHistory).toHaveBeenCalledTimes(1);
    });
    await user.clear(supplier);
    await user.type(supplier, "Changed Supplier");

    archive.resolve({
      state: "archived",
      receipt_event_id: translationReceipt.id,
      review_event_id: "receipt-review-archived",
      version: 2
    });

    await waitFor(() => {
      expect(screen.queryByText("Pasar Pagi SS2")).not.toBeInTheDocument();
      expect(
        window.localStorage.getItem(
          receiptReviewStorageKey("m_kak_lina_001")
        )
      ).toBeNull();
    });
    expect(saveReceiptHistory).toHaveBeenCalledTimes(1);
  });

  it("blocks confirmation while a receipt archive is in flight", async () => {
    const user = userEvent.setup();
    saveReceiptReviews(
      window.localStorage,
      "m_kak_lina_001",
      [confirmableReceipt]
    );
    const archive = deferred<ReceiptReviewUpsertResponse>();
    const confirmReceipt = vi.fn();
    const saveReceiptHistory = vi.fn(
      ({ reviewState }: { reviewState: "draft" | "archived" }) =>
        reviewState === "archived"
          ? archive.promise
          : Promise.resolve({
              state: "saved" as const,
              receipt_event_id: confirmableReceipt.id,
              review_event_id: "receipt-review-before-archive",
              version: 1
            })
    );

    render(
      <ReceiptReviewScreen
        {...receiptScreenContext}
        locale="en"
        loadReceiptHistory={vi.fn(
          () => new Promise<ReceiptReviewsResponse>(() => undefined)
        )}
        saveReceiptHistory={saveReceiptHistory}
        confirmReceipt={confirmReceipt}
      />
    );

    const confirmButton = await screen.findByRole("button", {
      name: "Confirm and record costs"
    });
    await user.click(
      screen.getByRole("button", {
        name: "Delete Pasar Pagi SS2 receipt"
      })
    );
    await waitFor(() => {
      expect(confirmButton).toBeDisabled();
    });
    await user.click(confirmButton);
    expect(confirmReceipt).not.toHaveBeenCalled();

    archive.resolve({
      state: "archived",
      receipt_event_id: confirmableReceipt.id,
      review_event_id: "receipt-review-archive-confirm-blocked",
      version: 2
    });
    await waitFor(() => {
      expect(screen.queryByText("Pasar Pagi SS2")).not.toBeInTheDocument();
    });
  });

  it("never stores data URL evidence or corrupts an older snapshot on quota failure", () => {
    const dataReceipt = {
      ...translationReceipt,
      imageUrl: "data:image/jpeg;base64,stored-image",
      evidenceUri: "data:image/jpeg;base64,stored-evidence"
    };

    expect(
      saveReceiptReviews(
        window.localStorage,
        "m_kak_lina_001",
        [dataReceipt]
      )
    ).toBe(true);
    const stored = window.localStorage.getItem(
      receiptReviewStorageKey("m_kak_lina_001")
    );
    expect(stored).not.toContain("data:image");
    expect(stored).toContain('"imageUrl":""');
    expect(stored).toContain('"evidenceUri":null');

    window.localStorage.setItem(
      receiptReviewStorageKey("m_kak_lina_001"),
      JSON.stringify({
        version: 1,
        receipts: [dataReceipt]
      })
    );
    expect(
      loadReceiptReviews(window.localStorage, "m_kak_lina_001")
    ).toEqual([
      expect.objectContaining({
        imageUrl: "",
        evidenceUri: null
      })
    ]);

    const serverRecords = receiptReviewRecords({
      merchant_id: "m_kak_lina_001",
      receipts: [
        {
          receipt_event_id: "receipt-server-data-url",
          review_state: "draft",
          version: 1,
          title: "Server data URL",
          image_uri: "data:image/jpeg;base64,server-evidence",
          uploaded_at: "2026-07-16T08:00:00.000Z",
          updated_at: "2026-07-16T08:00:00.000Z",
          extraction: translationReceipt.extraction,
          confirmed: false,
          cost_event_id: null,
          verified_at: null,
          material_changes: []
        }
      ]
    });
    expect(serverRecords).toEqual([
      expect.objectContaining({
        imageUrl: "",
        evidenceUri: null
      })
    ]);

    let previousSnapshot = stored;
    const quotaStorage = {
      get length() {
        return previousSnapshot ? 1 : 0;
      },
      clear: vi.fn(),
      getItem: vi.fn(() => previousSnapshot),
      key: vi.fn(() => receiptReviewStorageKey("m_kak_lina_001")),
      removeItem: vi.fn(),
      setItem: vi.fn(() => {
        throw new DOMException("Quota exceeded", "QuotaExceededError");
      })
    } as Storage;

    expect(
      saveReceiptReviews(
        quotaStorage,
        "m_kak_lina_001",
        [translationReceipt]
      )
    ).toBe(false);
    expect(previousSnapshot).toBe(stored);
  });

  it("discards structurally malformed cached receipt extractions", () => {
    window.localStorage.setItem(
      receiptReviewStorageKey("m_kak_lina_001"),
      JSON.stringify({
        version: 1,
        receipts: [{
          ...translationReceipt,
          extraction: {
            supplier_name: "Malformed supplier"
          }
        }]
      })
    );

    expect(
      loadReceiptReviews(window.localStorage, "m_kak_lina_001")
    ).toEqual([]);

    window.localStorage.setItem(
      receiptReviewStorageKey("m_kak_lina_001"),
      JSON.stringify({
        version: 1,
        receipts: [{
          ...translationReceipt,
          extraction: {
            ...translationReceipt.extraction,
            supplier_name: 42
          }
        }]
      })
    );
    expect(
      loadReceiptReviews(window.localStorage, "m_kak_lina_001")
    ).toEqual([]);

    window.localStorage.setItem(
      receiptReviewStorageKey("m_kak_lina_001"),
      JSON.stringify({
        version: 1,
        receipts: [{
          ...translationReceipt,
          extraction: {
            ...translationReceipt.extraction,
            line_items: [{}]
          }
        }]
      })
    );
    expect(
      loadReceiptReviews(window.localStorage, "m_kak_lina_001")
    ).toEqual([]);

    window.localStorage.setItem(
      receiptReviewStorageKey("m_kak_lina_001"),
      JSON.stringify({
        version: 1,
        receipts: [{
          ...translationReceipt,
          extraction: {
            ...translationReceipt.extraction,
            ambiguities: [{
              field: "supplier_name",
              question: "Malformed option",
              options: [{}]
            }]
          }
        }]
      })
    );
    expect(
      loadReceiptReviews(window.localStorage, "m_kak_lina_001")
    ).toEqual([]);

    window.localStorage.setItem(
      receiptReviewStorageKey("m_kak_lina_001"),
      JSON.stringify({
        version: 1,
        receipts: [{
          ...translationReceipt,
          confirmed: true,
          materialChanges: { length: 1 }
        }]
      })
    );
    expect(
      loadReceiptReviews(window.localStorage, "m_kak_lina_001")
    ).toEqual([]);

    window.localStorage.setItem(
      receiptReviewStorageKey("m_kak_lina_001"),
      JSON.stringify({
        version: 1,
        receipts: [{
          ...translationReceipt,
          confirmed: true,
          verifiedAt: "not-a-date"
        }]
      })
    );
    expect(
      loadReceiptReviews(window.localStorage, "m_kak_lina_001")
    ).toEqual([]);
  });

  it("saves edited draft state through the receipt history API", async () => {
    const user = userEvent.setup();
    const saveReceiptHistory = vi.fn().mockResolvedValue({
      state: "saved",
      receipt_event_id: "receipt-upload-draft",
      review_event_id: "receipt-review-draft",
      version: 2
    });
    const extractReceipt = vi.fn().mockResolvedValue({
      state: "ready_for_review",
      event_id: "receipt-upload-draft",
      evidence_uri: "synthetic://evidence/receipt-upload-draft",
      extraction: {
        receipt_id: "DRAFT-001",
        supplier_name: "Draft Supplier",
        date: "2026-07-16",
        currency: "MYR",
        line_items: [
          {
            raw_name: "Egg tray",
            normalized_component_id: "c_egg",
            quantity: "1",
            uom: "tray",
            pack_size: null,
            unit_price_rm: "15.00",
            total_price_rm: "15.00",
            confidence: "0.99"
          }
        ],
        total_rm: "15.00",
        overall_confidence: "0.99",
        ambiguities: []
      }
    });

    render(
      <ReceiptReviewScreen
        {...receiptScreenContext}
        locale="en"
        extractReceipt={extractReceipt}
        loadReceiptHistory={vi.fn().mockResolvedValue({
          merchant_id: "m_kak_lina_001",
          receipts: []
        })}
        saveReceiptHistory={saveReceiptHistory}
      />
    );
    await user.upload(
      screen.getByLabelText("Upload receipt photo"),
      new File(["receipt"], "draft.jpg", { type: "image/jpeg" })
    );
    await user.type(
      await screen.findByLabelText("Line 1 pack size"),
      "30"
    );

    await waitFor(() => {
      expect(saveReceiptHistory).toHaveBeenLastCalledWith({
        merchantId: "m_kak_lina_001",
        receiptEventId: "receipt-upload-draft",
        reviewState: "draft",
        extraction: expect.objectContaining({
          line_items: [
            expect.objectContaining({ pack_size: "30" })
          ]
        })
      });
    });
  });

  it("keeps a failed draft sync across reload and retries it", async () => {
    const user = userEvent.setup();
    const extractReceipt = vi.fn().mockResolvedValue({
      state: "ready_for_review",
      event_id: "receipt-upload-retry",
      evidence_uri: "synthetic://evidence/receipt-upload-retry",
      extraction: {
        receipt_id: "RETRY-001",
        supplier_name: "Retry Supplier",
        date: "2026-07-16",
        currency: "MYR",
        line_items: [
          {
            raw_name: "Egg tray",
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
    });
    const emptyHistory = vi.fn().mockResolvedValue({
      merchant_id: "m_kak_lina_001",
      receipts: []
    });
    const failedSave = vi.fn().mockRejectedValue(new Error("offline"));
    const firstRender = render(
      <ReceiptReviewScreen
        {...receiptScreenContext}
        locale="en"
        extractReceipt={extractReceipt}
        loadReceiptHistory={emptyHistory}
        saveReceiptHistory={failedSave}
      />
    );

    await user.upload(
      screen.getByLabelText("Upload receipt photo"),
      new File(["receipt"], "retry.jpg", { type: "image/jpeg" })
    );

    expect(await screen.findByText("Retry Supplier")).toBeInTheDocument();
    await waitFor(() => {
      const stored = window.localStorage.getItem(
        "pasarai.receipt-reviews:m_kak_lina_001"
      );
      expect(stored).toContain('"pendingSync":true');
      expect(stored).toContain(
        "synthetic://evidence/receipt-upload-retry"
      );
    });
    expect(
      screen.queryByText(
        "The receipt is saved on this device, but server sync failed."
      )
    ).not.toBeInTheDocument();

    firstRender.unmount();
    const retrySave = vi.fn().mockResolvedValue({
      state: "saved",
      receipt_event_id: "receipt-upload-retry",
      review_event_id: "receipt-review-retry",
      version: 1
    });
    render(
      <ReceiptReviewScreen
        {...receiptScreenContext}
        locale="en"
        loadReceiptHistory={emptyHistory}
        saveReceiptHistory={retrySave}
      />
    );

    expect(await screen.findByText("Retry Supplier")).toBeInTheDocument();
    await waitFor(() => {
      expect(retrySave).toHaveBeenCalledWith({
        merchantId: "m_kak_lina_001",
        receiptEventId: "receipt-upload-retry",
        reviewState: "draft",
        extraction: expect.objectContaining({
          supplier_name: "Retry Supplier"
        })
      });
      const stored = window.localStorage.getItem(
        "pasarai.receipt-reviews:m_kak_lina_001"
      );
      expect(stored).toContain('"pendingSync":false');
    });
  });

  it("ignores history captured before a pending retry succeeds", async () => {
    const pendingReceipt = {
      ...translationReceipt,
      pendingSync: true,
      localRevision: 1
    };
    saveReceiptReviews(
      window.localStorage,
      "m_kak_lina_001",
      [pendingReceipt]
    );
    const history = deferred<ReceiptReviewsResponse>();
    const saveReceiptHistory = vi.fn().mockResolvedValue({
      state: "saved",
      receipt_event_id: pendingReceipt.id,
      review_event_id: "receipt-review-retried",
      version: 2
    });

    render(
      <ReceiptReviewScreen
        {...receiptScreenContext}
        locale="en"
        loadReceiptHistory={vi.fn(() => history.promise)}
        saveReceiptHistory={saveReceiptHistory}
      />
    );

    expect(await screen.findByText("Pasar Pagi SS2")).toBeInTheDocument();
    await waitFor(() => {
      const stored = window.localStorage.getItem(
        receiptReviewStorageKey("m_kak_lina_001")
      );
      expect(stored).toContain('"pendingSync":false');
      expect(stored).toContain('"reviewVersion":2');
    });

    history.resolve({
      merchant_id: "m_kak_lina_001",
      receipts: []
    });

    await waitFor(() => {
      expect(screen.getByText("Pasar Pagi SS2")).toBeInTheDocument();
      expect(
        window.localStorage.getItem(
          receiptReviewStorageKey("m_kak_lina_001")
        )
      ).toContain("receipt-translation");
    });
  });

  it("makes committed confirmation authoritative and never retries it as a draft", async () => {
    const user = userEvent.setup();
    const pendingReceipt: ReceiptReviewRecord = {
      ...confirmableReceipt,
      pendingSync: true,
      localRevision: 1
    };
    saveReceiptReviews(
      window.localStorage,
      "m_kak_lina_001",
      [pendingReceipt]
    );
    const loadReceiptHistory = vi.fn().mockRejectedValue(
      new Error("offline")
    );
    const saveReceiptHistory = vi.fn().mockResolvedValue({
      state: "saved",
      receipt_event_id: pendingReceipt.id,
      review_event_id: "receipt-review-confirmed",
      version: 3
    });
    const confirmReceipt = vi.fn().mockResolvedValue({
      state: "committed",
      event_id: "cost-receipt-confirmed"
    });
    const firstRender = render(
      <ReceiptReviewScreen
        {...receiptScreenContext}
        locale="en"
        loadReceiptHistory={loadReceiptHistory}
        saveReceiptHistory={saveReceiptHistory}
        confirmReceipt={confirmReceipt}
      />
    );

    await user.click(
      await screen.findByRole("button", {
        name: "Confirm and record costs"
      })
    );
    expect(
      await screen.findByRole("button", {
        name: "Verified costs recorded"
      })
    ).toBeInTheDocument();
    await waitFor(() => {
      const stored = window.localStorage.getItem(
        receiptReviewStorageKey("m_kak_lina_001")
      );
      expect(stored).toContain('"confirmed":true');
      expect(stored).toContain('"pendingSync":false');
    });
    const saveCallsBeforeReload = saveReceiptHistory.mock.calls.length;

    firstRender.unmount();
    render(
      <ReceiptReviewScreen
        {...receiptScreenContext}
        locale="en"
        loadReceiptHistory={loadReceiptHistory}
        saveReceiptHistory={saveReceiptHistory}
        confirmReceipt={confirmReceipt}
      />
    );

    expect(
      await screen.findByRole("button", {
        name: "Verified costs recorded"
      })
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(saveReceiptHistory).toHaveBeenCalledTimes(
        saveCallsBeforeReload
      );
    });
  });

  it("blocks receipt edits while confirmation is in flight", async () => {
    const user = userEvent.setup();
    saveReceiptReviews(
      window.localStorage,
      "m_kak_lina_001",
      [confirmableReceipt]
    );
    const confirmation = deferred<CostsResponse>();
    const confirmReceipt = vi.fn(() => confirmation.promise);
    const saveReceiptHistory = vi.fn().mockResolvedValue({
      state: "saved",
      receipt_event_id: confirmableReceipt.id,
      review_event_id: "receipt-review-before-confirm",
      version: 2
    });

    render(
      <ReceiptReviewScreen
        {...receiptScreenContext}
        locale="en"
        loadReceiptHistory={vi.fn(
          () => new Promise<ReceiptReviewsResponse>(() => undefined)
        )}
        saveReceiptHistory={saveReceiptHistory}
        confirmReceipt={confirmReceipt}
      />
    );

    await user.click(
      await screen.findByRole("button", {
        name: "Confirm and record costs"
      })
    );
    await waitFor(() => {
      expect(confirmReceipt).toHaveBeenCalledTimes(1);
    });

    const receiptPanel = screen.getByRole("tabpanel", {
      name: "Receipt image"
    });
    const supplier = within(receiptPanel).getByLabelText("Supplier");
    await user.clear(supplier);
    await user.type(supplier, "Changed Supplier");

    confirmation.resolve({
      state: "committed",
      event_id: "cost-confirmation-locked"
    });

    expect(
      await screen.findByRole("button", {
        name: "Verified costs recorded"
      })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Pasar Pagi SS2" })
    ).toBeInTheDocument();
    expect(screen.queryByText("Changed Supplier")).not.toBeInTheDocument();
    expect(confirmReceipt).toHaveBeenCalledWith(expect.objectContaining({
      merchantId: "m_kak_lina_001",
      receiptEventId: confirmableReceipt.id,
      extraction: confirmableReceipt.extraction
    }));
  });

  it("keeps a local commit when post-confirm history is empty", async () => {
    const user = userEvent.setup();
    saveReceiptReviews(
      window.localStorage,
      "m_kak_lina_001",
      [confirmableReceipt]
    );
    const initialHistory = deferred<ReceiptReviewsResponse>();
    const loadReceiptHistory = vi.fn()
      .mockImplementationOnce(() => initialHistory.promise)
      .mockResolvedValueOnce({
        merchant_id: "m_kak_lina_001",
        receipts: []
      });

    render(
      <ReceiptReviewScreen
        {...receiptScreenContext}
        locale="en"
        loadReceiptHistory={loadReceiptHistory}
        saveReceiptHistory={vi.fn().mockResolvedValue({
          state: "saved",
          receipt_event_id: confirmableReceipt.id,
          review_event_id: "receipt-review-confirmed-empty-history",
          version: 2
        })}
        confirmReceipt={vi.fn().mockResolvedValue({
          state: "committed",
          event_id: "cost-confirmed-empty-history"
        })}
      />
    );

    await user.click(
      await screen.findByRole("button", {
        name: "Confirm and record costs"
      })
    );
    expect(
      await screen.findByRole("button", {
        name: "Verified costs recorded"
      })
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(loadReceiptHistory).toHaveBeenCalledTimes(2);
      expect(
        window.localStorage.getItem(
          receiptReviewStorageKey("m_kak_lina_001")
        )
      ).toContain('"confirmed":true');
    });

    initialHistory.resolve({
      merchant_id: "m_kak_lina_001",
      receipts: []
    });

    await waitFor(() => {
      expect(
        screen.getByRole("button", {
          name: "Verified costs recorded"
        })
      ).toBeInTheDocument();
    });
  });

  it("reuses confirmation identity after an uncertain response", async () => {
    const user = userEvent.setup();
    saveReceiptReviews(
      window.localStorage,
      "m_kak_lina_001",
      [confirmableReceipt]
    );
    const initialHistory = deferred<ReceiptReviewsResponse>();
    const loadReceiptHistory = vi.fn()
      .mockImplementationOnce(() => initialHistory.promise)
      .mockResolvedValue({
        merchant_id: "m_kak_lina_001",
        receipts: []
      });
    const confirmReceipt = vi.fn()
      .mockRejectedValueOnce(new Error("response lost"))
      .mockResolvedValueOnce({
        state: "committed",
        event_id: "cost-confirmation-retry"
      });

    render(
      <ReceiptReviewScreen
        {...receiptScreenContext}
        locale="en"
        loadReceiptHistory={loadReceiptHistory}
        saveReceiptHistory={vi.fn().mockResolvedValue({
          state: "saved",
          receipt_event_id: confirmableReceipt.id,
          review_event_id: "receipt-review-confirm-retry",
          version: 2
        })}
        confirmReceipt={confirmReceipt}
      />
    );

    await user.click(
      await screen.findByRole("button", {
        name: "Confirm and record costs"
      })
    );
    await waitFor(() => {
      expect(confirmReceipt).toHaveBeenCalledTimes(1);
      expect(
        screen.getByRole("button", {
          name: "Confirm and record costs"
        })
      ).toBeEnabled();
    });
    await user.click(
      screen.getByRole("button", {
        name: "Confirm and record costs"
      })
    );

    expect(
      await screen.findByRole("button", {
        name: "Verified costs recorded"
      })
    ).toBeInTheDocument();
    expect(confirmReceipt).toHaveBeenCalledTimes(2);
    expect(confirmReceipt.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        idempotencyKey: confirmReceipt.mock.calls[0]?.[0].idempotencyKey,
        occurredAt: confirmReceipt.mock.calls[0]?.[0].occurredAt
      })
    );
  });

  it("preserves confirmation identity through reload reconciliation", async () => {
    const user = userEvent.setup();
    const attemptedReceipt: ReceiptReviewRecord = {
      ...confirmableReceipt,
      pendingSync: false,
      localRevision: 3,
      reviewVersion: 2,
      confirmationIdempotencyKey: "confirmation-reload-key",
      confirmationOccurredAt: "2026-07-16T09:10:00.000Z",
      confirmationRevision: 3
    };
    saveReceiptReviews(
      window.localStorage,
      "m_kak_lina_001",
      [attemptedReceipt]
    );
    const serverDraft = {
      ...confirmableReceipt,
      reviewVersion: 2,
      pendingSync: false
    };
    const confirmReceipt = vi.fn().mockResolvedValue({
      state: "committed",
      event_id: "cost-confirmation-reload"
    });

    render(
      <ReceiptReviewScreen
        {...receiptScreenContext}
        locale="en"
        loadReceiptHistory={vi.fn().mockResolvedValue({
          merchant_id: "m_kak_lina_001",
          receipts: [receiptHistoryEntry(serverDraft)]
        })}
        saveReceiptHistory={vi.fn().mockResolvedValue({
          state: "saved",
          receipt_event_id: confirmableReceipt.id,
          review_event_id: "receipt-review-confirm-reload",
          version: 2
        })}
        confirmReceipt={confirmReceipt}
      />
    );

    await waitFor(() => {
      expect(
        window.localStorage.getItem(
          receiptReviewStorageKey("m_kak_lina_001")
        )
      ).toContain("confirmation-reload-key");
    });
    await user.click(
      screen.getByRole("button", {
        name: "Confirm and record costs"
      })
    );

    expect(confirmReceipt).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: "confirmation-reload-key",
      occurredAt: "2026-07-16T09:10:00.000Z"
    }));
  });

  it("does not restore a confirmed receipt after the user selects another", async () => {
    const user = userEvent.setup();
    const secondReceipt: ReceiptReviewRecord = {
      ...translationReceipt,
      id: "receipt-second-selection",
      sourceEventId: "receipt-second-selection",
      title: "Second Supplier",
      extraction: {
        ...translationReceipt.extraction,
        receipt_id: "SECOND-001",
        supplier_name: "Second Supplier"
      }
    };
    saveReceiptReviews(
      window.localStorage,
      "m_kak_lina_001",
      [confirmableReceipt, secondReceipt]
    );
    const initialHistory = deferred<ReceiptReviewsResponse>();
    const postConfirmHistory = deferred<ReceiptReviewsResponse>();
    const loadReceiptHistory = vi.fn()
      .mockImplementationOnce(() => initialHistory.promise)
      .mockImplementationOnce(() => postConfirmHistory.promise);

    render(
      <ReceiptReviewScreen
        {...receiptScreenContext}
        locale="en"
        loadReceiptHistory={loadReceiptHistory}
        saveReceiptHistory={vi.fn().mockResolvedValue({
          state: "saved",
          receipt_event_id: confirmableReceipt.id,
          review_event_id: "receipt-review-selection",
          version: 2
        })}
        confirmReceipt={vi.fn().mockResolvedValue({
          state: "committed",
          event_id: "cost-selection"
        })}
      />
    );

    await user.click(
      await screen.findByRole("button", {
        name: "Confirm and record costs"
      })
    );
    await waitFor(() => {
      expect(loadReceiptHistory).toHaveBeenCalledTimes(2);
    });
    await user.click(
      screen.getByRole("button", {
        name: "Open Second Supplier receipt"
      })
    );
    expect(
      screen.getByRole("heading", { name: "Second Supplier" })
    ).toBeInTheDocument();

    postConfirmHistory.resolve({
      merchant_id: "m_kak_lina_001",
      receipts: [
        receiptHistoryEntry({
          ...confirmableReceipt,
          confirmed: true,
          readyToConfirm: false,
          reviewVersion: 3,
          costEventId: "cost-selection",
          verifiedAt: "2026-07-16T09:00:00.000Z"
        })
      ]
    });
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Second Supplier" })
      ).toBeInTheDocument();
    });
  });

  it("keeps verified server history authoritative over a pending local draft", () => {
    const localPending = {
      ...translationReceipt,
      pendingSync: true,
      localRevision: 4,
      confirmed: false,
      materialChanges: []
    };
    const serverVerified: ReceiptReviewRecord = {
      ...translationReceipt,
      confirmed: true,
      pendingSync: false,
      reviewVersion: 5,
      costEventId: "cost-verified",
      verifiedAt: "2026-07-16T08:15:00.000Z",
      materialChanges: [
        {
          componentId: "c_peanut",
          componentName: "Kacang Tanah",
          productId: "p_nlb_001",
          quantity: "1",
          uom: "pack",
          packSize: "10",
          totalPriceRm: "8.00",
          previousCostRmPerPack: "0.70",
          currentCostRmPerPack: "0.80",
          changeRmPerPack: "0.10"
        }
      ]
    };

    expect(
      mergeReceiptReviewHistory([serverVerified], [localPending])
    ).toEqual([serverVerified]);
  });

  it("does not regress newer local receipts during a mutation refresh", () => {
    const pendingLocal: ReceiptReviewRecord = {
      ...translationReceipt,
      id: "receipt-pending-local",
      title: "Pending local",
      pendingSync: true,
      localRevision: 3,
      reviewVersion: 2
    };
    const acknowledgedLocal: ReceiptReviewRecord = {
      ...translationReceipt,
      id: "receipt-acknowledged-local",
      title: "Acknowledged local",
      pendingSync: false,
      reviewVersion: 5
    };
    const confirmedLocal: ReceiptReviewRecord = {
      ...translationReceipt,
      id: "receipt-confirmed-local",
      title: "Confirmed local",
      confirmed: true,
      pendingSync: false,
      reviewVersion: 7,
      costEventId: "cost-confirmed-local"
    };
    const staleServer = [
      {
        ...pendingLocal,
        title: "Pending server",
        pendingSync: false,
        localRevision: undefined,
        reviewVersion: 2
      },
      {
        ...acknowledgedLocal,
        title: "Acknowledged server",
        reviewVersion: 4
      },
      {
        ...confirmedLocal,
        title: "Confirmed server draft",
        confirmed: false,
        reviewVersion: 6,
        costEventId: null
      }
    ];

    expect(
      mergeReceiptReviewHistory(staleServer, [
        pendingLocal,
        acknowledgedLocal,
        confirmedLocal
      ], {
        preserveUnmatchedLocal: true
      })
    ).toEqual([
      pendingLocal,
      acknowledgedLocal,
      confirmedLocal
    ]);
  });

  it("preserves other local receipts when confirming against stale history", async () => {
    const user = userEvent.setup();
    const pendingLocal: ReceiptReviewRecord = {
      ...translationReceipt,
      id: "receipt-pending-during-confirm",
      sourceEventId: "receipt-pending-during-confirm",
      title: "Pending during confirm",
      pendingSync: true,
      localRevision: 4,
      reviewVersion: 2
    };
    const acknowledgedLocal: ReceiptReviewRecord = {
      ...translationReceipt,
      id: "receipt-acknowledged-during-confirm",
      sourceEventId: "receipt-acknowledged-during-confirm",
      title: "Acknowledged during confirm",
      pendingSync: false,
      reviewVersion: 5
    };
    const confirmedLocal: ReceiptReviewRecord = {
      ...translationReceipt,
      id: "receipt-confirmed-during-confirm",
      sourceEventId: "receipt-confirmed-during-confirm",
      title: "Confirmed during confirm",
      confirmed: true,
      pendingSync: false,
      reviewVersion: 7,
      costEventId: "cost-confirmed-during-confirm",
      verifiedAt: "2026-07-16T08:30:00.000Z"
    };
    saveReceiptReviews(
      window.localStorage,
      "m_kak_lina_001",
      [
        confirmableReceipt,
        pendingLocal,
        acknowledgedLocal,
        confirmedLocal
      ]
    );
    const initialHistory = deferred<ReceiptReviewsResponse>();
    const verifiedReceipt: ReceiptReviewRecord = {
      ...confirmableReceipt,
      confirmed: true,
      readyToConfirm: false,
      reviewVersion: 3,
      costEventId: "cost-current-confirmation",
      verifiedAt: "2026-07-16T09:00:00.000Z"
    };
    const loadReceiptHistory = vi.fn()
      .mockImplementationOnce(() => initialHistory.promise)
      .mockResolvedValueOnce({
        merchant_id: "m_kak_lina_001",
        receipts: [
          receiptHistoryEntry(verifiedReceipt),
          receiptHistoryEntry({
            ...pendingLocal,
            title: "Pending server draft",
            pendingSync: false,
            reviewVersion: 2
          }),
          receiptHistoryEntry({
            ...acknowledgedLocal,
            title: "Acknowledged server draft",
            reviewVersion: 4
          }),
          receiptHistoryEntry({
            ...confirmedLocal,
            title: "Confirmed server draft",
            confirmed: false,
            reviewVersion: 6,
            costEventId: null,
            verifiedAt: null
          })
        ]
      });
    const saveReceiptHistory = vi.fn(
      ({ receiptEventId }: { receiptEventId: string }) =>
        receiptEventId === pendingLocal.id
          ? Promise.reject(new Error("offline"))
          : Promise.resolve({
              state: "saved" as const,
              receipt_event_id: receiptEventId,
              review_event_id: "receipt-review-monotonic-confirm",
              version: 2
            })
    );

    render(
      <ReceiptReviewScreen
        {...receiptScreenContext}
        locale="en"
        loadReceiptHistory={loadReceiptHistory}
        saveReceiptHistory={saveReceiptHistory}
        confirmReceipt={vi.fn().mockResolvedValue({
          state: "committed",
          event_id: verifiedReceipt.costEventId
        })}
      />
    );

    await user.click(
      await screen.findByRole("button", {
        name: "Confirm and record costs"
      })
    );

    await waitFor(() => {
      const stored = loadReceiptReviews(
        window.localStorage,
        "m_kak_lina_001"
      );
      expect(stored).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: verifiedReceipt.id,
            confirmed: true,
            costEventId: verifiedReceipt.costEventId
          }),
          expect.objectContaining({
            id: pendingLocal.id,
            title: pendingLocal.title,
            pendingSync: true,
            localRevision: pendingLocal.localRevision
          }),
          expect.objectContaining({
            id: acknowledgedLocal.id,
            title: acknowledgedLocal.title,
            reviewVersion: acknowledgedLocal.reviewVersion
          }),
          expect.objectContaining({
            id: confirmedLocal.id,
            title: confirmedLocal.title,
            confirmed: true,
            costEventId: confirmedLocal.costEventId
          })
        ])
      );
    });

    initialHistory.resolve({
      merchant_id: "m_kak_lina_001",
      receipts: []
    });
  });

  it("uses empty server history to clear stale cached receipts after reset", async () => {
    saveReceiptReviews(
      window.localStorage,
      "m_kak_lina_001",
      [translationReceipt]
    );

    render(
      <ReceiptReviewScreen
        {...receiptScreenContext}
        locale="en"
        loadReceiptHistory={vi.fn().mockResolvedValue({
          merchant_id: "m_kak_lina_001",
          receipts: []
        })}
      />
    );

    await waitFor(() => {
      expect(screen.queryByText("Pasar Pagi SS2")).not.toBeInTheDocument();
      expect(window.localStorage.length).toBe(0);
    });
  });

  it("shows the material changes recorded by a verified receipt", () => {
    render(
      <ReceiptReview
        locale="en"
        onUpload={vi.fn()}
        onConfirm={vi.fn()}
        confirmState="success"
        receipt={{
          ...translationReceipt,
          confirmed: true,
          verifiedAt: "2026-07-16T08:15:00.000Z",
          materialChanges: [
            {
              componentId: "c_peanut",
              componentName: "Kacang Tanah",
              productId: "p_nlb_001",
              quantity: "1",
              uom: "pack",
              packSize: "10",
              totalPriceRm: "8.00",
              previousCostRmPerPack: "0.70",
              currentCostRmPerPack: "0.80",
              changeRmPerPack: "0.10"
            }
          ]
        }}
      />
    );

    expect(screen.getByText("Material changes recorded")).toBeInTheDocument();
    expect(screen.getByText("Kacang Tanah")).toBeInTheDocument();
    expect(screen.getByText("RM0.70")).toBeInTheDocument();
    expect(screen.getByText("RM0.80")).toBeInTheDocument();
    expect(screen.getByText("+RM0.10")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Verified costs recorded" })
    ).toBeDisabled();
  });
});
