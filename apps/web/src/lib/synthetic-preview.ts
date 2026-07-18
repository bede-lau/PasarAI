import type {
  DashboardData,
  DashboardEvidenceRecord,
  ReceiptReviewRecord
} from "@/lib/dashboard-types";
import { shiftDashboardDate } from "@/lib/dashboard-date";
import demoSnapshot from "../../../../fixtures/demo/current-snapshot.json";

export const syntheticDashboardDateRange = {
  min: "2026-07-05",
  max: demoSnapshot.dashboard_date
} as const;

const syntheticTones = ["egg", "sambal", "coconut", "pandan"] as const;

const syntheticSalesHistory = {
  "2026-07-05": {
    revenueRm: "260.00",
    cogsRm: "150.80",
    grossProfitRm: "109.20",
    grossMarginPct: "42.00"
  },
  "2026-07-06": {
    revenueRm: "240.00",
    cogsRm: "139.20",
    grossProfitRm: "100.80",
    grossMarginPct: "42.00"
  },
  "2026-07-07": {
    revenueRm: "170.00",
    cogsRm: "98.60",
    grossProfitRm: "71.40",
    grossMarginPct: "42.00"
  },
  "2026-07-08": {
    revenueRm: "180.00",
    cogsRm: "104.40",
    grossProfitRm: "75.60",
    grossMarginPct: "42.00"
  },
  "2026-07-09": {
    revenueRm: "195.00",
    cogsRm: "113.10",
    grossProfitRm: "81.90",
    grossMarginPct: "42.00"
  },
  "2026-07-10": {
    revenueRm: "210.00",
    cogsRm: "121.80",
    grossProfitRm: "88.20",
    grossMarginPct: "42.00"
  },
  "2026-07-11": {
    revenueRm: "230.00",
    cogsRm: "133.40",
    grossProfitRm: "96.60",
    grossMarginPct: "42.00"
  },
  "2026-07-12": {
    revenueRm: "200.00",
    cogsRm: "127.20",
    grossProfitRm: "72.80",
    grossMarginPct: "36.40"
  },
  "2026-07-13": {
    revenueRm: "220.00",
    cogsRm: "139.92",
    grossProfitRm: "80.08",
    grossMarginPct: "36.40"
  },
  "2026-07-14": {
    revenueRm: "190.00",
    cogsRm: "120.84",
    grossProfitRm: "69.16",
    grossMarginPct: "36.40"
  },
  "2026-07-15": {
    revenueRm: "10.00",
    cogsRm: "5.00",
    grossProfitRm: "5.00",
    grossMarginPct: "50.00"
  }
} as const;

export const syntheticEvidence: readonly DashboardEvidenceRecord[] = [
  {
    id: "SBR-120726-184",
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
      },
      {
        rawName: "Minyak Masak 5kg x 1",
        componentId: "c_sambal",
        totalPriceRm: "32.00",
        confidence: "0.97"
      },
      {
        rawName: "Santan Segar 1kg x 4",
        componentId: "c_coconut",
        totalPriceRm: "62.00",
        confidence: "0.96"
      }
    ]
  },
  {
    id: "PPSS2-1207",
    title: "Pasar Pagi SS2 receipt",
    imageUrl: "/evidence/receipt_003_pasar_pagi.jpg",
    receiptId: "PPSS2-1207",
    supplierName: "Pasar Pagi SS2",
    transcript: null,
    lineItems: [
      {
        rawName: "Timun 3kg",
        componentId: "c_cucumber",
        totalPriceRm: "12.00",
        confidence: "1.00"
      },
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
  },
  {
    id: "demo-packaging-update",
    title: "Packaging cost update",
    imageUrl: null,
    receiptId: null,
    supplierName: null,
    transcript:
      "The cost of food containers increased by two ringgit for a pack of 50 containers.",
    lineItems: [
      {
        rawName: "Bekas Makanan 50 pcs",
        componentId: "c_packaging",
        totalPriceRm: "12.00",
        confidence: "1.00"
      }
    ]
  }
];

