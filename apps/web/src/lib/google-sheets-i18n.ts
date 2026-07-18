import type { Locale } from "@/lib/dashboard-types";

const messages = {
  en: {
    eyebrow: "Settings / Integrations",
    title: "Google Sheets",
    integrationName: "Google Sheets",
    integrationDescription:
      "Connect a spreadsheet, export the latest PasarAI data, and open it without leaving the merchant workflow.",
    status: "Connection status",
    loading: "Checking connection",
    connected: "Connected",
    notConnected: "Not connected",
    error: "Needs attention",
    unavailable: "Unavailable",
    connectedHelp: "PasarAI can export to this spreadsheet.",
    notConnectedHelp:
      "Connect Google Sheets to create or use an existing spreadsheet.",
    errorHelp:
      "The connection could not be verified. Refresh the status or reconnect.",
    unavailableHelp:
      "PasarAI could not check the connection. Refresh after the service is configured or restarted.",
    spreadsheet: "Spreadsheet",
    untitledSpreadsheet: "Connected spreadsheet",
    spreadsheetId: "Existing spreadsheet ID",
    spreadsheetIdHint:
      "Optional. Leave blank to let the connection flow choose a sheet.",
    syncMode: "Sync mode",
    syncModeHelp:
      "Choose whether spreadsheet updates run on demand or automatically.",
    manual: "Manual",
    automatic: "Automatic",
    updatingSyncMode: "Updating sync mode",
    lastExport: "Last export",
    lastImport: "Last import",
    lastReconciled: "Last reconciled",
    watchExpires: "Automatic sync expires",
    never: "Not yet",
    refresh: "Refresh status",
    connect: "Connect Google Sheets",
    connecting: "Opening Google",
    openSheet: "Open spreadsheet",
    export: "Export now",
    exporting: "Exporting",
    importInputs: "Import inputs",
    importing: "Importing inputs",
    reconcile: "Reconcile now",
    reconciling: "Reconciling",
    disconnect: "Disconnect",
    disconnectPrompt:
      "Disconnect Google Sheets? The spreadsheet will remain in Google Drive.",
    confirmDisconnect: "Confirm disconnect",
    disconnecting: "Disconnecting",
    cancel: "Cancel",
    connectedNotice: "Google Sheets is connected.",
    callbackError:
      "Google Sheets could not be connected. Try the connection again.",
    requestError: "Google Sheets is temporarily unavailable.",
    configurationError:
      "Google Sheets is not configured for this PasarAI environment.",
    webhookConfigurationError:
      "Automatic synchronization needs a public HTTPS webhook configured in PasarAI.",
    exportComplete: (rows: number, errors: number) =>
      errors > 0
        ? `Exported ${rows} rows with ${errors} errors.`
        : `Exported ${rows} rows successfully.`,
    importComplete: (rows: number, errors: number) =>
      errors > 0
        ? `Imported ${rows} input rows with ${errors} errors.`
        : `Imported ${rows} input rows successfully.`,
    reconcileComplete: (rows: number, errors: number) =>
      errors > 0
        ? `Reconciled ${rows} rows with ${errors} errors.`
        : `Reconciled ${rows} rows successfully.`,
    disconnectedNotice: "Google Sheets was disconnected."
  },
  ms: {
    eyebrow: "Tetapan / Integrasi",
    title: "Google Sheets",
    integrationName: "Google Sheets",
    integrationDescription:
      "Sambungkan hamparan, eksport data PasarAI terkini dan bukanya terus daripada aliran kerja peniaga.",
    status: "Status sambungan",
    loading: "Menyemak sambungan",
    connected: "Disambungkan",
    notConnected: "Belum disambungkan",
    error: "Perlu perhatian",
    unavailable: "Tidak tersedia",
    connectedHelp: "PasarAI boleh mengeksport ke hamparan ini.",
    notConnectedHelp:
      "Sambungkan Google Sheets untuk mencipta atau menggunakan hamparan sedia ada.",
    errorHelp:
      "Sambungan tidak dapat disahkan. Muat semula status atau sambung semula.",
    unavailableHelp:
      "PasarAI tidak dapat menyemak sambungan. Muat semula selepas perkhidmatan dikonfigurasi atau dimulakan semula.",
    spreadsheet: "Hamparan",
    untitledSpreadsheet: "Hamparan yang disambungkan",
    spreadsheetId: "ID hamparan sedia ada",
    spreadsheetIdHint:
      "Pilihan. Biarkan kosong untuk memilih hamparan semasa proses sambungan.",
    syncMode: "Mod segerak",
    syncModeHelp:
      "Pilih sama ada kemas kini hamparan dijalankan apabila diminta atau secara automatik.",
    manual: "Manual",
    automatic: "Automatik",
    updatingSyncMode: "Mengemas kini mod segerak",
    lastExport: "Eksport terakhir",
    lastImport: "Import terakhir",
    lastReconciled: "Penyelarasan terakhir",
    watchExpires: "Penyegerakan automatik tamat",
    never: "Belum ada",
    refresh: "Muat semula status",
    connect: "Sambungkan Google Sheets",
    connecting: "Membuka Google",
    openSheet: "Buka hamparan",
    export: "Eksport sekarang",
    exporting: "Mengeksport",
    importInputs: "Import input",
    importing: "Mengimport input",
    reconcile: "Selaraskan sekarang",
    reconciling: "Menyelaraskan",
    disconnect: "Putuskan sambungan",
    disconnectPrompt:
      "Putuskan sambungan Google Sheets? Hamparan akan kekal dalam Google Drive.",
    confirmDisconnect: "Sahkan putus sambungan",
    disconnecting: "Memutuskan sambungan",
    cancel: "Batal",
    connectedNotice: "Google Sheets telah disambungkan.",
    callbackError:
      "Google Sheets tidak dapat disambungkan. Cuba sambungkan sekali lagi.",
    requestError: "Google Sheets tidak tersedia buat sementara waktu.",
    configurationError:
      "Google Sheets belum dikonfigurasi untuk persekitaran PasarAI ini.",
    webhookConfigurationError:
      "Penyegerakan automatik memerlukan webhook HTTPS awam yang dikonfigurasi dalam PasarAI.",
    exportComplete: (rows: number, errors: number) =>
      errors > 0
        ? `${rows} baris dieksport dengan ${errors} ralat.`
        : `${rows} baris berjaya dieksport.`,
    importComplete: (rows: number, errors: number) =>
      errors > 0
        ? `${rows} baris input diimport dengan ${errors} ralat.`
        : `${rows} baris input berjaya diimport.`,
    reconcileComplete: (rows: number, errors: number) =>
      errors > 0
        ? `${rows} baris diselaraskan dengan ${errors} ralat.`
        : `${rows} baris berjaya diselaraskan.`,
    disconnectedNotice: "Sambungan Google Sheets telah diputuskan."
  },
  zh: {
    unavailable: "\u4e0d\u53ef\u7528",
    unavailableHelp:
      "\u65e0\u6cd5\u68c0\u67e5\u8fde\u63a5\u3002\u8bf7\u5728\u670d\u52a1\u914d\u7f6e\u6216\u91cd\u542f\u540e\u5237\u65b0\u3002",
    configurationError:
      "\u6b64 PasarAI \u73af\u5883\u5c1a\u672a\u914d\u7f6e Google Sheets\u3002",
    webhookConfigurationError:
      "\u81ea\u52a8\u540c\u6b65\u9700\u8981\u5728 PasarAI \u4e2d\u914d\u7f6e\u516c\u5f00 HTTPS webhook\u3002",
    syncModeHelp:
      "\u9009\u62e9\u4ec5\u5728\u9700\u8981\u65f6\u66f4\u65b0\u7535\u5b50\u8868\u683c\uff0c\u6216\u81ea\u52a8\u66f4\u65b0\u3002",
    updatingSyncMode:
      "\u6b63\u5728\u66f4\u65b0\u540c\u6b65\u6a21\u5f0f",
    reconcile: "\u7acb\u5373\u6838\u5bf9",
    reconciling: "\u6b63\u5728\u6838\u5bf9",
    reconcileComplete: (rows: number, errors: number) =>
      errors > 0
        ? `\u5df2\u6838\u5bf9 ${rows} \u884c\uff0c\u5176\u4e2d ${errors} \u4e2a\u9519\u8bef\u3002`
        : `\u5df2\u6210\u529f\u6838\u5bf9 ${rows} \u884c\u3002`,
    importInputs: "导入输入数据",
    importing: "正在导入输入数据",
    importComplete: (rows: number, errors: number) =>
      errors > 0
        ? `已导入 ${rows} 行输入数据，其中 ${errors} 个错误。`
        : `已成功导入 ${rows} 行输入数据。`,
    eyebrow: "设置 / 集成",
    title: "Google Sheets",
    integrationName: "Google Sheets",
    integrationDescription:
      "连接电子表格、导出最新的 PasarAI 数据，并直接从商家工作流程打开。",
    status: "连接状态",
    loading: "正在检查连接",
    connected: "已连接",
    notConnected: "未连接",
    error: "需要处理",
    connectedHelp: "PasarAI 可以将数据导出到此电子表格。",
    notConnectedHelp: "连接 Google Sheets 以创建或使用现有电子表格。",
    errorHelp: "无法验证连接。请刷新状态或重新连接。",
    spreadsheet: "电子表格",
    untitledSpreadsheet: "已连接的电子表格",
    spreadsheetId: "现有电子表格 ID",
    spreadsheetIdHint: "可选。留空即可在连接流程中选择电子表格。",
    syncMode: "同步模式",
    manual: "手动",
    automatic: "自动",
    lastExport: "上次导出",
    lastImport: "上次导入",
    lastReconciled: "上次核对",
    watchExpires: "自动同步到期时间",
    never: "尚无记录",
    refresh: "刷新状态",
    connect: "连接 Google Sheets",
    connecting: "正在打开 Google",
    openSheet: "打开电子表格",
    export: "立即导出",
    exporting: "正在导出",
    disconnect: "断开连接",
    disconnectPrompt:
      "要断开 Google Sheets 吗？电子表格仍会保留在 Google Drive 中。",
    confirmDisconnect: "确认断开",
    disconnecting: "正在断开",
    cancel: "取消",
    connectedNotice: "Google Sheets 已连接。",
    callbackError: "无法连接 Google Sheets。请重试。",
    requestError: "Google Sheets 暂时不可用。",
    exportComplete: (rows: number, errors: number) =>
      errors > 0
        ? `已导出 ${rows} 行，其中 ${errors} 个错误。`
        : `已成功导出 ${rows} 行。`,
    disconnectedNotice: "Google Sheets 已断开连接。"
  }
} as const;

export function getGoogleSheetsMessages(locale: Locale) {
  return messages[locale];
}
