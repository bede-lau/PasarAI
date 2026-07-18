import { DashboardStatus } from "@/components/dashboard-status";

export default function Loading() {
  return <DashboardStatus locale="ms" state={{ status: "loading" }} />;
}
