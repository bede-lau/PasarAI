import type { DashboardData } from "@/lib/dashboard-types";

export const goldenDashboardFixture: DashboardData = {
  merchant: {
    id: "m_kak_lina_001",
    name: "Kedai Kak Lina Nasi Lemak",
    location: "SS2, Petaling Jaya",
    productId: "p_nlb_001",
    productName: "Nasi Lemak Biasa"
  },
  summary: {
    merchant_id: "m_kak_lina_001",
    date: "2026-07-12",
    revenue_rm: "200.00",
    cogs_rm: "127.20",
    gross_profit_rm: "72.80",
    gross_margin_pct: "36.40",
    data_completeness: {
      state: "complete",
      missing_inputs: []
    },
    top_cost_drivers: [
      { name: "Telur", contribution_rm_per_pack: "0.10" },
      { name: "Sambal + Minyak", contribution_rm_per_pack: "0.08" },
      { name: "Santan", contribution_rm_per_pack: "0.06" },
      { name: "Bekas Makanan", contribution_rm_per_pack: "0.04" }
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
    cost_stack: null,
    evidence: [],
    assumptions: [
      "Gross profit excludes rent, wages and other overheads.",
      "Synthetic fixture for development and automated tests."
    ]
  },
  costStack: {
    baselineDate: "2026-07-11",
    baselineUnitCogsRm: "2.90",
    currentUnitCogsRm: "3.18",
    components: [
      {
        id: "c_egg",
        name: "Telur",
        changeRmPerPack: "0.10",
        tone: "egg",
        evidenceId: "receipt-sinar"
      },
      {
        id: "c_sambal",
        name: "Sambal + Minyak",
        changeRmPerPack: "0.08",
        tone: "sambal",
        evidenceId: "receipt-sinar"
      },
      {
        id: "c_coconut",
        name: "Santan",
        changeRmPerPack: "0.06",
        tone: "coconut",
        evidenceId: "receipt-sinar"
      },
      {
        id: "c_packaging",
        name: "Bekas Makanan",
        changeRmPerPack: "0.04",
        tone: "pandan",
        evidenceId: "receipt-packpro"
      }
    ]
  },
  evidence: [
    {
      id: "receipt-sinar",
      title: "Sinar Borong Jaya receipt",
      imageUrl: "/evidence/receipt_001_sinar_borong.jpg",
      receiptId: "SBR-120726-184",
      supplierName: "Sinar Borong Jaya",
      transcript: null,
      lineItems: [
        {
          rawName: "Telur Gred B 30 biji x 3 tray",
          componentId: "c_egg",
          totalPriceRm: "49.50",
          confidence: "0.98"
        }
      ]
    }
  ],
  dateRange: {
    min: "2026-07-05",
    max: "2026-07-12"
  },
  provenance: "synthetic"
};
