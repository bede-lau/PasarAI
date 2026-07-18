import {
  validateContract,
  validateEndpointInvocation,
} from "@pasarai/contracts/v1";
import {
  buildDemandForecast,
  buildPriceVolumeMatrix,
} from "@pasarai/analytics";
import {
  calculatePurchasedContribution,
  calculatePortfolioMetrics,
  calculatePriceFloor,
  calculatePriceSimulation,
  calculateRevenue,
  decimalEquals,
  decimalIsBelow,
  decimalIsZero,
  formatMyr,
  rankCostDrivers,
  resolvePackPriceIncrease,
  subtractDecimal,
  sumDecimal,
} from "@pasarai/finance";

import { createPersistentKey } from "../persistent-key.js";

function evidenceIdentity(evidence) {
  if (evidence?.external_message_id) {
    return { kind: "message", id: evidence.external_message_id };
  }
  if (evidence?.receipt_id) {
    return { kind: "receipt", id: evidence.receipt_id };
  }
  if (evidence?.source_event_id) {
    return { kind: "source_event", id: evidence.source_event_id };
  }
  return null;
}

function externalIdFromEvidence(evidence, merchantId) {
  const identity = evidenceIdentity(evidence);
  return identity
    ? createPersistentKey(merchantId, identity.kind, identity.id)
    : null;
}

function clarificationKey(merchantId, evidenceKind, sourceEventId) {
  return createPersistentKey(merchantId, evidenceKind, sourceEventId);
}

function clarificationReference(value) {
  const match = /^(message|receipt|source_event):(.+)$/.exec(value);
  return match
    ? { kind: match[1], id: match[2] }
    : { kind: null, id: value };
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  );
}

function fingerprint(value) {
  return JSON.stringify(canonicalize(value));
}

function shiftCalendarDate(value, days) {
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.valueOf())) {
    throw new TypeError(`Invalid calendar date: ${value}`);
  }
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function calendarDates(from, to, maximumDays = 120) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from ?? "")) {
    throw new TypeError("from must be a calendar date");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(to ?? "")) {
    throw new TypeError("to must be a calendar date");
  }
  if (from > to) throw new TypeError("from must not be after to");

  const dates = [];
  let current = from;
  while (current <= to) {
    dates.push(current);
    if (dates.length > maximumDays) {
      throw new TypeError(`Analytics range cannot exceed ${maximumDays} days`);
    }
    current = shiftCalendarDate(current, 1);
  }
  return dates;
}

function percentage(numerator, denominator) {
  return denominator === 0
    ? "0.00"
    : ((numerator / denominator) * 100).toFixed(2);
}

function newestInstant(events) {
  const timestamps = events
    .map((event) => Date.parse(event.ingestedAt ?? event.occurredAt))
    .filter(Number.isFinite);
  return timestamps.length
    ? new Date(Math.max(...timestamps)).toISOString()
    : null;
}

function activityTitle(event) {
  if (event.type === "sale") return "Sale recorded";
  if (event.type === "cost") {
    return event.payload?.supplier_name
      ? `Purchase from ${event.payload.supplier_name}`
      : "Purchase cost recorded";
  }
  if (event.type === "correction") return "Correction applied";
  if (event.type === "clarification") return "Clarification recorded";
  if (event.type === "day_status") {
    return event.payload?.business_day_state === "closed_no_sales"
      ? "Day closed with no sales"
      : "Business day closed";
  }
  if (event.type === "receipt") return "Receipt reviewed";
  if (event.type === "receipt_uploaded") {
    return event.payload?.receipt_id
      ? `Receipt ${event.payload.receipt_id} uploaded`
      : "Receipt uploaded";
  }
  if (event.type === "purchase_intake") return "Purchase intake updated";
  const title = event.type.replaceAll("_", " ");
  return `${title.charAt(0).toUpperCase()}${title.slice(1)} recorded`;
}

function activityEvidenceUri(event) {
  const uri =
    event.evidence?.asset_uri
    ?? event.evidence?.evidence_uri
    ?? event.evidence?.receipt_evidence_uri
    ?? event.evidence?.raw_evidence_uri
    ?? event.evidence?.uri
    ?? event.payload?.evidence?.asset_uri
    ?? event.payload?.evidence_uri
    ?? event.payload?.receipt_evidence_uri
    ?? event.response?.evidence_uri
    ?? null;
  if (uri) return uri;

  const evidencePath =
    event.evidence?.evidence_path
    ?? event.payload?.evidence_path
    ?? null;
  const filename = evidencePath?.split(/[\\/]/).at(-1);
  return filename && /^[A-Za-z0-9._-]+$/.test(filename)
    ? `/evidence/${filename}`
    : null;
}

function dayOverDayProfile(currentProfile, baselineProfile, comparisonDate) {
  if (!currentProfile) {
    return { profile: null, comparisonAvailable: false };
  }
  const currentComponents = currentProfile.components ?? [];
  const baselineComponents = new Map(
    (baselineProfile?.components ?? []).map((component) => [
      component.componentId,
      component,
    ]),
  );
  const currentComponentIds = new Set(
    currentComponents.map((component) => component.componentId),
  );
  const comparisonAvailable = Boolean(baselineProfile)
    && currentComponents.every((component) =>
      baselineComponents.has(component.componentId))
    && (baselineProfile.components ?? []).every((component) =>
      currentComponentIds.has(component.componentId));
  const components = currentComponents.map((component) => ({
    ...component,
    baselineCostRm: comparisonAvailable
      ? baselineComponents.get(component.componentId).currentCostRm
      : component.currentCostRm,
  }));
  return {
    comparisonAvailable,
    profile: {
      ...currentProfile,
      baselineEffectiveDate: comparisonDate,
      baselineUnitCogsRm: comparisonAvailable
        ? baselineProfile.currentUnitCogsRm
        : currentProfile.currentUnitCogsRm,
      components,
    },
  };
}

function moneyToCents(value) {
  if (value === null) return null;
  const match = /^(0|[1-9][0-9]*)\.([0-9]{2})$/.exec(value);
  if (!match) throw new Error(`Invalid MYR amount: ${value}`);
  return BigInt(match[1]) * 100n + BigInt(match[2]);
}

function receiptTotalMismatch(extraction) {
  const receiptTotal = moneyToCents(extraction.total_rm);
  if (receiptTotal === null) return 0n;
  const lineTotal = extraction.line_items.reduce(
    (total, line) => total + (moneyToCents(line.total_price_rm) ?? 0n),
    0n,
  );
  return lineTotal >= receiptTotal
    ? lineTotal - receiptTotal
    : receiptTotal - lineTotal;
}

function contractErrors(endpointId, headers, payload) {
  return validateEndpointInvocation({
    endpoint_id: endpointId,
    headers,
    payload,
  });
}

function rejected(errors) {
  return {
    state: "rejected",
    errors: errors.map((message) => ({
      code: "invalid_request",
      message,
    })),
  };
}

function duplicateResponse(event, payload) {
  if (fingerprint(event.payload) !== fingerprint(payload)) {
    return rejected([
      "Source evidence was already committed with a different payload",
    ]);
  }
  return event.response;
}

function evidenceProjection(evidence, {
  supplierName = null,
  line = null,
} = {}) {
  const evidenceId = evidence?.receipt_id
    ?? evidence?.source_event_id
    ?? evidence?.external_message_id;
  if (!evidenceId) return null;
  return {
    evidenceId,
    title: supplierName
      ? `${supplierName} receipt`
      : "Merchant source evidence",
    assetUri: evidence.asset_uri ?? null,
    receiptId: evidence.receipt_id ?? null,
    supplierName,
    transcript: evidence.transcript ?? null,
    lineItems: line
      ? [{
          rawName: line.raw_name ?? line.component_id,
          componentId: line.component_id ?? null,
          totalPriceRm: line.total_price_rm ?? null,
          confidence: line.confidence ?? null,
        }]
      : [],
  };
}

function mergeEvidenceProjection(existing, incoming) {
  if (!incoming) return existing;
  if (!existing) return incoming;
  return {
    ...existing,
    ...incoming,
    lineItems: [
      ...(existing.lineItems ?? []),
      ...(incoming.lineItems ?? []),
    ],
  };
}

function mergeEvidenceByReceipt(components) {
  const projections = new Map();
  for (const component of components) {
    const projection = component.evidence;
    if (!projection) continue;
    projections.set(
      projection.evidenceId,
      mergeEvidenceProjection(
        projections.get(projection.evidenceId),
        projection,
      ),
    );
  }
  return [...projections.values()];
}

function publicEvidence(projection) {
  return {
    evidence_id: projection.evidenceId,
    title: projection.title,
    asset_uri: projection.assetUri,
    receipt_id: projection.receiptId,
    supplier_name: projection.supplierName,
    transcript: projection.transcript,
    line_items: projection.lineItems.map((line) => ({
      raw_name: line.rawName,
      component_id: line.componentId,
      total_price_rm: line.totalPriceRm,
      confidence: line.confidence,
    })),
  };
}

function correctionValue(payload, change) {
  const lineIndex = change.line_index
    ?? (payload.lines.length === 1 ? 0 : undefined);
  if (change.kind === "decimal" && change.field === "quantity") {
    return lineIndex === undefined
      ? undefined
      : payload.lines[lineIndex]?.quantity;
  }
  if (change.kind === "money" && change.field === "unit_price_rm") {
    return lineIndex === undefined
      ? undefined
      : payload.lines[lineIndex]?.unit_price_rm;
  }
  if (change.kind === "identifier" && change.field === "product_id") {
    return lineIndex === undefined
      ? undefined
      : payload.lines[lineIndex]?.product_id;
  }
  if (change.kind === "text" && change.field === "source_language") {
    return payload.source_language;
  }
  return undefined;
}

function applyCorrection(payload, change) {
  const lineIndex = change.line_index
    ?? (payload.lines.length === 1 ? 0 : undefined);
  if (change.kind === "decimal" && change.field === "quantity") {
    payload.lines[lineIndex].quantity = change.corrected_value;
  } else if (change.kind === "money" && change.field === "unit_price_rm") {
    payload.lines[lineIndex].unit_price_rm = change.corrected_value;
  } else if (change.kind === "identifier" && change.field === "product_id") {
    payload.lines[lineIndex].product_id = change.corrected_value;
  } else if (change.kind === "text" && change.field === "source_language") {
    payload.source_language = change.corrected_value;
  }
}

const PURCHASE_INTAKE_REQUIRED_FIELDS = [
  "supplier_name",
  "item.component_id",
  "item.quantity",
  "item.uom",
  "item.pack_size",
  "item.total_price_rm",
];

