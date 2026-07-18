import { ReceiptReviewScreen } from "@/components/receipt-review-screen";
import { loadComponentCatalog } from "@/lib/component-catalog";
import {
  configuredDashboardDate,
  resolveDashboardDate
} from "@/lib/dashboard-date";
import { loadDashboardState } from "@/lib/dashboard-data";
import type { Locale } from "@/lib/dashboard-types";
import {
  demoMerchant,
  syntheticPreviewEnabled
} from "@/lib/merchant";
import { authenticatedMerchant } from "@/lib/merchant-auth-page";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

type ReceiptPageProps = {
  searchParams: Promise<{
    date?: string;
    entry?: string;
    lang?: string;
  }>;
};

function parseLocale(value?: string): Locale {
  return value === "en" || value === "zh" ? value : "ms";
}

export default async function ReceiptsPage({
  searchParams
}: ReceiptPageProps) {
  const { date, entry, lang } = await searchParams;
  const preview = syntheticPreviewEnabled();
  const merchant = preview ? demoMerchant : await authenticatedMerchant();
  if (!merchant) {
    const nextParams = new URLSearchParams();
    if (lang) nextParams.set("lang", lang);
    if (date) nextParams.set("date", date);
    if (entry === "cash") nextParams.set("entry", "cash");
    const next = nextParams.size
      ? `/receipts?${nextParams.toString()}`
      : "/receipts";
    redirect(`/login?next=${encodeURIComponent(next)}`);
  }
  const initialReceipt =
    preview
      ? (await import("@/lib/synthetic-preview")).syntheticReviewReceipt
      : undefined;
  const dashboardState = await loadDashboardState(merchant, date);
  const fallbackDateRange = {
    max: configuredDashboardDate(process.env.PASARAI_DASHBOARD_DATE)
  };
  const dateRange =
    dashboardState.status === "ready"
      ? dashboardState.data.dateRange
      : fallbackDateRange;
  const summaryDate =
    dashboardState.status === "ready"
      ? dashboardState.data.summary.date
      : resolveDashboardDate(
          date,
          process.env.PASARAI_DASHBOARD_DATE
            ?? initialReceipt?.extraction.date
            ?? undefined,
          dateRange
        );
  const componentCatalog = await loadComponentCatalog(
    merchant,
    summaryDate,
    dashboardState
  );

  return (
    <ReceiptReviewScreen
      initialEntry={entry === "cash" ? "cash" : "receipt"}
      locale={parseLocale(lang)}
      merchant={merchant}
      summaryDate={summaryDate}
      dateRange={dateRange}
      initialReceipt={initialReceipt}
      componentCatalog={componentCatalog.catalog}
      componentCatalogUnavailable={componentCatalog.unavailable}
    />
  );
}
