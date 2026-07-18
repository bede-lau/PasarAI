"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { ExternalLink, Plus, X } from "lucide-react";
import type {
  PriceSimulationRequest,
  PriceSimulationResponse
} from "@pasarai/contracts/v1";

import {
  AnalyticsViewTabs,
  DashboardAnalyticsView,
  type DashboardView
} from "@/components/dashboard-analytics";
import { DashboardHeader } from "@/components/dashboard-header";
import { DashboardProductPicker } from "@/components/dashboard-product-picker";
import {
  getAnalyticsActivity,
  getAnalyticsOverview
} from "@/lib/analytics-actions";
import type {
  DashboardAnalyticsState,
  DashboardData,
  Locale,
  SimulationState
} from "@/lib/dashboard-types";
import { shiftDashboardDate } from "@/lib/dashboard-date";
import {
  getDashboardDataForProduct,
  getDashboardProductOptions,
  type DashboardProductOption
} from "@/lib/demo-dashboard-products";
import { getMessages } from "@/lib/i18n";
import { postPriceSimulation } from "@/lib/simulate-price";

type DashboardProps = {
  initialData: DashboardData;
  initialAnalytics?: DashboardAnalyticsState;
  locale: Locale;
  simulatePrice?: (
    request: PriceSimulationRequest
  ) => Promise<PriceSimulationResponse>;
};

type EvidenceSelection = {
  evidenceId: string;
  componentId: string;
};

function formatMyr(value: string) {
  return `RM${Number(value).toFixed(2)}`;
}

function formatSignedMyr(value: string) {
  const amount = Number(value);
  if (amount === 0) return "RM0.00";
  return `${amount > 0 ? "+" : "-"}RM${Math.abs(amount).toFixed(2)}`;
}

function formatSnapshotDate(value: string, locale: Locale) {
  const language = locale === "zh" ? "zh-CN" : `${locale}-MY`;
  return new Intl.DateTimeFormat(language, {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC"
  }).format(new Date(`${value}T00:00:00Z`));
}

