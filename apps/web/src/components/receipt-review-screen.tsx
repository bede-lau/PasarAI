"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ComponentCatalogResponse,
  CostsResponse,
  ReceiptExtraction,
  ReceiptReviewsResponse,
  ReceiptReviewUpsertResponse,
  ReceiptUploadResponse
} from "@pasarai/contracts/v1";

import { CashPurchaseFlow } from "@/components/cash-purchase-flow";
import { DashboardHeader } from "@/components/dashboard-header";
import { ReceiptReview } from "@/components/receipt-review";
import type { DashboardDateRange } from "@/lib/dashboard-date";
import type { Locale, ReceiptReviewRecord } from "@/lib/dashboard-types";
import type { MerchantContext } from "@/lib/merchant";
import {
  getReceiptReviews,
  postReceiptConfirmation,
  postReceiptReview,
  postReceiptUpload,
  receiptEvidenceUrl,
  receiptReviewRecords
} from "@/lib/receipt-upload";
import {
  getCashPurchaseMessages
} from "@/lib/cash-purchase-i18n";
import {
  getReceiptReviewMessages,
  type ReceiptReviewMessages
} from "@/lib/receipt-review-i18n";
import {
  loadReceiptReviews as loadCachedReceiptReviews,
  mergeReceiptReviewHistory,
  saveReceiptReviews
} from "@/lib/receipt-review-storage";

type ReceiptField = "supplier_name" | "date" | "total_rm";
type LineField =
  | "normalized_component_id"
  | "quantity"
  | "uom"
  | "pack_size"
  | "unit_price_rm"
  | "total_price_rm";
type Ambiguity = ReceiptExtraction["ambiguities"][number];

type ReceiptReviewScreenProps = {
  initialEntry?: "receipt" | "cash";
  locale: Locale;
  merchant: MerchantContext;
  summaryDate: string;
  dateRange: DashboardDateRange;
  componentCatalog: ComponentCatalogResponse;
  componentCatalogUnavailable?: boolean;
  initialReceipt?: ReceiptReviewRecord;
  extractReceipt?: (input: {
    file: File;
    merchantId: string;
  }) => Promise<ReceiptUploadResponse>;
  confirmReceipt?: (input: {
    merchantId: string;
    receiptEventId: string;
    extraction: ReceiptReviewRecord["extraction"];
    occurredAt: string;
    idempotencyKey: string;
  }) => Promise<CostsResponse>;
  loadReceiptHistory?: (input: {
    merchantId: string;
  }) => Promise<ReceiptReviewsResponse>;
  saveReceiptHistory?: (input: {
    merchantId: string;
    receiptEventId: string;
    extraction: ReceiptReviewRecord["extraction"];
    reviewState: "draft" | "archived";
  }) => Promise<ReceiptReviewUpsertResponse>;
};

const MONEY_PATTERN = /^(0|[1-9][0-9]*)\.[0-9]{2}$/u;
const POSITIVE_DECIMAL_PATTERN =
  /^(?:0\.(?:0*[1-9][0-9]*)|[1-9][0-9]*(?:\.[0-9]+)?)$/u;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;

function ambiguityKey(ambiguity: Ambiguity) {
  return `${ambiguity.field}:${ambiguity.question}`;
}

function isValidDate(value: string | null) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf())
    && parsed.toISOString().slice(0, 10) === value;
}

function moneyToCents(value: string | null) {
  if (!value || !MONEY_PATTERN.test(value)) return null;
  const [ringgit, sen] = value.split(".");
  return Number(ringgit) * 100 + Number(sen);
}

function formatMoney(value: string) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed.toFixed(2) : null;
}

function isValidConfidence(value: string) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1;
}

function matchesManualField(manualField: string, editedPath: string) {
  return manualField === editedPath
    || (
      /^line_items\[\d+\]$/u.test(manualField)
      && editedPath.startsWith(`${manualField}.`)
    );
}

