import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { GoogleSheetsSettings } from "@/components/google-sheets-settings";
import type { Locale } from "@/lib/dashboard-types";
import type { GoogleSheetsStatus } from "@/lib/google-sheets";

const merchant = {
  id: "m_kak_lina_001",
  name: "Warung Kak Lina",
  location: "Petaling Jaya",
  productId: "p_nlb_001",
  productName: "Nasi Lemak Biasa"
};

const connectedStatus: GoogleSheetsStatus = {
  state: "connected",
  spreadsheet_id: "sheet_001",
  spreadsheet_url: "https://docs.google.com/spreadsheets/d/sheet_001",
  spreadsheet_title: "PasarAI Ledger",
  sync_mode: "manual",
  last_export_at: "2026-07-16T04:30:00Z",
  last_import_at: null,
  last_reconciled_at: null,
  watch_expires_at: null,
  last_error: null
};

const notConnectedStatus: GoogleSheetsStatus = {
  state: "not_connected",
  spreadsheet_id: null,
  spreadsheet_url: null,
  spreadsheet_title: null,
  sync_mode: "manual",
  last_export_at: null,
  last_import_at: null,
  last_reconciled_at: null,
  watch_expires_at: null,
  last_error: null
};

function renderSettings(
  options: {
    locale?: Locale;
    status?: GoogleSheetsStatus | null;
    fetcher?: typeof fetch;
    navigate?: (url: string) => void;
  } = {}
) {
  return render(
    <GoogleSheetsSettings
      locale={options.locale ?? "en"}
      merchant={merchant}
      summaryDate="2026-07-16"
      dateRange={{ max: "2026-07-16" }}
      initialStatus={
        options.status === null ? undefined : options.status ?? connectedStatus
      }
      fetcher={options.fetcher}
      navigate={options.navigate}
    />
  );
}

