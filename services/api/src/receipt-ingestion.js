import { createHash } from "node:crypto";

import {
  validateContract,
  validateEndpointInvocation,
} from "@pasarai/contracts/v1";

import { createPersistentKey } from "./persistent-key.js";

function moneyToCents(value) {
  if (value === null) return null;
  const match = /^(0|[1-9][0-9]*)\.([0-9]{2})$/.exec(value);
  if (!match) throw new Error(`Invalid MYR amount: ${value}`);
  return BigInt(match[1]) * 100n + BigInt(match[2]);
}

function isJpeg(bytes) {
  const buffer = Buffer.from(bytes);
  return buffer.length >= 4
    && buffer[0] === 0xff
    && buffer[1] === 0xd8
    && buffer.at(-2) === 0xff
    && buffer.at(-1) === 0xd9;
}

function isPng(bytes) {
  const signature = Buffer.from(bytes).subarray(0, 8);
  return signature.equals(Buffer.from("89504e470d0a1a0a", "hex"));
}

export function validateReceiptImage({ bytes, contentType }) {
  if (!Buffer.from(bytes).length) return "empty_image";
  if (Buffer.from(bytes).length > 20 * 1024 * 1024) return "image_too_large";
  if (contentType === "image/jpeg" && isJpeg(bytes)) return null;
  if (contentType === "image/png" && isPng(bytes)) return null;
  return "invalid_receipt_image";
}

