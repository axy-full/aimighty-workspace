# Independent money review: fix/sample-no-spend-2 (S12.4 follow-ups on top of #544)

- Reviewer: fresh independent reviewer (Claude), 2026-10-06. Read-only; nothing committed, pushed or merged.
- Range `6a7844db..1bb91343` (3 commits): `effde229` a malformed sample mark fails closed; `b20c4b9a` Transcribe on the
  sample answers 409 not 402; `1bb91343` the mixed project/shot test asserts the sample's refusal.
- Touched files (diffed in full): `lib/demo/spend-guard.server.ts` (+21/-1), `lib/transcription.ts` (+3/-1),
  `tests/unit/demo-s12-no-spend.spec.ts` (+95/-2). Nothing else.
- Worktree `W/rev-544b` (detached at `1bb91343`), left in place. `node_modules` is a symlink to `W/ci-checks/node_modules`
  (W/glass's copy lacks `@aws-sdk/*`, which made tsc fail on `lib/storage/r2.ts` for environment reasons only).

## VERDICT: PASS

No high or medium finding. The delta strictly tightens the base guard. Four low findings; the first means the 409 fix for
Transcribe is incomplete (two reachable paths still answer before the guard), but no credit moves on any of them.

## Gates

| Gate | Result |
|---|---|
| `tsc --noEmit -p .` | 0 errors |
| `env -u CREDIT_USD ENGINE_MOCK=1 PW_BASE_URL=http://localhost:4999 playwright test --project=unit --workers=1` on `demo-s12-no-spend`, `demo-s12-sample-flag`, `transcriptionRecovery`, `generationRequests`, `quoteMatchesCharge` | 73 passed, 0 failed |
| Scratch probes `tests/unit/zz-probe-544b.spec.ts` (5 tests, 27 crafted marks, recovery, Transcribe ordering) | ran, results below; file deleted after, `git status` clean |

## (1) guardMark: does every bad mark fail closed?

`lib/demo/spend-guard.server.ts:34-43`. Order: a mark `parseSampleMark` accepts wins (:35-36); then not JSON → "unreadable"
(:38); not a plain object → "unreadable" (:39); `hiddenAt` a number > 0 → no sample (:41); a non-empty string `projectId` →
that production is the sample (:42); anything else → "unreadable", which refuses every paid job in the workspace (:18).
`guardMark` cannot throw (both parses are caught), so the guard has no new error path.

Probe results (`sampleSpendRefusal` for project `film` = the marked one, `other`, unfiled, and `shot_film`):

| Stored value | film | other / unfiled | Verdict |
|---|---|---|---|
| `projectId` 7, `["film"]`, `{id}`, `""`, `null` | refused | refused | closed (whole workspace) |
| not JSON, `""`, `1`, `true`, nested `{mark:{…}}`, double-encoded string, `hiddenAt: NaN` (invalid JSON) | refused | refused | closed (whole workspace) |
| `hiddenAt` `"5"`, `-1`, `0`, `true`, `null`, `[5]` | refused | admitted | closed for the sample |
| duplicate key `hiddenAt:5,hiddenAt:-1` (last wins) | refused | admitted | closed |
| `"__proto__":{"hiddenAt":5}` | refused | admitted | closed (own key, not inherited) |
| `version: "1"`, `version: 2` with projectId, `{version:1, projectId}` only | refused | admitted | closed for the sample |
| SQL `NULL` value | n/a | n/a | not storable (`settings.value NOT NULL`) |
| `hiddenAt: 1e999` (parses to Infinity) | admitted | admitted | reads as undone (see below) |
| `projectId: " film"` (padded), or > 100 chars | admitted | admitted | pre-existing, unreachable (L3) |

**Is "hiddenAt > 0 means no sample" safe?** Yes, given who writes the row. The only writer of `sampleProduction` is
`writeMark` (`lib/demo/mark.server.ts:43-55`), reached only from `markSampleProduction` and `hideSampleMark`, both gated by
`canBuildSample` (owner or admin, never `agent:`; :20-24, :63, :99) behind `POST /api/demo/sample`, which uses
`requireSession` so a token is refused (`app/api/demo/sample/route.ts:27`). `hiddenAt` is only ever written as `now()` on a
normalised mark (:103). `PATCH /api/settings` only writes keys in `DEFAULTS` (`app/api/settings/route.ts:23-25`), and
`sampleProduction` is not one (`lib/demo/sample.ts:8`). No other `setSetting`/`INSERT INTO settings` caller writes it. So a
crafted `hiddenAt` (Infinity, or on a misshapen row) needs a direct database write; anyone with that can delete the row
anyway. A person who may undo the sample can already undo it legitimately.

**Can a member or token block a whole workspace's spend?** No. Members and tokens have no write path to the row (above).
An "unreadable" row only comes from a hand edit, corruption, or a future mark shape read by older code during a rolling
deploy. Fail-closed is the right default there. Recovery is weaker than the comment says (L2).

**Does the delta weaken the base?** No. Every input the base refused is still refused: `parseSampleMark` runs first and
its result is used unchanged (:35-36), and the fallback only turns base "no sample" answers into refusals, except a row
whose `hiddenAt` is > 0, which the base also read as no sample (`lib/demo/sample.ts:47`). This fixes base finding L4.

## (2) Transcribe answers 409

- `lib/transcription.ts:237`: 503 for `LEDGER_UNIT_PAUSED`, 409 only when `error.message === SAMPLE_LINE`, else 402 as
  before. `SAMPLE_LINE` is thrown only by the guard (`lib/generationRequests.ts:369-370`). Other 409-class reservation
  refusals (run stopped, engine changed, cap) still map to 402 as before; unchanged behaviour.
- Nothing is held or metered before the refusal: the guard runs before `reservationsReady` and `billingTransaction`
  (`lib/generationRequests.ts:369-371` vs :402). The catch returns immediately with `charged: 0`, skipping the
  meter-cleanup branch (:238-244), which was the same for 402. The PR's test and my probes show 0 meter events and 0
  provider calls.
- The 409 is stored on the claim (`withGenerationRequest`, `lib/generationRequests.ts:180-184`, `Idempotency-Status:
  complete`). `sendTranscription` then releases the slot with the line as its reason, and `repriced` stays unset because
  the body has no `estimatedCredits` (`lib/workbench/transcription-request.ts:266-269`). `TranscribePanel` shows it as
  the alert (`components/graphite/production/TranscribePanel.tsx:97-100`), with no top-up control. A later check gives
  "Your last transcription did not complete. <line>" (`transcription-request.ts:186-190`).
- **But** two refusals still come before the reservation (L1).

## (3) Prices, balances, ledger, reservation order

Unchanged. The diff touches only the guard's reading of the mark and the status code of one existing early return. No
pricing, credit, ledger, meter or reservation-order line changed. The guard stays where #544 put it (first in
`reserveGenerationSpendLocked`, :369; admission hooks unchanged).

