import { Dashboard } from "@/components/dashboard";
import { DashboardStatus } from "@/components/dashboard-status";
import type { DashboardState, Locale } from "@/lib/dashboard-types";
import { loadDashboardState } from "@/lib/dashboard-data";
import { initialAnalyticsState } from "@/lib/analytics-data";
import { syntheticPreviewEnabled } from "@/lib/merchant";
import { authenticatedMerchant } from "@/lib/merchant-auth-page";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

type PageProps = {
  searchParams: Promise<{
    date?: string;
    lang?: string;
    state?: string;
  }>;
};

function parseLocale(value?: string): Locale {
  return value === "en" || value === "zh" ? value : "ms";
}

function previewState(value?: string): DashboardState | null {
  if (process.env.NODE_ENV === "production") return null;
  if (value === "loading") return { status: "loading" };
  if (value === "quota") {
    return { status: "quota", retryAfter: "tomorrow morning" };
  }
  if (value === "error") {
    return { status: "error", message: "Summary service timed out." };
  }
  if (value === "clarification") {
    return {
      status: "clarification",
      question: "Packaging naik RM2 itu per bundle atau total hari ini?",
      options: ["Per bundle of 50", "Total hari ini"]
    };
  }
  return null;
}

export default async function Home({ searchParams }: PageProps) {
  const params = await searchParams;
  const locale = parseLocale(params.lang);
  const preview = syntheticPreviewEnabled();
  const merchant = preview ? null : await authenticatedMerchant();
  if (!preview && !merchant) {
    const nextParams = new URLSearchParams();
    if (params.lang) nextParams.set("lang", params.lang);
    if (params.date) nextParams.set("date", params.date);
    const next = nextParams.size ? `/?${nextParams.toString()}` : "/";
    redirect(`/login?next=${encodeURIComponent(next)}`);
  }
  const state =
    previewState(params.state) ??
    (await loadDashboardState(merchant ?? undefined, params.date));

  if (state.status !== "ready") {
    return <DashboardStatus locale={locale} state={state} />;
  }

  const analytics = initialAnalyticsState(state.data);

  return (
    <Dashboard
      key={`${state.data.provenance}:${state.data.summary.date}`}
      initialData={state.data}
      initialAnalytics={analytics}
      locale={locale}
    />
  );
}
