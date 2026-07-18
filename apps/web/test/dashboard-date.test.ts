import { describe, expect, it } from "vitest";

import {
  configuredDashboardDate,
  currentDateInKualaLumpur,
  DEFAULT_DEMO_DASHBOARD_DATE,
  isDashboardDate,
  resolveDashboardDate,
  shiftDashboardDate
} from "@/lib/dashboard-date";

describe("dashboard date utilities", () => {
  it("validates exact ISO calendar dates", () => {
    expect(isDashboardDate("2026-07-12")).toBe(true);
    expect(isDashboardDate("2026-02-30")).toBe(false);
    expect(isDashboardDate("12-07-2026")).toBe(false);
  });

  it("uses the Kuala Lumpur calendar day", () => {
    expect(
      currentDateInKualaLumpur(new Date("2026-07-15T16:30:00Z"))
    ).toBe("2026-07-16");
  });

  it("pins the demo dashboard to July 16, 2026", () => {
    expect(DEFAULT_DEMO_DASHBOARD_DATE).toBe("2026-07-16");
    expect(configuredDashboardDate()).toBe("2026-07-16");
    expect(configuredDashboardDate("invalid")).toBe("2026-07-16");
    expect(configuredDashboardDate("2026-07-15")).toBe("2026-07-15");
  });

  it("steps dates and rejects requests outside the available range", () => {
    const range = { min: "2026-07-05", max: "2026-07-12" };

    expect(shiftDashboardDate("2026-07-12", -1)).toBe("2026-07-11");
    expect(
      resolveDashboardDate("2026-07-13", "2026-07-10", range)
    ).toBe("2026-07-10");
    expect(
      resolveDashboardDate("invalid", undefined, range)
    ).toBe("2026-07-12");
  });
});
