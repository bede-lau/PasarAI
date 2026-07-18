import type {
  CorrectionRequest,
  Evidence,
  SalesRequest,
  SalesResponse,
} from "@pasarai/contracts/v1";

const evidence: Evidence = { source_event_id: "evt_voice_001" };
const request: SalesRequest = {
  merchant_id: "m_kak_lina_001",
  occurred_at: "2026-07-12T14:30:00+08:00",
  source: "voice_agent",
  source_language: "ms-en",
  lines: [{ product_id: "p_nlb_001", quantity: "40", unit_price_rm: "5.00" }],
  evidence,
};
const response: SalesResponse = { state: "committed", event_id: "evt_sales_001" };
const correction: CorrectionRequest = {
  merchant_id: "m_kak_lina_001",
  target_event_id: "evt_voice_001",
  occurred_at: "2026-07-12T14:31:00+08:00",
  reason: "Correct quantity",
  replacement_payload: {
    changes: [{
      kind: "decimal",
      field: "quantity",
      previous_value: "40",
      corrected_value: "38",
    }],
  },
  evidence,
};

void request;
void response;
void correction;