function ambiguityFieldHasUsableValue(
  extraction: ReceiptExtraction,
  field: string
) {
  if (field === "supplier_name") {
    return Boolean(extraction.supplier_name?.trim());
  }
  if (field === "date") return isValidDate(extraction.date);
  if (field === "total_rm") return moneyToCents(extraction.total_rm) !== null;
  if (field === "receipt_id") {
    return Boolean(
      extraction.receipt_id
      && IDENTIFIER_PATTERN.test(extraction.receipt_id)
    );
  }

  const lineMatch =
    /^line_items\[(\d+)\](?:\.([A-Za-z_]+))?$/u.exec(field);
  if (!lineMatch) return false;
  const line = extraction.line_items[Number(lineMatch[1])];
  const lineField = lineMatch[2] as LineField | undefined;
  if (!line) return false;
  if (!lineField) {
    return Boolean(
      line.quantity
      && POSITIVE_DECIMAL_PATTERN.test(line.quantity)
      && line.uom?.trim()
      && line.total_price_rm
      && MONEY_PATTERN.test(line.total_price_rm)
    );
  }
  if (lineField === "normalized_component_id") {
    return Boolean(
      line.normalized_component_id
      && IDENTIFIER_PATTERN.test(line.normalized_component_id)
    );
  }
  if (lineField === "quantity") {
    return Boolean(
      line.quantity && POSITIVE_DECIMAL_PATTERN.test(line.quantity)
    );
  }
  if (lineField === "uom") return Boolean(line.uom?.trim());
  if (lineField === "pack_size") {
    return Boolean(
      line.pack_size && POSITIVE_DECIMAL_PATTERN.test(line.pack_size)
    );
  }
  if (lineField === "unit_price_rm") {
    return Boolean(
      line.unit_price_rm && MONEY_PATTERN.test(line.unit_price_rm)
    );
  }
  return Boolean(
    line.total_price_rm && MONEY_PATTERN.test(line.total_price_rm)
  );
}

function validationBlockers(
  extraction: ReceiptExtraction | undefined,
  text: ReceiptReviewMessages
) {
  if (!extraction) return [];
  const blockers: string[] = [];

  if (!extraction.supplier_name?.trim()) {
    blockers.push(text.supplierRequired);
  }
  if (
    extraction.receipt_id !== null
    && !IDENTIFIER_PATTERN.test(extraction.receipt_id)
  ) {
    blockers.push(text.invalidReceiptId);
  }
  if (!isValidDate(extraction.date)) {
    blockers.push(text.invalidDate);
  }
  if (!isValidConfidence(extraction.overall_confidence)) {
    blockers.push(text.invalidConfidence);
  }
  const receiptTotal = moneyToCents(extraction.total_rm);
  if (receiptTotal === null) {
    blockers.push(text.invalidTotal);
  }
  if (extraction.ambiguities.length) {
    blockers.push(text.resolveClarifications);
  }

  let lineTotal = 0;
  let hasInvalidLineTotal = false;
  let mappedLines = 0;

  extraction.line_items.forEach((line, index) => {
    const label = text.lineLabel(index + 1);
    if (!line.raw_name.trim()) {
      blockers.push(`${label} ${text.itemNameRequired}`);
    }
    const componentId = line.normalized_component_id?.trim() || null;
    if (componentId && !IDENTIFIER_PATTERN.test(componentId)) {
      blockers.push(`${label} ${text.invalidComponent}`);
    }

    const total = moneyToCents(line.total_price_rm);
    if (total === null) {
      blockers.push(`${label} ${text.validLineTotalRequired}`);
      hasInvalidLineTotal = true;
    } else {
      lineTotal += total;
    }

    if (
      line.unit_price_rm !== null
      && !MONEY_PATTERN.test(line.unit_price_rm)
    ) {
      blockers.push(`${label} ${text.invalidUnitPrice}`);
    }

    if (!componentId) return;
    mappedLines += 1;
    if (!line.quantity || !POSITIVE_DECIMAL_PATTERN.test(line.quantity)) {
      blockers.push(`${label} ${text.positiveQuantityRequired}`);
    }
    if (!line.uom?.trim()) {
      blockers.push(`${label} ${text.unitRequired}`);
    }
    if (!line.pack_size || !POSITIVE_DECIMAL_PATTERN.test(line.pack_size)) {
      blockers.push(`${label} ${text.positivePackSizeRequired}`);
    }
    if (!isValidConfidence(line.confidence)) {
      blockers.push(`${label} ${text.invalidFinancialConfidence}`);
    }
  });

  if (!mappedLines) {
    blockers.push(text.mapLineRequired);
  }
  if (
    receiptTotal !== null
    && !hasInvalidLineTotal
    && Math.abs(lineTotal - receiptTotal) > 5
  ) {
    blockers.push(text.reconcileTotal);
  }

  return blockers;
}

