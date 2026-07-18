// Generated from canonical JSON Schemas. Do not edit manually.
export type AnalyticsActivityResponse = {
  readonly "merchant_id": Identifier;
  readonly "product_id": Identifier;
  readonly "from": Date;
  readonly "to": Date;
  readonly "items": ReadonlyArray<{
    readonly "event_id": Identifier;
    readonly "occurred_at": DateTime;
    readonly "source": string;
    readonly "type": string;
    readonly "state": "committed" | "clarification_required" | "rejected" | "recorded";
    readonly "title": string;
    readonly "evidence_uri": string | null;
    readonly "target_event_id": Identifier | null;
  }>;
};

export type AnalyticsDayStatusRequest = {
  readonly "merchant_id": Identifier;
  readonly "product_id": Identifier;
  readonly "date": Date;
  readonly "occurred_at": DateTime;
  readonly "business_day_state": "closed_complete" | "closed_no_sales";
  readonly "sold_out_state": "yes" | "no" | "unknown";
};

export type AnalyticsDayStatusResponse = {
  readonly "state": "committed";
  readonly "event_id": Identifier;
  readonly "date": Date;
  readonly "business_day_state": "closed_complete" | "closed_no_sales";
  readonly "sold_out_state": "yes" | "no" | "unknown";
};

export type AnalyticsForecastResponse = {
  readonly "merchant_id": Identifier;
  readonly "product_id": Identifier;
  readonly "as_of": Date;
  readonly "status": "unavailable" | "shadow" | "ready";
  readonly "generated_at": DateTime;
  readonly "data_through": Date | null;
  readonly "model_version": string | null;
  readonly "reasons": ReadonlyArray<string>;
  readonly "training_days": number;
  readonly "diagnostics": {
    readonly "model_name": string;
    readonly "mae": NonNegativeDecimalString;
    readonly "wape_pct": NonNegativeDecimalString;
    readonly "prediction_interval_coverage_pct": NonNegativeDecimalString | null;
    readonly "backtest_windows": number;
    readonly "accuracy_state": "pass" | "fail" | "insufficient";
  } | null;
  readonly "forecast": {
    readonly "date": Date;
    readonly "p10": NonNegativeDecimalString;
    readonly "p50": NonNegativeDecimalString;
    readonly "p90": NonNegativeDecimalString;
    readonly "planning_note": string;
  } | null;
};

export type AnalyticsOverviewResponse = {
  readonly "merchant_id": Identifier;
  readonly "product_id": Identifier;
  readonly "from": Date;
  readonly "to": Date;
  readonly "generated_at": DateTime;
  readonly "data_through": Date | null;
  readonly "freshness": {
    readonly "state": "fresh" | "stale" | "unavailable";
    readonly "lag_seconds": number;
    readonly "source_max_ingested_at": DateTime | null;
    readonly "projection_version": string;
  };
  readonly "completeness_coverage_pct": DecimalString;
  readonly "quality_flags": ReadonlyArray<string>;
  readonly "days": ReadonlyArray<{
    readonly "date": Date;
    readonly "state": "complete" | "partial" | "closed_no_sales" | "missing";
    readonly "quantity": NonNegativeDecimalString | null;
    readonly "revenue_rm": MyrAmount | null;
    readonly "cogs_rm": MyrAmount | null;
    readonly "gross_profit_rm": MyrAmount | null;
    readonly "gross_margin_pct": DecimalString | null;
    readonly "sold_out_state": "yes" | "no" | "unknown";
  }>;
  readonly "alerts": ReadonlyArray<{
    readonly "id": Identifier;
    readonly "severity": "info" | "warning" | "critical";
    readonly "title": string;
    readonly "message": string;
    readonly "metric": Identifier;
    readonly "threshold": string | null;
    readonly "evidence_id": Identifier | null;
    readonly "action": "record_sales" | "review_receipt" | "resolve_clarification" | "inspect_cost" | "none";
  }>;
  readonly "cost_waterfall": {
    readonly "baseline_date": Date | null;
    readonly "baseline_unit_cogs_rm": NonNegativeMyrAmount;
    readonly "current_unit_cogs_rm": NonNegativeMyrAmount;
    readonly "components": ReadonlyArray<{
      readonly "component_id": Identifier;
      readonly "name": string;
      readonly "baseline_cost_rm_per_pack": NonNegativeMyrAmount;
      readonly "current_cost_rm_per_pack": NonNegativeMyrAmount;
      readonly "change_rm_per_pack": MyrAmount;
      readonly "evidence_id": Identifier | null;
    }>;
  } | null;
};

export type ComponentCatalogResponse = {
  readonly "merchant_id": Identifier;
  readonly "components": ReadonlyArray<{
    readonly "component_id": Identifier;
    readonly "name": string;
  }>;
};

