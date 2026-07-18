# Manual actions

These actions require a human and are not automated by foundation CI:

- Create provider accounts and projects.
- Supply credentials through secure platform configuration.
- Enable the Google Sheets and Drive APIs, configure the OAuth consent screen,
  register the web callback, and expose the API's public HTTPS Drive webhook as
  documented in `docs/google-sheets-integration.md`.
- Configure `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
  `GOOGLE_TOKEN_ENCRYPTION_KEY`, and `GOOGLE_SHEETS_WEBHOOK_URL`; optionally
  tune `GOOGLE_SHEETS_SYNC_INTERVAL_MS`.
- Select available Databricks workspace resources, catalogs, schemas, and model endpoints.
- Create the Telegram bot and register its single webhook.
- Create and configure the ElevenLabs agent.
- Configure a public host such as Railway.
- Run `pnpm --filter @pasarai/api db:migrate` and
  `pnpm --filter @pasarai/api db:seed:synthetic` against the selected Lakebase
  database.
- Before a local rehearsal, run `pnpm demo:reset` to restore Kak Lina's
  July 16, 2026 demo state and its July 15 baseline.
- Configure `PASARAI_WEB_ACCESS_CODE` and a high-entropy
  `PASARAI_WEB_SESSION_SECRET` for the merchant web session.
- Configure the production merchant and primary product context with
  `PASARAI_MERCHANT_ID`, `PASARAI_MERCHANT_NAME`,
  `PASARAI_MERCHANT_LOCATION`, `PASARAI_PRODUCT_ID`, and
  `PASARAI_PRODUCT_NAME`.
- Configure one merchant-bound API bearer value in the API, Next.js server and
  ElevenLabs secret environment label `pasarai_api_bearer`.
- Mount durable storage for `PASARAI_EVIDENCE_ROOT`, or replace the file
  evidence adapter with an approved durable object store.
- Supply `PASARAI_RECEIPT_EXTRACTOR_MODULE` after selecting the live receipt
  provider, and `PASARAI_MESSAGE_INTERPRETER_MODULE` for Telegram text/voice
  interpretation.
- Supply `DASHSCOPE_API_KEY` for Qwen-backed Telegram interpretation and
  receipt extraction. The Qwen message adapter remains operational in
  local-parser fallback mode when the key is absent or provider calls fail.
- Optionally configure `ELEVENLABS_SCRIBE_KEYTERMS` with merchant-specific
  products and common financial terms after reviewing transcription errors.
- Set `TELEGRAM_ALLOWED_CHAT_ID` to the merchant chat mapped to
  `PASARAI_MERCHANT_ID`.
- Configure `PASARAI_PRODUCT_CATALOG_JSON` and
  `PASARAI_COMPONENT_CATALOG_JSON` before applying the production ElevenLabs
  agent; leave them empty only for the synthetic demo catalog.
- Run `databricks/notebooks/00_snapshot_lakebase_to_delta.py` with the selected
  Lakebase JDBC and secret settings before the triggered Lakeflow update.
- Review provider quotas and start or warm demo resources.
- Connect the merchant workbook from the Integrations settings page and verify
  one manual export, one controlled input import, and automatic-mode watch
  expiration before release.

No credential, provider URL, model ID, workspace ID, catalog, schema, or endpoint value belongs in source control or `.env.example`.
