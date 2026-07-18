"""Append-only Lakebase repository with a dependency-free test double."""

from __future__ import annotations

import hashlib
import json
from copy import deepcopy
from typing import Any


class InMemoryLakebaseRepository:
    """Behavioral test double for Lakebase idempotency and append-only semantics."""

    def __init__(self) -> None:
        self._events: list[dict[str, Any]] = []
        self._idempotency_index: dict[
            tuple[str, str, str],
            tuple[str, str],
        ] = {}

    def append_raw_event(
        self,
        *,
        merchant_id: str,
        endpoint_id: str,
        idempotency_key: str,
        payload: dict[str, Any],
    ) -> str:
        key = (merchant_id, endpoint_id, idempotency_key)
        fingerprint = json.dumps(payload, separators=(",", ":"), sort_keys=True)
        existing = self._idempotency_index.get(key)
        if existing is not None:
            event_id, existing_fingerprint = existing
            if existing_fingerprint != fingerprint:
                raise ValueError(
                    "Idempotency key was already used with a different payload"
                )
            return event_id

        digest = hashlib.sha256(
            f"{merchant_id}:{endpoint_id}:{idempotency_key}".encode("utf-8")
        ).hexdigest()
        event_id = f"evt_{digest[:24]}"
        self._events.append(
            {
                "event_id": event_id,
                "merchant_id": merchant_id,
                "endpoint_id": endpoint_id,
                "idempotency_key": idempotency_key,
                "payload": deepcopy(payload),
            }
        )
        self._idempotency_index[key] = (event_id, fingerprint)
        return event_id

    def append_correction(
        self,
        *,
        merchant_id: str,
        idempotency_key: str,
        target_event_id: str,
        occurred_at: str,
        reason: str,
        replacement_payload: dict[str, Any],
        evidence: dict[str, Any],
    ) -> str:
        if not any(event["event_id"] == target_event_id for event in self._events):
            raise KeyError(f"Unknown correction target: {target_event_id}")
        return self.append_raw_event(
            merchant_id=merchant_id,
            endpoint_id="corrections.create",
            idempotency_key=idempotency_key,
            payload={
                "type": "correction",
                "target_event_id": target_event_id,
                "occurred_at": occurred_at,
                "reason": reason,
                "replacement_payload": deepcopy(replacement_payload),
                "evidence": deepcopy(evidence),
            },
        )

    def events(self) -> list[dict[str, Any]]:
        return deepcopy(self._events)


class SqlLakebaseRepository:
    """Thin DB-API adapter over idempotent Postgres repository functions."""

    def __init__(self, connection: Any) -> None:
        self._connection = connection

    def append_raw_event(
        self,
        *,
        merchant_id: str,
        endpoint_id: str,
        idempotency_key: str,
        event_type: str,
        occurred_at: str,
        source: str,
        source_language: str | None,
        payload: dict[str, Any],
        evidence: dict[str, Any],
    ) -> str:
        with self._connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT pasarai_append_raw_event(
                    %s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s::jsonb
                )
                """,
                (
                    merchant_id,
                    endpoint_id,
                    idempotency_key,
                    event_type,
                    occurred_at,
                    source,
                    source_language,
                    json.dumps(payload, separators=(",", ":"), sort_keys=True),
                    json.dumps(evidence, separators=(",", ":"), sort_keys=True),
                ),
            )
            event_id = cursor.fetchone()[0]
        self._connection.commit()
        return str(event_id)

    def append_correction(
        self,
        *,
        merchant_id: str,
        idempotency_key: str,
        target_event_id: str,
        occurred_at: str,
        reason: str,
        replacement_payload: dict[str, Any],
        evidence: dict[str, Any],
    ) -> str:
        with self._connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT pasarai_append_correction(
                    %s, %s, %s, %s, %s, %s::jsonb, %s::jsonb
                )
                """,
                (
                    merchant_id,
                    idempotency_key,
                    target_event_id,
                    occurred_at,
                    reason,
                    json.dumps(replacement_payload, separators=(",", ":"), sort_keys=True),
                    json.dumps(evidence, separators=(",", ":"), sort_keys=True),
                ),
            )
            event_id = cursor.fetchone()[0]
        self._connection.commit()
        return str(event_id)
