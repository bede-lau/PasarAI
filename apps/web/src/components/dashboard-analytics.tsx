"use client";

import {
  Activity,
  AlertTriangle,
  CalendarCheck,
  CircleDollarSign,
  Gauge,
  History,
  MessageCircle,
  ReceiptText,
  SlidersHorizontal,
  TrendingUp
} from "lucide-react";
import { useEffect, useState } from "react";
import type {
  AnalyticsActivityResponse,
  AnalyticsOverviewResponse,
  PriceVolumeScenarioResponse
} from "@pasarai/contracts/v1";

import { postPriceVolumeScenario } from "@/lib/analytics-actions";
import type {
  DashboardAnalyticsState,
  DashboardData,
  Locale
} from "@/lib/dashboard-types";
import { getMessages } from "@/lib/i18n";
import { resolvePerformanceTrend } from "@/lib/synthetic-performance";

export type DashboardView = "today" | "trends" | "plan" | "activity";

type AnalyticsProps = {
  analytics: DashboardAnalyticsState;
  dashboard: DashboardData;
  isDemoProduct: boolean;
  locale: Locale;
};

function AnalyticsLoadingState({ label }: { label: string }) {
  return (
    <div
      className="analytics-loading"
      role="status"
      aria-label={label}
    >
      <span />
      <span />
      <span />
    </div>
  );
}

type TrendMetric =
  | "revenue_rm"
  | "gross_profit_rm"
  | "gross_margin_pct"
  | "quantity";

function localeName(locale: Locale) {
  return locale === "zh" ? "zh-CN" : `${locale}-MY`;
}

function formatDate(value: string, locale: Locale) {
  return new Intl.DateTimeFormat(localeName(locale), {
    day: "2-digit",
    month: "short",
    timeZone: "UTC"
  }).format(new Date(`${value}T00:00:00Z`));
}

function formatFullDate(value: string, locale: Locale) {
  return new Intl.DateTimeFormat(localeName(locale), {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC"
  }).format(new Date(`${value}T00:00:00Z`));
}

function evenlySpacedIndexes(length: number, maximumTicks: number) {
  if (length <= 0) return [];
  if (length <= maximumTicks) {
    return Array.from({ length }, (_, index) => index);
  }
  return Array.from({ length: maximumTicks }, (_, index) =>
    Math.round((index * (length - 1)) / (maximumTicks - 1))
  ).filter((value, index, values) => index === 0 || value !== values[index - 1]);
}