export type CorrectionRequest = {
  readonly "merchant_id": Identifier;
  readonly "target_event_id": Identifier;
  readonly "occurred_at": DateTime;
  readonly "reason": string;
  readonly "replacement_payload": {
    readonly "changes": ReadonlyArray<{
      readonly "kind": "money";
      readonly "field": "unit_price_rm";
      readonly "line_index"?: number;
      readonly "previous_value"?: MyrAmount | null;
      readonly "corrected_value": MyrAmount;
    } | {
      readonly "kind": "decimal";
      readonly "field": "quantity";
      readonly "line_index"?: number;
      readonly "previous_value"?: NonNegativeDecimalString | null;
      readonly "corrected_value": NonNegativeDecimalString;
    } | {
      readonly "kind": "identifier";
      readonly "field": "product_id";
      readonly "line_index"?: number;
      readonly "previous_value"?: Identifier | null;
      readonly "corrected_value": Identifier;
    } | {
      readonly "kind": "text";
      readonly "field": "source_language";
      readonly "previous_value"?: string | null;
      readonly "corrected_value": string;
    }>;
  };
  readonly "evidence": Evidence;
};

export type CorrectionResponse = {
  readonly "state": "committed";
  readonly "correction_event_id": Identifier;
  readonly "target_event_id": Identifier;
  readonly "changes": ReadonlyArray<{
    readonly "field": string;
    readonly "line_index"?: number;
    readonly "before_value": string;
    readonly "after_value": string;
  }>;
};

export type CostChangeRequest = {
  readonly "merchant_id": Identifier;
  readonly "pack_size"?: PositiveDecimalString;
  readonly "clarification_source"?: Identifier;
  readonly "occurred_at": DateTime;
  readonly "component_id": Identifier;
  readonly "increase_rm": NonNegativeMyrAmount;
  readonly "evidence": Evidence;
};

export type CostChangeResponse = {
  readonly "state": "committed";
  readonly "event_id": Identifier;
  readonly "before_value_rm": NonNegativeMyrAmount;
  readonly "after_value_rm": NonNegativeMyrAmount;
} | {
  readonly "state": "clarification_required";
  readonly "clarification_source": Identifier;
  readonly "clarifications": ReadonlyArray<Ambiguity>;
} | {
  readonly "state": "rejected";
  readonly "errors": ReadonlyArray<ContractError>;
};

export type CostsRequest = {
  readonly "merchant_id": Identifier;
  readonly "occurred_at": DateTime;
  readonly "source"?: SourceKind;
  readonly "source_language"?: SourceLanguage;
  readonly "supplier_name": string;
  readonly "metadata"?: PurchaseMetadata;
  readonly "lines": ReadonlyArray<{
    readonly "component_id": Identifier;
    readonly "raw_name"?: string;
    readonly "quantity": NonNegativeDecimalString;
    readonly "uom": string;
    readonly "pack_size": NonNegativeDecimalString;
    readonly "total_price_rm": NonNegativeMyrAmount;
    readonly "confidence": Confidence;
  }>;
  readonly "evidence": Evidence;
};

export type CostsResponse = {
  readonly "state": "committed";
  readonly "event_id": Identifier;
} | {
  readonly "state": "clarification_required";
  readonly "clarifications": ReadonlyArray<Ambiguity>;
} | {
  readonly "state": "rejected";
  readonly "errors": ReadonlyArray<ContractError>;
};

export type GoogleSheetsDisconnectRequest = {

};

export type GoogleSheetsDisconnectResponse = {
  readonly "state": "disconnected";
};

export type GoogleSheetsExportRequest = {
  readonly "dates"?: ReadonlyArray<Date>;
};

export type GoogleSheetsImportRequest = {

};

export type GoogleSheetsOAuthCompleteRequest = {
  readonly "code": string;
  readonly "state": string;
  readonly "redirect_uri": string;
};

export type GoogleSheetsOAuthStartRequest = {
  readonly "redirect_uri": string;
  readonly "spreadsheet_id"?: string;
};

export type GoogleSheetsOAuthStartResponse = {
  readonly "authorization_url": string;
  readonly "state": string;
  readonly "expires_at": DateTime;
};

export type GoogleSheetsReconcileRequest = {

};

export type GoogleSheetsStatusResponse = {
  readonly "state": "not_connected" | "connected" | "error";
  readonly "spreadsheet_id": string | null;
  readonly "spreadsheet_url": string | null;
  readonly "spreadsheet_title": string | null;
  readonly "sync_mode": "manual" | "automatic";
  readonly "last_export_at": DateTime | null;
  readonly "last_import_at": DateTime | null;
  readonly "last_reconciled_at": DateTime | null;
  readonly "watch_expires_at": DateTime | null;
  readonly "last_error": string | null;
};

export type GoogleSheetsSyncModeRequest = {
  readonly "sync_mode": "manual" | "automatic";
};