export function Dashboard({
  initialData,
  initialAnalytics = {
    overview: { status: "loading" },
    activity: { status: "idle" }
  },
  locale,
  simulatePrice = postPriceSimulation
}: DashboardProps) {
  const [activeLocale, setActiveLocale] = useState(locale);
  const [activeView, setActiveView] = useState<DashboardView>("today");
  const [analytics, setAnalytics] = useState(initialAnalytics);
  const overviewRequest = useRef<AbortController | null>(null);
  const activityRequest = useRef<AbortController | null>(null);
  const [activeProductId, setActiveProductId] = useState(
    initialData.merchant.productId
  );
  const [sessionRecipes, setSessionRecipes] = useState<
    DashboardProductOption[]
  >([]);
  const activeData = getDashboardDataForProduct(
    initialData,
    activeProductId,
    sessionRecipes
  );
  const productOptions = [
    ...getDashboardProductOptions(initialData),
    ...sessionRecipes
  ];
  const isDemoProduct =
    activeProductId !== initialData.merchant.productId;
  const { summary, costStack } = activeData;
  const text = getMessages(activeLocale);
  const purchaseParams = new URLSearchParams({
    lang: activeLocale,
    date: summary.date,
    entry: "cash"
  });
  const [proposedPrice, setProposedPrice] = useState("0.00");
  const [expectedQuantity, setExpectedQuantity] = useState("0");
  const [simulation, setSimulation] = useState<SimulationState>({
    status: "idle"
  });
  const [evidenceSelection, setEvidenceSelection] =
    useState<EvidenceSelection | null>(null);
  const selectedEvidence = activeData.evidence.find(
    (record) => record.id === evidenceSelection?.evidenceId
  );
  const selectedComponent =
    evidenceSelection && !("unavailableReason" in costStack)
      ? costStack.components.find(
          (component) => component.id === evidenceSelection.componentId
        )
      : null;
  const matchingEvidenceLines = selectedEvidence?.lineItems.filter(
    (line) => line.componentId === evidenceSelection?.componentId
  ) ?? [];
  const visibleEvidenceLines = selectedComponent
    ? matchingEvidenceLines
    : selectedEvidence?.lineItems ?? [];

  useEffect(() => {
    if (
      initialData.provenance !== "live"
      || initialAnalytics.overview.status !== "loading"
    ) {
      return;
    }

    loadOverview(["loading"]);
  }, [
    initialAnalytics.overview.status,
    initialData.provenance,
    initialData.summary.date
  ]);

  useEffect(() => {
    return () => {
      overviewRequest.current?.abort();
      activityRequest.current?.abort();
    };
  }, []);

  function loadOverview(allowedStatuses: Array<
    DashboardAnalyticsState["overview"]["status"]
  >) {
    if (
      isDemoProduct
      || initialData.provenance !== "live"
      || overviewRequest.current
      || !allowedStatuses.includes(analytics.overview.status)
    ) {
      return;
    }

    const request = new AbortController();
    overviewRequest.current = request;
    setAnalytics((current) => ({
      ...current,
      overview: { status: "loading" }
    }));
    const from = shiftDashboardDate(initialData.summary.date, -27);
    void getAnalyticsOverview({
      from,
      signal: request.signal,
      to: initialData.summary.date
    }).then(
      (overview) => {
        if (request.signal.aborted) return;
        overviewRequest.current = null;
        setAnalytics((current) => ({
          ...current,
          overview: { status: "ready", data: overview }
        }));
      },
      (error: unknown) => {
        if (request.signal.aborted) return;
        overviewRequest.current = null;
        setAnalytics((current) => ({
          ...current,
          overview: {
            status: "error",
            message:
              error instanceof Error
                ? error.message
                : "Analytics overview could not be loaded."
          }
        }));
      }
    );
  }

  function loadActivity(allowedStatuses: Array<
    DashboardAnalyticsState["activity"]["status"]
  >) {
    if (
      isDemoProduct
      || initialData.provenance !== "live"
      || activityRequest.current
      || !allowedStatuses.includes(analytics.activity.status)
    ) {
      return;
    }

    const request = new AbortController();
    activityRequest.current = request;
    setAnalytics((current) => ({
      ...current,
      activity: { status: "loading" }
    }));
    const from = shiftDashboardDate(initialData.summary.date, -27);
    void getAnalyticsActivity({
      from,
      signal: request.signal,
      to: initialData.summary.date
    }).then(
      (activity) => {
        if (request.signal.aborted) return;
        activityRequest.current = null;
        setAnalytics((current) => ({
          ...current,
          activity: { status: "ready", data: activity }
        }));
      },
      (error: unknown) => {
        if (request.signal.aborted) return;
        activityRequest.current = null;
        setAnalytics((current) => ({
          ...current,
          activity: {
            status: "error",
            message:
              error instanceof Error
                ? error.message
                : "Activity could not be loaded."
          }
        }));
      }
    );
  }

  function selectView(view: DashboardView) {
    setActiveView(view);
    if (view === "activity") loadActivity(["idle", "error"]);
    if (view === "today" || view === "trends" || view === "plan") {
      loadOverview(["idle", "error"]);
    }
  }

  async function runSimulation(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (isDemoProduct) return;

    setSimulation({ status: "loading" });
    try {
      const result = await simulatePrice({
        merchant_id: activeData.merchant.id,
        product_id: activeData.merchant.productId,
        quantity: expectedQuantity,
        proposed_unit_price_rm: proposedPrice,
        as_of: summary.date
      });
      setSimulation({ status: "success", result });
    } catch (error) {
      setSimulation({
        status: "error",
        message:
          error instanceof Error ? error.message : text.simulationUnavailable
      });
    }
  }

  function selectProduct(productId: string) {
    setActiveProductId(productId);
    setActiveView("today");
    setEvidenceSelection(null);
    setProposedPrice("0.00");
    setExpectedQuantity("0");
    setSimulation({ status: "idle" });
  }

  function addRecipe(productName: string) {
    const existingProduct = productOptions.find(
      (product) =>
        product.productName.toLocaleLowerCase() ===
        productName.toLocaleLowerCase()
    );
    if (existingProduct) {
      selectProduct(existingProduct.productId);
      return;
    }

    const recipe: DashboardProductOption = {
      productId: `session_recipe_${sessionRecipes.length + 1}`,
      productName,
      mode: "demo"
    };
    setSessionRecipes((current) => [...current, recipe]);
    selectProduct(recipe.productId);
  }

  return (
    <div
      className="app-canvas"
      data-locale={activeLocale}
      lang={activeLocale === "zh" ? "zh-CN" : activeLocale}
    >
      <DashboardHeader
        activeLocale={activeLocale}
        activeTab="dashboard"
        merchant={activeData.merchant}
        summaryDate={summary.date}
        dateRange={initialData.dateRange}
        onLocaleChange={setActiveLocale}
      />
      <main className="dashboard-main">
        <div className="page-intro">
          <div className="page-intro-title">
            <DashboardProductPicker
              products={productOptions}
              selectedProductId={activeProductId}
              labels={{
                addRecipe: text.addRecipe,
                cancelRecipe: text.cancelRecipe,
                close: text.closeProductPicker,
                connected: text.connectedProduct,
                createRecipe: text.createRecipe,
                menu: text.productMenu,
                recipeName: text.recipeName,
                selected: text.selectedProduct,
                title: text.productPickerTitle
              }}
              onAddRecipe={addRecipe}
              onSelect={selectProduct}
            />
            <h1>{activeData.merchant.productName}</h1>
          </div>
        </div>

        <AnalyticsViewTabs
          activeView={activeView}
          locale={activeLocale}
          onChange={selectView}
        />

        {activeView === "today" ? (
          <>
            <div className="dashboard-grid">
          <section
            className="ledger-module margin-module"
            aria-labelledby="margin-heading"
          >
            <div className="module-heading">
              <div>
                <p className="module-index">01</p>
                <h2 id="margin-heading">{text.todayGrossMargin}</h2>
              </div>
              <span className="estimate-chip">
                {text.estimatedShort.toUpperCase()}
              </span>
            </div>
            <div className="margin-story">
              <div className="margin-figure">
                <span className="metric-value">
                  {Number(summary.gross_margin_pct).toFixed(2)}%
                </span>
                <p className="margin-delta">
                  {text.down}{" "}
                  <strong>
                    {Math.abs(
                      Number(
                        summary.baseline_comparison
                          .margin_change_percentage_points
                      )
                    ).toFixed(2)}
                  </strong>{" "}
                  {text.percentagePoints}
                </p>
              </div>
              <div
                className="baseline-track"
                role="img"
                aria-label={`${text.today}: ${Number(summary.gross_margin_pct).toFixed(2)}%. ${text.baseline}: ${Number(summary.baseline_comparison.baseline_margin_pct).toFixed(2)}%.`}
                aria-describedby="margin-comparison-help"
              >
                <div className="baseline-label">
                  <span>{text.today}</span>
                </div>
                <div className="track-line">
                  <span
                    className="track-current"
                    style={{
                      width: `${Math.min(
                        Number(summary.gross_margin_pct) / 0.5,
                        100
                      )}%`
                    }}
                  />
                  <span
                    className="track-current-marker"
                    style={{
                      left: `${Math.min(
                        Number(summary.gross_margin_pct) / 0.5,
                        100
                      )}%`
                    }}
                  >
                    <strong>
                      {Number(summary.gross_margin_pct).toFixed(2)}%
                    </strong>
                  </span>
                </div>
                <div className="baseline-label baseline-label--end">
                  <span>{text.baseline}</span>
                  <strong>
                    {Number(
                      summary.baseline_comparison.baseline_margin_pct
                    ).toFixed(2)}
                    %
                  </strong>
                </div>
                <p
                  className="baseline-explainer"
                  id="margin-comparison-help"
                >
                  {text.marginComparisonHelp}
                </p>
              </div>
            </div>
            <dl className="finance-ledger">
              <div>
                <dt>{text.revenue}</dt>
                <dd>{formatMyr(summary.revenue_rm)}</dd>
              </div>
              <div>
                <dt>{text.cogs}</dt>
                <dd>{formatMyr(summary.cogs_rm)}</dd>
              </div>
              <div className="finance-ledger__focus">
                <dt>{text.grossProfit}</dt>
                <dd>
                  <strong>{formatMyr(summary.gross_profit_rm)}</strong>
                </dd>
              </div>
            </dl>
            <p className="assumption-note">
              {text.grossProfitExcludesOverheads}
            </p>
          </section>

          <section
            className="ledger-module cost-module"
            aria-labelledby="cost-heading"
          >
            <div className="module-heading">
              <div>
                <p className="module-index">02</p>
                <h2 id="cost-heading">{text.costPerPack}</h2>
              </div>
              <div className="cost-heading-actions">
                {isDemoProduct ? null : (
                  <a
                    className="add-purchase-link"
                    href={`/receipts?${purchaseParams.toString()}`}
                  >
                    <Plus aria-hidden="true" />
                    {text.addPurchase}
                  </a>
                )}
                {"unavailableReason" in costStack ? null : (
                  <span className="cost-total">
                    <small>{text.current}</small>
                    <strong>{formatMyr(costStack.currentUnitCogsRm)}</strong>
                  </span>
                )}
              </div>
            </div>
            {"unavailableReason" in costStack ? (
              <div className="unavailable-panel" role="status">
                <strong>{text.evidenceUnavailable}</strong>
                <p>{text.uploadItemOrReceipt}</p>
              </div>
            ) : (
              <>
                <div className="cost-receipt">
                  <div className="cost-before">
                    <span>{text.baseline}</span>
                    <strong>{formatMyr(costStack.baselineUnitCogsRm)}</strong>
                    {costStack.baselineDate ? (
                      <small className="cost-snapshot-date">
                        <span>{text.baselineDateLabel}</span>
                        <time dateTime={costStack.baselineDate}>
                          {formatSnapshotDate(
                            costStack.baselineDate,
                            activeLocale
                          )}
                        </time>
                      </small>
                    ) : null}
                  </div>
                  <div className="cost-arrow" aria-hidden="true">
                    →
                  </div>
                  <div className="cost-after">
                    <span>{text.current}</span>
                    <strong>{text.latest}</strong>
                  </div>
                </div>
                <div className="stack-strip" aria-label={text.change}>
                  <span className="stack-base" />
                  {costStack.components.map((component) => (
                    <button
                      key={component.id}
                      type="button"
                      className={[
                        "stack-increment",
                        `stack-increment--${component.tone}`,
                        Number(component.changeRmPerPack) < 0
                          ? "stack-increment--decrease"
                          : ""
                      ].filter(Boolean).join(" ")}
                      style={{
                        flexGrow: Math.abs(
                          Number(component.changeRmPerPack)
                        )
                      }}
                      aria-label={`${text.costSegment}: ${component.name}, ${formatSignedMyr(component.changeRmPerPack)}`}
                      disabled={!component.evidenceId}
                      onClick={() => {
                        if (component.evidenceId) {
                          setEvidenceSelection({
                            evidenceId: component.evidenceId,
                            componentId: component.id
                          });
                        }
                      }}
                    />
                  ))}
                </div>
                <ol className="driver-list">
                  {costStack.components.map((component, index) => (
                    <li key={component.id}>
                      <button
                        type="button"
                        aria-label={`${text.viewEvidence} ${component.name}`}
                        disabled={!component.evidenceId}
                        onClick={() => {
                          if (component.evidenceId) {
                            setEvidenceSelection({
                              evidenceId: component.evidenceId,
                              componentId: component.id
                            });
                          }
                        }}
                      >
                        <span
                          className={`driver-swatch driver-swatch--${component.tone}`}
                          aria-hidden="true"
                        />
                        <span className="driver-rank">
                          {String(index + 1).padStart(2, "0")}
                        </span>
                        <strong>{component.name}</strong>
                        <span>{formatSignedMyr(component.changeRmPerPack)}</span>
                        <small>{text.viewReceipt}</small>
                      </button>
                    </li>
                  ))}
                </ol>
              </>
            )}
          </section>

          <section
            className="ledger-module simulator-module"
            aria-labelledby="simulation-heading"
          >
            <div className="module-heading">
              <div>
                <p className="module-index">03</p>
                <h2 id="simulation-heading">{text.simulation}</h2>
              </div>
            </div>
            <form className="simulation-form" onSubmit={runSimulation}>
              <label>
                <span>{text.proposedPrice}</span>
                <span className="input-shell">
                  <i>RM</i>
                  <input
                    aria-label={text.proposedPrice}
                    inputMode="decimal"
                    value={proposedPrice}
                    disabled={isDemoProduct}
                    onChange={(event) => setProposedPrice(event.target.value)}
                  />
                </span>
              </label>
              <label>
                <span>{text.expectedQuantity}</span>
                <span className="input-shell input-shell--quantity">
                  <input
                    aria-label={text.expectedQuantity}
                    inputMode="numeric"
                    value={expectedQuantity}
                    disabled={isDemoProduct}
                    onChange={(event) => setExpectedQuantity(event.target.value)}
                  />
                  <i>{text.packs}</i>
                </span>
              </label>
              <button
                className="simulation-button"
                type="submit"
                disabled={
                  isDemoProduct || simulation.status === "loading"
                }
              >
                {simulation.status === "loading"
                  ? text.calculating
                  : text.runSimulation}
              </button>
            </form>
            <div className="simulation-output" aria-live="polite">
              {isDemoProduct ? (
                <div className="simulation-empty simulation-empty--demo">
                  <span aria-hidden="true">D</span>
                  <p>{text.demoProductNotice}</p>
                </div>
              ) : null}
              {!isDemoProduct && simulation.status === "idle" ? (
                <div className="simulation-empty">
                  <span aria-hidden="true">↗</span>
                  <p>{text.scenarioPrompt}</p>
                </div>
              ) : null}
              {!isDemoProduct && simulation.status === "loading" ? (
                <div className="result-skeleton" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </div>
              ) : null}
              {!isDemoProduct && simulation.status === "success" ? (
                <>
                  <div className="simulation-result-primary">
                    <span>{text.grossProfit}</span>
                    <strong>
                      {formatMyr(simulation.result.gross_profit_rm)}
                    </strong>
                    {simulation.result.incremental_gross_profit_vs_today_rm ? (
                      <small>
                        +
                        {formatMyr(
                          simulation.result
                            .incremental_gross_profit_vs_today_rm
                        )}{" "}
                        {text.versusToday}
                      </small>
                    ) : null}
                  </div>
                  <dl className="simulation-result-grid">
                    <div>
                      <dt>{text.revenue}</dt>
                      <dd>{formatMyr(simulation.result.revenue_rm)}</dd>
                    </div>
                    <div>
                      <dt>{text.grossMargin}</dt>
                      <dd>
                        {Number(simulation.result.gross_margin_pct).toFixed(2)}%
                      </dd>
                    </div>
                  </dl>
                  <p className="assumption-note">{text.constantDemand}</p>
                </>
              ) : null}
              {!isDemoProduct && simulation.status === "error" ? (
                <div className="inline-error" role="alert">
                  <strong>{text.simulationUnavailable}</strong>
                  <p>{simulation.message}</p>
                </div>
              ) : null}
            </div>
          </section>
            </div>
          </>
        ) : (
          <DashboardAnalyticsView
            activeView={activeView}
            analytics={analytics}
            dashboard={activeData}
            isDemoProduct={isDemoProduct}
            locale={activeLocale}
          />
        )}
      </main>
      {selectedEvidence ? (
        <aside
          className="evidence-drawer"
          role="dialog"
          aria-modal="true"
          aria-label={selectedEvidence.title}
        >
          <div className="drawer-header">
            <div>
              <p className="eyebrow">{text.sourceEvidence}</p>
              <h2>{selectedEvidence.supplierName ?? selectedEvidence.title}</h2>
              <p>{selectedEvidence.receiptId}</p>
              {selectedComponent ? (
                <span className="evidence-component">
                  {selectedComponent.name}
                </span>
              ) : null}
            </div>
            <button
              type="button"
              aria-label={text.closeEvidence}
              title={text.closeEvidence}
              onClick={() => setEvidenceSelection(null)}
            >
              <X aria-hidden="true" />
            </button>
          </div>
          <div className="drawer-body">
            <figure className="receipt-frame">
              {selectedEvidence.imageUrl && selectedEvidence.receiptId ? (
                <a
                  className="receipt-link"
                  href={selectedEvidence.imageUrl}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={`${text.openReceipt} ${selectedEvidence.receiptId}`}
                  title={`${text.openReceipt} ${selectedEvidence.receiptId}`}
                >
                  <img
                    src={selectedEvidence.imageUrl}
                    alt={`${selectedEvidence.title}: ${text.sourceEvidence}`}
                  />
                  <span aria-hidden="true">
                    <ExternalLink />
                  </span>
                </a>
              ) : (
                <blockquote>
                  {selectedEvidence.transcript ?? text.evidenceUnavailable}
                </blockquote>
              )}
              <figcaption>{text.originalEvidence}</figcaption>
            </figure>
            <div className="normalized-lines">
              <h3>{text.normalizedLines}</h3>
              {visibleEvidenceLines.length ? (
                <ul>
                  {visibleEvidenceLines.map((line) => (
                    <li
                      key={`${line.componentId}-${line.rawName}-${line.totalPriceRm}`}
                    >
                      <span>
                        <strong>{line.rawName}</strong>
                        <small>
                          {line.componentId ?? text.review}
                          {line.confidence
                            ? ` · ${Math.round(Number(line.confidence) * 100)}% ${text.confidence}`
                            : ""}
                        </small>
                      </span>
                      <strong>
                        {line.totalPriceRm
                          ? formatMyr(line.totalPriceRm)
                          : text.review}
                      </strong>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="evidence-empty">{text.evidenceUnavailable}</p>
              )}
            </div>
          </div>
        </aside>
      ) : null}
      {selectedEvidence ? (
        <button
          className="drawer-backdrop"
          type="button"
          aria-label={text.closeEvidence}
          onClick={() => setEvidenceSelection(null)}
        />
      ) : null}
    </div>
  );
}
