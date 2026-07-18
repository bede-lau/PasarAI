"use client";

import {
  useEffect,
  useRef,
  useState,
  type FormEvent
} from "react";
import type {
  ComponentCatalogResponse,
  CostsResponse,
  PurchaseIntakeConfirmRequest,
  PurchaseIntakeUpsertRequest,
  PurchaseIntakeUpsertResponse
} from "@pasarai/contracts/v1";
import {
  Check,
  LoaderCircle,
  Pencil,
  ShoppingBasket
} from "lucide-react";

import type { Locale } from "@/lib/dashboard-types";
import { getCashPurchaseMessages } from "@/lib/cash-purchase-i18n";
import {
  clearCashPurchaseRecovery,
  loadCashPurchaseRecovery,
  saveCashPurchaseRecovery,
  type CashPurchaseDraft
} from "@/lib/cash-purchase-storage";
import {
  confirmPurchaseIntake,
  postPurchaseIntake
} from "@/lib/purchase-intake";

type Draft = CashPurchaseDraft;

type CashPurchaseFlowProps = {
  locale: Locale;
  merchantId: string;
  summaryDate: string;
  catalog: ComponentCatalogResponse;
  catalogUnavailable?: boolean;
  upsertPurchase?: (
    request: PurchaseIntakeUpsertRequest,
    idempotencyKey: string
  ) => Promise<PurchaseIntakeUpsertResponse>;
  confirmPurchase?: (
    request: PurchaseIntakeConfirmRequest,
    idempotencyKey: string
  ) => Promise<CostsResponse>;
};

const POSITIVE_NUMBER = /^(?:0\.(?:0*[1-9][0-9]*)|[1-9][0-9]*(?:\.[0-9]+)?)$/u;
const MONEY = /^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,2})?$/u;

function purchaseDateTime(date: string) {
  return new Date(`${date}T12:00:00+08:00`).toISOString();
}

function formatMoney(value: string) {
  return Number(value).toFixed(2);
}

function initialDraft(summaryDate: string): Draft {
  return {
    componentId: "",
    supplier: "",
    quantity: "",
    uom: "",
    packSize: "",
    totalPaid: "",
    date: summaryDate,
    note: ""
  };
}

function sameDraft(left: Draft, right: Draft) {
  return Object.keys(left).every(
    (field) => left[field as keyof Draft] === right[field as keyof Draft]
  );
}

