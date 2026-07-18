import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  createApiApp,
  createBearerAuthenticator,
  createGoogleSheetsBackgroundWorker,
  createGoogleSheetsIntegration,
  createGoogleTokenCipher,
  createGoogleWorkspaceClient,
  createPasarAiService,
  LakebaseGoogleSheetsStore,
  LakebaseLedgerStore,
} from "./backend/index.js";
import {
  createElevenLabsScribeTranscriber,
  createFileEvidenceStore,
  createLakebaseTelegramEventStore,
  createReceiptUploadIngestion,
  createTelegramBotClient,
  createTelegramIngestion,
} from "./index.js";

const apiDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryDirectory = resolve(apiDirectory, "../..");

export function resolveConfiguredModulePath(
  modulePath,
  { workingDirectory = process.cwd() } = {},
) {
  const candidates = isAbsolute(modulePath)
    ? [modulePath]
    : [
        resolve(workingDirectory, modulePath),
        resolve(repositoryDirectory, modulePath),
        resolve(apiDirectory, modulePath),
      ];
  const configuredPath = [...new Set(candidates)].find((candidate) =>
    existsSync(candidate)
  );
  if (!configuredPath) {
    throw new Error(
      `Configured adapter module could not be found: ${modulePath}`,
    );
  }
  return configuredPath;
}

async function loadConfiguredAdapter(modulePath, exportName, context) {
  if (!modulePath) return null;
  const configuredPath = resolveConfiguredModulePath(modulePath);
  const module = await import(pathToFileURL(configuredPath).href);
  const candidate = module[exportName] ?? module.default;
  if (typeof candidate === "function") return candidate(context);
  if (candidate && typeof candidate === "object") return candidate;
  throw new Error(
    `${modulePath} must export ${exportName} or a default adapter`,
  );
}

function requiredEnvironment(environment, name) {
  const value = environment[name];
  if (!value || value === "<PLACEHOLDER>") {
    throw new Error(`${name} is required`);
  }
  return value;
}

