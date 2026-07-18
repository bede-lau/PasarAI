"use client";

import type { ChangeEvent } from "react";
import type { ReceiptExtraction } from "@pasarai/contracts/v1";
import { FileText, LoaderCircle, Trash2 } from "lucide-react";

import type { Locale, ReceiptReviewRecord } from "@/lib/dashboard-types";
import { getReceiptReviewMessages } from "@/lib/receipt-review-i18n";

type ReceiptLine = ReceiptExtraction["line_items"][number];
type ReceiptField = "supplier_name" | "date" | "total_rm";
type LineField =
  | "normalized_component_id"
  | "quantity"
  | "uom"
  | "pack_size"
  | "unit_price_rm"
  | "total_price_rm";

type ReceiptReviewProps = {
  locale: Locale;
  receipt?: ReceiptReviewRecord;
  onUpload: (file: File) => void;
  onReceiptFieldChange?: (field: ReceiptField, value: string) => void;
  onLineFieldChange?: (
    lineIndex: number,
    field: LineField,
    value: string
  ) => void;
  onClarificationSelect?: (
    ambiguity: ReceiptExtraction["ambiguities"][number],
    option: string
  ) => void;
  onConfirm?: () => void;
  canConfirm?: boolean;
  blockers?: readonly string[];
  manualCorrectionFields?: ReadonlySet<string>;
  selectedClarifications?: Readonly<Record<string, string>>;
  confirmState?: "idle" | "loading" | "success";
  isProcessing?: boolean;
  savedReceipts?: readonly ReceiptReviewRecord[];
  onReceiptSelect?: (receipt: ReceiptReviewRecord) => void;
  onReceiptDelete?: (receiptId: string) => void;
};

function ambiguityKey(
  ambiguity: ReceiptExtraction["ambiguities"][number]
) {
  return `${ambiguity.field}:${ambiguity.question}`;
}

function valueOrEmpty(value: string | null) {
  return value ?? "";
}

function fieldIsManual(
  manualCorrectionFields: ReadonlySet<string>,
  path: string
) {
  if (manualCorrectionFields.has(path)) return true;
  const linePath = path.match(/^(line_items\[\d+\])/u)?.[1];
  return linePath ? manualCorrectionFields.has(linePath) : false;
}

