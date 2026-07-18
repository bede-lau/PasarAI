import type {
  GoogleSheetsDisconnectResponse,
  GoogleSheetsOAuthStartResponse,
  GoogleSheetsStatusResponse,
  GoogleSheetsSyncModeRequest,
  GoogleSheetsSyncResponse
} from "@pasarai/contracts/v1";

export type GoogleSheetsStatus = GoogleSheetsStatusResponse;
export type {
  GoogleSheetsDisconnectResponse,
  GoogleSheetsOAuthStartResponse,
  GoogleSheetsSyncModeRequest,
  GoogleSheetsSyncResponse
};

export type GoogleSheetsNotice = "connected" | "error" | null;
