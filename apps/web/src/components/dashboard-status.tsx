import { LoaderCircle } from "lucide-react";

import type { DashboardState, Locale } from "@/lib/dashboard-types";

type DashboardStatusProps = {
  locale: Locale;
  state: Exclude<DashboardState, { status: "ready" }>;
};

const copy = {
  en: {
    loading: "Loading",
    clarification: "Clarification required",
    quota: "Data service quota reached",
    quotaDetail: "PasarAI has preserved your evidence. Retry",
    error: "Could not load verified data"
  },
  ms: {
    loading: "Memuatkan",
    clarification: "Pengesahan diperlukan",
    quota: "Kuota perkhidmatan data telah dicapai",
    quotaDetail: "PasarAI telah menyimpan bukti anda. Cuba lagi",
    error: "Data yang disahkan tidak dapat dimuatkan"
  },
  zh: {
    loading: "正在加载",
    clarification: "需要确认",
    quota: "数据服务配额已用完",
    quotaDetail: "PasarAI 已保留您的凭证。请重试",
    error: "无法加载已验证数据"
  }
} as const;

export function DashboardStatus({ locale, state }: DashboardStatusProps) {
  const text = copy[locale];

  if (state.status === "loading") {
    return (
      <main className="state-shell" aria-busy="true">
        <p className="eyebrow">PasarAI</p>
        <LoaderCircle
          className="state-loader is-spinning"
          role="status"
          aria-live="polite"
          aria-label={text.loading}
        />
      </main>
    );
  }

  if (state.status === "clarification") {
    return (
      <main className="state-shell">
        <section className="state-panel" role="status" aria-live="polite">
          <p className="state-kicker">{text.clarification}</p>
          <h1>{state.question}</h1>
          <div className="state-actions">
            {state.options.map((option) => (
              <button key={option} type="button">
                {option}
              </button>
            ))}
          </div>
        </section>
      </main>
    );
  }

  if (state.status === "quota") {
    return (
      <main className="state-shell">
        <section className="state-panel" role="alert">
          <p className="state-kicker">SERVICE STATUS</p>
          <h1>{text.quota}</h1>
          <p>
            {text.quotaDetail} {state.retryAfter ?? "later"}.
          </p>
        </section>
      </main>
    );
  }

  return (
    <main className="state-shell">
      <section className="state-panel" role="alert">
        <p className="state-kicker">REVIEW NEEDED</p>
        <h1>{text.error}</h1>
        <p>{state.message}</p>
      </section>
    </main>
  );
}