export function ReceiptReview({
  locale,
  receipt,
  onUpload,
  onReceiptFieldChange,
  onLineFieldChange,
  onClarificationSelect,
  onConfirm,
  canConfirm = false,
  blockers = [],
  manualCorrectionFields = new Set(),
  selectedClarifications = {},
  confirmState = "idle",
  isProcessing = false,
  savedReceipts = [],
  onReceiptSelect,
  onReceiptDelete
}: ReceiptReviewProps) {
  const text = getReceiptReviewMessages(locale);
  const editable = Boolean(
    onReceiptFieldChange
    && onLineFieldChange
    && !receipt?.confirmed
  );
  const displayTitle = (candidate: ReceiptReviewRecord) =>
    candidate.extraction.supplier_name
      ? `${candidate.extraction.supplier_name} ${text.receiptNoun}`
      : candidate.title;

  function handleUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) onUpload(file);
  }

  function lineInput(
    line: ReceiptLine,
    lineIndex: number,
    field: LineField,
    label: string,
    inputMode?: "decimal"
  ) {
    const path = `line_items[${lineIndex}].${field}`;
    return (
      <label
        className={fieldIsManual(manualCorrectionFields, path) ? "is-manual" : ""}
      >
        <span>{label}</span>
        <input
          aria-label={`${text.lineLabel(lineIndex + 1)} ${label.toLowerCase()}`}
          value={valueOrEmpty(line[field])}
          inputMode={inputMode}
          onChange={(event) =>
            onLineFieldChange?.(lineIndex, field, event.target.value)
          }
        />
      </label>
    );
  }

  return (
    <main className="receipt-review-shell">
      <header className="receipt-review-header">
        <p className="eyebrow">{text.eyebrow}</p>
        <h1>{text.title}</h1>
      </header>
      <label className="upload-dropzone">
        <span className="upload-mark" aria-hidden="true">
          +
        </span>
        <span>
          <strong>{text.upload}</strong>
          <small>{text.uploadHint}</small>
        </span>
        <input
          aria-label={text.upload}
          type="file"
          accept="image/jpeg,image/png"
          disabled={isProcessing}
          onChange={handleUpload}
        />
      </label>

      {isProcessing ? (
        <div className="receipt-processing" role="status" aria-live="polite">
          <LoaderCircle aria-hidden="true" />
          <span>
            <strong>{text.processingTitle}</strong>
            <small>{text.processingDescription}</small>
          </span>
        </div>
      ) : null}

      {savedReceipts.length ? (
        <section className="saved-receipts" aria-label={text.savedReceipts}>
          <header>
            <h2>{text.savedReceipts}</h2>
            <span>{text.savedCount(savedReceipts.length)}</span>
          </header>
          <div className="saved-receipt-list">
            {savedReceipts.map((savedReceipt) => {
              const savedTitle = displayTitle(savedReceipt);
              return (
                <article
                  className={`saved-receipt-item${
                    receipt?.id === savedReceipt.id ? " is-active" : ""
                  }`}
                  key={savedReceipt.id}
                >
                  <button
                    className="saved-receipt-select"
                    type="button"
                    aria-label={text.openLabel(savedTitle)}
                    aria-pressed={receipt?.id === savedReceipt.id}
                    onClick={() => onReceiptSelect?.(savedReceipt)}
                  >
                    <FileText aria-hidden="true" />
                    <span>
                      <strong>{savedTitle}</strong>
                      <small>
                        {savedReceipt.extraction.receipt_id || text.pending}
                        {" - "}
                        {savedReceipt.confirmed ? text.verified : text.pending}
                      </small>
                    </span>
                  </button>
                  {!savedReceipt.confirmed ? (
                    <button
                      className="saved-receipt-delete"
                      type="button"
                      aria-label={text.deleteLabel(savedTitle)}
                      title={text.deleteReceipt}
                      onClick={() => onReceiptDelete?.(savedReceipt.id)}
                    >
                      <Trash2 aria-hidden="true" />
                    </button>
                  ) : null}
                </article>
              );
            })}
          </div>
        </section>
      ) : null}

      {!receipt && !isProcessing ? (
        <p className="receipt-empty">{text.empty}</p>
      ) : null}

      {receipt ? (
        <section
          className="receipt-review-grid"
          aria-labelledby="receipt-review-heading"
        >
          <div className="receipt-review-summary">
            <p
              className={`review-status${
                receipt.confirmed
                  ? " is-verified"
                  : canConfirm
                    ? " is-ready"
                    : ""
              }`}
            >
              <span aria-hidden="true" />
              {receipt.confirmed
                ? text.verified
                : canConfirm
                  ? text.ready
                  : text.pending}
            </p>
            <h2 id="receipt-review-heading">
              {receipt.extraction.supplier_name || text.pending}
            </h2>
            <p>{receipt.extraction.receipt_id}</p>
            {editable ? (
              <div className="receipt-meta-editor">
                <label
                  className={
                    fieldIsManual(manualCorrectionFields, "supplier_name")
                      ? "is-manual"
                      : ""
                  }
                >
                  <span>{text.supplier}</span>
                  <input
                    aria-label={text.supplier}
                    value={valueOrEmpty(receipt.extraction.supplier_name)}
                    onChange={(event) =>
                      onReceiptFieldChange?.(
                        "supplier_name",
                        event.target.value
                      )
                    }
                  />
                </label>
                <label
                  className={
                    fieldIsManual(manualCorrectionFields, "date")
                      ? "is-manual"
                      : ""
                  }
                >
                  <span>{text.date}</span>
                  <input
                    aria-label={text.date}
                    type="date"
                    value={valueOrEmpty(receipt.extraction.date)}
                    onChange={(event) =>
                      onReceiptFieldChange?.("date", event.target.value)
                    }
                  />
                </label>
                <label
                  className={
                    fieldIsManual(manualCorrectionFields, "total_rm")
                      ? "is-manual"
                      : ""
                  }
                >
                  <span>{text.receiptTotal}</span>
                  <span className="receipt-money-input">
                    <i>RM</i>
                    <input
                      aria-label={text.receiptTotal}
                      inputMode="decimal"
                      value={valueOrEmpty(receipt.extraction.total_rm)}
                      onChange={(event) =>
                        onReceiptFieldChange?.("total_rm", event.target.value)
                      }
                    />
                  </span>
                </label>
              </div>
            ) : (
              <dl>
                <div>
                  <dt>{text.date}</dt>
                  <dd>{receipt.extraction.date}</dd>
                </div>
                <div>
                  <dt>{text.receiptTotal}</dt>
                  <dd>RM{receipt.extraction.total_rm}</dd>
                </div>
                <div>
                  <dt>{text.confidence}</dt>
                  <dd>
                    {Math.round(
                      Number(receipt.extraction.overall_confidence) * 100
                    )}
                    %
                  </dd>
                </div>
              </dl>
            )}
          </div>
          <figure className="receipt-review-image">
            <img
              src={receipt.imageUrl}
              alt={text.sourceAlt(displayTitle(receipt))}
            />
            <figcaption>{text.source}</figcaption>
          </figure>
          <div className="extraction-panel">
            <h3>{text.extracted}</h3>
            {receipt.extraction.line_items.map((line, lineIndex) => (
              <article
                className="extracted-line receipt-line-editor"
                key={`${lineIndex}-${line.raw_name}`}
              >
                <header>
                  <span>
                    <strong>{line.raw_name}</strong>
                    <small>
                      {Math.round(Number(line.confidence) * 100)}%{" "}
                      {text.confidence.toLowerCase()}
                    </small>
                  </span>
                </header>
                {editable ? (
                  <div className="receipt-line-fields">
                    {lineInput(
                      line,
                      lineIndex,
                      "normalized_component_id",
                      text.mapping
                    )}
                    {lineInput(
                      line,
                      lineIndex,
                      "quantity",
                      text.quantity,
                      "decimal"
                    )}
                    {lineInput(line, lineIndex, "uom", text.uom)}
                    {lineInput(
                      line,
                      lineIndex,
                      "pack_size",
                      text.packSize,
                      "decimal"
                    )}
                    {lineInput(
                      line,
                      lineIndex,
                      "unit_price_rm",
                      text.unitPrice,
                      "decimal"
                    )}
                    {lineInput(
                      line,
                      lineIndex,
                      "total_price_rm",
                      text.lineTotal,
                      "decimal"
                    )}
                  </div>
                ) : (
                  <strong>
                    {line.total_price_rm
                      ? `RM${line.total_price_rm}`
                      : text.pending}
                  </strong>
                )}
              </article>
            ))}
          </div>
          {receipt.confirmed ? (
            <section className="receipt-material-changes">
              <header>
                <div>
                  <p className="eyebrow">{text.verified}</p>
                  <h3>{text.materialChanges}</h3>
                </div>
                {receipt.verifiedAt ? (
                  <time dateTime={receipt.verifiedAt}>
                    {new Intl.DateTimeFormat(
                      locale === "zh" ? "zh-CN" : locale,
                      {
                        dateStyle: "medium",
                        timeStyle: "short"
                      }
                    ).format(new Date(receipt.verifiedAt))}
                  </time>
                ) : null}
              </header>
              <p>{text.materialChangesDescription}</p>
              {receipt.materialChanges?.length ? (
                <div className="receipt-material-change-list">
                  {receipt.materialChanges.map((change) => (
                    <article
                      key={`${change.productId ?? "product"}-${change.componentId}`}
                    >
                      <header>
                        <strong>{change.componentName}</strong>
                        <span>{change.componentId}</span>
                      </header>
                      <dl>
                        <div>
                          <dt>{text.purchase}</dt>
                          <dd>
                            {change.quantity} {change.uom} x {change.packSize}
                            {" - "}RM{change.totalPriceRm}
                          </dd>
                        </div>
                        <div>
                          <dt>{text.previousCost}</dt>
                          <dd>
                            {change.previousCostRmPerPack
                              ? `RM${change.previousCostRmPerPack}`
                              : text.notAvailable}
                          </dd>
                        </div>
                        <div>
                          <dt>{text.currentCost}</dt>
                          <dd>RM{change.currentCostRmPerPack}</dd>
                        </div>
                        <div>
                          <dt>{text.costChange}</dt>
                          <dd>
                            {change.changeRmPerPack
                              ? `${Number(change.changeRmPerPack) >= 0 ? "+" : ""}RM${change.changeRmPerPack}`
                              : text.notAvailable}
                          </dd>
                        </div>
                      </dl>
                    </article>
                  ))}
                </div>
              ) : (
                <p className="receipt-material-empty">
                  {text.noMaterialChanges}
                </p>
              )}
            </section>
          ) : null}
          {receipt.extraction.ambiguities.map((ambiguity) => {
            const key = ambiguityKey(ambiguity);
            const isManual = manualCorrectionFields.has(ambiguity.field);
            return (
              <section
                className="clarification-box"
                key={key}
                aria-label={ambiguity.question}
              >
                <h3>{ambiguity.question}</h3>
                <p>{isManual ? text.manualCorrection : text.commitWarning}</p>
                <div className="clarification-options">
                  {ambiguity.options.map((option) => (
                    <button
                      className={
                        selectedClarifications[key] === option
                          ? "is-selected"
                          : ""
                      }
                      key={option}
                      type="button"
                      aria-pressed={selectedClarifications[key] === option}
                      onClick={() =>
                        onClarificationSelect?.(ambiguity, option)
                      }
                    >
                      {option}
                    </button>
                  ))}
                  {!ambiguity.options.length ? (
                    <>
                      <button
                        type="button"
                        onClick={() =>
                          onClarificationSelect?.(ambiguity, "confirm")
                        }
                      >
                        {text.acceptValues}
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          onClarificationSelect?.(
                            ambiguity,
                            "Needs correction"
                          )
                        }
                      >
                        {text.needsCorrection}
                      </button>
                    </>
                  ) : null}
                </div>
              </section>
            );
          })}
          {onConfirm ? (
            <div className="receipt-confirm-panel">
              {!canConfirm && blockers.length ? (
                <div className="receipt-blockers" role="status">
                  <strong>{text.blockers}</strong>
                  <ul>
                    {blockers.map((blocker) => (
                      <li key={blocker}>{blocker}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <button
                className="simulation-button receipt-confirm-button"
                type="button"
                disabled={!canConfirm || confirmState !== "idle"}
                onClick={onConfirm}
              >
                {confirmState === "loading"
                  ? text.confirming
                  : confirmState === "success"
                    ? text.confirmed
                    : text.confirm}
              </button>
            </div>
          ) : null}
        </section>
      ) : null}
    </main>
  );
}
