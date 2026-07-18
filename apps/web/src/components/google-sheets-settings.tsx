"use client";

import {
  AlertTriangle,
  CheckCircle2,
  Download,
  ExternalLink,
  FileSpreadsheet,
  Link2,
  LoaderCircle,
  RefreshCw,
  Send,
  Unplug
} from "lucide-react";
import { useEffect, useState } from "react";

import { DashboardHeader } from "@/components/dashboard-header";
import type { DashboardDateRange } from "@/lib/dashboard-date";
import type { Locale } from "@/lib/dashboard-types";
import type {
  GoogleSheetsDisconnectResponse,
  GoogleSheetsNotice,
  GoogleSheetsOAuthStartResponse,
  GoogleSheetsStatus,
  GoogleSheetsSyncModeRequest,
  GoogleSheetsSyncResponse
} from "@/lib/google-sheets";
import { getGoogleSheetsMessages } from "@/lib/google-sheets-i18n";
import type { MerchantContext } from "@/lib/merchant";

type GoogleSheetsSettingsProps = {
  locale: Locale;
  merchant: MerchantContext;
  summaryDate: string;
  dateRange: DashboardDateRange;
  notice?: GoogleSheetsNotice;
  initialStatus?: GoogleSheetsStatus;
  fetcher?: typeof fetch;
  navigate?: (url: string) => void;
};

type ActionState =
  | "idle"
  | "refresh"
  | "connect"
  | "export"
  | "import"
  | "reconcile"
  | "sync-mode-manual"
  | "sync-mode-automatic"
  | "disconnect";

class GoogleSheetsRequestError extends Error {
  code: string | null;

  constructor(code: string | null, message: string) {
    super(message);
    this.name = "GoogleSheetsRequestError";
    this.code = code;
  }
}

async function responseJson<T>(response: Response) {
  const body = await response.json().catch(() => null) as
    | (T & { error?: string; message?: string })
    | null;
  if (!response.ok) {
    throw new GoogleSheetsRequestError(
      body?.error ?? null,
      body?.message || body?.error || "Request failed."
    );
  }
  return body as T;
}

function formatTimestamp(
  value: string | null,
  locale: Locale,
  fallback: string
) {
  if (!value) return fallback;
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return fallback;
  const language = locale === "zh" ? "zh-CN" : `${locale}-MY`;
  return new Intl.DateTimeFormat(language, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Kuala_Lumpur"
  }).format(date);
}