## Findings

### High: none. Medium: none.

### Low

1. **L1. The Transcribe fix is incomplete: on the sample, a short balance or a moved price answers first.**
   - `lib/transcription.ts:224-227` runs the `maxCredits` check and `allowanceCheck` before the reservation, and the
     guard lives only in the reservation (:235). The audio door asks the guard first (`lib/audioAdmission.ts:229-231`,
     before :351 and :364), and so does generation admission (`lib/generationAdmission.ts:423-428`, before :457 and :562).
   - Scenario A (probed): sample marked, 0 credits, Transcribe on the sample gives **402** "Out of credits (0 left). Top
     up in Settings › Credits."
   - Scenario B (probed): the price moved past `maxCredits` gives **409** "...Review the price before submitting." with
     `estimatedCredits`, and the client then shows a new price (`transcription-request.ts:268`,
     `TranscribePanel.tsx:172`).
   - The Transcribe button is not gated on the sample (`TranscribePanel.tsx:203`; `EditStage.tsx:388`), so a person
     can reach both. Nothing is charged, held or sent in either case. The new comment at :236 ("never 'not enough
     credits'") is not yet true.
   - Fix: in `transcription()`, after the `quoteOnly` return (:221) and before :224, add
     `const sample = await sampleSpendRefusal(typeof input.projectId === "string" ? input.projectId : null); if (sample)
     return { status: 409, body: { error: sample, charged: 0 } };`. Keep the reservation mapping as the backstop. Add
     test cases for credits 0 and for `maxCredits` below the estimate.
2. **L2. An unreadable mark can't be undone, and the owner can't see it.**
   - Probed: with `{not json` or `{"version":2,"projectId":7}`, `hideSampleMark` returns `false` and every job stays
     refused (`mark.server.ts:100-102`, because `parseSampleMark` gives null). Re-marking does recover it: it writes a good
     mark, and spend on other productions resumes.
   - `readSampleMark` and the board read the same row as "no sample", so Home shows no sample card and no Undo. Every
     paid job says "Sample production · nothing here spends credits" with nothing on screen to explain why.
   - A non-JSON bad row is overwritten without being archived. `storedMark` returns null for it (:31), so `hadRow` is
     false (:93). Probed: 0 archived rows for `{not json`, 1 for the JSON-but-misshapen row. That is a small gap in the
     never-delete rule.
   - The comment at `spend-guard.server.ts:31` ("or undoes it") is wrong.
   - Fix (owner's call): pass `row != null` to `writeMark` rather than "parsed". Let `hideSampleMark` archive and hide a
     row that is present but unreadable. Have the board or settings show "the sample mark can't be read: mark or undo
     again" to owners and admins. Only reachable through out-of-band writes today.
3. **L3 (pre-existing, unreachable). `parseSampleMark` cuts and doesn't trim `projectId`.**
   - `text(m.projectId, 100)` (`lib/demo/sample.ts:45`) cuts a longer id, and the guard then compares the cut id, so the
     real project is admitted (probed). A padded `" film"` admits `film` (probed).
   - The writer never produces either: `id100` trims and caps input, and the production id comes from the `projects`
     table, whose ids the app generates short (for example `mappedId`, 31 characters, `lib/workbench/records.ts:41-42`).
   - Fix if wanted: in `guardMark`, refuse when the raw `projectId` is not exactly the parsed one.
4. **L4. Test strength.**
   - The new Transcribe test proves "no Top up" by grepping `TranscribePanel.tsx` source for /top.?up/
     (`demo-s12-no-spend.spec.ts`, last line). The top-up wording comes from the server's error text (`lib/credits.ts:76-77`),
     so that check would not catch L1.
   - The fail-closed test covers the main shapes, but not `hiddenAt` of the wrong type, nor recovery (undo or re-mark) from
     an unreadable row.

## Probes run (scratch file, deleted)

`tests/unit/zz-probe-544b.spec.ts`. It reused the setup of `demo-s12-no-spend.spec.ts` (one database per workspace,
network forbidden, `ENGINE_MOCK=1`). Run with
`env -u CREDIT_USD ENGINE_MOCK=1 PW_BASE_URL=http://localhost:4999 ./node_modules/.bin/playwright test --project=unit --workers=1 tests/unit/zz-probe-544b.spec.ts`:
5 passed.

1. Crafted marks: the 23 rows in the table in (1), each checked for `film`, `other`, unfiled and `shot_film`.
2. `projectId` longer than 100 characters: the full id is admitted, the cut id is refused.
3. SQL `NULL` value: refused by the `NOT NULL` constraint.
4. Recovery from `{not json` and from `{"version":2,"projectId":7}`:
   - undo returns false, and `other` stays refused;
   - re-mark by draft gives `film`, and `other` is admitted again;
   - archived `settings` rows: 0 and 1.
5. Transcribe on the sample: 0 credits gives 402 Top up; `maxCredits: 0` gives 409 with `estimatedCredits: 1`. Both had 0
   provider calls and 0 meter events.

---

# Delta check: 1bb91343..d5faa116 (fixes L1, L4 and the L2 comment)

## VERDICT: PASS

- Worktree `W/rev-544b` detached at `d5faa116`, read-only.
- Diffed all three touched files in full: `lib/transcription.ts` (+5/-1), `lib/demo/spend-guard.server.ts` (comment only)
  and `tests/unit/demo-s12-no-spend.spec.ts`.
- `tsc --noEmit -p .`: 0 errors.
- Unit run, 74 passed and 0 failed (`env -u CREDIT_USD ENGINE_MOCK=1 PW_BASE_URL=http://localhost:4999 playwright
  --project=unit --workers=1`). It covered `demo-s12-no-spend`, `demo-s12-sample-flag`, `transcriptionRecovery`,
  `generationRequests` and `quoteMatchesCharge`.
- Scratch probe `tests/unit/zz-probe-544c.spec.ts`: ran, 1 passed, then deleted. `git status` is clean.

## What changed

`lib/transcription.ts:222-224`: `sampleSpendRefusal(input.projectId)` now runs right after the `quoteOnly` return. It
comes before the claim check, the `maxCredits` check (:228), `allowanceCheck` (:230) and the reservation (:238). On the
sample it returns `409 { error: SAMPLE_LINE, charged: 0 }`. The reservation mapping (:241) stays as the backstop. Prices,
terms, balance and the ledger are untouched, and so are the reservation order and the order for every other project.

## The three points asked

1. **0 credits and a moved price on the sample both give 409 with the line, no top-up and no `estimatedCredits`.**
   Probed with `maxCredits` 100000 and 0 credits, then `maxCredits` 0 and 10000 credits. Both gave
   `409 {"error":"Sample production · nothing here spends credits","charged":0}`. The new spec test asserts the same.
   Without a claim it also answers 409 with the line, not the earlier 500. The quote still answers 200 with its price.
2. **Other projects are unchanged.** With 0 credits, project `other` gets
   `402 "Out of credits (0 left). Top up in Settings › Credits."`. With a moved price it gets
   `409 "...Review the price before submitting."` with `estimatedCredits: 1`. Both match the behaviour before.
3. **Nothing is claimed, held or metered before the refusal.**
   - The probe injected a `reserve` dependency that throws if called: 0 calls on the sample.
   - Provider calls 0, meter events 0, generation rows 0.
   - The platform's `generation_reservations` table never existed in the probe database: `reservationsReady` was never
     reached.
   - The guard is a single read of `settings` and writes nothing.
   - The only row touched is the route's idempotency key (`generation_requests`). `withGenerationRequest` stores the 409
     reply there as complete, exactly as it stores any refusal. That is a request record, not a credit hold.

## Earlier findings

- **L1: fixed.** See above.
- **L4: fixed.** The source grep of `TranscribePanel.tsx` is gone. The test now asserts that the server's reply body has
  no /top.?up/ and no `estimatedCredits`. It also asserts the 0-credit and moved-price cases on both the sample and
  another production.
- **L2: comment only.** `spend-guard.server.ts:31-32` now says undo can't clear an unreadable mark and that marking again
  replaces it. The behaviour itself is unchanged and still open as a Low for the owner:
  - Home shows nothing when the mark can't be read.
  - A row that isn't JSON is overwritten without being archived.
- **L3: unchanged.** It existed before #544 and can't be reached.

## Low (new, minor)

The spec's moved-price case for the other production checks only the 409 status and that the error isn't the sample's
line. It does not check that `estimatedCredits` is present. The probe confirmed it is present.