function purchaseIntakeEvents(events, intakeId) {
  return events
    .filter((event) => event.payload?.intake_id === intakeId)
    .sort((left, right) =>
      (left.payload?.version ?? 0) - (right.payload?.version ?? 0));
}

function mergeEvidence(existing = {}, incoming = {}) {
  const transcripts = [
    existing.transcript,
    incoming.transcript,
  ].filter(Boolean);
  return {
    ...existing,
    ...incoming,
    ...(transcripts.length
      ? { transcript: [...new Set(transcripts)].join("\n") }
      : {}),
  };
}

function mergePurchaseIntakeRequest(existing, incoming) {
  if (!existing) return structuredClone(incoming);
  return {
    ...existing,
    ...incoming,
    metadata: {
      ...existing.metadata,
      ...incoming.metadata,
    },
    item: {
      ...existing.item,
      ...incoming.item,
    },
    evidence: mergeEvidence(existing.evidence, incoming.evidence),
  };
}

function purchaseIntakeMissingFields(request, knownComponentIds) {
  const missing = [];
  if (!request.supplier_name?.trim()) missing.push("supplier_name");
  if (
    !request.item?.component_id
    || !knownComponentIds.has(request.item.component_id)
  ) {
    missing.push("item.component_id");
  }
  for (const field of ["quantity", "uom", "pack_size", "total_price_rm"]) {
    if (!request.item?.[field]) missing.push(`item.${field}`);
  }
  return PURCHASE_INTAKE_REQUIRED_FIELDS.filter((field) =>
    missing.includes(field));
}

function purchaseIntakeSummary(request) {
  return {
    supplier_name: request.supplier_name ?? null,
    component_id: request.item?.component_id ?? null,
    item_name: request.item?.raw_name ?? null,
    quantity: request.item?.quantity ?? null,
    uom: request.item?.uom ?? null,
    pack_size: request.item?.pack_size ?? null,
    total_price_rm: request.item?.total_price_rm ?? null,
    occurred_at: request.occurred_at,
    payment_method: request.metadata.payment_method,
    note: request.metadata.note ?? null,
  };
}

