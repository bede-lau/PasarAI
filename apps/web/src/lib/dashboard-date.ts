export type DashboardDateRange = {
  min?: string;
  max: string;
};

export const DEFAULT_DEMO_DASHBOARD_DATE = "2026-07-16";

const DASHBOARD_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

export function isDashboardDate(value?: string): value is string {
  if (!value || !DASHBOARD_DATE_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf())
    && parsed.toISOString().slice(0, 10) === value;
}

export function currentDateInKualaLumpur(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Kuala_Lumpur",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(now);
  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value])
  );
  return `${values.year}-${values.month}-${values.day}`;
}

export function configuredDashboardDate(value?: string) {
  return isDashboardDate(value) ? value : DEFAULT_DEMO_DASHBOARD_DATE;
}

export function dateIsInRange(
  value: string,
  range: DashboardDateRange
) {
  return isDashboardDate(value)
    && value <= range.max
    && (!range.min || value >= range.min);
}

export function resolveDashboardDate(
  requestedDate: string | undefined,
  fallbackDate: string | undefined,
  range: DashboardDateRange
) {
  for (const candidate of [requestedDate, fallbackDate, range.max]) {
    if (candidate && dateIsInRange(candidate, range)) return candidate;
  }
  return range.max;
}

export function shiftDashboardDate(value: string, days: number) {
  if (!isDashboardDate(value)) return value;
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