function localizedUploadError(
  error: unknown,
  text: ReceiptReviewMessages
) {
  if (
    error instanceof Error
    && (
      error.message === text.manualReview
      || error.message.startsWith(`${text.rejected}:`)
    )
  ) {
    return error.message;
  }
  return text.uploadFailed;
}

function localizedConfirmationError(
  error: unknown,
  text: ReceiptReviewMessages
) {
  if (
    error instanceof Error
    && (
      error.message === text.moreFieldsRequired
      || error.message === text.costsNotRecorded
    )
  ) {
    return error.message;
  }
  return text.confirmationFailed;
}

function applyClarificationOption(
  extraction: ReceiptExtraction,
  ambiguity: Ambiguity,
  option: string
) {
  const lineMatch =
    /^line_items\[(\d+)\](?:\.([A-Za-z_]+))?$/u.exec(ambiguity.field);
  const moneyMatch = /RM\s*([0-9]+(?:\.[0-9]{1,2})?)/iu.exec(option);
  const measureMatch =
    /([0-9]+(?:\.[0-9]+)?)\s*([A-Za-z][A-Za-z0-9_-]*)/u.exec(option);
  const numberMatch = /([0-9]+(?:\.[0-9]+)?)/u.exec(option);
  const dateMatch = /\d{4}-\d{2}-\d{2}/u.exec(option);
  let next = extraction;
  let usable = false;

  if (lineMatch) {
    const lineIndex = Number(lineMatch[1]);
    const field = lineMatch[2] as LineField | undefined;
    const line = extraction.line_items[lineIndex];
    if (!line) return { extraction, usable: false };

    const updated = { ...line };
    if (!field || field === "quantity") {
      if (measureMatch) {
        updated.quantity = measureMatch[1];
        updated.uom = measureMatch[2];
        usable = true;
      } else if (numberMatch) {
        updated.quantity = numberMatch[1];
        usable = true;
      }
    }
    if (!field || field === "quantity" || field === "total_price_rm") {
      const amountValue =
        moneyMatch?.[1]
        ?? (field === "total_price_rm" ? numberMatch?.[1] : undefined);
      const amount = amountValue ? formatMoney(amountValue) : null;
      if (amount) {
        updated.total_price_rm = amount;
        usable = true;
      }
    }
    if (field === "unit_price_rm" && (moneyMatch || numberMatch)) {
      const amount = formatMoney((moneyMatch ?? numberMatch)![1]);
      if (amount) {
        updated.unit_price_rm = amount;
        usable = true;
      }
    }
    if (field === "pack_size" && numberMatch) {
      updated.pack_size = numberMatch[1];
      usable = true;
    }
    if (field === "uom" && option.trim()) {
      updated.uom = option.trim();
      usable = true;
    }
    if (
      field === "normalized_component_id"
      && IDENTIFIER_PATTERN.test(option.trim())
    ) {
      updated.normalized_component_id = option.trim();
      usable = true;
    }
    if (/^confirm$/iu.test(option.trim())) {
      if (!field) {
        usable = Boolean(
          updated.quantity
          && POSITIVE_DECIMAL_PATTERN.test(updated.quantity)
          && updated.uom?.trim()
          && updated.total_price_rm
          && MONEY_PATTERN.test(updated.total_price_rm)
        );
      } else if (field === "quantity") {
        usable = Boolean(
          updated.quantity
          && POSITIVE_DECIMAL_PATTERN.test(updated.quantity)
        );
      } else if (field === "uom") {
        usable = Boolean(updated.uom?.trim());
      } else if (field === "pack_size") {
        usable = Boolean(
          updated.pack_size
          && POSITIVE_DECIMAL_PATTERN.test(updated.pack_size)
        );
      } else if (field === "unit_price_rm") {
        usable = Boolean(
          updated.unit_price_rm
          && MONEY_PATTERN.test(updated.unit_price_rm)
        );
      } else if (field === "total_price_rm") {
        usable = Boolean(
          updated.total_price_rm
          && MONEY_PATTERN.test(updated.total_price_rm)
        );
      } else if (field === "normalized_component_id") {
        usable = Boolean(
          updated.normalized_component_id
          && IDENTIFIER_PATTERN.test(updated.normalized_component_id)
        );
      }
    }

    if (
      usable
      && updated.quantity
      && updated.total_price_rm
      && (!updated.unit_price_rm || moneyMatch)
    ) {
      const unitPrice =
        Number(updated.total_price_rm) / Number(updated.quantity);
      if (Number.isFinite(unitPrice)) {
        updated.unit_price_rm = unitPrice.toFixed(2);
      }
    }
    next = {
      ...extraction,
      line_items: extraction.line_items.map((candidate, index) =>
        index === lineIndex ? updated : candidate
      )
    };
  } else if (ambiguity.field === "total_rm" && (moneyMatch || numberMatch)) {
    const amount = formatMoney((moneyMatch ?? numberMatch)![1]);
    if (amount) {
      next = { ...extraction, total_rm: amount };
      usable = true;
    }
  } else if (ambiguity.field === "date" && dateMatch) {
    next = { ...extraction, date: dateMatch[0] };
    usable = true;
  } else if (ambiguity.field === "supplier_name" && option.trim()) {
    next = { ...extraction, supplier_name: option.trim() };
    usable = true;
  } else if (
    ambiguity.field === "receipt_id"
    && IDENTIFIER_PATTERN.test(option.trim())
  ) {
    next = { ...extraction, receipt_id: option.trim() };
    usable = true;
  }

  return { extraction: next, usable };
}

