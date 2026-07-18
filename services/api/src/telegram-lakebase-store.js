import { randomUUID } from "node:crypto";

import { createPersistentKey } from "./persistent-key.js";

export function createLakebaseTelegramEventStore({
  ledgerStore,
  merchantId,
  now = () => new Date().toISOString(),
  processingLeaseMs = 30_000,
}) {
  if (!ledgerStore?.appendEvent) {
    throw new Error("ledgerStore.appendEvent is required");
  }
  if (!merchantId) throw new Error("merchantId is required");
  const activeClaims = new Set();

  function assertMerchant(resolvedMerchantId) {
    if (resolvedMerchantId !== merchantId) {
      throw new Error("Telegram merchant does not match event store owner");
    }
  }

  async function appendStatus(updateId, changes) {
    const eventId = `telegram-status:${updateId}:${randomUUID()}`;
    await ledgerStore.appendEvent({
      eventId,
      externalId: null,
      endpointId: "telegram.status",
      idempotencyKey: eventId,
      type: "telegram_status",
      merchantId,
      occurredAt: now(),
      payload: {
        update_id: updateId,
        ...changes,
      },
      evidence: changes.evidence_uri
        ? { asset_uri: changes.evidence_uri }
        : {},
      response: { state: changes.state ?? "accepted" },
    });
    return { update_id: updateId, ...structuredClone(changes) };
  }

  async function appendConfirmation(confirmation) {
    const eventId =
      `telegram-confirmation:${confirmation.confirmation_id}:${randomUUID()}`;
    await ledgerStore.appendEvent({
      eventId,
      externalId: null,
      endpointId: "telegram.confirmation",
      idempotencyKey: eventId,
      type: "telegram_confirmation",
      merchantId,
      occurredAt: now(),
      payload: confirmation,
      evidence: confirmation.evidence_uri
        ? { asset_uri: confirmation.evidence_uri }
        : {},
      response: { state: confirmation.state },
    });
    return structuredClone(confirmation);
  }

  return {
    receiptStore: ledgerStore,

    async claimUpdate({
      updateId,
      merchantId: resolvedMerchantId,
      event,
      leaseMs = processingLeaseMs,
    }) {
      assertMerchant(resolvedMerchantId);
      const externalId = createPersistentKey(
        merchantId,
        "telegram_update",
        updateId,
      );
      const response = {
        state: "received",
        event_id: event.event_id,
        update_id: updateId,
      };
      const appended = await ledgerStore.appendEvent({
        eventId: event.event_id,
        externalId,
        endpointId: "telegram.update",
        idempotencyKey: String(updateId),
        type: "telegram_update",
        merchantId,
        occurredAt: now(),
        payload: event,
        evidence: {},
        response,
      });
      const storedEvent = appended.appended
        ? structuredClone(event)
        : {
            ...structuredClone(appended.event.payload),
            event_id: appended.event.eventId,
          };
      if (!appended.appended) {
        if (activeClaims.has(updateId)) {
          return { claimed: false, event: storedEvent };
        }
        const statuses = (await ledgerStore.listEvents({
          merchantId,
          type: "telegram_status",
        })).filter((candidate) => candidate.payload?.update_id === updateId);
        const latest = Object.assign(
          {},
          ...statuses.map((candidate) => candidate.payload),
        );
        const leaseExpiry = Date.parse(latest?.lease_expires_at ?? "");
        const retryable = latest?.processing_state === "retryable";
        const expired = latest?.processing_state === "processing"
          && leaseExpiry <= Date.parse(now());
        if (!retryable && !expired) {
          return { claimed: false, event: { ...storedEvent, ...latest } };
        }
      }

      activeClaims.add(updateId);
      const processing = {
        state: "processing",
        processing_state: "processing",
        lease_expires_at: new Date(
          Date.parse(now()) + leaseMs,
        ).toISOString(),
      };
      await appendStatus(updateId, processing);
      return {
        claimed: true,
        retried: !appended.appended,
        event: { ...storedEvent, ...processing },
      };
    },

    async updateEvent(updateId, changes) {
      if (changes.processing_state !== "processing") {
        activeClaims.delete(updateId);
      }
      return appendStatus(updateId, changes);
    },

    async appendReceipt({
      updateId,
      merchantId: resolvedMerchantId,
      occurredAt,
      fileName,
      contentType,
      evidenceUri,
      extraction,
      response,
    }) {
      assertMerchant(resolvedMerchantId);
      const appended = await ledgerStore.appendEvent({
        eventId: `telegram-receipt:${updateId}`,
        externalId: createPersistentKey(
          merchantId,
          "telegram_receipt",
          updateId,
        ),
        endpointId: "receipt-upload.create",
        idempotencyKey: `telegram:${updateId}:receipt`,
        type: "receipt",
        merchantId,
        occurredAt,
        payload: {
          merchant_id: merchantId,
          file_name: fileName,
          content_type: contentType,
          ...(extraction ? { extraction } : {}),
        },
        evidence: {
          ...(evidenceUri ? { asset_uri: evidenceUri } : {}),
          ...(extraction?.receipt_id
            ? { receipt_id: extraction.receipt_id }
            : {}),
        },
        response,
      });
      return appended.event;
    },

    async getPendingConfirmation({
      merchantId: resolvedMerchantId,
      conversationKey,
    }) {
      assertMerchant(resolvedMerchantId);
      const confirmations = (
        await ledgerStore.listEvents({
          merchantId,
          type: "telegram_confirmation",
        })
      ).filter(
        (event) => event.payload?.conversation_key === conversationKey,
      );
      const stateByConfirmation = new Map();
      for (const event of confirmations) {
        const candidate = event.payload;
        if (!candidate?.confirmation_id) continue;
        const existing = stateByConfirmation.get(candidate.confirmation_id);
        if (!existing || candidate.state !== "pending") {
          stateByConfirmation.set(candidate.confirmation_id, candidate);
        }
      }
      const pending = [...stateByConfirmation.values()]
        .filter((candidate) => candidate.state === "pending")
        .sort((left, right) =>
          Number(left.original_update_id ?? 0)
            - Number(right.original_update_id ?? 0)
        )
        .at(-1);
      return pending ? structuredClone(pending) : null;
    },

    async savePendingConfirmation({
      merchantId: resolvedMerchantId,
      conversationKey,
      confirmation,
    }) {
      assertMerchant(resolvedMerchantId);
      return appendConfirmation({
        ...structuredClone(confirmation),
        merchant_id: merchantId,
        conversation_key: conversationKey,
        state: "pending",
      });
    },

    async resolvePendingConfirmation({
      merchantId: resolvedMerchantId,
      conversationKey,
      confirmationId,
      state,
      resolutionUpdateId,
    }) {
      assertMerchant(resolvedMerchantId);
      const pending = await this.getPendingConfirmation({
        merchantId,
        conversationKey,
      });
      if (
        !pending
        || pending.confirmation_id !== confirmationId
      ) {
        return null;
      }
      return appendConfirmation({
        ...pending,
        state,
        resolution_update_id: resolutionUpdateId,
      });
    },
  };
}
