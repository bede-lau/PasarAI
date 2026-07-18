"use client";

import { DashboardStatus } from "@/components/dashboard-status";

export default function ErrorPage({ error }: { error: Error }) {
  return (
    <DashboardStatus
      locale="ms"
      state={{ status: "error", message: error.message }}
    />
  );
}
