import type {
  AnalyticsActivityResponse,
  AnalyticsOverviewResponse,
  DailySummaryResponse,
  PriceSimulationResponse,
  ReceiptExtraction
} from "@pasarai/contracts/v1";
import type { DashboardDateRange } from "@/lib/dashboard-date";

export type Locale = "en" | "ms" | "zh";
export type CostTone = "egg" | "sambal" | "coconut" | "pandan";

export type CostStackComponent = {
  id: string;
  name: string;
  changeRmPerPack: string;
  tone: CostTone;
  evidenceId: string | null;
};

export type CostStack = {
  baselineDate?: string | null;
  baselineUnitCogsRm: string;
  currentUnitCogsRm: string;
  components: readonly CostStackComponent[];
};

export type UnavailableCostStack = {
  unavailableReason: string;
};

export type DashboardEvidenceRecord = {
  id: string;
  title: string;
  imageUrl: string | null;
  receiptId: string | null;
  supplierName: string | null;
  transcript: string | null;
  lineItems: ReadonlyArray<{
    rawName: string;
    componentId: string | null;
    totalPriceRm: string | null;
    confidence: string | null;
  }>;
};

export type ReceiptReviewRecord = {
  id: string;
  title: string;
  imageUrl: string;
  evidenceUri?: string | null;
  extraction: ReceiptExtraction;
  sourceEventId?: string;
  readyToConfirm?: boolean;
  confirmed?: boolean;
  pendingSync?: boolean;
  localRevision?: number;
  reviewVersion?: number;
  confirmationIdempotencyKey?: string;
  confirmationOccurredAt?: string;
  confirmationRevision?: number;
  updatedAt?: string;
  costEventId?: string | null;
  verifiedAt?: string | null;
  materialChanges?: ReadonlyArray<{
    componentId: string;
    componentName: string;
    productId: string | null;
    quantity: string;
    uom: string;
    packSize: string;
    totalPriceRm: string;
    previousCostRmPerPack: string | null;
    currentCostRmPerPack: string;
    changeRmPerPack: string | null;
  }>;
};

export type DashboardData = {
  merchant: {
    id: string;
    name: string;
    location: string;
    productId: string;
    productName: string;
  };
  summary: DailySummaryResponse;
  costStack: CostStack | UnavailableCostStack;
  evidence: readonly DashboardEvidenceRecord[];
  dateRange: DashboardDateRange;
  provenance: "live" | "synthetic";
};

export type DashboardState =
  | { status: "ready"; data: DashboardData }
  | { status: "loading" }
  | { status: "clarification"; question: string; options: readonly string[] }
  | { status: "quota"; retryAfter?: string }
  | { status: "error"; message: string };

export type DashboardAnalyticsResource<T> =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; data: T }
  | { status: "error"; message: string };

export type DashboardAnalyticsState = {
  overview: DashboardAnalyticsResource<AnalyticsOverviewResponse>;
  activity: DashboardAnalyticsResource<AnalyticsActivityResponse>;
};

export type SimulationState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; result: PriceSimulationResponse }
  | { status: "error"; message: string };
