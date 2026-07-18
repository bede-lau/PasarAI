import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { DashboardStatus } from "@/components/dashboard-status";

describe("dashboard operational states", () => {
  it("renders only the centered SVG spinner for visible loading feedback", () => {
    const { container } = render(
      <DashboardStatus locale="ms" state={{ status: "loading" }} />
    );

    expect(
      container.querySelector("svg.lucide-loader-circle")
    ).toBeInTheDocument();
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
    expect(container.querySelector(".state-skeleton")).not.toBeInTheDocument();
    expect(
      screen.getByRole("status", { name: "Memuatkan" })
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Memuatkan data hari ini yang telah disahkan")
    ).not.toBeInTheDocument();
  });

  it("renders clarification, quota and error states without financial results", () => {
    const { rerender } = render(
      <DashboardStatus
        locale="en"
        state={{
          status: "clarification",
          question: "Packaging increase is per bundle or total today?",
          options: ["Per bundle of 50", "Total today"]
        }}
      />
    );

    expect(screen.getByText("Clarification required")).toBeInTheDocument();
    expect(
      screen.getByText("Packaging increase is per bundle or total today?")
    ).toBeInTheDocument();
    expect(screen.queryByText(/gross margin/i)).not.toBeInTheDocument();

    rerender(
      <DashboardStatus
        locale="en"
        state={{ status: "quota", retryAfter: "tomorrow" }}
      />
    );
    expect(screen.getByText("Data service quota reached")).toBeInTheDocument();
    expect(screen.getByText(/tomorrow/i)).toBeInTheDocument();

    rerender(
      <DashboardStatus
        locale="en"
        state={{ status: "error", message: "Summary service timed out." }}
      />
    );
    expect(screen.getByText("Summary service timed out.")).toBeInTheDocument();
  });
});