export function createPasarAiService({
  store,
  idFactory = () => crypto.randomUUID(),
}) {
  if (!store) throw new Error("store is required");

  async function idempotentMutation({
    merchantId,
    key,
    endpointId,
    payload,
    execute,
  }) {
    if (!key) return rejected(["Missing required header: Idempotency-Key"]);
    const result = await store.runIdempotent({
      merchantId,
      endpointId,
      key,
      fingerprint: fingerprint(payload),
      execute,
    });
    if (result.conflict) {
      return rejected([
        "Idempotency-Key was already used with a different request payload",
      ]);
    }
    return result.response;
  }

  async function purchaseIntakeTransition({
    merchantId,
    key,
    operation,
    payload,
    execute,
  }) {
    const result = await store.runIdempotent({
      merchantId,
      endpointId: "purchase-intake.transition",
      key,
      fingerprint: fingerprint({ operation, payload }),
      execute,
    });
    return result.conflict
      ? { conflict: true, response: null }
      : { conflict: false, response: result.response };
  }

  async function effectiveSalePayload(event, knownCorrections) {
    const payload = structuredClone(event.payload);
    const corrections = (
      knownCorrections
      ?? await store.listEvents({ type: "correction" })
    ).filter((correction) => correction.targetEventId === event.eventId);

    for (const correction of corrections) {
      for (const change of correction.payload.replacement_payload.changes) {
        applyCorrection(payload, change);
      }
    }
    return payload;
  }

  async function dailySummary({ merchantId, date, productId }) {
    const comparisonDate = shiftCalendarDate(date, -1);
    const sales = await store.listEvents({
      merchantId,
      date,
      type: "sale",
    });
    const missingInputs = [];
    const metricLines = [];
    const revenueLines = [];
    let driverComponents = [];
    let summaryProfile = null;
    let comparisonFallbackUsed = false;
    let matchedSaleLines = 0;
    const comparisonProfiles = new Map();

    async function loadComparisonProfile(candidateProductId) {
      if (comparisonProfiles.has(candidateProductId)) {
        return comparisonProfiles.get(candidateProductId);
      }
      const comparison = typeof store.getProductCostComparison === "function"
        ? await store.getProductCostComparison(candidateProductId, {
            currentDate: date,
            comparisonDate,
            merchantId,
          })
        : {
            current: await store.getProductProfile(candidateProductId, {
              asOfDate: date,
              merchantId,
            }),
            baseline: await store.getProductProfile(candidateProductId, {
              asOfDate: comparisonDate,
              merchantId,
            }),
          };
      const resolved = dayOverDayProfile(
        comparison.current,
        comparison.baseline,
        comparisonDate,
      );
      comparisonProfiles.set(candidateProductId, resolved);
      return resolved;
    }

    for (const event of sales) {
      const payload = await effectiveSalePayload(event);
      for (const line of payload.lines) {
        if (productId && line.product_id !== productId) continue;
        matchedSaleLines += 1;
        revenueLines.push({
          quantity: line.quantity,
          unitPriceRm: line.unit_price_rm,
        });
        const comparison = await loadComparisonProfile(line.product_id);
        const profile = comparison.profile;
        if (!profile) {
          missingInputs.push(`cost_profile:${line.product_id}`);
          continue;
        }
        comparisonFallbackUsed ||= !comparison.comparisonAvailable;
        summaryProfile ??= profile;
        metricLines.push({
          quantity: line.quantity,
          unitPriceRm: line.unit_price_rm,
          unitCogsRm: profile.currentUnitCogsRm,
          baselineUnitCogsRm: profile.baselineUnitCogsRm,
        });
        if (!driverComponents.length) driverComponents = profile.components ?? [];
      }
    }
    if (!summaryProfile && !productId) {
      const costEvents = await store.listEvents({
        merchantId,
        date,
        type: "cost",
      });
      costProfile:
      for (const event of [...costEvents].reverse()) {
        for (const line of [...(event.payload?.lines ?? [])].reverse()) {
          const profiles = await store.findProductProfilesByComponent(
            merchantId,
            line.component_id,
            { asOfDate: date },
          );
          if (!profiles.length) continue;
          const comparison = await loadComparisonProfile(
            profiles[0].productId,
          );
          summaryProfile = comparison.profile;
          comparisonFallbackUsed ||= !comparison.comparisonAvailable;
          driverComponents = summaryProfile?.components ?? [];
          break costProfile;
        }
      }
    }
    if (!summaryProfile && productId) {
      const comparison = await loadComparisonProfile(productId);
      summaryProfile = comparison.profile;
      comparisonFallbackUsed ||= Boolean(summaryProfile)
        && !comparison.comparisonAvailable;
      driverComponents = summaryProfile?.components ?? [];
    }
    if (!matchedSaleLines) missingInputs.push("sales");

    const metrics = calculatePortfolioMetrics(metricLines);
    const partial = missingInputs.length > 0;
    const response = {
      merchant_id: merchantId,
      date,
      revenue_rm: calculateRevenue(revenueLines),
      cogs_rm: metrics.cogsRm,
      gross_profit_rm: partial ? "0.00" : metrics.grossProfitRm,
      gross_margin_pct: partial ? "0.00" : metrics.grossMarginPct,
      data_completeness: {
        state: partial ? "partial" : "complete",
        missing_inputs: [...new Set(missingInputs)],
      },
      top_cost_drivers: rankCostDrivers(driverComponents),
      baseline_comparison: {
        baseline_margin_pct: partial
          ? "0.00"
          : metrics.baselineGrossMarginPct,
        margin_change_percentage_points:
          partial ? "0.00" : metrics.marginChangePercentagePoints,
      },
      price_floor: partial || !summaryProfile
        ? null
        : {
            target_gross_margin_pct:
              formatMyr(summaryProfile.targetGrossMarginPct ?? "40.00"),
            price_floor_rm: calculatePriceFloor({
              unitCogsRm: summaryProfile.currentUnitCogsRm,
              targetGrossMarginPct:
                summaryProfile.targetGrossMarginPct ?? "40.00",
            }),
            assumption: "current_unit_cogs",
          },
      cost_stack: summaryProfile
        ? {
            baseline_comparison_date: comparisonDate,
            baseline_effective_date: comparisonDate,
            baseline_unit_cogs_rm:
              formatMyr(summaryProfile.baselineUnitCogsRm),
            current_unit_cogs_rm:
              formatMyr(summaryProfile.currentUnitCogsRm),
            components: (summaryProfile.components ?? []).map((component) => ({
              component_id: component.componentId,
              name: component.name,
              baseline_cost_rm_per_pack:
                formatMyr(component.baselineCostRm),
              current_cost_rm_per_pack:
                formatMyr(component.currentCostRm),
              change_rm_per_pack: formatMyr(subtractDecimal(
                component.currentCostRm,
                component.baselineCostRm,
              )),
              evidence_id: component.evidence?.evidenceId ?? null,
            })),
          }
        : null,
      evidence: summaryProfile
        ? mergeEvidenceByReceipt(
            summaryProfile.components ?? [],
          ).map(publicEvidence)
        : [],
      assumptions: [
        "Costs compare the latest known recipe state on the selected date with the previous calendar day.",
        "Gross profit excludes operating expenses.",
        ...(comparisonFallbackUsed
          ? [
              "No complete previous-day cost profile was available; current costs are used as the comparison fallback.",
            ]
          : []),
        ...(partial
          ? ["Profit metrics are withheld until missing cost inputs are supplied."]
          : []),
      ],
    };
    const errors = validateContract("daily-summary.response", response);
    if (errors.length) {
      throw new Error(`Invalid daily summary response: ${errors.join("; ")}`);
    }
    return response;
  }

  async function productGrossProfit({ merchantId, date, productId, profile }) {
    const metricLines = [];
    for (const event of await store.listEvents({
      merchantId,
      date,
      type: "sale",
    })) {
      for (const line of (await effectiveSalePayload(event)).lines) {
        if (line.product_id !== productId) continue;
        metricLines.push({
          quantity: line.quantity,
          unitPriceRm: line.unit_price_rm,
          unitCogsRm: profile.currentUnitCogsRm,
          baselineUnitCogsRm: profile.baselineUnitCogsRm,
        });
      }
    }
    return metricLines.length
      ? calculatePortfolioMetrics(metricLines).grossProfitRm
      : undefined;
  }

  async function analyticsEventFacts({
    merchantId,
    productId,
    sourceEvents,
  }) {
    const corrections = await store.listEvents({
      merchantId,
      type: "correction",
    });
    const datedEvents = await Promise.all(
      sourceEvents
        .filter((event) =>
          event.type === "sale" || event.type === "day_status")
        .map(async (event) => ({
          event,
          businessDate:
            event.type === "day_status" && event.payload?.date
              ? event.payload.date
              : typeof store.getMerchantCalendarDate === "function"
                ? await store.getMerchantCalendarDate(
                    merchantId,
                    event.occurredAt,
                  )
                : event.occurredAt.slice(0, 10),
        })),
    );
    const salesByDate = new Map();
    const statusByDate = new Map();
    const observedAtByDate = new Map();
    const recordObservedAt = (date, event) => {
      const timestamp = event.ingestedAt ?? event.occurredAt;
      const current = observedAtByDate.get(date);
      if (!current || Date.parse(current) <= Date.parse(timestamp)) {
        observedAtByDate.set(date, timestamp);
      }
    };

    for (const { event, businessDate } of datedEvents) {
      if (event.type === "day_status") {
        if (event.payload?.product_id !== productId) continue;
        const current = statusByDate.get(businessDate);
        if (
          !current
          || Date.parse(current.occurredAt) <= Date.parse(event.occurredAt)
        ) {
          statusByDate.set(businessDate, event);
        }
        recordObservedAt(businessDate, event);
        continue;
      }
      const payload = await effectiveSalePayload(event, corrections);
      const lines = payload.lines.filter(
        (line) => line.product_id === productId,
      );
      if (!lines.length) continue;
      const existing = salesByDate.get(businessDate) ?? [];
      existing.push(...lines);
      salesByDate.set(businessDate, existing);
      recordObservedAt(businessDate, event);
    }
    return { observedAtByDate, salesByDate, statusByDate };
  }

  async function analyticsOverview({
    merchantId,
    productId,
    from,
    to,
  }) {
    const dates = calendarDates(from, to);
    const generatedAt = new Date().toISOString();
    const sourceEvents = await store.listEvents({
      merchantId,
      fromDate: from,
      toDate: to,
    });
    const sourceMaxIngestedAt = newestInstant(sourceEvents);
    const lagSeconds = sourceMaxIngestedAt
      ? Math.max(
          0,
          Math.floor(
            (Date.parse(generatedAt) - Date.parse(sourceMaxIngestedAt)) / 1000,
          ),
        )
      : 0;
    const freshnessState = sourceMaxIngestedAt === null
      ? "unavailable"
      : lagSeconds <= 900
        ? "fresh"
        : "stale";
    const projectionVersion = sourceMaxIngestedAt
      ? `analytics-v1:${sourceMaxIngestedAt}`
      : `analytics-v1:empty:${to}`;
    const {
      salesByDate,
      statusByDate,
    } = await analyticsEventFacts({
      merchantId,
      productId,
      sourceEvents,
    });
    const summaryDates = new Set([to, ...salesByDate.keys()]);
    const summaryEntries = await Promise.all(
      [...summaryDates].map(async (date) => [
        date,
        await dailySummary({ merchantId, date, productId }),
      ]),
    );
    const summariesByDate = new Map(summaryEntries);
    const days = [];

    for (const date of dates) {
      const summary = summariesByDate.get(date) ?? null;
      const saleLines = salesByDate.get(date) ?? [];
      const quantity = saleLines.length
        ? sumDecimal(saleLines.map((line) => line.quantity))
        : "0";
      const status = statusByDate.get(date)?.payload ?? null;

      if (status?.business_day_state === "closed_no_sales") {
        days.push({
          date,
          state: "closed_no_sales",
          quantity: "0",
          revenue_rm: "0.00",
          cogs_rm: "0.00",
          gross_profit_rm: "0.00",
          gross_margin_pct: null,
          sold_out_state: status.sold_out_state,
        });
        continue;
      }

      if (summary?.data_completeness.state === "complete") {
        days.push({
          date,
          state: "complete",
          quantity,
          revenue_rm: summary.revenue_rm,
          cogs_rm: summary.cogs_rm,
          gross_profit_rm: summary.gross_profit_rm,
          gross_margin_pct: summary.gross_margin_pct,
          sold_out_state: status?.sold_out_state ?? "unknown",
        });
        continue;
      }

      days.push({
        date,
        state:
          saleLines.length > 0
          || status?.business_day_state === "closed_complete"
            ? "partial"
            : "missing",
        quantity: null,
        revenue_rm: null,
        cogs_rm: null,
        gross_profit_rm: null,
        gross_margin_pct: null,
        sold_out_state: status?.sold_out_state ?? "unknown",
      });
    }

    const latestDay = days.at(-1);
    const latestSummary = summariesByDate.get(to) ?? null;
    const completeDays = days.filter((day) =>
      day.state === "complete" || day.state === "closed_no_sales");
    const profile = await store.getProductProfile(productId, {
      asOfDate: to,
      merchantId,
    });
    if (!profile) throw new Error(`Unknown product: ${productId}`);

    const alerts = [];
    if (latestDay?.state === "missing") {
      alerts.push({
        id: "record-latest-sales",
        severity: "warning",
        title: "Latest sales are missing",
        message: "Record sales or close the day with no sales before relying on the trend.",
        metric: "data-completeness",
        threshold: null,
        evidence_id: null,
        action: "record_sales",
      });
    } else if (latestDay?.state === "partial") {
      alerts.push({
        id: "complete-latest-day",
        severity: "critical",
        title: "Latest day is incomplete",
        message: "Some cost or sales inputs are unresolved, so profit metrics are withheld.",
        metric: "data-completeness",
        threshold: "complete",
        evidence_id: null,
        action: "resolve_clarification",
      });
    }
    if (
      latestDay?.gross_margin_pct !== null
      && Number(latestDay?.gross_margin_pct)
        < Number(profile.targetGrossMarginPct ?? "40.00")
    ) {
      alerts.push({
        id: "margin-below-target",
        severity: "critical",
        title: "Gross margin is below target",
        message: `Latest complete margin is ${Number(latestDay.gross_margin_pct).toFixed(2)}% against a ${Number(profile.targetGrossMarginPct ?? "40.00").toFixed(2)}% target.`,
        metric: "gross-margin",
        threshold: profile.targetGrossMarginPct ?? "40.00",
        evidence_id: null,
        action: "inspect_cost",
      });
    }
    const largestCostIncrease = latestSummary?.cost_stack?.components
      ?.filter((component) => Number(component.change_rm_per_pack) > 0)
      .sort((left, right) =>
        Number(right.change_rm_per_pack)
        - Number(left.change_rm_per_pack))[0];
    if (largestCostIncrease && Number(largestCostIncrease.change_rm_per_pack) >= 0.05) {
      alerts.push({
        id: `cost-increase-${largestCostIncrease.component_id}`,
        severity: "warning",
        title: `${largestCostIncrease.name} cost increased`,
        message: `${largestCostIncrease.name} adds ${largestCostIncrease.change_rm_per_pack} RM per pack versus the previous day.`,
        metric: "unit-cost",
        threshold: "0.05",
        evidence_id: largestCostIncrease.evidence_id,
        action: "review_receipt",
      });
    }
    if (freshnessState === "stale") {
      alerts.push({
        id: "analytics-stale",
        severity: "warning",
        title: "Analytics are not current",
        message: "The latest source event is more than 15 minutes behind this projection.",
        metric: "freshness",
        threshold: "900",
        evidence_id: null,
        action: "none",
      });
    }

    const qualityFlags = [];
    if (days.some((day) => day.state === "missing")) {
      qualityFlags.push("missing_days");
    }
    if (days.some((day) => day.state === "partial")) {
      qualityFlags.push("partial_days");
    }
    if (days.some((day) => day.sold_out_state === "yes")) {
      qualityFlags.push("sold_out_days_excluded_from_forecast");
    }
    if (freshnessState === "stale") qualityFlags.push("stale_projection");

    const response = {
      merchant_id: merchantId,
      product_id: productId,
      from,
      to,
      generated_at: generatedAt,
      data_through: completeDays.at(-1)?.date ?? null,
      freshness: {
        state: freshnessState,
        lag_seconds: lagSeconds,
        source_max_ingested_at: sourceMaxIngestedAt,
        projection_version: projectionVersion,
      },
      completeness_coverage_pct: percentage(
        completeDays.length,
        days.length,
      ),
      quality_flags: qualityFlags,
      days,
      alerts,
      cost_waterfall: latestSummary?.cost_stack
        ? {
            baseline_date:
              latestSummary.cost_stack.baseline_comparison_date
              ?? latestSummary.cost_stack.baseline_effective_date
              ?? null,
            baseline_unit_cogs_rm:
              latestSummary.cost_stack.baseline_unit_cogs_rm,
            current_unit_cogs_rm:
              latestSummary.cost_stack.current_unit_cogs_rm,
            components: latestSummary.cost_stack.components,
          }
        : null,
    };
    const errors = validateContract("analytics-overview.response", response);
    if (errors.length) {
      throw new Error(
        `Invalid analytics overview response: ${errors.join("; ")}`,
      );
    }
    if (typeof store.saveAnalyticsOverview === "function") {
      void Promise.resolve()
        .then(() => store.saveAnalyticsOverview(response))
        .catch((error) => {
          console.error(
            "Analytics overview projection persistence failed",
            error,
          );
        });
    }
    return response;
  }

  async function analyticsActivity({
    merchantId,
    productId,
    from,
    to,
  }) {
    calendarDates(from, to);
    const allowedStates = new Set([
      "committed",
      "clarification_required",
      "rejected",
    ]);
    const events = (await store.listEvents({
      merchantId,
      fromDate: from,
      toDate: to,
    })).filter((event) => {
      if (event.type === "receipt_review") return false;
      if (event.type === "sale") {
        return event.payload?.lines?.some(
          (line) => line.product_id === productId,
        );
      }
      if (event.type === "day_status") {
        return event.payload?.product_id === productId;
      }
      return true;
    });
    const response = {
      merchant_id: merchantId,
      product_id: productId,
      from,
      to,
      items: events
        .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt))
        .slice(0, 100)
        .map((event) => ({
          event_id: event.eventId,
          occurred_at: event.occurredAt,
          source: event.payload?.source ?? "api",
          type: event.type,
          state: allowedStates.has(event.response?.state)
            ? event.response.state
            : "recorded",
          title: activityTitle(event),
          evidence_uri: activityEvidenceUri(event),
          target_event_id: event.targetEventId ?? null,
        })),
    };
    const errors = validateContract("analytics-activity.response", response);
    if (errors.length) {
      throw new Error(
        `Invalid analytics activity response: ${errors.join("; ")}`,
      );
    }
    return response;
  }

  async function priceVolumeScenario(request) {
    const errors = contractErrors(
      "price-volume-scenario.create",
      {},
      request,
    );
    if (errors.length) {
      throw new TypeError(
        `Invalid price-volume scenario: ${errors.join("; ")}`,
      );
    }
    const profile = await store.getProductProfile(request.product_id, {
      asOfDate: request.as_of,
      merchantId: request.merchant_id,
    });
    if (!profile) throw new Error(`Unknown product: ${request.product_id}`);
    const matrix = buildPriceVolumeMatrix({
      centerUnitPriceRm: request.center_price_rm,
      centerQuantity: request.center_quantity,
      unitCogsRm: profile.currentUnitCogsRm,
      priceStepPct: request.price_step_pct,
      quantityStepPct: request.quantity_step_pct,
      targetGrossMarginPct: profile.targetGrossMarginPct ?? "40.00",
    });
    const response = {
      merchant_id: request.merchant_id,
      product_id: request.product_id,
      as_of: request.as_of,
      target_gross_margin_pct:
        formatMyr(profile.targetGrossMarginPct ?? "40.00"),
      assumption:
        "constant_unit_cogs_and_independent_price_volume_inputs",
      scenarios: matrix.matrix.flatMap((row) =>
        row.map((scenario) => ({
          row: scenario.quantityIndex,
          column: scenario.priceIndex,
          quantity: scenario.quantity,
          unit_price_rm: scenario.unitPriceRm,
          revenue_rm: scenario.revenueRm,
          cogs_rm: scenario.cogsRm,
          gross_profit_rm: scenario.grossProfitRm,
          gross_margin_pct: scenario.grossMarginPct,
          incremental_gross_profit_rm:
            scenario.incrementalGrossProfitRm,
          target_margin_met: scenario.targetMarginViable === true,
        }))),
    };
    const responseErrors = validateContract(
      "price-volume-scenario.response",
      response,
    );
    if (responseErrors.length) {
      throw new Error(
        `Invalid price-volume scenario response: ${responseErrors.join("; ")}`,
      );
    }
    return response;
  }

  function forecastDiagnostics({
    modelName,
    mae,
    wape,
    backtestWindows,
    passed,
  }) {
    if (!modelName || mae === null || wape === null) return null;
    return {
      model_name: modelName,
      mae: String(Number(mae).toFixed(2)),
      wape_pct: String((Number(wape) * 100).toFixed(2)),
      prediction_interval_coverage_pct: null,
      backtest_windows: Number(backtestWindows ?? 0),
      accuracy_state: Number(backtestWindows ?? 0) < 8
        ? "insufficient"
        : passed
          ? "pass"
          : "fail",
    };
  }

  async function analyticsForecast({ merchantId, productId, asOf }) {
    const forecastDate = shiftCalendarDate(asOf, 1);
    if (typeof store.getLatestAnalyticsForecast === "function") {
      const published = await store.getLatestAnalyticsForecast({
        merchantId,
        productId,
        forecastDate,
      });
      if (published) {
        const models = published.diagnostics?.models ?? [];
        const selected = models.find((model) => model.selected)
          ?? models.find((model) =>
            model.model_name === published.selectedModel)
          ?? null;
        const status = published.visibilityStatus === "display"
          ? "ready"
          : published.visibilityStatus === "shadow"
            ? "shadow"
            : "unavailable";
        const response = {
          merchant_id: merchantId,
          product_id: productId,
          as_of: asOf,
          status,
          generated_at: published.generatedAt,
          data_through: published.sourceWatermark,
          model_version: published.modelVersion,
          reasons: [
            ...(status === "shadow" ? ["forecast_is_shadow_only"] : []),
            ...(!published.accuracyGatePassed
              ? ["forecast_accuracy_gate_failed"]
              : []),
          ],
          training_days: published.usableDayCount,
          diagnostics: selected
            ? forecastDiagnostics({
                modelName: published.selectedModel,
                mae: selected.mae,
                wape: selected.wape,
                backtestWindows: selected.backtest_points,
                passed: published.accuracyGatePassed,
              })
            : null,
          forecast: status === "ready"
            ? {
                date: published.forecastDate,
                p10: String(published.p10),
                p50: String(published.p50),
                p90: String(published.p90),
                planning_note:
                  `Plan around ${published.p50} packs, with a working range of ${published.p10} to ${published.p90}.`,
              }
            : null,
        };
        const errors = validateContract(
          "analytics-forecast.response",
          response,
        );
        if (errors.length) {
          throw new Error(
            `Invalid published forecast response: ${errors.join("; ")}`,
          );
        }
        return response;
      }
    }

    const historyFrom = shiftCalendarDate(asOf, -89);
    const sourceEvents = await store.listEvents({
      merchantId,
      fromDate: historyFrom,
      toDate: asOf,
    });
    const {
      observedAtByDate,
      salesByDate,
      statusByDate,
    } = await analyticsEventFacts({
      merchantId,
      productId,
      sourceEvents,
    });
    const generatedAt = new Date().toISOString();
    const observations = calendarDates(historyFrom, asOf).map((date) => {
      const status = statusByDate.get(date)?.payload ?? null;
      const saleLines = salesByDate.get(date) ?? [];
      const closedNoSales =
        status?.business_day_state === "closed_no_sales";
      return {
        date,
        demand: closedNoSales
          ? "0"
          : saleLines.length
            ? sumDecimal(saleLines.map((line) => line.quantity))
            : null,
        complete: closedNoSales || saleLines.length > 0,
        soldOut: status?.sold_out_state === "yes",
        observedAt:
          observedAtByDate.get(date)
          ?? `${date}T00:00:00.000Z`,
      };
    });
    const result = buildDemandForecast({
      observations,
      forecastDate,
      asOf: generatedAt,
    });
    const selected = result.diagnostics.candidates.find(
      (candidate) => candidate.name === result.selectedModel,
    ) ?? null;
    const status = result.readiness === "ready"
      ? "ready"
      : result.readiness === "shadow"
        ? "shadow"
        : "unavailable";
    const response = {
      merchant_id: merchantId,
      product_id: productId,
      as_of: asOf,
      status,
      generated_at: generatedAt,
      data_through:
        observations
          .filter((observation) => observation.complete)
          .at(-1)?.date ?? null,
      model_version: result.modelVersion,
      reasons: result.reasons,
      training_days: result.sampleSize,
      diagnostics: selected
        ? forecastDiagnostics({
            modelName: selected.name,
            mae: selected.mae,
            wape: selected.wapePct === null
              ? null
              : selected.wapePct / 100,
            backtestWindows: selected.origins,
            passed: selected.errorGatePassed,
          })
        : null,
      forecast: status === "ready"
        ? {
            date: result.forecastDate,
            p10: String(result.p10),
            p50: String(result.p50),
            p90: String(result.p90),
            planning_note:
              `Plan around ${result.p50} packs, with a working range of ${result.p10} to ${result.p90}.`,
          }
        : null,
    };
    const errors = validateContract("analytics-forecast.response", response);
    if (errors.length) {
      throw new Error(
        `Invalid analytics forecast response: ${errors.join("; ")}`,
      );
    }
    return response;
  }

  async function commitResolvedCostIncrease({
    merchantId,
    componentId,
    increaseRm,
    packSize,
    occurredAt,
    evidence,
  }) {
    const effectiveDate = typeof store.getMerchantCalendarDate === "function"
      ? await store.getMerchantCalendarDate(merchantId, occurredAt)
      : occurredAt.slice(0, 10);
    const profiles = await store.findProductProfilesByComponent(
      merchantId,
      componentId,
      { asOfDate: effectiveDate },
    );
    if (!profiles.length) {
      return rejected([
        `Unknown component for merchant: ${componentId}`,
      ]);
    }

    const updatedProfiles = [];
    let beforeValueRm;
    let afterValueRm;
    for (const profile of profiles) {
      const component = profile.components.find(
        (candidate) => candidate.componentId === componentId,
      );
      const resolved = resolvePackPriceIncrease({
        currentContributionRm: component.currentCostRm,
        packPriceIncreaseRm: increaseRm,
        packSize,
        usagePerProductUnit: component.usagePerProductUnit ?? "1",
      });
      beforeValueRm ??= formatMyr(component.currentCostRm);
      component.currentCostRm = resolved.currentContributionRm;
      component.evidence = mergeEvidenceProjection(
        component.evidence,
        evidenceProjection(evidence),
      );
      afterValueRm ??= formatMyr(component.currentCostRm);
      profile.currentUnitCogsRm = sumDecimal(
        profile.components.map((item) => item.currentCostRm),
      );
      updatedProfiles.push(profile);
    }

    const eventId = idFactory("cost");
    const response = {
      state: "committed",
      event_id: eventId,
      before_value_rm: beforeValueRm,
      after_value_rm: afterValueRm,
    };
    const appended = await store.appendEvent({
      eventId,
      endpointId: "cost-changes.create",
      externalId: externalIdFromEvidence(evidence, merchantId),
      type: "cost",
      merchantId,
      occurredAt,
      payload: {
        merchant_id: merchantId,
        occurred_at: occurredAt,
        component_id: componentId,
        increase_rm: increaseRm,
        pack_size: packSize,
        evidence,
      },
      evidence,
      response,
    });
    if (!appended.appended) {
      return duplicateResponse(appended.event, {
        merchant_id: merchantId,
        occurred_at: occurredAt,
        component_id: componentId,
        increase_rm: increaseRm,
        pack_size: packSize,
        evidence,
      });
    }
    for (const profile of updatedProfiles) {
      await store.saveProductProfile(profile, {
        effectiveAt: occurredAt,
        changedComponentIds: [componentId],
      });
    }
    return response;
  }

  async function productOwnedByAnotherMerchant(productId, merchantId) {
    const profile = await store.getProductProfile(productId);
    return profile !== null && profile.merchantId !== merchantId;
  }

  async function latestPurchaseIntake(merchantId, intakeId) {
    const events = await store.listEvents({
      merchantId,
      type: "purchase_intake",
    });
    return purchaseIntakeEvents(events, intakeId).at(-1)?.payload ?? null;
  }

  async function activePurchaseIntake(merchantId, conversationKey) {
    if (!conversationKey) return null;
    const events = await store.listEvents({
      merchantId,
      type: "purchase_intake",
    });
    const latestByIntake = new Map();
    for (const event of events) {
      const payload = event.payload;
      if (payload?.conversation_key !== conversationKey) continue;
      const current = latestByIntake.get(payload.intake_id);
      if (!current || payload.version > current.version) {
        latestByIntake.set(payload.intake_id, payload);
      }
    }
    return [...latestByIntake.values()]
      .filter(({ state }) =>
        !["committed", "cancelled"].includes(state))
      .sort((left, right) => left.version - right.version)
      .at(-1) ?? null;
  }

  async function purchaseIntakeConversationGeneration(
    merchantId,
    conversationKey,
  ) {
    if (!conversationKey) return fingerprint([]);
    const events = await store.listEvents({
      merchantId,
      type: "purchase_intake",
    });
    const intakeIds = [...new Set(
      events
        .map(({ payload }) => payload)
        .filter((payload) =>
          payload?.conversation_key === conversationKey
          && payload.intake_id
        )
        .map(({ intake_id: intakeId }) => intakeId),
    )].sort();
    return fingerprint(intakeIds);
  }

  async function receiptReviewEvents(merchantId, receiptEventId) {
    return (await store.listEvents({
      merchantId,
      type: "receipt_review",
    }))
      .filter((event) =>
        event.targetEventId === receiptEventId
        || event.payload?.receipt_event_id === receiptEventId)
      .sort((left, right) =>
        (left.payload?.version ?? 0) - (right.payload?.version ?? 0)
        || String(left.ingestedAt ?? left.occurredAt).localeCompare(
          String(right.ingestedAt ?? right.occurredAt),
        ));
  }

  async function receiptCostEvents(merchantId, receiptEventId) {
    return (await store.listEvents({
      merchantId,
      type: "cost",
    })).filter((event) =>
      event.payload?.evidence?.source_event_id === receiptEventId
      || event.evidence?.source_event_id === receiptEventId);
  }

  async function receiptMaterialChanges(request) {
    const effectiveDate =
      typeof store.getMerchantCalendarDate === "function"
        ? await store.getMerchantCalendarDate(
            request.merchant_id,
            request.occurred_at,
          )
        : request.occurred_at.slice(0, 10);
    const changes = [];
    for (const line of request.extraction.line_items) {
      if (
        !line.normalized_component_id
        || !line.quantity
        || !line.uom
        || !line.pack_size
        || !line.total_price_rm
      ) {
        continue;
      }
      const profiles = await store.findProductProfilesByComponent(
        request.merchant_id,
        line.normalized_component_id,
        { asOfDate: effectiveDate },
      );
      for (const profile of profiles) {
        const component = profile.components.find(
          (candidate) =>
            candidate.componentId === line.normalized_component_id,
        );
        if (!component) continue;
        const calculation = calculatePurchasedContribution({
          purchaseQuantity: line.quantity,
          packSize: line.pack_size,
          totalPriceRm: line.total_price_rm,
          usagePerProductUnit: component.usagePerProductUnit ?? "1",
        });
        changes.push({
          component_id: line.normalized_component_id,
          component_name: component.name ?? line.raw_name,
          product_id: profile.productId,
          quantity: line.quantity,
          uom: line.uom,
          pack_size: line.pack_size,
          total_price_rm: line.total_price_rm,
          previous_cost_rm_per_pack: formatMyr(component.currentCostRm),
          current_cost_rm_per_pack: formatMyr(calculation.contributionRm),
          change_rm_per_pack: formatMyr(subtractDecimal(
            calculation.contributionRm,
            component.currentCostRm,
          )),
        });
      }
    }
    return changes;
  }

  function materialChangesFromCostEvent(event) {
    return (event?.payload?.lines ?? []).flatMap((line) => {
      if (
        !line.component_id
        || !line.quantity
        || !line.uom
        || !line.pack_size
        || !line.total_price_rm
      ) {
        return [];
      }
      const calculation = calculatePurchasedContribution({
        purchaseQuantity: line.quantity,
        packSize: line.pack_size,
        totalPriceRm: line.total_price_rm,
      });
      return [{
        component_id: line.component_id,
        component_name: line.raw_name ?? line.component_id,
        product_id: null,
        quantity: line.quantity,
        uom: line.uom,
        pack_size: line.pack_size,
        total_price_rm: line.total_price_rm,
        previous_cost_rm_per_pack: null,
        current_cost_rm_per_pack: formatMyr(calculation.contributionRm),
        change_rm_per_pack: null,
      }];
    });
  }

  const api = {
    async recordSale(request, { idempotencyKey } = {}) {
      const errors = contractErrors(
        "sales.create",
        { "Idempotency-Key": idempotencyKey ?? "" },
        request,
      );
      if (errors.length) return rejected(errors);
      for (const line of request.lines) {
        if (
          await productOwnedByAnotherMerchant(
            line.product_id,
            request.merchant_id,
          )
        ) {
          return rejected([
            `Unknown product for merchant: ${line.product_id}`,
          ]);
        }
      }

      return idempotentMutation({
        merchantId: request.merchant_id,
        key: idempotencyKey,
        endpointId: "sales.create",
        payload: request,
        execute: async () => {
          const externalId = externalIdFromEvidence(
            request.evidence,
            request.merchant_id,
          );
          const duplicate = externalId
            ? await store.findEventByExternalId(externalId)
            : null;
          if (duplicate) return duplicateResponse(duplicate, request);

          const eventId = idFactory("sale");
          const response = { state: "committed", event_id: eventId };
          const appended = await store.appendEvent({
            eventId,
            endpointId: "sales.create",
            externalId,
            type: "sale",
            merchantId: request.merchant_id,
            occurredAt: request.occurred_at,
            payload: request,
            evidence: request.evidence,
            response,
          });
          if (!appended.appended) {
            return duplicateResponse(appended.event, request);
          }
          return response;
        },
      });
    },

    async recordCost(
      request,
      {
        idempotencyKey,
        idempotencyEndpointId = "costs.create",
        idempotencyPayload = request,
        eventEndpointId = "costs.create",
      } = {},
    ) {
      return idempotentMutation({
        merchantId: request.merchant_id,
        key: idempotencyKey,
        endpointId: idempotencyEndpointId,
        payload: idempotencyPayload,
        execute: async () => {
          const externalId = externalIdFromEvidence(
            request.evidence,
            request.merchant_id,
          );
          const duplicate = externalId
            ? await store.findEventByExternalId(externalId)
            : null;
          if (duplicate) return duplicateResponse(duplicate, request);

          const clarifications = [];
          for (const [index, line] of (request.lines ?? []).entries()) {
            if (
              line.pack_size === undefined
              || line.pack_size === null
              || decimalIsZero(line.pack_size)
            ) {
              clarifications.push({
                field: `lines[${index}].pack_size`,
                question: `How many base units are in one ${line.uom}?`,
                options: [],
              });
            }
            if (
              line.quantity === undefined
              || line.quantity === null
              || decimalIsZero(line.quantity)
            ) {
              clarifications.push({
                field: `lines[${index}].quantity`,
                question: `How many ${line.uom} units were purchased?`,
                options: [],
              });
            }
            if (
              line.confidence !== undefined
              && decimalIsBelow(line.confidence, "0.90")
            ) {
              clarifications.push({
                field: `lines[${index}]`,
                question: `Please confirm the quantity and total price for ${line.component_id}.`,
                options: ["confirm", "correct"],
              });
            }
          }
          const errors = contractErrors(
            "costs.create",
            { "Idempotency-Key": idempotencyKey ?? "" },
            request,
          );
          const nonClarificationErrors = errors.filter(
            (error) => !/pack_size.*required|required.*pack_size/i.test(error),
          );
          if (nonClarificationErrors.length) {
            return rejected(nonClarificationErrors);
          }
          if (clarifications.length) {
            if (!externalId) {
              return rejected([
                "Clarification requires external_message_id, receipt_id, or source_event_id evidence",
              ]);
            }
            const response = {
              state: "clarification_required",
              clarifications,
            };
            const identity = evidenceIdentity(request.evidence);
            const sourceEventId = identity.id;
            const storageKey = clarificationKey(
              request.merchant_id,
              identity.kind,
              sourceEventId,
            );
            const existing = await store.getClarificationBySourceEventId(storageKey);
            if (existing) return existing.response;
            await store.saveClarification({
              taskId: idFactory("clarification"),
              kind: "cost_request",
              storageKey,
              evidenceKind: identity.kind,
              sourceEventId,
              merchantId: request.merchant_id,
              occurredAt: request.occurred_at,
              request,
              evidence: request.evidence,
              response,
              resolution: null,
            });
            return response;
          }

          const commit = async () => {
            const updatedProfiles = new Map();
            const effectiveDate =
              typeof store.getMerchantCalendarDate === "function"
                ? await store.getMerchantCalendarDate(
                    request.merchant_id,
                    request.occurred_at,
                  )
                : request.occurred_at.slice(0, 10);
            for (const line of request.lines) {
              const profiles = await store.findProductProfilesByComponent(
                request.merchant_id,
                line.component_id,
                { asOfDate: effectiveDate },
              );
              if (!profiles.length) {
                return rejected([
                  `Unknown component for merchant: ${line.component_id}`,
                ]);
              }
              for (const original of profiles) {
                const profile =
                  updatedProfiles.get(original.productId) ?? original;
                const component = profile.components.find(
                  (candidate) => candidate.componentId === line.component_id,
                );
                const calculation = calculatePurchasedContribution({
                  purchaseQuantity: line.quantity,
                  packSize: line.pack_size,
                  totalPriceRm: line.total_price_rm,
                  usagePerProductUnit: component.usagePerProductUnit ?? "1",
                });
                component.currentCostRm = calculation.contributionRm;
                component.evidence = mergeEvidenceProjection(
                  component.evidence,
                  evidenceProjection(request.evidence, {
                    supplierName: request.supplier_name,
                    line,
                  }),
                );
                profile.currentUnitCogsRm = sumDecimal(
                  profile.components.map((item) => item.currentCostRm),
                );
                updatedProfiles.set(profile.productId, profile);
              }
            }
            const eventId = idFactory("cost");
            const response = { state: "committed", event_id: eventId };
            const appended = await store.appendEvent({
              eventId,
              endpointId: eventEndpointId,
              externalId,
              type: "cost",
              merchantId: request.merchant_id,
              occurredAt: request.occurred_at,
              payload: request,
              evidence: request.evidence,
              response,
            });
            if (!appended.appended) {
              return duplicateResponse(appended.event, request);
            }
            const changedComponentIds = request.lines.map(
              (line) => line.component_id,
            );
            for (const profile of updatedProfiles.values()) {
              await store.saveProductProfile(profile, {
                effectiveAt: request.occurred_at,
                changedComponentIds,
              });
            }
            return response;
          };

          const resolutionSource = request.evidence.source_event_id;
          if (!resolutionSource) return commit();
          const reference = clarificationReference(resolutionSource);
          const matchingTasks = (await store.findClarificationsByRawSourceId(
            reference.id,
          )).filter((candidate) =>
            candidate.merchantId === request.merchant_id
            && (
              reference.kind === null
              || candidate.evidenceKind === reference.kind
            ));
          if (!matchingTasks.length) {
            const otherTasks =
              await store.findClarificationsByRawSourceId(reference.id);
            if (otherTasks.length) {
              return rejected([
                "Clarification belongs to a different merchant",
              ]);
            }
            return commit();
          }
          if (matchingTasks.length > 1) {
            return rejected([
              "Clarification source is ambiguous; include its evidence namespace",
            ]);
          }
          const task = matchingTasks[0];
          const storageKey = task.storageKey;
          if (task.kind !== "cost_request") {
            return rejected([
              "Clarification kind does not match a costs request",
            ]);
          }
          const answerFingerprint = fingerprint({
            merchant_id: request.merchant_id,
            supplier_name: request.supplier_name,
            lines: request.lines,
          });
          const resolution = await store.runClarificationResolution(
            storageKey,
            async () => ({
              response: await commit(),
              evidence: request.evidence,
              fingerprint: answerFingerprint,
            }),
          );
          if (resolution.fingerprint !== answerFingerprint) {
            return rejected([
              "Clarification was already resolved with a different answer",
            ]);
          }
          return resolution.response;
        },
      });
    },

    async getComponentCatalog({ merchantId, asOfDate } = {}) {
      const response = {
        merchant_id: merchantId,
        components: (await store.listComponents(merchantId, { asOfDate }))
          .map((component) => ({
            component_id: component.componentId,
            name: component.name,
          })),
      };
      const errors = validateContract("component-catalog.response", response);
      if (errors.length) {
        throw new Error(
          `Invalid component catalog response: ${errors.join("; ")}`,
        );
      }
      return response;
    },

    async getActivePurchaseIntake({ merchantId, conversationKey }) {
      return activePurchaseIntake(merchantId, conversationKey);
    },

    async upsertPurchaseIntake(
      request,
      {
        idempotencyKey,
        conversationKey = null,
      } = {},
    ) {
      const errors = contractErrors(
        "purchase-intake.upsert",
        { "Idempotency-Key": idempotencyKey ?? "" },
        request,
      );
      if (errors.length) return rejected(errors);

      return idempotentMutation({
        merchantId: request.merchant_id,
        key: idempotencyKey,
        endpointId: "purchase-intake.upsert",
        payload: { request, conversationKey },
        execute: async () => {
          const existing = request.intake_id
            ? await latestPurchaseIntake(
                request.merchant_id,
                request.intake_id,
              )
            : await activePurchaseIntake(
                request.merchant_id,
                conversationKey,
              );
          if (
            request.intake_id
            && (!existing || existing.merchant_id !== request.merchant_id)
          ) {
            return rejected(["Unknown purchase intake for merchant"]);
          }
          if (
            existing
            && request.expected_version !== existing.version
          ) {
            return rejected([
              "Purchase intake changed; reload the latest version before editing",
            ]);
          }
          if (existing && ["committed", "cancelled"].includes(existing.state)) {
            return rejected(["Purchase intake is already closed"]);
          }

          const applyUpdate = async () => {
            const merged = mergePurchaseIntakeRequest(
              existing?.request,
              request,
            );
            delete merged.intake_id;
            delete merged.expected_version;
            const effectiveDate =
              typeof store.getMerchantCalendarDate === "function"
                ? await store.getMerchantCalendarDate(
                    request.merchant_id,
                    merged.occurred_at,
                  )
                : merged.occurred_at.slice(0, 10);
            const catalog = await api.getComponentCatalog({
              merchantId: request.merchant_id,
              asOfDate: effectiveDate,
            });
            const knownComponentIds = new Set(
              catalog.components.map(({ component_id: id }) => id),
            );
            const selectedComponent = catalog.components.find(
              ({ component_id: id }) => id === merged.item?.component_id,
            );
            if (selectedComponent && !merged.item.raw_name) {
              merged.item.raw_name = selectedComponent.name;
            }
            const missingFields = purchaseIntakeMissingFields(
              merged,
              knownComponentIds,
            );
            const intakeId = existing?.intake_id
              ?? idFactory("purchase_intake");
            const version = (existing?.version ?? 0) + 1;
            const confirmationToken = missingFields.length
              ? null
              : idFactory("confirmation");
            const state = missingFields.length
              ? "clarification_required"
              : "ready_for_confirmation";
            const response = {
              state,
              intake_id: intakeId,
              version,
              missing_fields: missingFields,
              confirmation_token: confirmationToken,
              summary: purchaseIntakeSummary(merged),
            };
            const responseErrors = validateContract(
              "purchase-intake-upsert.response",
              response,
            );
            if (responseErrors.length) {
              throw new Error(
                `Invalid purchase intake response: ${responseErrors.join("; ")}`,
              );
            }
            const snapshot = {
              intake_id: intakeId,
              merchant_id: request.merchant_id,
              state,
              version,
              conversation_key:
                conversationKey ?? existing?.conversation_key ?? null,
              request: merged,
              missing_fields: missingFields,
              confirmation_token: confirmationToken,
              content_fingerprint: fingerprint(merged),
              committed_event_id: null,
              commit_response: null,
            };
            await store.appendEvent({
              eventId: idFactory("purchase_intake_snapshot"),
              endpointId: "purchase-intake.upsert",
              externalId: null,
              type: "purchase_intake",
              merchantId: request.merchant_id,
              occurredAt: merged.occurred_at,
              payload: snapshot,
              evidence: merged.evidence,
              response,
            });
            return response;
          };
          if (!existing && !conversationKey) return applyUpdate();

          const transition = await purchaseIntakeTransition({
            merchantId: request.merchant_id,
            key: existing
              ? `${existing.intake_id}:${existing.version}`
              : `conversation:${conversationKey}:${
                  await purchaseIntakeConversationGeneration(
                    request.merchant_id,
                    conversationKey,
                  )
                }`,
            operation: "upsert",
            payload: { request, conversationKey },
            execute: applyUpdate,
          });
          return transition.conflict
            ? rejected([
                "Purchase intake changed; reload the latest version before editing",
              ])
            : transition.response;
        },
      });
    },

    async confirmPurchaseIntake(request, { idempotencyKey } = {}) {
      const errors = contractErrors(
        "purchase-intake.confirm",
        { "Idempotency-Key": idempotencyKey ?? "" },
        request,
      );
      if (errors.length) return rejected(errors);

      return idempotentMutation({
        merchantId: request.merchant_id,
        key: idempotencyKey,
        endpointId: "purchase-intake.confirm",
        payload: request,
        execute: async () => {
          const intake = await latestPurchaseIntake(
            request.merchant_id,
            request.intake_id,
          );
          if (!intake) return rejected(["Unknown purchase intake for merchant"]);
          if (intake.state === "committed" && intake.commit_response) {
            return (
              intake.confirmed_version === request.expected_version
              && intake.confirmed_confirmation_token
                === request.confirmation_token
            )
              ? intake.commit_response
              : rejected([
                  "Purchase confirmation is stale; review the latest intake version",
                ]);
          }
          if (
            intake.state !== "ready_for_confirmation"
            || intake.version !== request.expected_version
            || intake.confirmation_token !== request.confirmation_token
          ) {
            return rejected([
              "Purchase confirmation is stale; review the latest intake version",
            ]);
          }
          const transition = await purchaseIntakeTransition({
            merchantId: request.merchant_id,
            key: `${intake.intake_id}:${intake.version}`,
            operation: "confirm",
            payload: request,
            execute: async () => {
              const sourceRequest = intake.request;
              const costRequest = {
                merchant_id: request.merchant_id,
                occurred_at: sourceRequest.occurred_at,
                source: sourceRequest.source,
                ...(sourceRequest.source_language
                  ? { source_language: sourceRequest.source_language }
                  : {}),
                supplier_name: sourceRequest.supplier_name,
                metadata: sourceRequest.metadata,
                lines: [{
                  component_id: sourceRequest.item.component_id,
                  ...(sourceRequest.item.raw_name
                    ? { raw_name: sourceRequest.item.raw_name }
                    : {}),
                  quantity: sourceRequest.item.quantity,
                  uom: sourceRequest.item.uom,
                  pack_size: sourceRequest.item.pack_size,
                  total_price_rm: sourceRequest.item.total_price_rm,
                  confidence: "1.00",
                }],
                evidence: {
                  ...sourceRequest.evidence,
                  external_message_id:
                    `purchase-intake:${request.intake_id}`,
                },
              };
              const commitResponse = await api.recordCost(costRequest, {
                idempotencyKey:
                  `purchase-intake:${request.intake_id}:cost-commit`,
                idempotencyEndpointId: "purchase-intake.cost-commit",
                idempotencyPayload: {
                  intake_id: request.intake_id,
                  content_fingerprint: intake.content_fingerprint,
                },
                eventEndpointId: "purchase-intake.confirm",
              });
              if (commitResponse.state !== "committed") return commitResponse;

              await store.appendEvent({
                eventId: idFactory("purchase_intake_snapshot"),
                endpointId: "purchase-intake.confirm",
                externalId: null,
                type: "purchase_intake",
                merchantId: request.merchant_id,
                occurredAt: sourceRequest.occurred_at,
                payload: {
                  ...intake,
                  state: "committed",
                  version: intake.version + 1,
                  confirmation_token: null,
                  confirmed_version: intake.version,
                  confirmed_confirmation_token: intake.confirmation_token,
                  committed_event_id: commitResponse.event_id,
                  commit_response: commitResponse,
                },
                evidence: sourceRequest.evidence,
                response: commitResponse,
              });
              return commitResponse;
            },
          });
          return transition.conflict
            ? rejected([
                "Purchase confirmation is stale; review the latest intake version",
              ])
            : transition.response;
        },
      });
    },

    async cancelPurchaseIntake({
      merchantId,
      intakeId,
      expectedVersion,
    }) {
      const intake = await latestPurchaseIntake(merchantId, intakeId);
      if (
        !intake
        || intake.version !== expectedVersion
        || ["committed", "cancelled"].includes(intake.state)
      ) {
        return false;
      }
      const transition = await purchaseIntakeTransition({
        merchantId,
        key: `${intake.intake_id}:${intake.version}`,
        operation: "cancel",
        payload: { intakeId, expectedVersion },
        execute: async () => {
          await store.appendEvent({
            eventId: idFactory("purchase_intake_snapshot"),
            endpointId: "purchase-intake.cancel",
            externalId: null,
            type: "purchase_intake",
            merchantId,
            occurredAt: intake.request.occurred_at,
            payload: {
              ...intake,
              state: "cancelled",
              version: intake.version + 1,
              confirmation_token: null,
            },
            evidence: intake.request.evidence,
            response: { state: "cancelled" },
          });
          return true;
        },
      });
      return !transition.conflict && transition.response === true;
    },

    async saveReceiptReview(request, { idempotencyKey } = {}) {
      const errors = contractErrors(
        "receipt-review.upsert",
        { "Idempotency-Key": idempotencyKey ?? "" },
        request,
      );
      if (errors.length) return rejected(errors);

      const sourceEvent = await store.getEvent(request.receipt_event_id);
      if (
        !sourceEvent
        || sourceEvent.type !== "receipt"
        || sourceEvent.merchantId !== request.merchant_id
      ) {
        return rejected([
          "Receipt review must reference this merchant's receipt event",
        ]);
      }
      return store.runReceiptReviewMutation({
        merchantId: request.merchant_id,
        receiptEventId: request.receipt_event_id,
      }, () => idempotentMutation({
          merchantId: request.merchant_id,
          key: idempotencyKey,
          endpointId: "receipt-review.upsert",
          payload: request,
          execute: async () => {
            if ((await receiptCostEvents(
              request.merchant_id,
              request.receipt_event_id,
            )).length) {
              return rejected(["Verified receipt reviews cannot be changed"]);
            }
            const reviews = await receiptReviewEvents(
              request.merchant_id,
              request.receipt_event_id,
            );
            if (reviews.at(-1)?.payload?.review_state === "archived") {
              return rejected(["Archived receipt reviews cannot be changed"]);
            }
            const version = (reviews.at(-1)?.payload?.version ?? 0) + 1;
            const reviewEventId = idFactory("receipt_review");
            const response = {
              state:
                request.review_state === "archived" ? "archived" : "saved",
              receipt_event_id: request.receipt_event_id,
              review_event_id: reviewEventId,
              version,
            };
            const responseErrors = validateContract(
              "receipt-review-upsert.response",
              response,
            );
            if (responseErrors.length) {
              throw new Error(
                `Invalid receipt review response: ${responseErrors.join("; ")}`,
              );
            }
            await store.appendEvent({
              eventId: reviewEventId,
              endpointId: "receipt-review.upsert",
              externalId: null,
              type: "receipt_review",
              merchantId: request.merchant_id,
              occurredAt: request.occurred_at,
              targetEventId: request.receipt_event_id,
              payload: {
                receipt_event_id: request.receipt_event_id,
                review_state: request.review_state,
                version,
                extraction: request.extraction,
                committed_event_id: null,
                material_changes: [],
              },
              evidence: sourceEvent.evidence ?? {},
              response,
            });
            return response;
          },
        }));
    },

    async getReceiptReviews({ merchantId }) {
      const [receipts, reviews, costs] = await Promise.all([
        store.listEvents({ merchantId, type: "receipt" }),
        store.listEvents({ merchantId, type: "receipt_review" }),
        store.listEvents({ merchantId, type: "cost" }),
      ]);
      const latestReviewByReceipt = new Map();
      for (const review of reviews) {
        const receiptEventId =
          review.targetEventId ?? review.payload?.receipt_event_id;
        if (!receiptEventId) continue;
        const current = latestReviewByReceipt.get(receiptEventId);
        if (
          !current
          || (review.payload?.version ?? 0) >=
            (current.payload?.version ?? 0)
        ) {
          latestReviewByReceipt.set(receiptEventId, review);
        }
      }
      const costByReceipt = new Map();
      for (const cost of costs) {
        const receiptEventId =
          cost.payload?.evidence?.source_event_id
          ?? cost.evidence?.source_event_id;
        if (receiptEventId) costByReceipt.set(receiptEventId, cost);
      }

      const response = {
        merchant_id: merchantId,
        receipts: receipts.flatMap((sourceEvent) => {
          const review = latestReviewByReceipt.get(sourceEvent.eventId);
          const cost = costByReceipt.get(sourceEvent.eventId);
          if (review?.payload?.review_state === "archived" && !cost) return [];
          const extraction =
            review?.payload?.extraction
            ?? sourceEvent.payload?.extraction
            ?? sourceEvent.response?.extraction;
          if (!extraction) return [];
          const confirmed = Boolean(cost);
          const updatedAt =
            cost?.ingestedAt
            ?? cost?.occurredAt
            ?? review?.ingestedAt
            ?? review?.occurredAt
            ?? sourceEvent.ingestedAt
            ?? sourceEvent.occurredAt;
          return [{
            receipt_event_id: sourceEvent.eventId,
            review_state: confirmed ? "verified" : "draft",
            version: review?.payload?.version ?? 0,
            title:
              extraction.supplier_name
              ?? sourceEvent.payload?.file_name
              ?? `Receipt ${sourceEvent.eventId}`,
            image_uri: activityEvidenceUri(sourceEvent),
            uploaded_at: sourceEvent.occurredAt,
            updated_at: updatedAt,
            extraction,
            confirmed,
            cost_event_id: cost?.eventId ?? null,
            verified_at:
              cost
                ? cost.ingestedAt ?? cost.occurredAt
                : null,
            material_changes:
              confirmed
                ? (
                    review?.payload?.material_changes?.length
                      ? review.payload.material_changes
                      : materialChangesFromCostEvent(cost)
                  )
                : [],
          }];
        }).sort((left, right) =>
          Date.parse(right.updated_at) - Date.parse(left.updated_at)),
      };
      const responseErrors = validateContract(
        "receipt-reviews.response",
        response,
      );
      if (responseErrors.length) {
        throw new Error(
          `Invalid receipt reviews response: ${responseErrors.join("; ")}`,
        );
      }
      return response;
    },

    async recordCostChange(request, { idempotencyKey } = {}) {
      const errors = contractErrors(
        "cost-changes.create",
        { "Idempotency-Key": idempotencyKey ?? "" },
        request,
      );
      if (errors.length) return rejected(errors);

      if (request.pack_size == null) {
        return this.recordAmbiguousCostIncrease({
          merchantId: request.merchant_id,
          componentId: request.component_id,
          increaseRm: request.increase_rm,
          occurredAt: request.occurred_at,
          evidence: request.evidence,
        }, { idempotencyKey });
      }

      if (request.clarification_source != null) {
        return this.resolveCostClarification({
          sourceEventId: request.clarification_source,
          packSize: request.pack_size,
          merchantId: request.merchant_id,
          componentId: request.component_id,
          increaseRm: request.increase_rm,
          occurredAt: request.occurred_at,
          evidence: request.evidence,
        }, { idempotencyKey });
      }

      return idempotentMutation({
        merchantId: request.merchant_id,
        key: idempotencyKey,
        endpointId: "cost-changes.create",
        payload: request,
        execute: async () => commitResolvedCostIncrease({
          merchantId: request.merchant_id,
          componentId: request.component_id,
          increaseRm: request.increase_rm,
          packSize: request.pack_size,
          occurredAt: request.occurred_at,
          evidence: request.evidence,
        }),
      });
    },

    async recordAmbiguousCostIncrease(request, { idempotencyKey } = {}) {
      return idempotentMutation({
        merchantId: request.merchantId,
        key: idempotencyKey,
        endpointId: "cost-changes.create",
        payload: request,
        execute: async () => {
          const identity = evidenceIdentity(request.evidence);
          if (!identity) {
            return rejected(["Ambiguous cost evidence requires an external event ID"]);
          }
          const sourceEventId = identity.id;
          const storageKey = clarificationKey(
            request.merchantId,
            identity.kind,
            sourceEventId,
          );
          const existing = await store.getClarificationBySourceEventId(storageKey);
          if (existing) return existing.response;
          const componentName = (await store.findProductProfilesByComponent(
            request.merchantId,
            request.componentId,
          ))[0]?.components.find(
            (component) => component.componentId === request.componentId,
          )?.name ?? request.componentId;

          const response = {
            state: "clarification_required",
            clarification_source: `${identity.kind}:${sourceEventId}`,
            clarifications: [
              {
                field: "pack_size",
                question:
                  `${componentName} increase RM${request.increaseRm} applies to how many base units?`,
                options: request.options ?? ["50", "100", "other"],
              },
            ],
          };
          await store.saveClarification({
            taskId: idFactory("clarification"),
            kind: "cost_increase",
            storageKey,
            evidenceKind: identity.kind,
            sourceEventId,
            merchantId: request.merchantId,
            occurredAt: request.occurredAt,
            componentId: request.componentId,
            increaseRm: request.increaseRm,
            evidence: request.evidence,
            response,
            resolution: null,
          });
          return response;
        },
      });
    },

    async resolveCostClarification(request, { idempotencyKey } = {}) {
      return idempotentMutation({
        merchantId: request.merchantId,
        key: idempotencyKey,
        endpointId: "cost-changes.create",
        payload: request,
        execute: async () => {
          const reference = clarificationReference(request.sourceEventId);
          const candidates = (await store.findClarificationsByRawSourceId(reference.id))
            .filter((task) =>
              task.kind === "cost_increase"
              && (
                reference.kind === null
                || task.evidenceKind === reference.kind
              )
              && (
                request.merchantId === undefined
                || task.merchantId === request.merchantId
              ));
          if (candidates.length !== 1) {
            return rejected([
              candidates.length
                ? "Clarification source is ambiguous"
                : "Unknown cost clarification",
            ]);
          }
          const resolution = await store.runClarificationResolution(
            candidates[0].storageKey,
            async (task) => {
              if (task.kind !== "cost_increase") {
                return {
                  response: rejected([
                    "This clarification must be resolved by resubmitting /api/v1/costs",
                  ]),
                  evidence: request.evidence,
                };
              }
              if (
                request.componentId !== undefined
                && request.componentId !== task.componentId
              ) {
                return {
                  response: rejected([
                    "Clarification component does not match the pending interpretation",
                  ]),
                  evidence: request.evidence,
                };
              }
              if (
                request.increaseRm !== undefined
                && !decimalEquals(request.increaseRm, task.increaseRm)
              ) {
                return {
                  response: rejected([
                    "Clarification amount does not match the pending interpretation",
                  ]),
                  evidence: request.evidence,
                };
              }
              const response = await commitResolvedCostIncrease({
                merchantId: task.merchantId,
                componentId: task.componentId,
                increaseRm: task.increaseRm,
                packSize: request.packSize,
                occurredAt: task.occurredAt,
                evidence: request.evidence,
              });
              return {
                response,
                evidence: request.evidence,
              };
            },
          );
          return resolution?.response ?? rejected(["Unknown cost clarification"]);
        },
      });
    },

    async confirmReceipt(request, { idempotencyKey } = {}) {
      const errors = contractErrors(
        "receipt-confirm.create",
        { "Idempotency-Key": idempotencyKey ?? "" },
        request,
      );
      if (errors.length) return rejected(errors);

      const sourceEvent = await store.getEvent(request.receipt_event_id);
      if (
        !sourceEvent
        || sourceEvent.type !== "receipt"
        || sourceEvent.merchantId !== request.merchant_id
      ) {
        return rejected([
          "Receipt confirmation must reference this merchant's receipt event",
        ]);
      }
      if (!request.extraction.supplier_name) {
        return rejected(["Receipt supplier_name must be confirmed"]);
      }
      const totalMismatch = receiptTotalMismatch(request.extraction);
      if (totalMismatch > 5n) {
        return rejected([
          `Receipt total differs from line item totals by RM${
            totalMismatch / 100n
          }.${String(totalMismatch % 100n).padStart(2, "0")}`,
        ]);
      }

      const normalizedLines = request.extraction.line_items
        .filter((line) => line.normalized_component_id !== null);
      if (!normalizedLines.length) {
        return rejected([
          "Receipt has no recognized recipe-component lines to record",
        ]);
      }
      const incomplete = normalizedLines.find((line) =>
        line.quantity === null
        || line.uom === null
        || line.pack_size === null
        || line.total_price_rm === null);
      if (incomplete) {
        return rejected([
          `Receipt line requires quantity, unit, pack size and total before commit: ${incomplete.raw_name}`,
        ]);
      }

      return store.runReceiptReviewMutation({
        merchantId: request.merchant_id,
        receiptEventId: request.receipt_event_id,
      }, async () => {
        const reviews = await receiptReviewEvents(
          request.merchant_id,
          request.receipt_event_id,
        );
        if (reviews.at(-1)?.payload?.review_state === "archived") {
          return rejected(["Archived receipt reviews cannot be confirmed"]);
        }
        const materialChanges = await receiptMaterialChanges(request);
        const response = await this.recordCost({
          merchant_id: request.merchant_id,
          occurred_at: request.occurred_at,
          supplier_name: request.extraction.supplier_name,
          lines: normalizedLines.map((line) => ({
            component_id: line.normalized_component_id,
            raw_name: line.raw_name,
            quantity: line.quantity,
            uom: line.uom,
            pack_size: line.pack_size,
            total_price_rm: line.total_price_rm,
            confidence: "1.00",
          })),
          evidence: {
            receipt_id: request.extraction.receipt_id
              ?? request.receipt_event_id,
            source_event_id: request.receipt_event_id,
            ...(sourceEvent.evidence?.asset_uri
              ? { asset_uri: sourceEvent.evidence.asset_uri }
              : {}),
          },
        }, {
          idempotencyKey,
          idempotencyEndpointId: "receipt-confirm.create",
          idempotencyPayload: request,
          eventEndpointId: "receipt-confirm.create",
        });
        if (response.state !== "committed") return response;

        const reviewEventId = `receipt-review:${response.event_id}`;
        if (!await store.getEvent(reviewEventId)) {
          const latestReviews = await receiptReviewEvents(
            request.merchant_id,
            request.receipt_event_id,
          );
          await store.appendEvent({
            eventId: reviewEventId,
            endpointId: "receipt-confirm.create",
            externalId: null,
            type: "receipt_review",
            merchantId: request.merchant_id,
            occurredAt: request.occurred_at,
            targetEventId: request.receipt_event_id,
            payload: {
              receipt_event_id: request.receipt_event_id,
              review_state: "verified",
              version: (latestReviews.at(-1)?.payload?.version ?? 0) + 1,
              extraction: request.extraction,
              committed_event_id: response.event_id,
              material_changes: materialChanges,
            },
            evidence: sourceEvent.evidence ?? {},
            response,
          });
        }
        return response;
      });
    },

    async recordCorrection(
      request,
      { idempotencyKey, expectedTargetVersion } = {},
    ) {
      const errors = contractErrors(
        "corrections.create",
        { "Idempotency-Key": idempotencyKey ?? "" },
        request,
      );
      if (
        expectedTargetVersion !== undefined
        && (
          !Number.isInteger(expectedTargetVersion)
          || expectedTargetVersion < 1
        )
      ) {
        errors.push("Expected target version must be a positive integer");
      }
      if (errors.length) return rejected(errors);

      return idempotentMutation({
        merchantId: request.merchant_id,
        key: idempotencyKey,
        endpointId: "corrections.create",
        payload: expectedTargetVersion === undefined
          ? request
          : { request, expectedTargetVersion },
        execute: async () => {
          const target = await store.getEvent(request.target_event_id);
          if (!target || target.type !== "sale") {
            return rejected(["Correction target must be an existing sale event"]);
          }
          if (target.merchantId !== request.merchant_id) {
            return rejected(["Correction target belongs to a different merchant"]);
          }
          const effectiveTarget = await effectiveSalePayload(target);
          const appliedChanges = [];
          for (const change of request.replacement_payload.changes) {
            if (
              change.kind === "identifier"
              && change.field === "product_id"
              && await productOwnedByAnotherMerchant(
                change.corrected_value,
                request.merchant_id,
              )
            ) {
              return rejected([
                `Unknown product for merchant: ${change.corrected_value}`,
              ]);
            }
            const lineScoped = change.field !== "source_language";
            if (
              lineScoped
              && change.line_index === undefined
              && effectiveTarget.lines.length !== 1
            ) {
              return rejected([
                `Correction for ${change.field} requires line_index for a multi-line sale`,
              ]);
            }
            if (
              lineScoped
              && (
                change.line_index < 0
                || change.line_index >= effectiveTarget.lines.length
              )
            ) {
              return rejected([
                `Correction line_index is outside the sale lines: ${change.line_index}`,
              ]);
            }
            const currentValue = correctionValue(effectiveTarget, change);
            if (currentValue === undefined) {
              return rejected([
                `Unsupported sale correction field: ${change.field}`,
              ]);
            }
            if (
              change.previous_value !== undefined
              && change.previous_value !== null
              && (
                ["decimal", "money"].includes(change.kind)
                  ? !decimalEquals(change.previous_value, currentValue)
                  : change.previous_value !== currentValue
              )
            ) {
              return rejected([
                `Stale correction for ${change.field}: expected ${currentValue}`,
              ]);
            }
            const unchanged = ["decimal", "money"].includes(change.kind)
              ? decimalEquals(change.corrected_value, currentValue)
              : change.corrected_value === currentValue;
            if (unchanged) {
              return rejected([
                `Correction for ${change.field} does not change the current value`,
              ]);
            }
            appliedChanges.push({
              field: change.field,
              ...(lineScoped && change.line_index !== undefined
                ? { line_index: change.line_index }
                : {}),
              before_value: String(currentValue),
              after_value: String(change.corrected_value),
            });
            applyCorrection(effectiveTarget, change);
          }
          const externalId = externalIdFromEvidence(
            request.evidence,
            request.merchant_id,
          );
          const duplicate = externalId
            ? await store.findEventByExternalId(externalId)
            : null;
          if (duplicate) return duplicateResponse(duplicate, request);

          const eventId = idFactory("correction");
          const response = {
            state: "committed",
            correction_event_id: eventId,
            target_event_id: request.target_event_id,
            changes: appliedChanges,
          };
          const appended = await store.appendCorrection(
            {
              eventId,
              endpointId: "corrections.create",
              externalId,
              type: "correction",
              merchantId: request.merchant_id,
              occurredAt: request.occurred_at,
              targetEventId: request.target_event_id,
              payload: request,
              evidence: request.evidence,
              response,
            },
            { expectedTargetVersion },
          );
          if (appended.conflict) {
            return rejected([
              `Correction target changed; expected version ${
                expectedTargetVersion
              }, current version is ${appended.targetVersion}`,
            ]);
          }
          if (!appended.appended) {
            return duplicateResponse(appended.event, request);
          }
          return response;
        },
      });
    },

    async recordAnalyticsDayStatus(
      request,
      { idempotencyKey } = {},
    ) {
      const errors = contractErrors(
        "analytics-day-status.create",
        { "Idempotency-Key": idempotencyKey ?? "" },
        request,
      );
      if (errors.length) return rejected(errors);
      const profile = await store.getProductProfile(request.product_id, {
        asOfDate: request.date,
        merchantId: request.merchant_id,
      });
      if (!profile) {
        return rejected([
          `Unknown product for merchant: ${request.product_id}`,
        ]);
      }
      return idempotentMutation({
        merchantId: request.merchant_id,
        key: idempotencyKey,
        endpointId: "analytics-day-status.create",
        payload: request,
        execute: async () => {
          const eventId = idFactory("day-status");
          const response = {
            state: "committed",
            event_id: eventId,
            date: request.date,
            business_day_state: request.business_day_state,
            sold_out_state: request.sold_out_state,
          };
          await store.appendEvent({
            eventId,
            endpointId: "analytics-day-status.create",
            type: "day_status",
            merchantId: request.merchant_id,
            occurredAt: request.occurred_at,
            payload: request,
            evidence: {},
            response,
          });
          return response;
        },
      });
    },

    async simulatePrice(request) {
      const errors = contractErrors(
        "price-simulation.create",
        {},
        request,
      );
      if (errors.length) {
        throw new TypeError(`Invalid price simulation: ${errors.join("; ")}`);
      }
      const profile = await store.getProductProfile(request.product_id, {
        asOfDate: request.as_of,
        merchantId: request.merchant_id,
      });
      if (!profile || profile.merchantId !== request.merchant_id) {
        throw new Error(`Unknown product: ${request.product_id}`);
      }
      const response = calculatePriceSimulation({
        quantity: request.quantity,
        proposedUnitPriceRm: request.proposed_unit_price_rm,
        unitCogsRm: profile.currentUnitCogsRm,
        comparisonGrossProfitRm: await productGrossProfit({
          merchantId: request.merchant_id,
          date: request.as_of,
          productId: request.product_id,
          profile,
        }),
      });
      const responseErrors = validateContract(
        "price-simulation.response",
        response,
      );
      if (responseErrors.length) {
        throw new Error(
          `Invalid price simulation response: ${responseErrors.join("; ")}`,
        );
      }
      return response;
    },

    async simulatePriceVolume(request) {
      return priceVolumeScenario(request);
    },

    async getDailySummary(query) {
      return dailySummary(query);
    },

    async getAnalyticsOverview(query) {
      return analyticsOverview(query);
    },

    async getAnalyticsActivity(query) {
      return analyticsActivity(query);
    },

    async getAnalyticsForecast(query) {
      return analyticsForecast(query);
    },

    async getEvent(eventId) {
      return await store.getEvent(eventId);
    },
  };
  return api;
}