function formatDateTime(value: string, locale: Locale) {
  return new Intl.DateTimeFormat(localeName(locale), {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function signedMyr(value: string) {
  const amount = Number(value);
  return `${amount >= 0 ? "+" : "-"}RM${Math.abs(amount).toFixed(2)}`;
}

function evidenceUrl(value: string | null) {
  if (!value) return null;
  if (value.startsWith("pasarai-evidence:")) {
    return `/api/pasarai/evidence?uri=${encodeURIComponent(value)}`;
  }
  if (value.startsWith("/") && !value.startsWith("//")) return value;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? value
      : null;
  } catch {
    return null;
  }
}

export function AnalyticsViewTabs({
  activeView,
  locale,
  onChange
}: {
  activeView: DashboardView;
  locale: Locale;
  onChange: (view: DashboardView) => void;
}) {
  const text = getMessages(locale);
  const views = [
    { id: "today" as const, label: text.todayView, Icon: Gauge },
    { id: "trends" as const, label: text.trendsView, Icon: TrendingUp },
    { id: "activity" as const, label: text.activityView, Icon: History }
  ];
  return (
    <div className="analytics-view-tabs" role="tablist">
      {views.map(({ id, label, Icon }) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-label={label}
          aria-selected={activeView === id}
          title={label}
          onClick={() => onChange(id)}
        >
          <Icon aria-hidden="true" />
          <span>{label}</span>
        </button>
      ))}
    </div>
  );
}

function metricValue(
  day: AnalyticsOverviewResponse["days"][number],
  metric: TrendMetric
) {
  const value = day[metric];
  return value === null ? null : Number(value);
}

function TrendChart({
  overview,
  endDate,
  locale
}: {
  overview: AnalyticsOverviewResponse | null;
  endDate: string;
  locale: Locale;
}) {
  const text = getMessages(locale);
  const [metric, setMetric] = useState<TrendMetric>("gross_profit_rm");
  const [range, setRange] = useState<7 | 14 | 28>(14);
  const trend = resolvePerformanceTrend(overview, endDate);
  const days = trend.days.slice(-range);
  const values = days.map((day) => metricValue(day, metric));
  const valid = values.filter((value): value is number => value !== null);
  const rawMinimum = valid.length ? Math.min(...valid) : 0;
  const rawMaximum = valid.length ? Math.max(...valid) : 1;
  const padding = rawMaximum === rawMinimum
    ? Math.max(Math.abs(rawMaximum) * 0.1, 1)
    : (rawMaximum - rawMinimum) * 0.12;
  const minimum = Math.min(0, rawMinimum - padding);
  const maximum = rawMaximum + padding;
  const width = 1000;
  const height = 260;
  const chartLeft = 46;
  const chartRight = 976;
  const chartTop = 18;
  const chartBottom = 220;
  const point = (value: number, index: number) => {
    const x = days.length < 2
      ? (chartLeft + chartRight) / 2
      : chartLeft
        + (index / (days.length - 1)) * (chartRight - chartLeft);
    const y = chartBottom
      - ((value - minimum) / (maximum - minimum))
        * (chartBottom - chartTop);
    return { x, y };
  };
  const segments: Array<Array<{ x: number; y: number }>> = [];
  let segment: Array<{ x: number; y: number }> = [];
  values.forEach((value, index) => {
    if (value === null) {
      if (segment.length) segments.push(segment);
      segment = [];
      return;
    }
    segment.push(point(value, index));
  });
  if (segment.length) segments.push(segment);
  const metricOptions = [
    ["revenue_rm", text.revenue],
    ["gross_profit_rm", text.grossProfit],
    ["gross_margin_pct", text.grossMargin],
    ["quantity", text.quantity]
  ] as const;
  const suffix = metric === "gross_margin_pct" ? "%" : "";
  const prefix =
    metric === "revenue_rm" || metric === "gross_profit_rm" ? "RM" : "";
  const decimals = metric === "quantity" ? 0 : 2;
  const formatMetricValue = (value: number) =>
    `${prefix}${value.toFixed(decimals)}${suffix}`;
  const selectedMetricLabel =
    metricOptions.find(([id]) => id === metric)?.[1] ?? "";
  const valueTicks = Array.from({ length: 5 }, (_, index) => {
    const ratio = index / 4;
    return {
      value: maximum - ratio * (maximum - minimum),
      y: chartTop + ratio * (chartBottom - chartTop)
    };
  });
  const dateTickIndexes = evenlySpacedIndexes(days.length, 7);
  return (
    <section className="analytics-section trend-section">
      <div className="analytics-section-heading">
        <div>
          <p className="module-index">01</p>
          <h2>{text.trendTitle}</h2>
        </div>
        <div className="trend-controls">
          <div className="segmented-control" aria-label={text.trendTitle}>
            {metricOptions.map(([id, label]) => (
              <button
                key={id}
                type="button"
                aria-pressed={metric === id}
                onClick={() => setMetric(id)}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="segmented-control" aria-label={text.range}>
            {[7, 14, 28].map((daysInRange) => (
              <button
                key={daysInRange}
                type="button"
                aria-pressed={range === daysInRange}
                onClick={() => setRange(daysInRange as 7 | 14 | 28)}
              >
                {daysInRange}d
              </button>
            ))}
          </div>
        </div>
      </div>
      <div
        className="trend-chart"
        role="group"
        data-source={trend.source}
        aria-label={`${text.trendTitle}: ${selectedMetricLabel}`}
      >
        <div className="trend-y-axis" aria-hidden="true">
          {valueTicks.map((tick) => (
            <span
              key={tick.y}
              className="trend-y-tick"
              style={{ top: `${(tick.y / height) * 100}%` }}
            >
              {formatMetricValue(tick.value)}
            </span>
          ))}
        </div>
        <svg
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          {valueTicks.map((tick) => (
            <line
              key={tick.y}
              className="trend-gridline"
              x1={chartLeft}
              x2={chartRight}
              y1={tick.y}
              y2={tick.y}
            />
          ))}
          {dateTickIndexes.map((index) => {
            const x = days.length < 2
              ? (chartLeft + chartRight) / 2
              : chartLeft
                + (index / (days.length - 1))
                  * (chartRight - chartLeft);
            return (
              <line
                key={`date-grid-${days[index]?.date ?? index}`}
                className="trend-gridline trend-gridline--vertical"
                x1={x}
                x2={x}
                y1={chartTop}
                y2={chartBottom}
              />
            );
          })}
          {segments.map((points, index) => (
            <polyline
              key={index}
              className="trend-line"
              points={points.map(({ x, y }) => `${x},${y}`).join(" ")}
            />
          ))}
          {days.map((day, index) => {
            if (day.state === "complete") return null;
            const x = days.length < 2
              ? (chartLeft + chartRight) / 2
              : chartLeft
                + (index / (days.length - 1))
                  * (chartRight - chartLeft);
            return (
              <line
                key={`gap-${day.date}`}
                className={`trend-gap trend-gap--${day.state}`}
                x1={x}
                x2={x}
                y1={chartTop}
                y2={chartBottom}
              />
            );
          })}
        </svg>
        <div className="trend-point-layer">
          {values.map((value, index) => {
            if (value === null) return null;
            const coordinates = point(value, index);
            const day = days[index];
            if (!day) return null;
            const tooltipId = `trend-${metric}-${day.date}`;
            const fullDate = formatFullDate(day.date, locale);
            return (
              <button
                key={day.date}
                type="button"
                className="trend-point"
                aria-label={`${fullDate}, ${selectedMetricLabel} ${formatMetricValue(value)}`}
                aria-describedby={tooltipId}
                data-edge={
                  coordinates.x < 220
                    ? "start"
                    : coordinates.x > 650
                      ? "end"
                      : undefined
                }
                data-placement={coordinates.y < 78 ? "below" : "above"}
                style={{
                  left: `${(coordinates.x / width) * 100}%`,
                  top: `${(coordinates.y / height) * 100}%`
                }}
              >
                <span className="trend-tooltip" id={tooltipId} role="tooltip">
                  <time dateTime={day.date}>{fullDate}</time>
                  <strong>
                    {selectedMetricLabel} {formatMetricValue(value)}
                  </strong>
                </span>
              </button>
            );
          })}
        </div>
        <div className="trend-axis">
          {dateTickIndexes.map((index) => {
            const day = days[index];
            return day ? (
              <time key={day.date} dateTime={day.date}>
                {formatDate(day.date, locale)}
              </time>
            ) : null;
          })}
        </div>
      </div>
    </section>
  );
}

function CostWaterfall({
  overview,
  locale
}: {
  overview: AnalyticsOverviewResponse | null;
  locale: Locale;
}) {
  const text = getMessages(locale);
  const waterfall = overview?.cost_waterfall;
  if (!waterfall) {
    return (
      <section className="analytics-section cost-waterfall-section">
        <div className="analytics-section-heading">
          <div>
            <p className="module-index">02</p>
            <h2>{text.costWaterfall}</h2>
          </div>
        </div>
        <p className="analytics-empty">{text.evidenceUnavailable}</p>
      </section>
    );
  }
  const maximumChange = Math.max(
    0.01,
    ...waterfall.components.map((component) =>
      Math.abs(Number(component.change_rm_per_pack)))
  );
  return (
    <section className="analytics-section cost-waterfall-section">
      <div className="analytics-section-heading">
        <div>
          <p className="module-index">02</p>
          <h2>{text.costWaterfall}</h2>
        </div>
        <div className="waterfall-total">
          <span>RM{Number(waterfall.baseline_unit_cogs_rm).toFixed(2)}</span>
          <strong>RM{Number(waterfall.current_unit_cogs_rm).toFixed(2)}</strong>
        </div>
      </div>
      <ol className="waterfall-list">
        {waterfall.components.map((component, index) => {
          const amount = Number(component.change_rm_per_pack);
          return (
            <li key={component.component_id}>
              <span className="waterfall-rank">
                {String(index + 1).padStart(2, "0")}
              </span>
              <strong>{component.name}</strong>
              <span className="waterfall-bar-track" aria-hidden="true">
                <i
                  data-direction={amount < 0 ? "down" : "up"}
                  style={{
                    width: `${Math.max(
                      4,
                      Math.abs(amount) / maximumChange * 100
                    )}%`
                  }}
                />
              </span>
              <span className="waterfall-amount">
                {signedMyr(component.change_rm_per_pack)}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function syntheticScenario(
  dashboard: DashboardData,
  centerPrice: string,
  centerQuantity: string,
  priceStep: string,
  quantityStep: string
): PriceVolumeScenarioResponse {
  const price = Number(centerPrice);
  const quantity = Number(centerQuantity);
  const unitCogs = Number(
    "unavailableReason" in dashboard.costStack
      ? Number(centerQuantity) > 0
        ? Number(dashboard.summary.cogs_rm)
          / Number(centerQuantity)
        : 0
      : dashboard.costStack.currentUnitCogsRm
  );
  const priceFactor = Number(priceStep) / 100;
  const quantityFactor = Number(quantityStep) / 100;
  const prices = [price * (1 - priceFactor), price, price * (1 + priceFactor)];
  const quantities = [
    quantity * (1 - quantityFactor),
    quantity,
    quantity * (1 + quantityFactor)
  ];
  const baseline = quantity * (price - unitCogs);
  return {
    merchant_id: dashboard.merchant.id,
    product_id: dashboard.merchant.productId,
    as_of: dashboard.summary.date,
    target_gross_margin_pct: "40.00",
    assumption:
      "constant_unit_cogs_and_independent_price_volume_inputs",
    scenarios: quantities.flatMap((scenarioQuantity, row) =>
      prices.map((scenarioPrice, column) => {
        const revenue = scenarioQuantity * scenarioPrice;
        const cogs = scenarioQuantity * unitCogs;
        const profit = revenue - cogs;
        const margin = revenue === 0 ? 0 : profit / revenue * 100;
        return {
          row,
          column,
          quantity: String(Number(scenarioQuantity.toFixed(2))),
          unit_price_rm: scenarioPrice.toFixed(2),
          revenue_rm: revenue.toFixed(2),
          cogs_rm: cogs.toFixed(2),
          gross_profit_rm: profit.toFixed(2),
          gross_margin_pct: margin.toFixed(2),
          incremental_gross_profit_rm: (profit - baseline).toFixed(2),
          target_margin_met: margin >= 40
        };
      })
    )
  };
}

function ScenarioMatrix({
  dashboard,
  overview,
  locale
}: {
  dashboard: DashboardData;
  overview: AnalyticsOverviewResponse;
  locale: Locale;
}) {
  const text = getMessages(locale);
  const latest = [...overview.days]
    .reverse()
    .find((day) =>
      day.state === "complete"
      && day.quantity !== null
      && day.revenue_rm !== null
      && Number(day.quantity) > 0);
  const initialQuantity = latest?.quantity ?? "0";
  const initialPrice = latest
    ? (Number(latest.revenue_rm) / Number(latest.quantity)).toFixed(2)
    : "0.00";
  const [priceStep, setPriceStep] = useState("10");
  const [quantityStep, setQuantityStep] = useState("10");
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "ready"; result: PriceVolumeScenarioResponse }
    | { status: "error"; message: string }
  >({ status: "loading" });

  async function loadMatrix() {
    setState({ status: "loading" });
    try {
      const result = dashboard.provenance === "synthetic"
        ? syntheticScenario(
            dashboard,
            initialPrice,
            initialQuantity,
            priceStep,
            quantityStep
          )
        : await postPriceVolumeScenario({
            merchant_id: dashboard.merchant.id,
            product_id: dashboard.merchant.productId,
            as_of: dashboard.summary.date,
            center_price_rm: initialPrice,
            center_quantity: initialQuantity,
            price_step_pct: priceStep,
            quantity_step_pct: quantityStep
          });
      setState({ status: "ready", result });
    } catch (error) {
      setState({
        status: "error",
        message:
          error instanceof Error ? error.message : text.simulationUnavailable
      });
    }
  }

  useEffect(() => {
    void loadMatrix();
  }, []);

  const matrix = state.status === "ready" ? state.result : null;
  const prices = matrix
    ? [...new Set(matrix.scenarios.map((scenario) => scenario.unit_price_rm))]
    : [];
  const quantities = matrix
    ? [...new Set(matrix.scenarios.map((scenario) => scenario.quantity))]
    : [];
  return (
    <section className="analytics-section scenario-matrix-section">
      <div className="analytics-section-heading">
        <div>
          <p className="module-index">01</p>
          <h2>{text.scenarioMatrix}</h2>
        </div>
        <button
          className="matrix-update-button"
          type="button"
          onClick={() => void loadMatrix()}
          disabled={state.status === "loading"}
        >
          <CircleDollarSign aria-hidden="true" />
          {text.runMatrix}
        </button>
      </div>
      <div className="matrix-controls">
        <label>
          <span>{text.priceStep}</span>
          <select
            value={priceStep}
            onChange={(event) => setPriceStep(event.target.value)}
          >
            <option value="5">5%</option>
            <option value="10">10%</option>
            <option value="15">15%</option>
          </select>
        </label>
        <label>
          <span>{text.quantityStep}</span>
          <select
            value={quantityStep}
            onChange={(event) => setQuantityStep(event.target.value)}
          >
            <option value="5">5%</option>
            <option value="10">10%</option>
            <option value="15">15%</option>
          </select>
        </label>
      </div>
      {state.status === "loading" ? (
        <div className="matrix-loading" aria-label={text.calculating}>
          <span /><span /><span />
        </div>
      ) : null}
      {state.status === "error" ? (
        <div className="inline-error" role="alert">{state.message}</div>
      ) : null}
      {matrix ? (
        <>
          <div className="scenario-matrix" role="table">
            <div className="scenario-matrix__corner" />
            {prices.map((price) => (
              <div key={price} role="columnheader">
                RM{Number(price).toFixed(2)}
              </div>
            ))}
            {quantities.map((quantity, row) => (
              <div className="scenario-matrix__row" key={quantity}>
                <div role="rowheader">{quantity} {text.packs}</div>
                {prices.map((price, column) => {
                  const scenario = matrix.scenarios.find((candidate) =>
                    candidate.row === row && candidate.column === column);
                  if (!scenario) return <div key={price} />;
                  return (
                    <div
                      key={price}
                      role="cell"
                      data-current={row === 1 && column === 1}
                      data-viable={scenario.target_margin_met}
                    >
                      <strong>
                        RM{Number(scenario.gross_profit_rm).toFixed(2)}
                      </strong>
                      <span>
                        {Number(scenario.gross_margin_pct).toFixed(1)}%
                      </span>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
          <div className="matrix-legend">
            <span data-viable="true">{text.targetMet}</span>
            <span data-viable="false">{text.targetMissed}</span>
            <span data-current="true">{text.actual}</span>
          </div>
        </>
      ) : null}
    </section>
  );
}

function TrendsView({
  dashboard,
  overview,
  locale
}: {
  dashboard: DashboardData;
  overview: AnalyticsOverviewResponse | null;
  locale: Locale;
}) {
  return (
    <div className="analytics-view analytics-view--trends">
      <TrendChart
        overview={overview}
        endDate={dashboard.summary.date}
        locale={locale}
      />
      <CostWaterfall overview={overview} locale={locale} />
    </div>
  );
}

function PlanView({
  dashboard,
  overview,
  locale
}: {
  dashboard: DashboardData;
  overview: AnalyticsOverviewResponse;
  locale: Locale;
}) {
  return (
    <div className="analytics-view analytics-view--plan">
      <ScenarioMatrix
        dashboard={dashboard}
        overview={overview}
        locale={locale}
      />
    </div>
  );
}

function ActivityView({
  activity,
  locale
}: {
  activity: AnalyticsActivityResponse;
  locale: Locale;
}) {
  const text = getMessages(locale);
  const icon = (type: string) => {
    if (type === "sale") return MessageCircle;
    if (type === "cost" || type === "receipt") return ReceiptText;
    if (type === "day_status") return CalendarCheck;
    return Activity;
  };
  return (
    <section className="analytics-section activity-section">
      <div className="analytics-section-heading">
        <div>
          <p className="module-index">01</p>
          <h2>{text.activityTitle}</h2>
        </div>
      </div>
      {activity.items.length ? (
        <ol className="activity-timeline">
          {activity.items.map((item) => {
            const Icon = icon(item.type);
            const itemEvidenceUrl = evidenceUrl(item.evidence_uri);
            return (
              <li key={item.event_id}>
                <span className="activity-icon">
                  <Icon aria-hidden="true" />
                </span>
                <span className="activity-copy">
                  <strong>{item.title}</strong>
                  <small>
                    {formatDateTime(item.occurred_at, locale)}
                    {" · "}
                    {item.source.replaceAll("_", " ")}
                  </small>
                </span>
                <span className="activity-state">{item.state}</span>
                {itemEvidenceUrl ? (
                  <a
                    href={itemEvidenceUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {text.viewReceipt}
                  </a>
                ) : null}
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="analytics-empty">{text.noActivity}</p>
      )}
    </section>
  );
}

export function DashboardAnalyticsView({
  activeView,
  analytics,
  dashboard,
  isDemoProduct,
  locale
}: AnalyticsProps & { activeView: Exclude<DashboardView, "today"> }) {
  const text = getMessages(locale);
  if (isDemoProduct) {
    return (
      <div className="analytics-view analytics-view--empty">
        <SlidersHorizontal aria-hidden="true" />
        <p>{text.demoProductNotice}</p>
      </div>
    );
  }
  if (activeView === "trends") {
    if (
      analytics.overview.status === "idle"
      || analytics.overview.status === "loading"
    ) {
      return (
        <div className="analytics-view analytics-view--loading">
          <AnalyticsLoadingState label={text.loadingAnalytics} />
        </div>
      );
    }
    return (
      <TrendsView
        dashboard={dashboard}
        overview={
          analytics.overview.status === "ready"
            ? analytics.overview.data
            : null
        }
        locale={locale}
      />
    );
  }
  if (
    (activeView === "plan" && analytics.overview.status === "loading")
    || (activeView === "activity" && (
      analytics.activity.status === "idle"
      || analytics.activity.status === "loading"
    ))
  ) {
    return (
      <div className="analytics-view analytics-view--loading">
        <AnalyticsLoadingState label={text.loadingAnalytics} />
      </div>
    );
  }
  if (
    (activeView === "plan" && analytics.overview.status === "error")
    || (activeView === "activity" && analytics.activity.status === "error")
  ) {
    const message =
      activeView === "plan" && analytics.overview.status === "error"
        ? analytics.overview.message
        : analytics.activity.status === "error"
          ? analytics.activity.message
          : text.analyticsUnavailable;
    return (
      <div className="analytics-view analytics-view--empty">
        <AlertTriangle aria-hidden="true" />
        <p>{message}</p>
      </div>
    );
  }
  if (activeView === "plan") {
    if (analytics.overview.status !== "ready") return null;
    return (
      <PlanView
        dashboard={dashboard}
        overview={analytics.overview.data}
        locale={locale}
      />
    );
  }
  if (analytics.activity.status !== "ready") return null;
  return <ActivityView activity={analytics.activity.data} locale={locale} />;
}