describe("Google Sheets settings", () => {
  it("ends the loading state and explains when the integration is not configured", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      Response.json(
        {
          error: "integration_unavailable",
          message: "Google Sheets integration is not configured."
        },
        { status: 503 }
      )
    ) as unknown as typeof fetch;

    renderSettings({ status: null, fetcher });

    expect(await screen.findByText("Unavailable")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Google Sheets is not configured for this PasarAI environment."
      )
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "PasarAI could not check the connection. Refresh after the service is configured or restarted."
      )
    ).toBeInTheDocument();
    expect(screen.queryByText("Checking connection")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Connect Google Sheets" })
    ).toBeDisabled();
  });

  it("shows the connected sheet, actions, nav state, and localized copy", async () => {
    const user = userEvent.setup();
    renderSettings();

    expect(
      screen.getByRole("link", { name: "Integrations" })
    ).toHaveAttribute("aria-current", "page");
    expect(
      screen.getByRole("link", { name: "Dashboard" })
    ).toHaveAttribute("href", "/?lang=en&date=2026-07-16");
    expect(
      screen.getByRole("link", { name: "Integrations" })
    ).toHaveAttribute(
      "href",
      "/settings/integrations?lang=en&date=2026-07-16"
    );
    expect(screen.getByText("PasarAI Ledger")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open spreadsheet" })).toHaveAttribute(
      "href",
      connectedStatus.spreadsheet_url
    );
    expect(screen.getByRole("button", { name: "Export now" })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "BM" }));
    expect(screen.getByText("Status sambungan")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Eksport sekarang" })
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "中文" }));
    expect(screen.getByText("连接状态")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "立即导出" })
    ).toBeInTheDocument();
  });

  it("starts OAuth with an optional spreadsheet ID and navigates to Google", async () => {
    const user = userEvent.setup();
    const navigate = vi.fn();
    const fetcher = vi.fn().mockResolvedValue(
      Response.json({
        authorization_url:
          "https://accounts.google.com/o/oauth2/v2/auth?state=state_001",
        state: "state_001",
        expires_at: "2026-07-16T14:00:00Z"
      })
    ) as unknown as typeof fetch;
    renderSettings({
      status: notConnectedStatus,
      fetcher,
      navigate
    });

    await user.type(
      screen.getByLabelText("Existing spreadsheet ID"),
      "sheet_001"
    );
    await user.click(
      screen.getByRole("button", { name: "Connect Google Sheets" })
    );

    expect(fetcher).toHaveBeenCalledWith(
      "/api/pasarai/integrations/google-sheets/oauth/start",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ spreadsheet_id: "sheet_001" })
      })
    );
    expect(navigate).toHaveBeenCalledWith(
      "https://accounts.google.com/o/oauth2/v2/auth?state=state_001"
    );
  });

  it("localizes the import action in English, Malay, and Chinese", async () => {
    const user = userEvent.setup();
    renderSettings();

    expect(
      screen.getByRole("button", { name: "Import inputs" })
    ).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "BM" }));
    expect(
      screen.getByRole("button", { name: "Import input" })
    ).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "\u4e2d\u6587" })
    );
    expect(
      screen.getByRole("button", { name: "\u5bfc\u5165\u8f93\u5165\u6570\u636e" })
    ).toBeInTheDocument();
  });

  it("exports, refreshes status, and reports the row count", async () => {
    const user = userEvent.setup();
    const fetcher = vi.fn()
      .mockResolvedValueOnce(
        Response.json({
          state: "completed",
          job_id: "job_001",
          operation: "export",
          rows_processed: 24,
          errors: 0,
          spreadsheet_url: connectedStatus.spreadsheet_url,
          completed_at: "2026-07-16T13:00:00Z"
        })
      )
      .mockResolvedValueOnce(
        Response.json({
          ...connectedStatus,
          last_export_at: "2026-07-16T13:00:00Z"
        })
      ) as unknown as typeof fetch;
    renderSettings({ fetcher });

    await user.click(screen.getByRole("button", { name: "Export now" }));

    expect(await screen.findByText("Exported 24 rows successfully."))
      .toBeInTheDocument();
    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      "/api/pasarai/integrations/google-sheets/export",
      { method: "POST" }
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      "/api/pasarai/integrations/google-sheets",
      { cache: "no-store" }
    );
  });

  it("imports inputs with operation-specific loading copy and refreshes status", async () => {
    const user = userEvent.setup();
    let resolveImport: ((response: Response) => void) | undefined;
    const fetcher = vi.fn()
      .mockImplementationOnce(
        () => new Promise<Response>((resolve) => {
          resolveImport = resolve;
        })
      )
      .mockResolvedValueOnce(
        Response.json({
          ...connectedStatus,
          last_import_at: "2026-07-16T13:30:00Z"
        })
      ) as unknown as typeof fetch;
    renderSettings({ fetcher });

    await user.click(screen.getByRole("button", { name: "Import inputs" }));
    expect(
      screen.getByRole("button", { name: "Importing inputs" })
    ).toBeDisabled();

    resolveImport?.(
      Response.json({
        state: "completed",
        job_id: "job_import_001",
        operation: "import",
        rows_processed: 18,
        errors: 0,
        spreadsheet_url: connectedStatus.spreadsheet_url,
        completed_at: "2026-07-16T13:30:00Z"
      })
    );

    expect(
      await screen.findByText("Imported 18 input rows successfully.")
    ).toBeInTheDocument();
    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      "/api/pasarai/integrations/google-sheets/import",
      { method: "POST" }
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      "/api/pasarai/integrations/google-sheets",
      { cache: "no-store" }
    );
  });

  it.each([
    {
      locale: "en" as const,
      action: "Reconcile now",
      loading: "Reconciling",
      success: "Reconciled 6 rows successfully."
    },
    {
      locale: "ms" as const,
      action: "Selaraskan sekarang",
      loading: "Menyelaraskan",
      success: "6 baris berjaya diselaraskan."
    },
    {
      locale: "zh" as const,
      action: "\u7acb\u5373\u6838\u5bf9",
      loading: "\u6b63\u5728\u6838\u5bf9",
      success: "\u5df2\u6210\u529f\u6838\u5bf9 6 \u884c\u3002"
    }
  ])(
    "reconciles with operation-specific $locale loading and success copy",
    async ({ locale, action, loading, success }) => {
      const user = userEvent.setup();
      let resolveReconcile: ((response: Response) => void) | undefined;
      const fetcher = vi.fn()
        .mockImplementationOnce(
          () => new Promise<Response>((resolve) => {
            resolveReconcile = resolve;
          })
        )
        .mockResolvedValueOnce(
          Response.json({
            ...connectedStatus,
            last_reconciled_at: "2026-07-16T13:45:00Z"
          })
        ) as unknown as typeof fetch;
      renderSettings({ locale, fetcher });

      await user.click(screen.getByRole("button", { name: action }));
      expect(
        screen.getByRole("button", { name: loading })
      ).toBeDisabled();

      resolveReconcile?.(
        Response.json({
          state: "completed",
          job_id: "job_reconcile_001",
          operation: "reconcile",
          rows_processed: 6,
          errors: 0,
          spreadsheet_url: connectedStatus.spreadsheet_url,
          completed_at: "2026-07-16T13:45:00Z"
        })
      );

      expect(await screen.findByText(success)).toBeInTheDocument();
      expect(fetcher).toHaveBeenNthCalledWith(
        1,
        "/api/pasarai/integrations/google-sheets/reconcile",
        { method: "POST" }
      );
      expect(fetcher).toHaveBeenNthCalledWith(
        2,
        "/api/pasarai/integrations/google-sheets",
        { cache: "no-store" }
      );
    }
  );

  it("updates the sync mode through the segmented control and applies the returned status", async () => {
    const user = userEvent.setup();
    const automaticStatus: GoogleSheetsStatus = {
      ...connectedStatus,
      sync_mode: "automatic",
      watch_expires_at: "2026-07-23T13:45:00Z"
    };
    const fetcher = vi.fn().mockResolvedValue(
      Response.json(automaticStatus)
    ) as unknown as typeof fetch;
    renderSettings({ fetcher });

    const manual = screen.getByRole("button", { name: "Manual" });
    const automatic = screen.getByRole("button", { name: "Automatic" });
    expect(manual).toHaveAttribute("aria-pressed", "true");
    expect(automatic).toHaveAttribute("aria-pressed", "false");

    await user.click(automatic);

    expect(fetcher).toHaveBeenCalledWith(
      "/api/pasarai/integrations/google-sheets/sync-mode",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sync_mode: "automatic" })
      }
    );
    expect(
      await screen.findByRole("button", { name: "Automatic" })
    ).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Automatic sync expires")).toBeInTheDocument();
  });

  it("explains when automatic sync is missing its public webhook", async () => {
    const user = userEvent.setup();
    const fetcher = vi.fn().mockResolvedValue(
      Response.json(
        {
          error: "google_sheets_webhook_not_configured",
          message:
            "Automatic synchronization requires an HTTPS Google Sheets webhook URL."
        },
        { status: 409 }
      )
    ) as unknown as typeof fetch;
    renderSettings({ fetcher });

    await user.click(screen.getByRole("button", { name: "Automatic" }));

    expect(
      await screen.findByText(
        "Automatic synchronization needs a public HTTPS webhook configured in PasarAI."
      )
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Manual" })
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("requires confirmation before disconnecting and refreshes to not connected", async () => {
    const user = userEvent.setup();
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({ state: "disconnected" }))
      .mockResolvedValueOnce(Response.json(notConnectedStatus)) as unknown as
      typeof fetch;
    renderSettings({ fetcher });

    await user.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(
      screen.getByText(/spreadsheet will remain in Google Drive/i)
    ).toBeInTheDocument();
    expect(fetcher).not.toHaveBeenCalled();

    await user.click(
      screen.getByRole("button", { name: "Confirm disconnect" })
    );

    expect(
      await screen.findByText("Google Sheets was disconnected.")
    ).toBeInTheDocument();
    expect(screen.getByText("Not connected")).toBeInTheDocument();
    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      "/api/pasarai/integrations/google-sheets/disconnect",
      { method: "POST" }
    );
  });
});