export type GoogleSheetsSyncResponse = {
  readonly "state": "completed";
  readonly "job_id": Identifier;
  readonly "operation": "export" | "import" | "reconcile";
  readonly "rows_processed": number;
  readonly "errors": number;
  readonly "spreadsheet_url": string;
  readonly "completed_at": DateTime;
};

export type PurchaseIntakeConfirmRequest = {
  readonly "merchant_id": Identifier;
  readonly "intake_id": Identifier;
  readonly "expected_version": number;
  readonly "confirmation_token": Identifier;
};

export type PurchaseIntakeUpsertRequest = {
  readonly "merchant_id": Identifier;
  readonly "intake_id"?: Identifier;
  readonly "expected_version"?: number;
  readonly "occurred_at": DateTime;
  readonly "source": SourceKind;
  readonly "source_language"?: SourceLanguage;
  readonly "supplier_name"?: string | null;
  readonly "metadata": {
    readonly "payment_method": "cash";
    readonly "purchase_location"?: string | null;
    readonly "note"?: string | null;
    readonly "tags"?: ReadonlyArray<string>;
    readonly "external_reference"?: string | null;
  };
  readonly "item": {
    readonly "component_id"?: Identifier;
    readonly "raw_name"?: string;
    readonly "quantity"?: PositiveDecimalString;
    readonly "uom"?: string;
    readonly "pack_size"?: PositiveDecimalString;
    readonly "total_price_rm"?: NonNegativeMyrAmount;
  };
  readonly "evidence": Evidence;
};

export type PurchaseIntakeUpsertResponse = {
  readonly "state": "clarification_required" | "ready_for_confirmation";
  readonly "intake_id": Identifier;
  readonly "version": number;
  readonly "missing_fields": ReadonlyArray<"supplier_name" | "item.component_id" | "item.quantity" | "item.uom" | "item.pack_size" | "item.total_price_rm">;
  readonly "confirmation_token": Identifier | null;
  readonly "summary": {
    readonly "supplier_name": string | null;
    readonly "component_id": string | null;
    readonly "item_name": string | null;
    readonly "quantity": string | null;
    readonly "uom": string | null;
    readonly "pack_size": string | null;
    readonly "total_price_rm": string | null;
    readonly "occurred_at": DateTime;
    readonly "payment_method": "cash";
    readonly "note": string | null;
  };
};

export type ReceiptConfirmRequest = {
  readonly "merchant_id": Identifier;
  readonly "receipt_event_id": Identifier;
  readonly "occurred_at": DateTime;
  readonly "extraction": ReceiptExtraction;
};

export type ReceiptExtraction = {
  readonly "receipt_id": Identifier | null;
  readonly "supplier_name": string | null;
  readonly "date": Date | null;
  readonly "currency": "MYR";
  readonly "line_items": ReadonlyArray<{
    readonly "raw_name": string;
    readonly "normalized_component_id": Identifier | null;
    readonly "quantity": NonNegativeDecimalString | null;
    readonly "uom": string | null;
    readonly "pack_size": NonNegativeDecimalString | null;
    readonly "unit_price_rm": NonNegativeMyrAmount | null;
    readonly "total_price_rm": NonNegativeMyrAmount | null;
    readonly "confidence": Confidence;
  }>;
  readonly "total_rm": NonNegativeMyrAmount | null;
  readonly "overall_confidence": Confidence;
  readonly "ambiguities": ReadonlyArray<Ambiguity>;
};

export type ReceiptReviewUpsertRequest = {
  readonly "merchant_id": Identifier;
  readonly "receipt_event_id": Identifier;
  readonly "occurred_at": DateTime;
  readonly "review_state": "draft" | "archived";
  readonly "extraction": ReceiptExtraction;
};

export type ReceiptReviewUpsertResponse = {
  readonly "state": "saved" | "archived";
  readonly "receipt_event_id": Identifier;
  readonly "review_event_id": Identifier;
  readonly "version": number;
};

export type ReceiptReviewsResponse = {
  readonly "merchant_id": Identifier;
  readonly "receipts": ReadonlyArray<{
    readonly "receipt_event_id": Identifier;
    readonly "review_state": "draft" | "verified";
    readonly "version": number;
    readonly "title": string;
    readonly "image_uri": string | null;
    readonly "uploaded_at": DateTime;
    readonly "updated_at": DateTime;
    readonly "extraction": ReceiptExtraction;
    readonly "confirmed": boolean;
    readonly "cost_event_id": Identifier | null;
    readonly "verified_at": DateTime | null;
    readonly "material_changes": ReadonlyArray<{
      readonly "component_id": Identifier;
      readonly "component_name": string;
      readonly "product_id": Identifier | null;
      readonly "quantity": PositiveDecimalString;
      readonly "uom": string;
      readonly "pack_size": PositiveDecimalString;
      readonly "total_price_rm": NonNegativeMyrAmount;
      readonly "previous_cost_rm_per_pack": NonNegativeMyrAmount | null;
      readonly "current_cost_rm_per_pack": NonNegativeMyrAmount;
      readonly "change_rm_per_pack": MyrAmount | null;
    }>;
  }>;
};