export const syntheticDashboardData: DashboardData = {
  merchant: {
    id: "m_kak_lina_001",
    name: "Kedai Kak Lina Nasi Lemak",
    location: "SS2, Petaling Jaya",
    productId: "p_nlb_001",
    productName: "Nasi Lemak Biasa"
  },
  summary: {
    merchant_id: "m_kak_lina_001",
    date: demoSnapshot.dashboard_date,
    revenue_rm: demoSnapshot.metrics.revenue_rm,
    cogs_rm: demoSnapshot.metrics.cogs_rm,
    gross_profit_rm: demoSnapshot.metrics.gross_profit_rm,
    gross_margin_pct: demoSnapshot.metrics.gross_margin_pct,
    data_completeness: {
      state: "complete",
      missing_inputs: []
    },
    top_cost_drivers: [
      { name: "Santan", contribution_rm_per_pack: "0.13" },
      { name: "Telur", contribution_rm_per_pack: "0.13" },
      { name: "Sambal + Minyak", contribution_rm_per_pack: "0.12" },
      { name: "Ikan Bilis", contribution_rm_per_pack: "0.08" }
    ],
    baseline_comparison: {
      baseline_margin_pct: demoSnapshot.metrics.baseline_margin_pct,
      margin_change_percentage_points:
        demoSnapshot.metrics.margin_change_percentage_points
    },
    price_floor: {
      target_gross_margin_pct: "40.00",
      price_floor_rm: demoSnapshot.metrics.price_floor_rm,
      assumption: "current_unit_cogs"
    },
    cost_stack: {
      baseline_comparison_date: demoSnapshot.baseline_date,
      baseline_effective_date: demoSnapshot.baseline_date,
      baseline_unit_cogs_rm: demoSnapshot.metrics.baseline_unit_cogs_rm,
      current_unit_cogs_rm: demoSnapshot.metrics.current_unit_cogs_rm,
      components: demoSnapshot.components.map((component) => ({
        component_id: component.component_id,
        name: component.name,
        baseline_cost_rm_per_pack: component.baseline_cost_per_pack_rm,
        current_cost_rm_per_pack: component.current_cost_per_pack_rm,
        change_rm_per_pack: component.change_rm_per_pack,
        evidence_id:
          component.evidence_projection?.evidenceId ?? null
      }))
    },
    evidence: [],
    assumptions: [
      "Gross profit excludes rent, wages and other overheads.",
      "Costs use the latest merchant-confirmed receipt lines."
    ]
  },
  costStack: {
    baselineDate: demoSnapshot.baseline_date,
    baselineUnitCogsRm: demoSnapshot.metrics.baseline_unit_cogs_rm,
    currentUnitCogsRm: demoSnapshot.metrics.current_unit_cogs_rm,
    components: demoSnapshot.components.map((component, index) => ({
      id: component.component_id,
      name: component.name,
      changeRmPerPack: component.change_rm_per_pack,
      tone: syntheticTones[index % syntheticTones.length],
      evidenceId:
        component.evidence_projection?.evidenceId ?? null
    }))
  },
  evidence: syntheticEvidence,
  dateRange: syntheticDashboardDateRange,
  provenance: "synthetic"
};

export function getSyntheticDashboardData(date: string): DashboardData {
  if (date === syntheticDashboardDateRange.max) {
    return syntheticDashboardData;
  }

  const sale =
    syntheticSalesHistory[date as keyof typeof syntheticSalesHistory];
  if (!sale) return syntheticDashboardData;
  const historicalUnitCogsRm =
    date === demoSnapshot.baseline_date
      ? demoSnapshot.metrics.baseline_unit_cogs_rm
      : date >= "2026-07-12"
        ? "3.18"
        : "2.90";

  return {
    ...syntheticDashboardData,
    summary: {
      ...syntheticDashboardData.summary,
      date,
      revenue_rm: sale.revenueRm,
      cogs_rm: sale.cogsRm,
      gross_profit_rm: sale.grossProfitRm,
      gross_margin_pct: sale.grossMarginPct,
      top_cost_drivers: [],
      baseline_comparison: {
        baseline_margin_pct: "42.00",
        margin_change_percentage_points: "0.00"
      },
      cost_stack: {
        baseline_comparison_date: shiftDashboardDate(date, -1),
        baseline_effective_date: shiftDashboardDate(date, -1),
        baseline_unit_cogs_rm: historicalUnitCogsRm,
        current_unit_cogs_rm: historicalUnitCogsRm,
        components: []
      },
      evidence: []
    },
    costStack: {
      baselineDate: shiftDashboardDate(date, -1),
      baselineUnitCogsRm: historicalUnitCogsRm,
      currentUnitCogsRm: historicalUnitCogsRm,
      components: []
    },
    evidence: []
  };
}

export const syntheticReviewReceipt: ReceiptReviewRecord = {
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
};
