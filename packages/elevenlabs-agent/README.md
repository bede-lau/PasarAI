# PasarAI ElevenLabs multilingual agent

This package owns the PasarAI Live Advisor configuration, contract-derived webhook tools, multilingual prompt, language presets, VN-01 through VN-08 automated test definitions, and voice-audition checklist.

## What is automated

- Upserts six ElevenLabs webhook tools from `@pasarai/contracts/v1`.
- Enables the `language_detection` built-in system tool.
- Configures English as primary with Malay and Mandarin presets.
- Preserves existing agent LLM, TTS, voice, and unrelated tool settings.
- Patches only the agent identified by `ELEVENLABS_AGENT_ID`; it never creates or invents an agent ID.
- Upserts 14 ElevenLabs Agent Testing definitions covering all eight VN scripts, with separate tool-call and response checks where merchant-specific numbers are involved.
- Uses the ElevenLabs workspace environment label `pasarai_api_host` after a literal secure protocol prefix in tool URLs.
- Uses the ElevenLabs secret environment label `pasarai_api_bearer` for the API `Authorization` header.
- Uses conversation ID and turn count in mutation idempotency headers.

## Local commands

```text
pnpm --filter @pasarai/elevenlabs-agent test
pnpm --filter @pasarai/elevenlabs-agent validate
pnpm --filter @pasarai/elevenlabs-agent apply
pnpm --filter @pasarai/elevenlabs-agent test:remote
```

`apply` requires `ELEVENLABS_API_KEY` and `ELEVENLABS_AGENT_ID`. It writes created tool and test IDs to the repository `.tmp` directory, which is not a source artifact.

## Exact manual actions still required

1. Create the ElevenLabs agent named `PasarAI Live Advisor` and provide its ID through `ELEVENLABS_AGENT_ID`.
2. Provide the ElevenLabs API key through `ELEVENLABS_API_KEY`; never paste it into prompts or source files.
3. Create the ElevenLabs workspace string environment variable labeled `pasarai_api_host` and set its production value to the deployed public API hostname, without a protocol prefix.
4. Create the ElevenLabs secret environment variable labeled `pasarai_api_bearer` with the bearer value supplied by the API owner. Contract-derived tools attach it to the `Authorization` header without committing the value.
5. Select and audition one voice for English, Malay, and Mandarin. The apply command preserves these voice IDs instead of choosing them.
6. Pass the custom dynamic variable `merchant_id` when starting the web-widget conversation. For the synthetic demo use the seeded merchant ID; production sessions must use the authenticated merchant context.
7. Set `PASARAI_PRODUCT_CATALOG_JSON` and
   `PASARAI_COMPONENT_CATALOG_JSON` to arrays of `{ "id", "name" }` objects
   before `apply` for a non-demo merchant. Empty values intentionally use the
   committed synthetic fixture catalog for tests and rehearsal.
8. Run `test:remote` only after the public API, tool authentication, workspace environment variable, and voices are configured.
9. Complete `pronunciation-checklist.md` and rehearse three consecutive mid-session language switches.

## Contract integration

VN-01/VN-02 use the canonical `cost-changes.create` tool. A missing
denominator persists `clarification_required`; the follow-up supplies the
returned `clarification_source` and confirmed pack size without inventing a
purchase total. VN-07 reads the deterministic `price_floor` object from the
daily-summary response.

Mutation headers currently use the ElevenLabs conversation ID, agent-turn count, and tool name because the platform configuration exposes no per-utterance system ID. This is stable for a tool retry within the same agent turn, but a retry requested in a later turn can receive a new key. Before production, the API or web initiation layer must provide event-level deduplication that is stable across later-turn retries.