export type ReceiptUploadRequest = {
  readonly "merchant_id": Identifier;
  readonly "occurred_at": DateTime;
  readonly "file_name": string;
  readonly "content_type": "image/jpeg" | "image/png";
  readonly "content_base64": string;
};

export type ReceiptUploadResponse = {
  readonly "state": "ready_for_review";
  readonly "event_id": Identifier;
  readonly "evidence_uri": string;
  readonly "extraction": ReceiptExtraction;
} | {
  readonly "state": "clarification_required";
  readonly "event_id": Identifier;
  readonly "evidence_uri": string;
  readonly "extraction": ReceiptExtraction;
  readonly "clarifications": ReadonlyArray<Ambiguity>;
} | {
  readonly "state": "review_required";
  readonly "event_id": Identifier;
  readonly "evidence_uri": string;
  readonly "reason": Identifier;
  readonly "extraction"?: ReceiptExtraction;
  readonly "errors"?: ReadonlyArray<string>;
  readonly "clarifications"?: ReadonlyArray<Ambiguity>;
} | {
  readonly "state": "rejected";
  readonly "event_id": Identifier;
  readonly "evidence_uri"?: string;
  readonly "reason": Identifier;
  readonly "mismatch_rm"?: NonNegativeMyrAmount;
  readonly "errors"?: ReadonlyArray<string>;
};

export type SalesRequest = {
  readonly "merchant_id": Identifier;
  readonly "occurred_at": DateTime;
  readonly "source": SourceKind;
  readonly "source_language": SourceLanguage;
  readonly "lines": ReadonlyArray<{
    readonly "product_id": Identifier;
    readonly "quantity": PositiveDecimalString;
    readonly "unit_price_rm": NonNegativeMyrAmount;
  }>;
  readonly "evidence": Evidence;
};

export type SalesResponse = {
  readonly "state": "committed";
  readonly "event_id": Identifier;
} | {
  readonly "state": "clarification_required";
  readonly "clarifications": ReadonlyArray<Ambiguity>;
} | {
  readonly "state": "rejected";
  readonly "errors": ReadonlyArray<ContractError>;
};

export type Identifier = string;

export type DecimalString = string;

export type NonNegativeDecimalString = string;

export type PositiveDecimalString = string;

export type MyrAmount = string;

export type NonNegativeMyrAmount = string;

export type Confidence = string;

export type Date = string;

export type DateTime = string;

export type SourceLanguage = string;

export type SourceKind = "voice_agent" | "telegram_text" | "telegram_voice" | "telegram_photo" | "web_upload" | "web_manual" | "text_reply" | "receipt_extractor" | "api";

export type PurchaseMetadata = {
  readonly "payment_method": "cash" | "card" | "bank_transfer" | "other";
  readonly "purchase_location"?: string | null;
  readonly "note"?: string | null;
  readonly "tags"?: ReadonlyArray<string>;
  readonly "external_reference"?: string | null;
};

export type ResponseState = "committed" | "clarification_required" | "rejected";

export type Evidence = ({
  readonly "transcript"?: string;
  readonly "external_message_id"?: Identifier;
  readonly "receipt_id"?: Identifier;
  readonly "asset_uri"?: string;
  readonly "source_event_id"?: Identifier;
} & ({
  readonly "transcript": string;
} | {
  readonly "external_message_id": Identifier;
} | {
  readonly "receipt_id": Identifier;
} | {
  readonly "asset_uri": string;
} | {
  readonly "source_event_id": Identifier;
}));

export type Ambiguity = {
  readonly "field": string;
  readonly "question": string;
  readonly "options": ReadonlyArray<string>;
};

export type ContractError = {
  readonly "code": Identifier;
  readonly "message": string;
  readonly "field"?: string | null;
};

export type PriceSimulationRequest = {
  readonly "merchant_id": Identifier;
  readonly "product_id": Identifier;
  readonly "quantity": NonNegativeDecimalString;
  readonly "proposed_unit_price_rm": NonNegativeMyrAmount;
  readonly "as_of": Date;
};

export type PriceSimulationResponse = {
  readonly "revenue_rm": MyrAmount;
  readonly "cogs_rm": MyrAmount;
  readonly "gross_profit_rm": MyrAmount;
  readonly "gross_margin_pct": DecimalString;
  readonly "incremental_gross_profit_vs_today_rm"?: MyrAmount;
  readonly "assumption": "constant_demand";
};

export type PriceVolumeScenarioRequest = {
  readonly "merchant_id": Identifier;
  readonly "product_id": Identifier;
  readonly "as_of": Date;
  readonly "center_price_rm": NonNegativeMyrAmount;
  readonly "center_quantity": NonNegativeDecimalString;
  readonly "price_step_pct": NonNegativeDecimalString;
  readonly "quantity_step_pct": NonNegativeDecimalString;
};

