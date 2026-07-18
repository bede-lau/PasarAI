# QA and demo release checklist

Release is blocked unless the automated section passes, the product owner signs
the manual section, and every untested dependency has a named recovery path.
Synthetic rehearsal success is not evidence that a live provider is available.

## Automated pass

Run from the repository root:

```text
pnpm demo:reset
pnpm test:qa
pnpm demo:rehearse
pnpm ci:check
```

Required evidence:

- `.tmp/qa-demo/reset-report.json` says `status: pass`,
  `synthetic: true`, `dashboard_date: 2026-07-16`, and
  `baseline_date: 2026-07-15`. For the configured rehearsal database,
  `live_services_reset` must be `true`; a deliberately local-only run records
  `false`.
- `.tmp/qa-demo/rehearsal-report.json` records at least three consecutive
  golden runs.
- Every daily-summary and simulation value matches
  `fixtures/synthetic/seed_data/expected_metrics.json` to the cent or 0.01
  percentage point.
- VN-01 and TM-03 create clarifications with zero financial mutation.
- Receipt 003 retains its evidence for review but creates no cost mutation.
- Duplicate receipt, sale, clarification, and confirmation delivery creates
  one effective mutation.
- Receipt-provider failure returns a visible `review_required` state and
  preserves evidence.
- Quota and dependency failure render a visible status instead of financial
  results.

## Manual pass

The product owner records pass/fail and the time checked for each item:

- Restart and warm the public app, Lakebase, SQL warehouse, and Lakeflow
  pipeline.
- Confirm remaining Databricks quota and ElevenLabs credits.
- Run the deployed ElevenLabs conversation suite with
  `ELEVENLABS_TEST_REPEAT_COUNT=3`.
- Listen to English, Malay, Mandarin, and Manglish pronunciation, including
  nasi lemak, santan, ikan bilis, ringgit, telur, 毛利率, and RM5.50.
- Confirm one live Telegram text, voice note, and receipt photo produces
  exactly one raw event each.
- Connect Google Sheets, export the daily metrics, import one synthetic sale,
  verify an invalid row is isolated in `Sync Errors`, and confirm a sale edit
  creates one correction event.
- Enable automatic Google Sheets mode, confirm the watch expiration is
  populated, deliver one valid Drive notification, and confirm duplicate
  message numbers do not create another effective mutation. Restart the API
  after notification acceptance and confirm the durable queued reconciliation
  still completes.
- Confirm receipt 001 is read by the selected live receipt provider and then
  reviewed by the merchant.
- Confirm the July 16 dashboard shows RM200.00 revenue, RM71.20 gross profit,
  35.60% gross margin, a RM2.50 July 15 baseline, RM3.22 current cost, and nine
  positive component changes.
- Confirm VN-04 returns RM81.20 gross profit in Mandarin without a mutation.
- Complete the timed script in `docs/demo-120-second-rehearsal.md`.

## Untested dependencies

These remain untested until the manual pass is completed:

- ElevenLabs account, deployed agent, credits, selected voices, remote tests,
  and microphone permission.
- Telegram bot token, webhook registration, webhook secret, and merchant chat
  mapping.
- Databricks Free Edition quota, Lakebase, SQL warehouse, Lakeflow pipeline,
  and any selected model endpoint.
- Selected live receipt extraction provider.
- Public HTTPS deployment, production secrets, and durable evidence storage.

## Release stop conditions

Stop the release when any cent differs, an ambiguous fixture mutates data, a
duplicate creates another event, a failure state displays financial success, or
a live dependency has no truthful recovery path. Do not edit expected metrics
to make a failing rehearsal pass.
