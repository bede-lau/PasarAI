# PasarAI voice audition and pronunciation checklist

Complete this manually for the English, Malay, and Mandarin voices selected in the ElevenLabs dashboard. Record the chosen voice IDs outside source control.

## Voice quality

- [ ] English is concise and understandable with Malaysian product and place names.
- [ ] Malay sounds natural and friendly rather than formal or Indonesian.
- [ ] Mandarin uses clear Simplified Chinese phrasing and reads exact RM tokens naturally.
- [ ] Manglish code-switching does not pause unnaturally between Malay and English words.
- [ ] Mid-session `en` → `ms` → `zh` → `en` switching retains merchant and product context.

## Required terms

- [ ] PasarAI
- [ ] nasi lemak
- [ ] Nasi Lemak Biasa
- [ ] Nasi Lemak Ayam
- [ ] santan
- [ ] ikan bilis
- [ ] telur
- [ ] sambal
- [ ] ringgit
- [ ] margin kasar
- [ ] untung kasar
- [ ] 毛利率
- [ ] 毛利
- [ ] RM5.50
- [ ] RM81.20
- [ ] 42.18%

## Safety and interaction

- [ ] VN-01 asks whether the RM2 increase is per item, per bundle of 50, or total.
- [ ] VN-04 speaks Mandarin while keeping RM192.50, RM81.20, and 42.18% exact.
- [ ] VN-07 says RM5.30 as a mathematical threshold with assumptions, not a command.
- [ ] VN-08 does not pronounce gross profit as net profit or `untung bersih`.
- [ ] Tool timeout wording clearly says the record was not completed.
- [ ] Correction wording offers `betulkan`, `correct`, or `更正`.

Add pronunciation aliases only after listening tests show a real problem. Do not alter product or supplier names in ledger payloads.
