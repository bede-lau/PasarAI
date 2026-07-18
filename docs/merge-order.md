# Merge order

Contracts merge first so every specialist builds against one stable public boundary.

1. Integration lead foundation and `packages/contracts`.
2. Prompt 01: backend API and deterministic finance.
3. Prompt 02: Databricks Free Edition data platform.
4. Prompt 03: ElevenLabs multilingual agent configuration.
5. Prompt 04: receipt and Telegram ingestion.
6. Prompt 05: frontend dashboard.
7. Prompt 06: QA and demo hardening.

Independent work may proceed in parallel after contracts are published, but integration merges in dependency order. A specialist branch must rebase onto the accepted contracts revision and pass `pnpm ci:check` before merge.