export function ReceiptReviewScreen({
  initialEntry = "receipt",
  locale,
  merchant,
  summaryDate,
  dateRange,
  componentCatalog,
  componentCatalogUnavailable = false,
  initialReceipt,
  extractReceipt = postReceiptUpload,
  confirmReceipt = postReceiptConfirmation,
  loadReceiptHistory = getReceiptReviews,
  saveReceiptHistory = postReceiptReview
}: ReceiptReviewScreenProps) {
  const [activeLocale, setActiveLocale] = useState(locale);
  const [activeEntry, setActiveEntry] = useState(initialEntry);
  const [receipt, setReceipt] = useState(initialReceipt);
  const [savedReceipts, setSavedReceipts] = useState<ReceiptReviewRecord[]>([]);
  const [storageReady, setStorageReady] = useState(false);
  const [isExtracting, setIsExtracting] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [manualCorrectionFields, setManualCorrectionFields] = useState<
    Set<string>
  >(new Set());
  const [selectedClarifications, setSelectedClarifications] = useState<
    Record<string, string>
  >({});
  const [confirmState, setConfirmState] = useState<
    "idle" | "loading" | "success"
  >(initialReceipt?.confirmed ? "success" : "idle");
  const [deletingReceiptId, setDeletingReceiptId] = useState<string | null>(
    null
  );
  const persistenceQueue = useRef<Promise<void>>(Promise.resolve());
  const historyRequestGeneration = useRef(0);
  const receiptStateGeneration = useRef(0);
  const confirmationInFlight = useRef(false);
  const deletingReceiptIds = useRef(new Set<string>());
  const archivedReceiptIds = useRef(new Set<string>());
  const text = getReceiptReviewMessages(activeLocale);
  const cashText = getCashPurchaseMessages(activeLocale);
  const blockers = useMemo(
    () => validationBlockers(receipt?.extraction, text),
    [receipt?.extraction, text]
  );
  const canConfirm = Boolean(
    receipt?.sourceEventId
    && !receipt.confirmed
    && deletingReceiptId !== receipt.id
    && blockers.length === 0
  );

  useEffect(() => {
    let cancelled = false;
    const stored = loadCachedReceiptReviews(
      window.localStorage,
      merchant.id
    );
    setSavedReceipts(stored);
    setReceipt(stored[0] ?? initialReceipt);
    setConfirmState(
      (stored[0] ?? initialReceipt)?.confirmed ? "success" : "idle"
    );
    setStorageReady(true);
    stored
      .filter((candidate) => candidate.pendingSync && !candidate.confirmed)
      .forEach((candidate) => {
        void persistReceipt(candidate);
      });

    const requestGeneration = ++historyRequestGeneration.current;
    const stateGeneration = receiptStateGeneration.current;
    void loadReceiptHistory({ merchantId: merchant.id })
      .then((response) => {
        if (
          cancelled
          || requestGeneration !== historyRequestGeneration.current
          || stateGeneration !== receiptStateGeneration.current
        ) {
          return;
        }
        const serverReceipts = receiptReviewRecords(response);
        setSavedReceipts((current) =>
          mergeReceiptReviewHistory(serverReceipts, current)
        );
      })
      .catch(() => {
        // Pending local work remains authoritative while the API is offline.
      });

    return () => {
      cancelled = true;
    };
  }, [initialReceipt, loadReceiptHistory, merchant.id]);

  useEffect(() => {
    if (!storageReady) return;
    setReceipt((current) => {
      const selected = current
        ? savedReceipts.find((candidate) => candidate.id === current.id)
        : undefined;
      const initialFallback =
        initialReceipt && !archivedReceiptIds.current.has(initialReceipt.id)
          ? initialReceipt
          : undefined;
      return selected ?? savedReceipts[0] ?? initialFallback;
    });
  }, [initialReceipt, savedReceipts, storageReady]);

  useEffect(() => {
    setConfirmState((current) =>
      current === "loading"
        ? current
        : receipt?.confirmed ? "success" : "idle"
    );
  }, [receipt?.confirmed, receipt?.id]);

  useEffect(() => {
    if (!storageReady) return;
    const saved = saveReceiptReviews(
      window.localStorage,
      merchant.id,
      savedReceipts
    );
    setUploadError((current) =>
      saved
        ? current === text.storageFailed ? null : current
        : text.storageFailed
    );
  }, [merchant.id, savedReceipts, storageReady, text.storageFailed]);

  function resetReviewState() {
    setManualCorrectionFields(new Set());
    setSelectedClarifications({});
  }

  function replaceSavedReceipt(nextReceipt: ReceiptReviewRecord) {
    receiptStateGeneration.current += 1;
    setReceipt(nextReceipt);
    setSavedReceipts((current) => {
      const found = current.some(
        (candidate) => candidate.id === nextReceipt.id
      );
      return found
        ? current.map((candidate) =>
            candidate.id === nextReceipt.id ? nextReceipt : candidate
          )
        : [nextReceipt, ...current];
    });
  }

  function pendingReceipt(nextReceipt: ReceiptReviewRecord) {
    return {
      ...nextReceipt,
      pendingSync: true,
      localRevision: (nextReceipt.localRevision ?? 0) + 1,
      confirmationIdempotencyKey: undefined,
      confirmationOccurredAt: undefined,
      confirmationRevision: undefined
    };
  }

  function persistReceipt(
    nextReceipt: ReceiptReviewRecord,
    reviewState: "draft" | "archived" = "draft"
  ) {
    if (!nextReceipt.sourceEventId) return Promise.resolve(false);
    const localRevision = nextReceipt.localRevision;
    const operation = persistenceQueue.current.then(async () => {
      try {
        const result = await saveReceiptHistory({
          merchantId: merchant.id,
          receiptEventId: nextReceipt.sourceEventId!,
          extraction: nextReceipt.extraction,
          reviewState
        });
        if (reviewState === "draft") {
          receiptStateGeneration.current += 1;
          setSavedReceipts((current) =>
            current.map((candidate) =>
              candidate.id === nextReceipt.id
              && candidate.localRevision === localRevision
                ? {
                    ...candidate,
                    pendingSync: false,
                    reviewVersion: result.version
                  }
                : candidate
            )
          );
          setReceipt((current) =>
            current?.id === nextReceipt.id
            && current.localRevision === localRevision
              ? {
                  ...current,
                  pendingSync: false,
                  reviewVersion: result.version
                }
              : current
          );
        }
        return true;
      } catch {
        return false;
      }
    });
    persistenceQueue.current = operation.then(() => undefined);
    return operation;
  }

  function resolvedManualFields(
    path: string,
    extraction: ReceiptExtraction
  ) {
    return [...manualCorrectionFields].filter((field) =>
      matchesManualField(field, path)
      && ambiguityFieldHasUsableValue(extraction, field)
    );
  }

  function clearResolvedManualFields(resolved: readonly string[]) {
    if (!resolved.length) return;
    setManualCorrectionFields((current) => {
      const next = new Set(current);
      resolved.forEach((field) => next.delete(field));
      return next;
    });
  }

  function updateExtraction(
    update: (extraction: ReceiptExtraction) => ReceiptExtraction
  ) {
    if (
      !receipt
      || confirmationInFlight.current
      || deletingReceiptIds.current.has(receipt.id)
    ) {
      return;
    }
    const nextReceipt = {
      ...receipt,
      confirmed: false,
      extraction: update(receipt.extraction)
    };
    const pending = pendingReceipt(nextReceipt);
    replaceSavedReceipt(pending);
    void persistReceipt(pending);
    setConfirmState("idle");
  }

  function handleReceiptFieldChange(field: ReceiptField, value: string) {
    if (!receipt) return;
    const nextExtraction: ReceiptExtraction = {
      ...receipt.extraction,
      [field]: value || null,
      ambiguities: receipt.extraction.ambiguities
    };
    const resolved = resolvedManualFields(field, nextExtraction);
    clearResolvedManualFields(resolved);
    updateExtraction(() => ({
      ...nextExtraction,
      ambiguities: nextExtraction.ambiguities.filter(
        (ambiguity) => !resolved.includes(ambiguity.field)
      )
    }));
  }

  function handleLineFieldChange(
    lineIndex: number,
    field: LineField,
    value: string
  ) {
    if (!receipt) return;
    const path = `line_items[${lineIndex}].${field}`;
    const nextExtraction: ReceiptExtraction = {
      ...receipt.extraction,
      line_items: receipt.extraction.line_items.map((line, index) =>
        index === lineIndex
          ? {
              ...line,
              [field]: value || null
            }
          : line
      ),
      ambiguities: receipt.extraction.ambiguities
    };
    const resolved = resolvedManualFields(path, nextExtraction);
    clearResolvedManualFields(resolved);
    updateExtraction(() => ({
      ...nextExtraction,
      ambiguities: nextExtraction.ambiguities.filter(
        (ambiguity) => !resolved.includes(ambiguity.field)
      )
    }));
  }

  function handleClarificationSelect(
    ambiguity: Ambiguity,
    option: string
  ) {
    if (
      confirmationInFlight.current
      || (receipt && deletingReceiptIds.current.has(receipt.id))
    ) {
      return;
    }
    const key = ambiguityKey(ambiguity);
    setSelectedClarifications((current) => ({ ...current, [key]: option }));

    if (/correct|correction|needs correction|manual/iu.test(option)) {
      setManualCorrectionFields((current) =>
        new Set(current).add(ambiguity.field)
      );
      setConfirmState("idle");
      return;
    }

    if (!receipt) return;
    const applied = applyClarificationOption(
      receipt.extraction,
      ambiguity,
      option
    );
    if (!applied.usable) {
      setManualCorrectionFields((current) =>
        new Set(current).add(ambiguity.field)
      );
      setConfirmState("idle");
      return;
    }
    setManualCorrectionFields((current) => {
      const next = new Set(current);
      next.delete(ambiguity.field);
      return next;
    });
    updateExtraction(() => ({
      ...applied.extraction,
      ambiguities: applied.extraction.ambiguities.filter(
        (candidate) => ambiguityKey(candidate) !== key
      )
    }));
  }

  async function handleUpload(file: File) {
    if (
      confirmationInFlight.current
      || deletingReceiptIds.current.size > 0
    ) {
      return;
    }
    setUploadError(null);
    setConfirmState("idle");
    resetReviewState();
    setIsExtracting(true);
    try {
      const result = await extractReceipt({
        file,
        merchantId: merchant.id
      });
      if (!("extraction" in result) || !result.extraction) {
        throw new Error(
          result.state === "rejected"
            ? `${text.rejected}: ${result.reason}.`
            : text.manualReview
        );
      }
      const nextReceipt = pendingReceipt({
        id: result.event_id,
        title: result.extraction.supplier_name || file.name,
        imageUrl: receiptEvidenceUrl(result.evidence_uri),
        evidenceUri: result.evidence_uri,
        extraction: result.extraction,
        sourceEventId: result.event_id,
        readyToConfirm: result.state === "ready_for_review",
        confirmed: false
      });
      receiptStateGeneration.current += 1;
      setReceipt(nextReceipt);
      setSavedReceipts((current) => [
        nextReceipt,
        ...current.filter((candidate) => candidate.id !== nextReceipt.id)
      ]);
      void persistReceipt(nextReceipt);
    } catch (error) {
      setUploadError(localizedUploadError(error, text));
    } finally {
      setIsExtracting(false);
    }
  }

  function handleReceiptSelect(nextReceipt: ReceiptReviewRecord) {
    if (
      confirmationInFlight.current
      || deletingReceiptIds.current.size > 0
    ) {
      return;
    }
    receiptStateGeneration.current += 1;
    setReceipt(nextReceipt);
    setConfirmState(nextReceipt.confirmed ? "success" : "idle");
    setUploadError(null);
    resetReviewState();
  }

  async function handleReceiptDelete(receiptId: string) {
    if (
      confirmationInFlight.current
      || deletingReceiptIds.current.has(receiptId)
    ) {
      return;
    }
    const deletedReceipt = savedReceipts.find(
      (candidate) => candidate.id === receiptId
    );
    if (deletedReceipt?.confirmed) return;
    deletingReceiptIds.current.add(receiptId);
    setDeletingReceiptId(receiptId);
    try {
      if (deletedReceipt) {
        const archived = await persistReceipt(deletedReceipt, "archived");
        if (!archived) {
          setUploadError(text.deleteFailed);
          return;
        }
      }
      archivedReceiptIds.current.add(receiptId);
      receiptStateGeneration.current += 1;
      setSavedReceipts((current) =>
        current.filter((candidate) => candidate.id !== receiptId)
      );
      if (receipt?.id === receiptId) {
        setReceipt(undefined);
        setConfirmState("idle");
        resetReviewState();
      }
      setUploadError(null);
    } finally {
      deletingReceiptIds.current.delete(receiptId);
      setDeletingReceiptId((current) =>
        current === receiptId ? null : current
      );
    }
  }

  async function handleConfirm() {
    if (
      !receipt?.sourceEventId
      || !canConfirm
      || confirmationInFlight.current
      || deletingReceiptIds.current.has(receipt.id)
    ) {
      return;
    }
    confirmationInFlight.current = true;
    setUploadError(null);
    setConfirmState("loading");
    const receiptRevision = receipt.localRevision ?? 0;
    const confirmationAttempt =
      receipt.confirmationRevision === receiptRevision
      && receipt.confirmationIdempotencyKey
      && receipt.confirmationOccurredAt
        ? {
            idempotencyKey: receipt.confirmationIdempotencyKey,
            occurredAt: receipt.confirmationOccurredAt
          }
        : {
            idempotencyKey: crypto.randomUUID(),
            occurredAt: new Date().toISOString()
          };
    const receiptWithAttempt = {
      ...receipt,
      confirmationIdempotencyKey: confirmationAttempt.idempotencyKey,
      confirmationOccurredAt: confirmationAttempt.occurredAt,
      confirmationRevision: receiptRevision
    };
    replaceSavedReceipt(receiptWithAttempt);
    try {
      await persistReceipt(receiptWithAttempt);
      const result = await confirmReceipt({
        merchantId: merchant.id,
        receiptEventId: receipt.sourceEventId,
        extraction: receipt.extraction,
        occurredAt: confirmationAttempt.occurredAt,
        idempotencyKey: confirmationAttempt.idempotencyKey
      });
      if (result.state !== "committed") {
        throw new Error(
          result.state === "clarification_required"
            ? text.moreFieldsRequired
            : text.costsNotRecorded
        );
      }
      replaceSavedReceipt({
        ...receipt,
        readyToConfirm: false,
        confirmed: true,
        pendingSync: false,
        confirmationIdempotencyKey: undefined,
        confirmationOccurredAt: undefined,
        confirmationRevision: undefined,
        costEventId: result.event_id
      });
      setConfirmState("success");
      confirmationInFlight.current = false;
      try {
        const requestGeneration = ++historyRequestGeneration.current;
        const stateGeneration = receiptStateGeneration.current;
        const response = await loadReceiptHistory({
          merchantId: merchant.id
        });
        if (
          requestGeneration !== historyRequestGeneration.current
          || stateGeneration !== receiptStateGeneration.current
        ) {
          return;
        }
        const records = receiptReviewRecords(response);
        const verified = records.find(
          (candidate) =>
            candidate.id === receipt.id && candidate.confirmed
        );
        if (!verified) return;
        setSavedReceipts((current) =>
          mergeReceiptReviewHistory(records, current, {
            preserveUnmatchedLocal: true
          })
        );
        setReceipt((current) =>
          current?.id === receipt.id ? verified : current
        );
        setConfirmState("success");
      } catch {
        // The committed receipt remains visible from the local state.
      }
    } catch (error) {
      try {
        const response = await loadReceiptHistory({
          merchantId: merchant.id
        });
        const records = receiptReviewRecords(response);
        const verified = records.find(
          (candidate) =>
            candidate.id === receipt.id && candidate.confirmed
        );
        if (verified) {
          receiptStateGeneration.current += 1;
          setSavedReceipts((current) =>
            mergeReceiptReviewHistory(records, current, {
              preserveUnmatchedLocal: true
            })
          );
          setReceipt((current) =>
            current?.id === receipt.id ? verified : current
          );
          setConfirmState("success");
          return;
        }
      } catch {
        // Keep the reusable confirmation identity for the next retry.
      }
      setConfirmState("idle");
      setUploadError(localizedConfirmationError(error, text));
    } finally {
      confirmationInFlight.current = false;
    }
  }

  function handleTabKeyDown(
    event: React.KeyboardEvent<HTMLButtonElement>,
    entry: "receipt" | "cash"
  ) {
    if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    const nextEntry = entry === "receipt" ? "cash" : "receipt";
    setActiveEntry(nextEntry);
    document.getElementById(`purchase-tab-${nextEntry}`)?.focus();
  }

  return (
    <div
      data-locale={activeLocale}
      lang={activeLocale === "zh" ? "zh-CN" : activeLocale}
    >
      <DashboardHeader
        activeLocale={activeLocale}
        activeTab="receipts"
        merchant={merchant}
        summaryDate={summaryDate}
        dateRange={dateRange}
        onLocaleChange={setActiveLocale}
      />
      <div className="receipt-page">
        <div
          className="purchase-intake-tabs"
          role="tablist"
          aria-label={cashText.workspaceLabel}
        >
          <button
            id="purchase-tab-receipt"
            type="button"
            role="tab"
            aria-controls="purchase-panel-receipt"
            aria-selected={activeEntry === "receipt"}
            tabIndex={activeEntry === "receipt" ? 0 : -1}
            onClick={() => setActiveEntry("receipt")}
            onKeyDown={(event) => handleTabKeyDown(event, "receipt")}
          >
            {cashText.receiptTab}
          </button>
          <button
            id="purchase-tab-cash"
            type="button"
            role="tab"
            aria-controls="purchase-panel-cash"
            aria-selected={activeEntry === "cash"}
            tabIndex={activeEntry === "cash" ? 0 : -1}
            onClick={() => setActiveEntry("cash")}
            onKeyDown={(event) => handleTabKeyDown(event, "cash")}
          >
            {cashText.cashTab}
          </button>
        </div>
        <section
          id="purchase-panel-receipt"
          role="tabpanel"
          aria-labelledby="purchase-tab-receipt"
          hidden={activeEntry !== "receipt"}
        >
          <ReceiptReview
            locale={activeLocale}
            receipt={receipt}
            onUpload={handleUpload}
            isProcessing={isExtracting}
            savedReceipts={savedReceipts}
            onReceiptSelect={handleReceiptSelect}
            onReceiptDelete={handleReceiptDelete}
            onReceiptFieldChange={handleReceiptFieldChange}
            onLineFieldChange={handleLineFieldChange}
            onClarificationSelect={handleClarificationSelect}
            onConfirm={handleConfirm}
            canConfirm={canConfirm}
            blockers={blockers}
            manualCorrectionFields={manualCorrectionFields}
            selectedClarifications={selectedClarifications}
            confirmState={confirmState}
          />
          {receipt?.pendingSync ? (
            <p role="status" aria-live="polite">
              {text.pendingSync}
            </p>
          ) : null}
          {uploadError ? (
            <p className="inline-error" role="alert">
              {uploadError}
            </p>
          ) : null}
        </section>
        <section
          id="purchase-panel-cash"
          role="tabpanel"
          aria-labelledby="purchase-tab-cash"
          hidden={activeEntry !== "cash"}
        >
          <CashPurchaseFlow
            locale={activeLocale}
            merchantId={merchant.id}
            summaryDate={summaryDate}
            catalog={componentCatalog}
            catalogUnavailable={componentCatalogUnavailable}
          />
        </section>
      </div>
    </div>
  );
}