export function GoogleSheetsSettings({
  locale,
  merchant,
  summaryDate,
  dateRange,
  notice = null,
  initialStatus,
  fetcher = fetch,
  navigate = (url) => window.location.assign(url)
}: GoogleSheetsSettingsProps) {
  const [activeLocale, setActiveLocale] = useState(locale);
  const [status, setStatus] = useState<GoogleSheetsStatus | null>(
    initialStatus ?? null
  );
  const [statusLoadFailed, setStatusLoadFailed] = useState(false);
  const [action, setAction] = useState<ActionState>("idle");
  const [spreadsheetId, setSpreadsheetId] = useState("");
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const initialText = getGoogleSheetsMessages(locale);
  const [message, setMessage] = useState<{
    tone: "success" | "error";
    text: string;
  } | null>(
    notice === "connected"
      ? { tone: "success", text: initialText.connectedNotice }
      : notice === "error"
        ? { tone: "error", text: initialText.callbackError }
        : null
  );
  const text = getGoogleSheetsMessages(activeLocale);
  const busy = action !== "idle";

  function requestErrorText(error: unknown) {
    if (!(error instanceof GoogleSheetsRequestError)) {
      return text.requestError;
    }
    if (error.code === "integration_unavailable") {
      return text.configurationError;
    }
    if (error.code === "google_sheets_webhook_not_configured") {
      return text.webhookConfigurationError;
    }
    return text.requestError;
  }

  async function loadStatus(showBusy = true) {
    if (showBusy) setAction("refresh");
    try {
      const response = await fetcher(
        "/api/pasarai/integrations/google-sheets",
        { cache: "no-store" }
      );
      setStatus(await responseJson<GoogleSheetsStatus>(response));
      setStatusLoadFailed(false);
    } catch (error) {
      setStatusLoadFailed(true);
      setMessage({ tone: "error", text: requestErrorText(error) });
    } finally {
      if (showBusy) setAction("idle");
    }
  }

  useEffect(() => {
    if (!initialStatus) void loadStatus(false);
  }, []);

  async function connect() {
    setAction("connect");
    setMessage(null);
    try {
      const response = await fetcher(
        "/api/pasarai/integrations/google-sheets/oauth/start",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ...(spreadsheetId.trim()
              ? { spreadsheet_id: spreadsheetId.trim() }
              : {})
          })
        }
      );
      const result = await responseJson<GoogleSheetsOAuthStartResponse>(
        response
      );
      const authorizationUrl = new URL(result.authorization_url);
      if (authorizationUrl.protocol !== "https:") {
        throw new Error("Invalid authorization URL.");
      }
      navigate(authorizationUrl.toString());
    } catch (error) {
      setMessage({ tone: "error", text: requestErrorText(error) });
      setAction("idle");
    }
  }

  async function exportSheet() {
    setAction("export");
    setMessage(null);
    try {
      const response = await fetcher(
        "/api/pasarai/integrations/google-sheets/export",
        { method: "POST" }
      );
      const result = await responseJson<GoogleSheetsSyncResponse>(response);
      if (result.operation !== "export") {
        throw new Error("Unexpected Google Sheets operation.");
      }
      await loadStatus(false);
      setMessage({
        tone: "success",
        text: text.exportComplete(result.rows_processed, result.errors)
      });
    } catch (error) {
      setMessage({ tone: "error", text: requestErrorText(error) });
    } finally {
      setAction("idle");
    }
  }

  async function importInputs() {
    setAction("import");
    setMessage(null);
    try {
      const response = await fetcher(
        "/api/pasarai/integrations/google-sheets/import",
        { method: "POST" }
      );
      const result = await responseJson<GoogleSheetsSyncResponse>(response);
      if (result.operation !== "import") {
        throw new Error("Unexpected Google Sheets operation.");
      }
      await loadStatus(false);
      setMessage({
        tone: "success",
        text: text.importComplete(result.rows_processed, result.errors)
      });
    } catch (error) {
      setMessage({ tone: "error", text: requestErrorText(error) });
    } finally {
      setAction("idle");
    }
  }

  async function reconcileSheet() {
    setAction("reconcile");
    setMessage(null);
    try {
      const response = await fetcher(
        "/api/pasarai/integrations/google-sheets/reconcile",
        { method: "POST" }
      );
      const result = await responseJson<GoogleSheetsSyncResponse>(response);
      if (result.operation !== "reconcile") {
        throw new Error("Unexpected Google Sheets operation.");
      }
      await loadStatus(false);
      setMessage({
        tone: "success",
        text: text.reconcileComplete(result.rows_processed, result.errors)
      });
    } catch (error) {
      setMessage({ tone: "error", text: requestErrorText(error) });
    } finally {
      setAction("idle");
    }
  }

  async function updateSyncMode(
    syncMode: GoogleSheetsSyncModeRequest["sync_mode"]
  ) {
    setAction(
      syncMode === "automatic"
        ? "sync-mode-automatic"
        : "sync-mode-manual"
    );
    setMessage(null);
    try {
      const response = await fetcher(
        "/api/pasarai/integrations/google-sheets/sync-mode",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sync_mode: syncMode })
        }
      );
      setStatus(await responseJson<GoogleSheetsStatus>(response));
    } catch (error) {
      setMessage({ tone: "error", text: requestErrorText(error) });
    } finally {
      setAction("idle");
    }
  }

  async function disconnect() {
    setAction("disconnect");
    setMessage(null);
    try {
      const response = await fetcher(
        "/api/pasarai/integrations/google-sheets/disconnect",
        { method: "POST" }
      );
      await responseJson<GoogleSheetsDisconnectResponse>(response);
      await loadStatus(false);
      setConfirmDisconnect(false);
      setMessage({ tone: "success", text: text.disconnectedNotice });
    } catch (error) {
      setMessage({ tone: "error", text: requestErrorText(error) });
    } finally {
      setAction("idle");
    }
  }

  const statusUnavailable = statusLoadFailed && !status;
  const statusLabel =
    statusUnavailable
      ? text.unavailable
      : status?.state === "connected"
      ? text.connected
      : status?.state === "error"
        ? text.error
        : status
          ? text.notConnected
          : text.loading;
  const statusHelp =
    statusUnavailable
      ? text.unavailableHelp
      : status?.state === "connected"
      ? text.connectedHelp
      : status?.state === "error"
        ? status.last_error || text.errorHelp
        : text.notConnectedHelp;

  return (
    <div
      className="app-canvas integrations-canvas"
      data-locale={activeLocale}
      lang={activeLocale === "zh" ? "zh-CN" : activeLocale}
    >
      <DashboardHeader
        activeLocale={activeLocale}
        activeTab="integrations"
        merchant={merchant}
        summaryDate={summaryDate}
        dateRange={dateRange}
        showDateNavigation={false}
        onLocaleChange={setActiveLocale}
      />
      <main className="integrations-main">
        <header className="integrations-intro">
          <p className="eyebrow">{text.eyebrow}</p>
          <h1>{text.title}</h1>
        </header>

        {message ? (
          <div
            className={`integration-notice integration-notice--${message.tone}`}
            role={message.tone === "error" ? "alert" : "status"}
          >
            {message.tone === "success" ? (
              <CheckCircle2 aria-hidden="true" />
            ) : (
              <AlertTriangle aria-hidden="true" />
            )}
            <span>{message.text}</span>
          </div>
        ) : null}

        <section
          className="integration-panel"
          aria-labelledby="google-sheets-heading"
        >
          <div className="integration-panel__heading">
            <span className="integration-mark" aria-hidden="true">
              <FileSpreadsheet />
            </span>
            <div>
              <h2 id="google-sheets-heading">{text.integrationName}</h2>
              <p>{text.integrationDescription}</p>
            </div>
            <button
              className="integration-icon-button"
              type="button"
              title={text.refresh}
              aria-label={text.refresh}
              disabled={busy}
              onClick={() => void loadStatus()}
            >
              <RefreshCw
                aria-hidden="true"
                className={action === "refresh" ? "is-spinning" : undefined}
              />
            </button>
          </div>

          <div className="integration-status">
            <div
              className={[
                "integration-state",
                `integration-state--${
                  statusUnavailable ? "error" : status?.state ?? "loading"
                }`
              ].join(" ")}
            >
              {statusUnavailable ? (
                <AlertTriangle aria-hidden="true" />
              ) : status?.state === "connected" ? (
                <CheckCircle2 aria-hidden="true" />
              ) : status?.state === "error" ? (
                <AlertTriangle aria-hidden="true" />
              ) : status ? (
                <Link2 aria-hidden="true" />
              ) : (
                <LoaderCircle className="is-spinning" aria-hidden="true" />
              )}
              <span>
                <small>{text.status}</small>
                <strong>{statusLabel}</strong>
                <p>{statusHelp}</p>
              </span>
            </div>

            {status?.state === "connected" ? (
              <>
                <div className="integration-sync-setting">
                  <span>
                    <small>{text.syncMode}</small>
                    <p>{text.syncModeHelp}</p>
                  </span>
                  <div
                    className="integration-segmented-control"
                    role="group"
                    aria-label={text.syncMode}
                  >
                    {(["manual", "automatic"] as const).map((syncMode) => {
                      const syncAction = `sync-mode-${syncMode}` as const;
                      const isCurrent = status.sync_mode === syncMode;
                      const isUpdating = action === syncAction;
                      return (
                        <button
                          key={syncMode}
                          type="button"
                          className={isCurrent ? "is-active" : undefined}
                          aria-pressed={isCurrent}
                          disabled={busy}
                          onClick={() => {
                            if (!isCurrent) void updateSyncMode(syncMode);
                          }}
                        >
                          {isUpdating ? (
                            <LoaderCircle
                              className="is-spinning"
                              aria-hidden="true"
                            />
                          ) : null}
                          {isUpdating
                            ? text.updatingSyncMode
                            : syncMode === "automatic"
                              ? text.automatic
                              : text.manual}
                        </button>
                      );
                    })}
                  </div>
                </div>
                <dl className="integration-details">
                  <div>
                    <dt>{text.spreadsheet}</dt>
                    <dd>
                      {status.spreadsheet_title || text.untitledSpreadsheet}
                    </dd>
                  </div>
                  <div>
                    <dt>{text.lastExport}</dt>
                    <dd>
                      {formatTimestamp(
                        status.last_export_at,
                        activeLocale,
                        text.never
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>{text.lastImport}</dt>
                    <dd>
                      {formatTimestamp(
                        status.last_import_at,
                        activeLocale,
                        text.never
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>{text.lastReconciled}</dt>
                    <dd>
                      {formatTimestamp(
                        status.last_reconciled_at,
                        activeLocale,
                        text.never
                      )}
                    </dd>
                  </div>
                  {status.sync_mode === "automatic" ? (
                    <div>
                      <dt>{text.watchExpires}</dt>
                      <dd>
                        {formatTimestamp(
                          status.watch_expires_at,
                          activeLocale,
                          text.never
                        )}
                      </dd>
                    </div>
                  ) : null}
                </dl>
              </>
            ) : null}
          </div>

          {status?.state === "connected" ? (
            <div className="integration-actions">
              {status.spreadsheet_url ? (
                <a
                  className="integration-button integration-button--secondary"
                  href={status.spreadsheet_url}
                  target="_blank"
                  rel="noreferrer"
                >
                  <ExternalLink aria-hidden="true" />
                  {text.openSheet}
                </a>
              ) : null}
              <button
                className="integration-button integration-button--secondary"
                type="button"
                disabled={busy}
                onClick={() => void importInputs()}
              >
                {action === "import" ? (
                  <LoaderCircle className="is-spinning" aria-hidden="true" />
                ) : (
                  <Download aria-hidden="true" />
                )}
                {action === "import" ? text.importing : text.importInputs}
              </button>
              <button
                className="integration-button integration-button--secondary"
                type="button"
                disabled={busy}
                onClick={() => void reconcileSheet()}
              >
                {action === "reconcile" ? (
                  <LoaderCircle className="is-spinning" aria-hidden="true" />
                ) : (
                  <RefreshCw aria-hidden="true" />
                )}
                {action === "reconcile"
                  ? text.reconciling
                  : text.reconcile}
              </button>
              <button
                className="integration-button integration-button--primary"
                type="button"
                disabled={busy}
                onClick={() => void exportSheet()}
              >
                {action === "export" ? (
                  <LoaderCircle className="is-spinning" aria-hidden="true" />
                ) : (
                  <Send aria-hidden="true" />
                )}
                {action === "export" ? text.exporting : text.export}
              </button>
              <button
                className="integration-button integration-button--danger"
                type="button"
                disabled={busy}
                onClick={() => setConfirmDisconnect(true)}
              >
                <Unplug aria-hidden="true" />
                {text.disconnect}
              </button>
            </div>
          ) : (
            <div className="integration-connect">
              <label htmlFor="google-sheets-spreadsheet-id">
                {text.spreadsheetId}
              </label>
              <input
                id="google-sheets-spreadsheet-id"
                aria-describedby="google-sheets-spreadsheet-id-hint"
                value={spreadsheetId}
                onChange={(event) => setSpreadsheetId(event.target.value)}
              />
              <button
                className="integration-button integration-button--primary"
                type="button"
                disabled={busy || !status}
                onClick={() => void connect()}
              >
                {action === "connect" ? (
                  <LoaderCircle className="is-spinning" aria-hidden="true" />
                ) : (
                  <Link2 aria-hidden="true" />
                )}
                {action === "connect" ? text.connecting : text.connect}
              </button>
              <small id="google-sheets-spreadsheet-id-hint">
                {text.spreadsheetIdHint}
              </small>
            </div>
          )}

          {confirmDisconnect ? (
            <div className="integration-confirm" role="alert">
              <p>{text.disconnectPrompt}</p>
              <div>
                <button
                  className="integration-button integration-button--secondary"
                  type="button"
                  disabled={busy}
                  onClick={() => setConfirmDisconnect(false)}
                >
                  {text.cancel}
                </button>
                <button
                  className="integration-button integration-button--danger"
                  type="button"
                  disabled={busy}
                  onClick={() => void disconnect()}
                >
                  {action === "disconnect" ? (
                    <LoaderCircle className="is-spinning" aria-hidden="true" />
                  ) : (
                    <Unplug aria-hidden="true" />
                  )}
                  {action === "disconnect"
                    ? text.disconnecting
                    : text.confirmDisconnect}
                </button>
              </div>
            </div>
          ) : null}
        </section>
      </main>
    </div>
  );
}
