import { redirect } from "next/navigation";

import { GoogleSheetsSettings } from "@/components/google-sheets-settings";
import {
  configuredDashboardDate,
  resolveDashboardDate
} from "@/lib/dashboard-date";
import type { Locale } from "@/lib/dashboard-types";
import type { GoogleSheetsNotice } from "@/lib/google-sheets";
import { authenticatedMerchant } from "@/lib/merchant-auth-page";

export const dynamic = "force-dynamic";

type IntegrationsPageProps = {
  searchParams: Promise<{
    date?: string;
    google_sheets?: string;
    lang?: string;
  }>;
};

function parseLocale(value?: string): Locale {
  return value === "en" || value === "zh" ? value : "ms";
}

function parseNotice(value?: string): GoogleSheetsNotice {
  return value === "connected" || value === "error" ? value : null;
}

export default async function IntegrationsPage({
  searchParams
}: IntegrationsPageProps) {
  const params = await searchParams;
  const merchant = await authenticatedMerchant();
  if (!merchant) {
    const nextParams = new URLSearchParams();
    if (params.lang) nextParams.set("lang", params.lang);
    if (params.date) nextParams.set("date", params.date);
    if (params.google_sheets) {
      nextParams.set("google_sheets", params.google_sheets);
    }
    const next = nextParams.size
      ? `/settings/integrations?${nextParams.toString()}`
      : "/settings/integrations";
    redirect(`/login?next=${encodeURIComponent(next)}`);
  }

  const reportingDate = configuredDashboardDate(
    process.env.PASARAI_DASHBOARD_DATE
  );
  const dateRange = { max: reportingDate };
  const summaryDate = resolveDashboardDate(
    params.date,
    reportingDate,
    dateRange
  );
  return (
    <GoogleSheetsSettings
      locale={parseLocale(params.lang)}
      merchant={merchant}
      summaryDate={summaryDate}
      dateRange={dateRange}
      notice={parseNotice(params.google_sheets)}
    />
  );
}
