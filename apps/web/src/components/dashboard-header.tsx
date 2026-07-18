"use client";

import type { ChangeEvent } from "react";

import { BrandMark } from "@/components/brand-mark";
import {
  dateIsInRange,
  shiftDashboardDate,
  type DashboardDateRange
} from "@/lib/dashboard-date";
import type { Locale } from "@/lib/dashboard-types";
import { getMessages } from "@/lib/i18n";
import type { MerchantContext } from "@/lib/merchant";

type DashboardHeaderProps = {
  activeLocale: Locale;
  activeTab: "dashboard" | "receipts" | "integrations";
  merchant: MerchantContext;
  summaryDate: string;
  dateRange: DashboardDateRange;
  showDateNavigation?: boolean;
  onLocaleChange: (locale: Locale) => void;
};

function formatSummaryDate(value: string, locale: Locale) {
  const language = locale === "zh" ? "zh-CN" : `${locale}-MY`;
  return new Intl.DateTimeFormat(language, {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC"
  }).format(new Date(`${value}T00:00:00Z`));
}

function dashboardHref(
  path: "/" | "/receipts" | "/settings/integrations",
  locale: Locale,
  date: string
) {
  const params = new URLSearchParams({ lang: locale, date });
  return `${path}?${params.toString()}`;
}

export function DashboardHeader({
  activeLocale,
  activeTab,
  merchant,
  summaryDate,
  dateRange,
  showDateNavigation = true,
  onLocaleChange
}: DashboardHeaderProps) {
  const text = getMessages(activeLocale);
  const currentPath =
    activeTab === "dashboard"
      ? "/"
      : activeTab === "receipts"
        ? "/receipts"
        : "/settings/integrations";
  const previousDate = shiftDashboardDate(summaryDate, -1);
  const nextDate = shiftDashboardDate(summaryDate, 1);
  const previousEnabled = dateIsInRange(previousDate, dateRange);
  const nextEnabled = dateIsInRange(nextDate, dateRange);

  function submitSelectedDate(event: ChangeEvent<HTMLInputElement>) {
    if (event.currentTarget.value) {
      event.currentTarget.form?.requestSubmit();
    }
  }

  return (
    <header
      className={[
        "topbar",
        showDateNavigation ? "" : "topbar--without-date"
      ].filter(Boolean).join(" ")}
    >
      <a
        className="brand-lockup"
        href={dashboardHref("/", activeLocale, summaryDate)}
        aria-label={`PasarAI ${text.dashboard}`}
      >
        <BrandMark />
        <span>
          <strong>PasarAI</strong>
          <small>{text.slogan}</small>
        </span>
      </a>
      <div className="merchant-context">
        <span className="merchant-dot" aria-hidden="true" />
        <span>
          <strong>{merchant.name}</strong>
          <small>
            {merchant.location} {"\u00b7"} {merchant.productName}
          </small>
        </span>
      </div>
      {showDateNavigation ? (
        <div
          className="date-navigator"
          role="group"
          aria-label={text.dateNavigation}
        >
          {previousEnabled ? (
            <a
              className="date-step"
              href={dashboardHref(currentPath, activeLocale, previousDate)}
              aria-label={text.previousDate}
              title={text.previousDate}
            >
              {"\u2039"}
            </a>
          ) : (
            <button
              className="date-step"
              type="button"
              aria-label={text.previousDate}
              title={text.previousDate}
              disabled
            >
              {"\u2039"}
            </button>
          )}
          <form className="date-picker-form" action={currentPath} method="get">
            <input type="hidden" name="lang" value={activeLocale} />
            <label className="date-picker-field">
              <span>{text.reportingDate}</span>
              <input
                className="header-date"
                type="date"
                name="date"
                value={summaryDate}
                min={dateRange.min}
                max={dateRange.max}
                aria-label={text.reportingDate}
                title={formatSummaryDate(summaryDate, activeLocale)}
                onChange={submitSelectedDate}
              />
            </label>
          </form>
          {nextEnabled ? (
            <a
              className="date-step"
              href={dashboardHref(currentPath, activeLocale, nextDate)}
              aria-label={text.nextDate}
              title={text.nextDate}
            >
              {"\u203a"}
            </a>
          ) : (
            <button
              className="date-step"
              type="button"
              aria-label={text.nextDate}
              title={text.nextDate}
              disabled
            >
              {"\u203a"}
            </button>
          )}
        </div>
      ) : null}
      <nav className="topnav" aria-label={text.primaryNavigation}>
        <a
          aria-current={activeTab === "dashboard" ? "page" : undefined}
          href={dashboardHref("/", activeLocale, summaryDate)}
        >
          {text.dashboard}
        </a>
        <a
          aria-current={activeTab === "receipts" ? "page" : undefined}
          href={dashboardHref("/receipts", activeLocale, summaryDate)}
        >
          {text.receipts}
        </a>
        <a
          aria-current={activeTab === "integrations" ? "page" : undefined}
          href={dashboardHref(
            "/settings/integrations",
            activeLocale,
            summaryDate
          )}
        >
          {text.integrations}
        </a>
      </nav>
      <div className="locale-switcher" aria-label={text.language}>
        {(["ms", "en", "zh"] as const).map((language) => (
          <button
            key={language}
            type="button"
            aria-pressed={activeLocale === language}
            onClick={() => onLocaleChange(language)}
          >
            {language === "ms"
              ? "BM"
              : language === "en"
                ? "EN"
                : "\u4e2d\u6587"}
          </button>
        ))}
      </div>
    </header>
  );
}
