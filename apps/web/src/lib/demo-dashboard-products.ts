import type {
  CostStackComponent,
  DashboardData
} from "@/lib/dashboard-types";
import { shiftDashboardDate } from "@/lib/dashboard-date";

export type DashboardProductOption = {
  productId: string;
  productName: string;
  mode: "connected" | "demo";
};

type DemoProductSnapshot = {
  productId: string;
  productName: string;
  revenueRm: string;
  cogsRm: string;
  grossProfitRm: string;
  grossMarginPct: string;
  baselineMarginPct: string;
  marginChangePercentagePoints: string;
  priceFloorRm: string;
  baselineUnitCogsRm: string;
  currentUnitCogsRm: string;
  components: readonly CostStackComponent[];
};

const demoProductSnapshots: readonly DemoProductSnapshot[] = [
  {
    productId: "demo_nasi_lemak_ayam",
    productName: "Nasi Lemak Ayam Goreng",
    revenueRm: "288.00",
    cogsRm: "187.20",
    grossProfitRm: "100.80",
    grossMarginPct: "35.00",
    baselineMarginPct: "37.80",
    marginChangePercentagePoints: "-2.80",
    priceFloorRm: "7.50",
    baselineUnitCogsRm: "4.30",
    currentUnitCogsRm: "4.50",
    components: [
      {
        id: "demo_ayam",
        name: "Ayam Goreng",
        changeRmPerPack: "0.12",
        tone: "sambal",
        evidenceId: null
      },
      {
        id: "demo_sambal_ayam",
        name: "Sambal + Minyak",
        changeRmPerPack: "0.04",
        tone: "egg",
        evidenceId: null
      },
      {
        id: "demo_packaging_ayam",
        name: "Bekas Makanan",
        changeRmPerPack: "0.04",
        tone: "pandan",
        evidenceId: null
      }
    ]
  },
  {
    productId: "demo_nasi_lemak_rendang",
    productName: "Nasi Lemak Rendang Daging",
    revenueRm: "234.00",
    cogsRm: "149.76",
    grossProfitRm: "84.24",
    grossMarginPct: "36.00",
    baselineMarginPct: "38.20",
    marginChangePercentagePoints: "-2.20",
    priceFloorRm: "8.00",
    baselineUnitCogsRm: "4.62",
    currentUnitCogsRm: "4.80",
    components: [
      {
        id: "demo_rendang",
        name: "Rendang Daging",
        changeRmPerPack: "0.11",
        tone: "sambal",
        evidenceId: null
      },
      {
        id: "demo_santan_rendang",
        name: "Santan",
        changeRmPerPack: "0.04",
        tone: "coconut",
        evidenceId: null
      },
      {
        id: "demo_rempah_rendang",
        name: "Rempah",
        changeRmPerPack: "0.03",
        tone: "egg",
        evidenceId: null
      }
    ]
  },
  {
    productId: "demo_nasi_lemak_sotong",
    productName: "Nasi Lemak Sambal Sotong",
    revenueRm: "252.00",
    cogsRm: "171.36",
    grossProfitRm: "80.64",
    grossMarginPct: "32.00",
    baselineMarginPct: "35.60",
    marginChangePercentagePoints: "-3.60",
    priceFloorRm: "9.07",
    baselineUnitCogsRm: "5.18",
    currentUnitCogsRm: "5.44",
    components: [
      {
        id: "demo_sotong",
        name: "Sotong",
        changeRmPerPack: "0.17",
        tone: "sambal",
        evidenceId: null
      },
      {
        id: "demo_sambal_sotong",
        name: "Sambal + Minyak",
        changeRmPerPack: "0.06",
        tone: "egg",
        evidenceId: null
      },
      {
        id: "demo_packaging_sotong",
        name: "Bekas Makanan",
        changeRmPerPack: "0.03",
        tone: "pandan",
        evidenceId: null
      }
    ]
  }
];

function createSessionRecipeSnapshot(
  product: DashboardProductOption
): DemoProductSnapshot {
  return {
    productId: product.productId,
    productName: product.productName,
    revenueRm: "216.00",
    cogsRm: "140.40",
    grossProfitRm: "75.60",
    grossMarginPct: "35.00",
    baselineMarginPct: "36.50",
    marginChangePercentagePoints: "-1.50",
    priceFloorRm: "6.50",
    baselineUnitCogsRm: "3.72",
    currentUnitCogsRm: "3.90",
    components: [
      {
        id: `${product.productId}_main`,
        name: "Bahan Utama",
        changeRmPerPack: "0.10",
        tone: "sambal",
        evidenceId: null
      },
      {
        id: `${product.productId}_seasoning`,
        name: "Perencah",
        changeRmPerPack: "0.05",
        tone: "egg",
        evidenceId: null
      },
      {
        id: `${product.productId}_packaging`,
        name: "Bekas Makanan",
        changeRmPerPack: "0.03",
        tone: "pandan",
        evidenceId: null
      }
    ]
  };
}

export function getDashboardProductOptions(
  initialData: DashboardData
): readonly DashboardProductOption[] {
  return [
    {
      productId: initialData.merchant.productId,
      productName: initialData.merchant.productName,
      mode: "connected"
    },
    ...demoProductSnapshots.map((product) => ({
      productId: product.productId,
      productName: product.productName,
      mode: "demo" as const
    }))
  ];
}

export function getDashboardDataForProduct(
  initialData: DashboardData,
  productId: string,
  sessionProducts: readonly DashboardProductOption[] = []
): DashboardData {
  if (productId === initialData.merchant.productId) {
    return initialData;
  }

  const storedSnapshot = demoProductSnapshots.find(
    (candidate) => candidate.productId === productId
  );
  const sessionProduct = sessionProducts.find(
    (candidate) => candidate.productId === productId
  );
  const product = storedSnapshot ??
    (sessionProduct ? createSessionRecipeSnapshot(sessionProduct) : null);
  if (!product) {
    return initialData;
  }

  const baselineDate = shiftDashboardDate(initialData.summary.date, -1);

  return {
    ...initialData,
    merchant: {
      ...initialData.merchant,
      productId: product.productId,
      productName: product.productName
    },
    summary: {
      ...initialData.summary,
      revenue_rm: product.revenueRm,
      cogs_rm: product.cogsRm,
      gross_profit_rm: product.grossProfitRm,
      gross_margin_pct: product.grossMarginPct,
      top_cost_drivers: product.components.map((component) => ({
        name: component.name,
        contribution_rm_per_pack: component.changeRmPerPack
      })),
      baseline_comparison: {
        baseline_margin_pct: product.baselineMarginPct,
        margin_change_percentage_points:
          product.marginChangePercentagePoints
      },
      price_floor: {
        target_gross_margin_pct: "40.00",
        price_floor_rm: product.priceFloorRm,
        assumption: "current_unit_cogs"
      },
      cost_stack: null,
      evidence: [],
      assumptions: [
        "Demo-only placeholder metrics.",
        "No purchase, receipt or simulation data is connected."
      ]
    },
    costStack: {
      baselineDate,
      baselineUnitCogsRm: product.baselineUnitCogsRm,
      currentUnitCogsRm: product.currentUnitCogsRm,
      components: product.components
    },
    evidence: [],
    provenance: "synthetic"
  };
}