export function CashPurchaseFlow({
  locale,
  merchantId,
  summaryDate,
  catalog,
  catalogUnavailable = false,
  upsertPurchase = postPurchaseIntake,
  confirmPurchase = confirmPurchaseIntake
}: CashPurchaseFlowProps) {
  const text = getCashPurchaseMessages(locale);
  const [draft, setDraft] = useState<Draft>(() => initialDraft(summaryDate));
  const [reviewedDraft, setReviewedDraft] = useState<Draft | null>(null);
  const [review, setReview] = useState<PurchaseIntakeUpsertResponse | null>(
    null
  );
  const [upsertKey, setUpsertKey] = useState(() => crypto.randomUUID());
  const [confirmKey, setConfirmKey] = useState(() => crypto.randomUUID());
  const [rotateUpsertKeyOnEdit, setRotateUpsertKeyOnEdit] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [started, setStarted] = useState(false);
  const [state, setState] = useState<
    "entry" | "saving" | "review" | "confirming" | "success"
  >("entry");
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<
    Partial<Record<keyof Draft, string>>
  >({});
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const successHeading = useRef<HTMLHeadingElement>(null);
  const committed = useRef(false);
  const initializedMerchant = useRef<string | null>(null);

  useEffect(() => {
    const stored = loadCashPurchaseRecovery(window.localStorage, merchantId);
    if (stored) {
      setDraft(stored.draft);
      setReviewedDraft(stored.reviewedDraft);
      setReview(stored.review);
      setUpsertKey(stored.upsertKey);
      setConfirmKey(stored.confirmKey);
      setRotateUpsertKeyOnEdit(stored.rotateUpsertKeyOnEdit);
      setState(stored.phase);
      setStarted(true);
    } else {
      setDraft(initialDraft(summaryDate));
      setReviewedDraft(null);
      setReview(null);
      setUpsertKey(crypto.randomUUID());
      setConfirmKey(crypto.randomUUID());
      setRotateUpsertKeyOnEdit(false);
      setState("entry");
      setStarted(false);
    }
    initializedMerchant.current = merchantId;
    setHydrated(true);
  }, [merchantId, summaryDate]);

  useEffect(() => {
    if (
      !hydrated
      || !started
      || initializedMerchant.current !== merchantId
      || committed.current
      || state === "success"
    ) return;
    saveCashPurchaseRecovery(window.localStorage, merchantId, {
      draft,
      reviewedDraft,
      review,
      upsertKey,
      confirmKey,
      phase: state === "review" || state === "confirming" ? "review" : "entry",
      rotateUpsertKeyOnEdit
    });
  }, [
    confirmKey,
    draft,
    hydrated,
    merchantId,
    review,
    reviewedDraft,
    rotateUpsertKeyOnEdit,
    started,
    state,
    upsertKey
  ]);

  function updateField(field: keyof Draft, value: string) {
    if (draft[field] === value) return;
    setStarted(true);
    if (rotateUpsertKeyOnEdit) {
      setUpsertKey(crypto.randomUUID());
      setRotateUpsertKeyOnEdit(false);
    }
    setDraft((current) => ({ ...current, [field]: value }));
    setFieldErrors((current) => ({ ...current, [field]: undefined }));
    setError(null);
  }

  function validateDraft() {
    const errors: Partial<Record<keyof Draft, string>> = {};
    for (const field of [
      "componentId",
      "supplier",
      "quantity",
      "uom",
      "packSize",
      "totalPaid",
      "date"
    ] as const) {
      if (!draft[field].trim()) errors[field] = text.required;
    }
    for (const field of ["quantity", "packSize"] as const) {
      if (draft[field] && !POSITIVE_NUMBER.test(draft[field].trim())) {
        errors[field] = text.positiveNumber;
      }
    }
    if (draft.totalPaid && !MONEY.test(draft.totalPaid.trim())) {
      errors.totalPaid = text.money;
    }
    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  }

  async function handleReview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!validateDraft()) return;
    if (
      review?.confirmation_token
      && reviewedDraft
      && sameDraft(draft, reviewedDraft)
    ) {
      setState("review");
      requestAnimationFrame(() => reviewHeading.current?.focus());
      return;
    }
    setError(null);
    setState("saving");
    const selectedComponent = catalog.components.find(
      (component) => component.component_id === draft.componentId
    );
    const request: PurchaseIntakeUpsertRequest = {
      merchant_id: merchantId,
      ...(review
        ? {
            intake_id: review.intake_id,
            expected_version: review.version
          }
        : {}),
      occurred_at: purchaseDateTime(draft.date),
      source: "web_manual",
      source_language: locale,
      supplier_name: draft.supplier.trim(),
      metadata: {
        payment_method: "cash",
        note: draft.note.trim() || null
      },
      item: {
        component_id: draft.componentId,
        raw_name: selectedComponent?.name,
        quantity: draft.quantity.trim(),
        uom: draft.uom.trim(),
        pack_size: draft.packSize.trim(),
        total_price_rm: formatMoney(draft.totalPaid)
      },
      evidence: {
        transcript: text.cashWithoutReceipt
      }
    };

    try {
      saveCashPurchaseRecovery(window.localStorage, merchantId, {
        draft,
        reviewedDraft,
        review,
        upsertKey,
        confirmKey,
        phase: "entry",
        rotateUpsertKeyOnEdit
      });
      const result = await upsertPurchase(request, upsertKey);
      const nextConfirmKey = crypto.randomUUID();
      setReview(result);
      setReviewedDraft(draft);
      setConfirmKey(nextConfirmKey);
      setRotateUpsertKeyOnEdit(true);
      const reviewIncomplete =
        result.state !== "ready_for_confirmation"
        || !result.confirmation_token;
      saveCashPurchaseRecovery(window.localStorage, merchantId, {
        draft,
        reviewedDraft: draft,
        review: result,
        upsertKey,
        confirmKey: nextConfirmKey,
        phase: reviewIncomplete ? "entry" : "review",
        rotateUpsertKeyOnEdit: true
      });
      if (reviewIncomplete) {
        setState("entry");
        setError(text.incompleteReview);
        return;
      }
      setState("review");
      requestAnimationFrame(() => reviewHeading.current?.focus());
    } catch {
      setRotateUpsertKeyOnEdit(true);
      saveCashPurchaseRecovery(window.localStorage, merchantId, {
        draft,
        reviewedDraft,
        review,
        upsertKey,
        confirmKey,
        phase: "entry",
        rotateUpsertKeyOnEdit: true
      });
      setState("entry");
      setError(text.saveError);
    }
  }

  async function handleConfirm() {
    if (!review?.confirmation_token) return;
    setError(null);
    setState("confirming");
    try {
      saveCashPurchaseRecovery(window.localStorage, merchantId, {
        draft,
        reviewedDraft,
        review,
        upsertKey,
        confirmKey,
        phase: "review",
        rotateUpsertKeyOnEdit
      });
      const result = await confirmPurchase(
        {
          merchant_id: merchantId,
          intake_id: review.intake_id,
          expected_version: review.version,
          confirmation_token: review.confirmation_token
        },
        confirmKey
      );
      if (result.state !== "committed") {
        setState("review");
        setError(
          result.state === "rejected" ? text.rejected : text.confirmError
        );
        return;
      }
      committed.current = true;
      clearCashPurchaseRecovery(window.localStorage, merchantId);
      setState("success");
      requestAnimationFrame(() => successHeading.current?.focus());
    } catch {
      setState("review");
      setError(text.confirmError);
    }
  }

  const dashboardParams = new URLSearchParams({
    lang: locale,
    date: draft.date
  });
  const catalogEmpty =
    !catalogUnavailable && catalog.components.length === 0;

  if (state === "success" && review) {
    return (
      <section className="cash-purchase-success" aria-live="polite">
        <Check aria-hidden="true" />
        <p className="eyebrow">{text.cashWithoutReceipt}</p>
        <h1 ref={successHeading} tabIndex={-1}>
          {text.successTitle}
        </h1>
        <p>{text.successDescription}</p>
        <a
          className="cash-primary-action"
          href={`/?${dashboardParams.toString()}`}
        >
          {text.backToDashboard}
        </a>
      </section>
    );
  }

  if ((state === "review" || state === "confirming") && review) {
    const summary = review.summary;
    return (
      <section className="cash-review" aria-live="polite">
        <p className="eyebrow">{text.cashWithoutReceipt}</p>
        <h1 ref={reviewHeading} tabIndex={-1}>
          {text.reviewTitle}
        </h1>
        <p>{text.reviewDescription}</p>
        <dl className="cash-review-summary">
          <div>
            <dt>{text.itemSummary}</dt>
            <dd>{summary.item_name}</dd>
          </div>
          <div>
            <dt>{text.supplierSummary}</dt>
            <dd>{summary.supplier_name}</dd>
          </div>
          <div>
            <dt>{text.quantitySummary}</dt>
            <dd>{summary.quantity} {summary.uom}</dd>
          </div>
          <div>
            <dt>{text.packSizeSummary}</dt>
            <dd>{summary.pack_size}</dd>
          </div>
          <div>
            <dt>{text.totalSummary}</dt>
            <dd>RM{summary.total_price_rm}</dd>
          </div>
          <div>
            <dt>{text.dateSummary}</dt>
            <dd>{summary.occurred_at.slice(0, 10)}</dd>
          </div>
          <div>
            <dt>{text.paymentMethod}</dt>
            <dd>{text.cash}</dd>
          </div>
          {summary.note ? (
            <div>
              <dt>{text.noteSummary}</dt>
              <dd>{summary.note}</dd>
            </div>
          ) : null}
        </dl>
        {error ? (
          <p className="inline-error" role="alert">{error}</p>
        ) : null}
        <div className="cash-review-actions">
          <button
            className="cash-secondary-action"
            type="button"
            disabled={state === "confirming"}
            onClick={() => setState("entry")}
          >
            <Pencil aria-hidden="true" />
            {text.edit}
          </button>
          <button
            className="cash-primary-action"
            type="button"
            disabled={state === "confirming"}
            onClick={handleConfirm}
          >
            {state === "confirming" ? (
              <LoaderCircle className="is-spinning" aria-hidden="true" />
            ) : (
              <Check aria-hidden="true" />
            )}
            {state === "confirming" ? text.confirming : text.confirm}
          </button>
        </div>
      </section>
    );
  }

  return (
    <main className="cash-purchase-shell">
      <header className="cash-purchase-header">
        <ShoppingBasket aria-hidden="true" />
        <div>
          <p className="eyebrow">{text.eyebrow}</p>
          <h1>{text.title}</h1>
          <p>{text.description}</p>
        </div>
      </header>
      {catalogUnavailable ? (
        <p className="cash-catalog-error" role="alert">
          {text.catalogUnavailable}
        </p>
      ) : null}
      {catalogEmpty ? (
        <section className="cash-catalog-empty" role="status">
          <h2>{text.catalogEmptyTitle}</h2>
          <p>{text.catalogEmptyDescription}</p>
        </section>
      ) : null}
      {catalogEmpty ? null : (
        <form className="cash-purchase-form" noValidate onSubmit={handleReview}>
        <label>
          <span>{text.component}</span>
          <select
            aria-describedby={
              fieldErrors.componentId ? "cash-component-error" : undefined
            }
            aria-invalid={Boolean(fieldErrors.componentId)}
            value={draft.componentId}
            disabled={catalog.components.length === 0}
            onChange={(event) => updateField("componentId", event.target.value)}
          >
            <option value="">{text.componentPlaceholder}</option>
            {catalog.components.map((component) => (
              <option key={component.component_id} value={component.component_id}>
                {component.name}
              </option>
            ))}
          </select>
          {fieldErrors.componentId ? (
            <small id="cash-component-error">{fieldErrors.componentId}</small>
          ) : null}
        </label>
        <label>
          <span>{text.supplier}</span>
          <input
            aria-describedby={
              fieldErrors.supplier ? "cash-supplier-error" : undefined
            }
            aria-invalid={Boolean(fieldErrors.supplier)}
            value={draft.supplier}
            onChange={(event) => updateField("supplier", event.target.value)}
          />
          {fieldErrors.supplier ? (
            <small id="cash-supplier-error">{fieldErrors.supplier}</small>
          ) : null}
        </label>
        <div className="cash-form-row">
          <label>
            <span>{text.quantity}</span>
            <input
              inputMode="decimal"
              aria-describedby={
                fieldErrors.quantity ? "cash-quantity-error" : undefined
              }
              aria-invalid={Boolean(fieldErrors.quantity)}
              value={draft.quantity}
              onChange={(event) => updateField("quantity", event.target.value)}
            />
            {fieldErrors.quantity ? (
              <small id="cash-quantity-error">{fieldErrors.quantity}</small>
            ) : null}
          </label>
          <label>
            <span>{text.purchaseUnit}</span>
            <input
              aria-describedby={
                fieldErrors.uom ? "cash-uom-error" : undefined
              }
              aria-invalid={Boolean(fieldErrors.uom)}
              value={draft.uom}
              onChange={(event) => updateField("uom", event.target.value)}
            />
            {fieldErrors.uom ? (
              <small id="cash-uom-error">{fieldErrors.uom}</small>
            ) : null}
          </label>
        </div>
        <div className="cash-form-row">
          <label>
            <span>{text.packSize}</span>
            <input
              inputMode="decimal"
              aria-describedby={
                fieldErrors.packSize ? "cash-pack-size-error" : undefined
              }
              aria-invalid={Boolean(fieldErrors.packSize)}
              value={draft.packSize}
              onChange={(event) => updateField("packSize", event.target.value)}
            />
            {fieldErrors.packSize ? (
              <small id="cash-pack-size-error">{fieldErrors.packSize}</small>
            ) : null}
          </label>
          <label>
            <span>{text.totalPaid}</span>
            <span className="cash-money-input">
              <i>RM</i>
              <input
                inputMode="decimal"
                aria-label={text.totalPaid}
                aria-describedby={
                  fieldErrors.totalPaid ? "cash-total-error" : undefined
                }
                aria-invalid={Boolean(fieldErrors.totalPaid)}
                value={draft.totalPaid}
                onChange={(event) =>
                  updateField("totalPaid", event.target.value)
                }
              />
            </span>
            {fieldErrors.totalPaid ? (
              <small id="cash-total-error">{fieldErrors.totalPaid}</small>
            ) : null}
          </label>
        </div>
        <label>
          <span>{text.date}</span>
          <input
            type="date"
            aria-describedby={
              fieldErrors.date ? "cash-date-error" : undefined
            }
            aria-invalid={Boolean(fieldErrors.date)}
            value={draft.date}
            onChange={(event) => updateField("date", event.target.value)}
          />
          {fieldErrors.date ? (
            <small id="cash-date-error">{fieldErrors.date}</small>
          ) : null}
        </label>
        <label>
          <span>{text.note} <em>{text.optional}</em></span>
          <textarea
            rows={3}
            aria-label={text.note}
            value={draft.note}
            onChange={(event) => updateField("note", event.target.value)}
          />
        </label>
        {error ? (
          <p className="inline-error" role="alert">{error}</p>
        ) : null}
        <button
          className="cash-primary-action"
          type="submit"
          disabled={state === "saving" || catalog.components.length === 0}
        >
          {state === "saving" ? (
            <LoaderCircle className="is-spinning" aria-hidden="true" />
          ) : (
            <ShoppingBasket aria-hidden="true" />
          )}
          {state === "saving" ? text.reviewing : text.review}
        </button>
        </form>
      )}
    </main>
  );
}