export type PriceVolumeScenarioResponse = {
  readonly "merchant_id": Identifier;
  readonly "product_id": Identifier;
  readonly "as_of": Date;
  readonly "target_gross_margin_pct": DecimalString;
  readonly "assumption": "constant_unit_cogs_and_independent_price_volume_inputs";
  readonly "scenarios": ReadonlyArray<{
    readonly "row": number;
    readonly "column": number;
    readonly "quantity": NonNegativeDecimalString;
    readonly "unit_price_rm": NonNegativeMyrAmount;
    readonly "revenue_rm": MyrAmount;
    readonly "cogs_rm": MyrAmount;
    readonly "gross_profit_rm": MyrAmount;
    readonly "gross_margin_pct": DecimalString;
    readonly "incremental_gross_profit_rm": MyrAmount;
    readonly "target_margin_met": boolean;
  }>;
};

export type DailySummaryResponse = {
  readonly "merchant_id": Identifier;
  readonly "date": Date;
  readonly "revenue_rm": MyrAmount;
  readonly "cogs_rm": MyrAmount;
  readonly "gross_profit_rm": MyrAmount;
  readonly "gross_margin_pct": DecimalString;
  readonly "data_completeness": {
    readonly "state": "complete" | "partial";
    readonly "missing_inputs": ReadonlyArray<string>;
  };
  readonly "top_cost_drivers": ReadonlyArray<{
    readonly "name": string;
    readonly "contribution_rm_per_pack": MyrAmount;
  }>;
  readonly "baseline_comparison": {
    readonly "baseline_margin_pct": DecimalString;
    readonly "margin_change_percentage_points": DecimalString;
  };
  readonly "price_floor": {
    readonly "target_gross_margin_pct": DecimalString;
    readonly "price_floor_rm": NonNegativeMyrAmount;
    readonly "assumption": "current_unit_cogs";
  } | null;
  readonly "cost_stack": {
    readonly "baseline_comparison_date"?: Date;
    readonly "baseline_effective_date"?: Date;
    readonly "baseline_unit_cogs_rm": NonNegativeMyrAmount;
    readonly "current_unit_cogs_rm": NonNegativeMyrAmount;
    readonly "components": ReadonlyArray<{
      readonly "component_id": Identifier;
      readonly "name": string;
      readonly "baseline_cost_rm_per_pack": NonNegativeMyrAmount;
      readonly "current_cost_rm_per_pack": NonNegativeMyrAmount;
      readonly "change_rm_per_pack": MyrAmount;
      readonly "evidence_id": Identifier | null;
    }>;
  } | null;
  readonly "evidence": ReadonlyArray<{
    readonly "evidence_id": Identifier;
    readonly "title": string;
    readonly "asset_uri": string | null;
    readonly "receipt_id": Identifier | null;
    readonly "supplier_name": string | null;
    readonly "transcript": string | null;
    readonly "line_items": ReadonlyArray<{
      readonly "raw_name": string;
      readonly "component_id": Identifier | null;
      readonly "total_price_rm": NonNegativeMyrAmount | null;
      readonly "confidence": Confidence | null;
    }>;
  }>;
  readonly "assumptions": ReadonlyArray<string>;
};

