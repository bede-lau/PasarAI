# PasarAI 120-second demo rehearsal

The machine-readable timing and recovery source is
`fixtures/qa/rehearsal-plan.json`. Use a visible timer and stop at 120 seconds.

| Time | Segment | Operator action | Required visible evidence |
| --- | --- | --- | --- |
| 0:00-0:10 | Problem | Show the paper receipt and state that the vendor lacks a current margin view. | Source evidence appears before calculated output. |
| 0:10-0:35 | Receipt | Upload receipt 001 and confirm the three extracted cost lines. | The receipt is retained and ready for review. |
| 0:35-0:55 | Manglish update | Perform VN-01, then answer with VN-02. | Sales commit once; packaging waits for clarification and then moves from RM0.16 to RM0.20 once. |
| 0:55-1:15 | Dashboard insight | Reveal the July 16 margin and cost stack. | RM200.00 revenue, RM71.20 gross profit, 35.60% margin, RM2.50 July 15 baseline, RM3.22 current cost, and nine positive component changes. |
| 1:15-1:40 | Mandarin what-if | Simulate 35 packs at RM5.50. | RM192.50 revenue, RM79.80 gross profit, 41.45% margin, and the RM3.22 current-cost assumption. |
| 1:40-2:00 | Close | Open the receipt evidence and close with "Cakap. Snap. Tahu untung." | The source-to-ledger-to-dashboard trace is visible. |

## Recovery rehearsal

Run each branch before demo day. The disclosure sentence is part of the
rehearsal, not optional commentary.

### `receipt_provider_unavailable`

- Use receipt 002 in the manually verified extraction-review screen.
- Say that preserved evidence is being reviewed.
- Do not claim a model read the receipt live.

### `databricks_quota_or_compute_unavailable`

- Show the last materialized Gold snapshot.
- Say that it is previously processed demo state.
- Do not claim the dashboard is receiving a live warehouse result.

### `speech_or_microphone_failure`

- Paste the matching text fixture.
- Say that text input is being used.
- Do not claim a live transcript.

### `api_or_dashboard_failure`

- Keep the visible quota/error state on screen.
- Use the prerecorded recovery capture only after disclosing it.
- Do not claim cached, fixture, or recorded output is a live success.

### `golden_metric_mismatch`

- Stop the financial walkthrough.
- Open `fixtures/synthetic/seed_data/expected_metrics.json`.
- Do not claim replacement numbers and never change expected values on stage.

## Recovery checklist

- Expected metrics JSON is open locally.
- Receipt 002 review path is ready.
- Last materialized Gold snapshot is available.
- Matching text fixtures are ready for voice fallback.
- Prerecorded recovery capture is clearly labeled with its recording time.
- The operator has rehearsed every disclosure sentence.