function positiveIntegerEnvironment(environment, name, fallback) {
  const value = Number.parseInt(environment[name] ?? "", 10);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function commaSeparatedEnvironment(environment, name) {
  return (environment[name] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function dependencyProbe(candidate, configured = Boolean(candidate)) {
  return {
    async healthCheck() {
      if (!configured) return { status: "unavailable" };
      if (typeof candidate?.healthCheck === "function") {
        return candidate.healthCheck();
      }
      return { status: "ok" };
    },
  };
}

export function createProductionDependencyMap({
  store,
  evidenceStore,
  receiptExtractor,
  messageInterpreter,
  telegramConfigured,
  scribeConfigured,
  googleSheetsIntegration,
}) {
  return {
    lakebase: dependencyProbe(store),
    evidence_store: dependencyProbe(evidenceStore),
    receipt_extractor: dependencyProbe(receiptExtractor),
    message_interpreter: dependencyProbe(messageInterpreter),
    telegram: dependencyProbe(null, telegramConfigured),
    scribe: dependencyProbe(null, scribeConfigured),
    google_sheets: dependencyProbe(googleSheetsIntegration),
  };
}

export async function createProductionRuntime({
  environment = process.env,
} = {}) {
  const merchantId = requiredEnvironment(
    environment,
    "PASARAI_MERCHANT_ID",
  );
  const databaseUrl = requiredEnvironment(
    environment,
    "LAKEBASE_DATABASE_URL",
  );
  const databaseSsl = environment.LAKEBASE_SSL === "0"
    ? false
    : {
        rejectUnauthorized:
          environment.LAKEBASE_SSL_REJECT_UNAUTHORIZED !== "0",
      };
  const store = new LakebaseLedgerStore({
    databaseUrl,
    ssl: databaseSsl,
  });
  const service = createPasarAiService({ store });
  const evidenceStore = createFileEvidenceStore({
    rootDirectory: environment.PASARAI_EVIDENCE_ROOT
      ?? resolve(".pasarai-evidence"),
    portableUris: true,
  });
  const receiptExtractor = await loadConfiguredAdapter(
    environment.PASARAI_RECEIPT_EXTRACTOR_MODULE,
    "createReceiptExtractor",
    { environment },
  );
  const messageInterpreter = await loadConfiguredAdapter(
    environment.PASARAI_MESSAGE_INTERPRETER_MODULE,
    "createMessageInterpreter",
    { environment },
  );
  const receiptIngestion = receiptExtractor
    ? createReceiptUploadIngestion({
        store,
        evidenceStore,
        receiptExtractor,
      })
    : null;

  const googleConfigurationValues = [
    environment.GOOGLE_CLIENT_ID,
    environment.GOOGLE_CLIENT_SECRET,
    environment.GOOGLE_TOKEN_ENCRYPTION_KEY,
  ];
  const googleConfigurationStarted = googleConfigurationValues.some(Boolean);
  const googleConfigured = googleConfigurationValues.every(Boolean);
  if (googleConfigurationStarted && !googleConfigured) {
    throw new Error(
      "GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and "
        + "GOOGLE_TOKEN_ENCRYPTION_KEY must be configured together",
    );
  }
  const googleSheetsStore = googleConfigured
    ? new LakebaseGoogleSheetsStore({
        databaseUrl,
        ssl: databaseSsl,
      })
    : null;
  const googleSheetsIntegration = googleConfigured
    ? createGoogleSheetsIntegration({
        store: googleSheetsStore,
        ledgerStore: store,
        businessService: service,
        googleClient: createGoogleWorkspaceClient({
          clientId: environment.GOOGLE_CLIENT_ID,
          clientSecret: environment.GOOGLE_CLIENT_SECRET,
          timeoutMs: positiveIntegerEnvironment(
            environment,
            "GOOGLE_API_TIMEOUT_MS",
            30 * 1000,
          ),
        }),
        tokenCipher: createGoogleTokenCipher({
          key: environment.GOOGLE_TOKEN_ENCRYPTION_KEY,
        }),
        webhookUrl: environment.GOOGLE_SHEETS_WEBHOOK_URL,
        syncLeaseMs: positiveIntegerEnvironment(
          environment,
          "GOOGLE_SHEETS_SYNC_LEASE_MS",
          30 * 60 * 1000,
        ),
      })
    : null;
  const googleSheetsBackgroundWorker = googleSheetsIntegration
    ? createGoogleSheetsBackgroundWorker({
        integration: googleSheetsIntegration,
        store: googleSheetsStore,
        processNotification: (notification) =>
          googleSheetsIntegration.processDriveNotification(notification),
        intervalMs: positiveIntegerEnvironment(
          environment,
          "GOOGLE_SHEETS_SYNC_INTERVAL_MS",
          5 * 60 * 1000,
        ),
        stageTimeoutMs: positiveIntegerEnvironment(
          environment,
          "GOOGLE_SHEETS_WORKER_STAGE_TIMEOUT_MS",
          60 * 1000,
        ),
      })
    : null;
  googleSheetsBackgroundWorker?.start();

  let telegramIngestion = null;
  let telegramConfigured = false;
  let scribeConfigured = false;
  if (
    environment.TELEGRAM_BOT_TOKEN
    && environment.TELEGRAM_WEBHOOK_SECRET
  ) {
    telegramConfigured = true;
    const telegramClient = createTelegramBotClient({
      botToken: environment.TELEGRAM_BOT_TOKEN,
    });
    scribeConfigured = Boolean(environment.ELEVENLABS_API_KEY);
    const transcriber = environment.ELEVENLABS_API_KEY
      ? createElevenLabsScribeTranscriber({
          apiKey: environment.ELEVENLABS_API_KEY,
          keyterms: commaSeparatedEnvironment(
            environment,
            "ELEVENLABS_SCRIBE_KEYTERMS",
          ),
        })
      : {
          async transcribe() {
            throw new Error("ElevenLabs Scribe is not configured");
          },
        };
    const configuredChatId = environment.TELEGRAM_ALLOWED_CHAT_ID;
    telegramIngestion = createTelegramIngestion({
      webhookSecret: environment.TELEGRAM_WEBHOOK_SECRET,
      eventStore: createLakebaseTelegramEventStore({
        ledgerStore: store,
        merchantId,
      }),
      evidenceStore,
      telegramClient,
      transcriber,
      receiptExtractor: receiptExtractor ?? {
        async extract() {
          throw new Error("Receipt extractor is not configured");
        },
      },
      messageInterpreter,
      service,
      defaultBusinessDate:
        environment.PASARAI_DASHBOARD_DATE ?? "2026-07-16",
      processingLeaseMs: positiveIntegerEnvironment(
        environment,
        "PASARAI_TELEGRAM_PROCESSING_LEASE_MS",
        60_000,
      ),
      merchantResolver: async (body) =>
        configuredChatId
        && String(body.message?.chat?.id) === configuredChatId
          ? merchantId
          : null,
    });
  }

  const app = createApiApp({
    service,
    authenticate: createBearerAuthenticator({
      apiKey: requiredEnvironment(
        environment,
        "PASARAI_API_BEARER_TOKEN",
      ),
      merchantId,
    }),
    dependencies: createProductionDependencyMap({
      store,
      evidenceStore,
      receiptExtractor,
      messageInterpreter,
      telegramConfigured,
      scribeConfigured,
      googleSheetsIntegration,
    }),
    telegramIngestion,
    receiptIngestion,
    evidenceStore,
    googleSheetsIntegration,
  });

  return {
    app,
    store,
    googleSheetsStore,
    googleSheetsIntegration,
    googleSheetsBackgroundWorker,
    async close() {
      googleSheetsBackgroundWorker?.stop();
      await Promise.all([
        store.close(),
        googleSheetsStore?.close(),
      ]);
    },
  };
}