export type EndpointManifest = {
  readonly "version": "v1";
  readonly "canonical_schema_format": "JSON Schema 2020-12";
  readonly "openapi_status": "deferred_non_canonical";
  readonly "authentication": {
    readonly "scheme": "bearer";
    readonly "merchant_bound": true;
    readonly "required_for_prefix": "/api/v1/";
    readonly "telegram_webhook_path": "/webhooks/telegram";
    readonly "telegram_authentication": "X-Telegram-Bot-Api-Secret-Token";
    readonly "google_drive_webhook_path": "/webhooks/google-drive";
    readonly "google_drive_authentication": "X-Goog-Channel-Token";
  };
  readonly "endpoints": ReadonlyArray<{
    readonly "id": "sales.create";
    readonly "path": "/api/v1/sales";
    readonly "method": "POST";
    readonly "mutation": true;
    readonly "read_only": false;
    readonly "required_headers": ReadonlyArray<"Idempotency-Key">;
    readonly "idempotency_required": true;
    readonly "evidence_required": true;
    readonly "request_schema": "sales.request";
    readonly "response_schema": "sales.response";
    readonly "response_states": ReadonlyArray<"committed" | "clarification_required" | "rejected">;
    readonly "conversation_tool": true;
  } | {
    readonly "id": "costs.create";
    readonly "path": "/api/v1/costs";
    readonly "method": "POST";
    readonly "mutation": true;
    readonly "read_only": false;
    readonly "required_headers": ReadonlyArray<"Idempotency-Key">;
    readonly "idempotency_required": true;
    readonly "evidence_required": true;
    readonly "request_schema": "costs.request";
    readonly "response_schema": "costs.response";
    readonly "response_states": ReadonlyArray<"committed" | "clarification_required" | "rejected">;
    readonly "conversation_tool": true;
  } | {
    readonly "id": "purchase-intake.upsert";
    readonly "path": "/api/v1/purchase-intakes";
    readonly "method": "POST";
    readonly "mutation": true;
    readonly "read_only": false;
    readonly "append_only": true;
    readonly "required_headers": ReadonlyArray<"Idempotency-Key">;
    readonly "idempotency_required": true;
    readonly "evidence_required": true;
    readonly "request_schema": "purchase-intake-upsert.request";
    readonly "response_schema": "purchase-intake-upsert.response";
    readonly "response_states": ReadonlyArray<"clarification_required" | "ready_for_confirmation">;
    readonly "conversation_tool": false;
  } | {
    readonly "id": "purchase-intake.confirm";
    readonly "path": "/api/v1/purchase-intakes/confirm";
    readonly "method": "POST";
    readonly "mutation": true;
    readonly "read_only": false;
    readonly "append_only": true;
    readonly "required_headers": ReadonlyArray<"Idempotency-Key">;
    readonly "idempotency_required": true;
    readonly "evidence_required": false;
    readonly "request_schema": "purchase-intake-confirm.request";
    readonly "response_schema": "costs.response";
    readonly "response_states": ReadonlyArray<"committed" | "clarification_required" | "rejected">;
    readonly "conversation_tool": false;
  } | {
    readonly "id": "cost-changes.create";
    readonly "path": "/api/v1/cost-changes";
    readonly "method": "POST";
    readonly "mutation": true;
    readonly "read_only": false;
    readonly "required_headers": ReadonlyArray<"Idempotency-Key">;
    readonly "idempotency_required": true;
    readonly "evidence_required": true;
    readonly "request_schema": "cost-changes.request";
    readonly "response_schema": "cost-changes.response";
    readonly "response_states": ReadonlyArray<"committed" | "clarification_required" | "rejected">;
    readonly "conversation_tool": true;
  } | {
    readonly "id": "price-simulation.create";
    readonly "path": "/api/v1/simulations/price";
    readonly "method": "POST";
    readonly "mutation": false;
    readonly "read_only": true;
    readonly "required_headers": ReadonlyArray<never>;
    readonly "idempotency_required": false;
    readonly "evidence_required": false;
    readonly "request_schema": "price-simulation.request";
    readonly "response_schema": "price-simulation.response";
    readonly "response_states": ReadonlyArray<never>;
    readonly "conversation_tool": true;
  } | {
    readonly "id": "price-volume-scenario.create";
    readonly "path": "/api/v1/scenarios/price-volume";
    readonly "method": "POST";
    readonly "mutation": false;
    readonly "read_only": true;
    readonly "required_headers": ReadonlyArray<never>;
    readonly "idempotency_required": false;
    readonly "evidence_required": false;
    readonly "request_schema": "price-volume-scenario.request";
    readonly "response_schema": "price-volume-scenario.response";
    readonly "response_states": ReadonlyArray<never>;
    readonly "conversation_tool": false;
  } | {
    readonly "id": "corrections.create";
    readonly "path": "/api/v1/corrections";
    readonly "method": "POST";
    readonly "mutation": true;
    readonly "read_only": false;
    readonly "append_only": true;
    readonly "required_headers": ReadonlyArray<"Idempotency-Key">;
    readonly "idempotency_required": true;
    readonly "evidence_required": true;
    readonly "request_schema": "corrections.request";
    readonly "response_schema": "corrections.response";
    readonly "response_states": ReadonlyArray<"committed">;
    readonly "conversation_tool": true;
  } | {
    readonly "id": "receipt-upload.create";
    readonly "path": "/api/v1/receipts/extract";
    readonly "method": "POST";
    readonly "mutation": true;
    readonly "read_only": false;
    readonly "required_headers": ReadonlyArray<"Idempotency-Key">;
    readonly "idempotency_required": true;
    readonly "evidence_required": true;
    readonly "request_schema": "receipt-upload.request";
    readonly "response_schema": "receipt-upload.response";
    readonly "response_states": ReadonlyArray<"ready_for_review" | "clarification_required" | "review_required" | "rejected">;
    readonly "conversation_tool": false;
  } | {
    readonly "id": "receipt-confirm.create";
    readonly "path": "/api/v1/receipts/confirm";
    readonly "method": "POST";
    readonly "mutation": true;
    readonly "read_only": false;
    readonly "required_headers": ReadonlyArray<"Idempotency-Key">;
    readonly "idempotency_required": true;
    readonly "evidence_required": true;
    readonly "request_schema": "receipt-confirm.request";
    readonly "response_schema": "costs.response";
    readonly "response_states": ReadonlyArray<"committed" | "clarification_required" | "rejected">;
    readonly "conversation_tool": false;
  } | {
    readonly "id": "receipt-review.upsert";
    readonly "path": "/api/v1/receipts/reviews";
    readonly "method": "POST";
    readonly "mutation": true;
    readonly "read_only": false;
    readonly "append_only": true;
    readonly "required_headers": ReadonlyArray<"Idempotency-Key">;
    readonly "idempotency_required": true;
    readonly "evidence_required": true;
    readonly "request_schema": "receipt-review-upsert.request";
    readonly "response_schema": "receipt-review-upsert.response";
    readonly "response_states": ReadonlyArray<"saved" | "archived">;
    readonly "conversation_tool": false;
  } | {
    readonly "id": "receipt-reviews.get";
    readonly "path": "/api/v1/receipts/reviews";
    readonly "method": "GET";
    readonly "mutation": false;
    readonly "read_only": true;
    readonly "required_headers": ReadonlyArray<never>;
    readonly "idempotency_required": false;
    readonly "evidence_required": false;
    readonly "response_schema": "receipt-reviews.response";
    readonly "response_states": ReadonlyArray<never>;
    readonly "conversation_tool": false;
  } | {
    readonly "id": "daily-summary.get";
    readonly "path": "/api/v1/summary/daily";
    readonly "method": "GET";
    readonly "mutation": false;
    readonly "read_only": true;
    readonly "required_headers": ReadonlyArray<never>;
    readonly "idempotency_required": false;
    readonly "evidence_required": false;
    readonly "response_schema": "daily-summary.response";
    readonly "response_states": ReadonlyArray<never>;
    readonly "conversation_tool": true;
  } | {
    readonly "id": "analytics-overview.get";
    readonly "path": "/api/v1/analytics/overview";
    readonly "method": "GET";
    readonly "mutation": false;
    readonly "read_only": true;
    readonly "required_headers": ReadonlyArray<never>;
    readonly "idempotency_required": false;
    readonly "evidence_required": false;
    readonly "response_schema": "analytics-overview.response";
    readonly "response_states": ReadonlyArray<never>;
    readonly "conversation_tool": false;
  } | {
    readonly "id": "analytics-activity.get";
    readonly "path": "/api/v1/analytics/activity";
    readonly "method": "GET";
    readonly "mutation": false;
    readonly "read_only": true;
    readonly "required_headers": ReadonlyArray<never>;
    readonly "idempotency_required": false;
    readonly "evidence_required": false;
    readonly "response_schema": "analytics-activity.response";
    readonly "response_states": ReadonlyArray<never>;
    readonly "conversation_tool": false;
  } | {
    readonly "id": "analytics-forecast.get";
    readonly "path": "/api/v1/analytics/forecast";
    readonly "method": "GET";
    readonly "mutation": false;
    readonly "read_only": true;
    readonly "required_headers": ReadonlyArray<never>;
    readonly "idempotency_required": false;
    readonly "evidence_required": false;
    readonly "response_schema": "analytics-forecast.response";
    readonly "response_states": ReadonlyArray<"unavailable" | "shadow" | "ready">;
    readonly "conversation_tool": false;
  } | {
    readonly "id": "analytics-day-status.create";
    readonly "path": "/api/v1/analytics/day-status";
    readonly "method": "POST";
    readonly "mutation": true;
    readonly "read_only": false;
    readonly "append_only": true;
    readonly "required_headers": ReadonlyArray<"Idempotency-Key">;
    readonly "idempotency_required": true;
    readonly "evidence_required": false;
    readonly "request_schema": "analytics-day-status.request";
    readonly "response_schema": "analytics-day-status.response";
    readonly "response_states": ReadonlyArray<"committed">;
    readonly "conversation_tool": false;
  } | {
    readonly "id": "component-catalog.get";
    readonly "path": "/api/v1/catalog/components";
    readonly "method": "GET";
    readonly "mutation": false;
    readonly "read_only": true;
    readonly "required_headers": ReadonlyArray<never>;
    readonly "idempotency_required": false;
    readonly "evidence_required": false;
    readonly "response_schema": "component-catalog.response";
    readonly "response_states": ReadonlyArray<never>;
    readonly "conversation_tool": false;
  } | {
    readonly "id": "evidence.get";
    readonly "path": "/api/v1/evidence";
    readonly "method": "GET";
    readonly "mutation": false;
    readonly "read_only": true;
    readonly "required_headers": ReadonlyArray<never>;
    readonly "idempotency_required": false;
    readonly "evidence_required": false;
    readonly "response_schema": null;
    readonly "response_media_type": "application/octet-stream";
    readonly "response_states": ReadonlyArray<never>;
    readonly "conversation_tool": false;
  } | {
    readonly "id": "google-sheets.status";
    readonly "path": "/api/v1/integrations/google-sheets";
    readonly "method": "GET";
    readonly "mutation": false;
    readonly "read_only": true;
    readonly "required_headers": ReadonlyArray<never>;
    readonly "idempotency_required": false;
    readonly "evidence_required": false;
    readonly "response_schema": "google-sheets-status.response";
    readonly "response_states": ReadonlyArray<"not_connected" | "connected" | "error">;
    readonly "conversation_tool": false;
  } | {
    readonly "id": "google-sheets.oauth-start";
    readonly "path": "/api/v1/integrations/google-sheets/oauth/start";
    readonly "method": "POST";
    readonly "mutation": true;
    readonly "read_only": false;
    readonly "required_headers": ReadonlyArray<"Idempotency-Key">;
    readonly "idempotency_required": true;
    readonly "evidence_required": false;
    readonly "request_schema": "google-sheets-oauth-start.request";
    readonly "response_schema": "google-sheets-oauth-start.response";
    readonly "response_states": ReadonlyArray<never>;
    readonly "conversation_tool": false;
  } | {
    readonly "id": "google-sheets.oauth-complete";
    readonly "path": "/api/v1/integrations/google-sheets/oauth/complete";
    readonly "method": "POST";
    readonly "mutation": true;
    readonly "read_only": false;
    readonly "required_headers": ReadonlyArray<"Idempotency-Key">;
    readonly "idempotency_required": true;
    readonly "evidence_required": false;
    readonly "request_schema": "google-sheets-oauth-complete.request";
    readonly "response_schema": "google-sheets-status.response";
    readonly "response_states": ReadonlyArray<"connected" | "error">;
    readonly "conversation_tool": false;
  } | {
    readonly "id": "google-sheets.export";
    readonly "path": "/api/v1/integrations/google-sheets/export";
    readonly "method": "POST";
    readonly "mutation": true;
    readonly "read_only": false;
    readonly "required_headers": ReadonlyArray<"Idempotency-Key">;
    readonly "idempotency_required": true;
    readonly "evidence_required": false;
    readonly "request_schema": "google-sheets-export.request";
    readonly "response_schema": "google-sheets-sync.response";
    readonly "response_states": ReadonlyArray<"completed">;
    readonly "conversation_tool": false;
  } | {
    readonly "id": "google-sheets.import";
    readonly "path": "/api/v1/integrations/google-sheets/import";
    readonly "method": "POST";
    readonly "mutation": true;
    readonly "read_only": false;
    readonly "required_headers": ReadonlyArray<"Idempotency-Key">;
    readonly "idempotency_required": true;
    readonly "evidence_required": true;
    readonly "request_schema": "google-sheets-import.request";
    readonly "response_schema": "google-sheets-sync.response";
    readonly "response_states": ReadonlyArray<"completed">;
    readonly "conversation_tool": false;
  } | {
    readonly "id": "google-sheets.reconcile";
    readonly "path": "/api/v1/integrations/google-sheets/reconcile";
    readonly "method": "POST";
    readonly "mutation": true;
    readonly "read_only": false;
    readonly "required_headers": ReadonlyArray<"Idempotency-Key">;
    readonly "idempotency_required": true;
    readonly "evidence_required": false;
    readonly "request_schema": "google-sheets-reconcile.request";
    readonly "response_schema": "google-sheets-sync.response";
    readonly "response_states": ReadonlyArray<"completed">;
    readonly "conversation_tool": false;
  } | {
    readonly "id": "google-sheets.sync-mode";
    readonly "path": "/api/v1/integrations/google-sheets/sync-mode";
    readonly "method": "POST";
    readonly "mutation": true;
    readonly "read_only": false;
    readonly "required_headers": ReadonlyArray<"Idempotency-Key">;
    readonly "idempotency_required": true;
    readonly "evidence_required": false;
    readonly "request_schema": "google-sheets-sync-mode.request";
    readonly "response_schema": "google-sheets-status.response";
    readonly "response_states": ReadonlyArray<"connected" | "error">;
    readonly "conversation_tool": false;
  } | {
    readonly "id": "google-sheets.disconnect";
    readonly "path": "/api/v1/integrations/google-sheets/disconnect";
    readonly "method": "POST";
    readonly "mutation": true;
    readonly "read_only": false;
    readonly "required_headers": ReadonlyArray<"Idempotency-Key">;
    readonly "idempotency_required": true;
    readonly "evidence_required": false;
    readonly "request_schema": "google-sheets-disconnect.request";
    readonly "response_schema": "google-sheets-disconnect.response";
    readonly "response_states": ReadonlyArray<"disconnected">;
    readonly "conversation_tool": false;
  }>;
  readonly "non_endpoint_schemas": ReadonlyArray<{
    readonly "id": "receipt-extraction";
    readonly "purpose": "ReceiptExtractor adapter output";
    readonly "commit_rules": {
      readonly "review_below_overall_confidence": "0.85";
      readonly "confirm_financial_field_below_confidence": "0.90";
      readonly "clarify_missing_required_pack_size": true;
      readonly "reject_total_mismatch_over_rm": "0.05";
    };
  }>;
};