export function receiptDecision(extraction) {
  const contractErrors = validateContract("receipt-extraction", extraction);
  if (contractErrors.length) {
    return {
      state: "review_required",
      reason: "invalid_provider_payload",
      errors: contractErrors,
    };
  }

  const lineTotal = extraction.line_items.reduce(
    (total, line) => total + (moneyToCents(line.total_price_rm) ?? 0n),
    0n,
  );
  const receiptTotal = moneyToCents(extraction.total_rm);
  if (receiptTotal !== null) {
    const mismatch = lineTotal >= receiptTotal
      ? lineTotal - receiptTotal
      : receiptTotal - lineTotal;
    if (mismatch > 5n) {
      return {
        state: "rejected",
        reason: "receipt_total_mismatch",
        mismatch_rm:
          `${mismatch / 100n}.${String(mismatch % 100n).padStart(2, "0")}`,
      };
    }
  }

  if (Number(extraction.overall_confidence) < 0.85) {
    return {
      state: "review_required",
      reason: "low_overall_confidence",
      clarifications: extraction.ambiguities,
    };
  }

  const clarifications = [...extraction.ambiguities];
  extraction.line_items.forEach((line, index) => {
    const hasFinancialValue = [
      line.quantity,
      line.pack_size,
      line.unit_price_rm,
      line.total_price_rm,
    ].some((value) => value !== null);
    if (hasFinancialValue && Number(line.confidence) < 0.9) {
      clarifications.push({
        field: `line_items[${index}]`,
        question:
          `Please confirm the quantity and price for ${line.raw_name}.`,
        options: [],
      });
    }

    if (
      line.normalized_component_id !== null
      && line.pack_size === null
      && ["bundle", "pack", "tray", "tin"].includes(line.uom?.toLowerCase())
    ) {
      clarifications.push({
        field: `line_items[${index}].pack_size`,
        question:
          `How many base units are in one ${line.uom} of ${line.raw_name}?`,
        options: [],
      });
    }
  });

  return clarifications.length
    ? { state: "clarification_required", clarifications }
    : { state: "ready_for_commit" };
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

function decodeBase64(value) {
  if (
    typeof value !== "string"
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    throw new TypeError("content_base64 must be valid base64");
  }
  return Buffer.from(value, "base64");
}

function conflictEventId(idempotencyKey) {
  return `receipt-conflict-${createHash("sha256")
    .update(idempotencyKey)
    .digest("hex")
    .slice(0, 16)}`;
}

function rejectedResponse(eventId, reason, extra = {}) {
  return {
    state: "rejected",
    event_id: eventId,
    reason,
    ...extra,
  };
}

function validateResponse(response) {
  const errors = validateContract("receipt-upload.response", response);
  if (errors.length) {
    throw new Error(`Invalid receipt upload response: ${errors.join("; ")}`);
  }
  return response;
}

export function createReceiptUploadIngestion({
  store,
  evidenceStore,
  receiptExtractor,
  idFactory = () => crypto.randomUUID(),
}) {
  if (!store?.runIdempotent || !store?.appendEvent) {
    throw new Error("A durable receipt event store is required");
  }
  if (!evidenceStore?.put) throw new Error("evidenceStore.put is required");
  if (!receiptExtractor?.extract) {
    throw new Error("receiptExtractor.extract is required");
  }

  return {
    async extract(request, { idempotencyKey } = {}) {
      const errors = validateEndpointInvocation({
        endpoint_id: "receipt-upload.create",
        headers: { "Idempotency-Key": idempotencyKey ?? "" },
        payload: request,
      });
      if (errors.length) {
        return validateResponse(rejectedResponse(
          conflictEventId(idempotencyKey ?? "missing"),
          "invalid_request",
          { errors },
        ));
      }

      const result = await store.runIdempotent({
        merchantId: request.merchant_id,
        endpointId: "receipt-upload.create",
        key: idempotencyKey,
        fingerprint: fingerprint(request),
        execute: async () => {
          const eventId = idFactory("receipt");
          const bytes = decodeBase64(request.content_base64);
          const imageError = validateReceiptImage({
            bytes,
            contentType: request.content_type,
          });
          if (imageError) {
            const response = validateResponse(
              rejectedResponse(eventId, imageError),
            );
            await store.appendEvent({
              eventId,
              endpointId: "receipt-upload.create",
              externalId: createPersistentKey(
                request.merchant_id,
                "web_upload",
                idempotencyKey,
              ),
              type: "receipt",
              merchantId: request.merchant_id,
              occurredAt: request.occurred_at,
              payload: {
                merchant_id: request.merchant_id,
                file_name: request.file_name,
                content_type: request.content_type,
              },
              evidence: {},
              response,
            });
            return response;
          }

          const extension =
            request.content_type === "image/png" ? "png" : "jpg";
          const stored = await evidenceStore.put({
            key: `web/${request.merchant_id}/${eventId}/receipt.${extension}`,
            bytes,
            contentType: request.content_type,
          });

          let extraction;
          try {
            extraction = await receiptExtractor.extract({
              bytes,
              contentType: request.content_type,
              evidenceUri: stored.uri,
            });
          } catch {
            const response = validateResponse({
              state: "review_required",
              event_id: eventId,
              evidence_uri: stored.uri,
              reason: "receipt_provider_unavailable",
            });
            await store.appendEvent({
              eventId,
              endpointId: "receipt-upload.create",
              externalId: createPersistentKey(
                request.merchant_id,
                "web_upload",
                idempotencyKey,
              ),
              type: "receipt",
              merchantId: request.merchant_id,
              occurredAt: request.occurred_at,
              payload: {
                merchant_id: request.merchant_id,
                file_name: request.file_name,
                content_type: request.content_type,
              },
              evidence: { asset_uri: stored.uri },
              response,
            });
            return response;
          }

          const decision = receiptDecision(extraction);
          const state = decision.state === "ready_for_commit"
            ? "ready_for_review"
            : decision.state;
          const response = validateResponse({
            ...decision,
            state,
            event_id: eventId,
            evidence_uri: stored.uri,
            extraction,
          });
          await store.appendEvent({
            eventId,
            endpointId: "receipt-upload.create",
            externalId: createPersistentKey(
              request.merchant_id,
              "web_upload",
              idempotencyKey,
            ),
            type: "receipt",
            merchantId: request.merchant_id,
            occurredAt: request.occurred_at,
            payload: {
              merchant_id: request.merchant_id,
              file_name: request.file_name,
              content_type: request.content_type,
              extraction,
            },
            evidence: {
              asset_uri: stored.uri,
              receipt_id: extraction.receipt_id ?? undefined,
            },
            response,
          });
          return response;
        },
      });

      if (result.conflict) {
        return validateResponse(rejectedResponse(
          conflictEventId(idempotencyKey),
          "idempotency_conflict",
        ));
      }
      return result.response;
    },
  };
}
