# PR #540 (money/cinema-hold, replaces #523): money re-review

Private. Stream 14, 6 Oct 2026. Head `5c58f112c28dafa3a4170fac1dcc72a455786215`, base main `3ce363d8`. The worktree was `W/review-540` (detached), since removed. The probes are kept in `S/demo/review-540-probes/` (r1, r2, r3 with `pw.config.ts`). I pushed nothing.

## Verdict: FAIL, one MEDIUM money finding (M1). Gates incomplete: no slot in 45 minutes, so no full unit or browser run; CI still queued

Every finding from my #523 review is fixed and proved, except one part of H1: takes still running count at their estimate in the monthly allowance.

## Finding

**M1. The workspace's monthly allowance counts a Cinema take that is still running at its estimate, not at its hold.** A second take is admitted, and both can settle past the allowance. Proved by `r3-inflight-allowance.probe.ts` test E, which fails on 5c58f112.
- Where:
  - the reservation: `lib/generationRequests.ts:454`, where `monthly.set(id, … engine_cost_usd)` reads a running held row at 1× its dollars;
  - admission: `lib/platformSpend.ts:105-108` (`platformSpendSince` sums `engine_cost_usd`), read by `allowanceCheck` (`lib/allowance.ts:69-71`).
  - The new take itself is counted at its hold (fixed); only the takes already running are under-counted.
- Scenario (E): allowance = 5× one take's estimate.
  - Take 1: 0 + 3× ≤ 5×, admitted.
  - Take 2: 1× (take 1 at its estimate) + 3× = 4× ≤ 5×, admitted at admission and in the reservation.
  - Both settle at their hold: 6× against an allowance of 5× (the probe shows a settled total of 12 against an allowance of 10, in fixture dollars).
- The credit caps (project, shot, token) are **not** affected: they read running rows by `billed_credits`, which is the hold.
- Fix: count a running row with `hold_band > 1` at `engine_cost_usd × hold_band`, in both `generationRequests.ts:454` and `platformSpendSince`. The overrun dollars (`overrun_usd`) of settled takes are not counted against the allowance either; whether they should be is the owner's call (L).

## Low / informational

- **L1.** The hover is present only on Make/Gen's Generate price and the canvas dialog (`components/make/Composer.tsx`, `GenerationDialog.tsx`, via `cinemaPriceDollars` and the session's `creditUsd`; it shows credits × price only, no vendor figure). The Atomik buttons, the Rig and the Jobs tray have no hover.
- **L2.** Gen's batch strip, "approved at" (`components/graphite/GenView.tsx:63-66`, `approvedTotal`), sums the per-take quote N for a Cinema batch, not "about N cr, at most 3N cr". Display only.

## Checked and verified

1. **Scope (H3 closed).**
   - `git diff origin/main...origin/money/cinema-hold --stat` lists 56 files: money, display wording and hover, and tests.
   - There is no `MakePanel`, no `lib/shell/*`, no Gen redirect and no quick tools. The D0 5a/5b commits are absent from `git log origin/main..HEAD`.
   - Main's Gen keeps every piece of the hold:
     - Composer sends `maxCredits: heldCredits(perTakePrice)`;
     - the button reads `cinemaPriceWords` (`lib/workspace/composer.ts`);
     - `generate-submit.ts` sends the server's `ceilingCredits`;
     - the canvas dialog and the phone board send the hold.
   - The other component changes (`ui/Button` `costText`, the Atomik views) only carry the wording.
2. **Caps at the hold (H1).**
   - Code: project cap (`caps.ts` checkCap band; admission `generationAdmission.ts:2074`; reservation `generationRequests.ts:469`), shot cap (`shotCap.ts`; admission `:2057`; reservation `:464`), allowance for the new take (`allowance.ts:71`; reservation `:466`), token ceilings (`:486,:494`).
   - Probes r1 A–C **pass now**: the project cap refuses ("needs 90 cr" against a 60 cr cap), the shot cap refuses, and the allowance refuses at admission (429) and in the reservation.
   - Non-Cinema engines are unchanged: r3 test F, `hold_band` null, admitted at N under caps of N.
   - A project cap of 0 still means no cap (`caps.ts:28`, unchanged).
3. **H2.** `tests/project-generation-workbench.spec.ts` was updated; the PR also adds a hold browser spec. CI (`check-merge.py 540`): run 37389058222 is **WAIT / queued**, created 23:32Z and still queued at 00:30Z. No result yet.
4. **L1 of #523 closed.**
   - `hold_band=COALESCE(excluded.hold_band, meter_events.hold_band)` (`generationRequests.ts:518`) and `keptBand` from the prior row.
   - Tested by the PR's caps spec ("a second reservation of a running held take keeps its hold and band") and by my r3 test G: re-reserved without the option, it stays at band 3 and the 90 cr hold, and settles at most 90.
5. **Nothing new on the main paths.**
   - Band × unit is applied once (r2 passes: 12 → 96 held after conversion, settles at 96 capped, 32 with no figure, balance exact; the pause comes before the hold).
   - Rounding is whole credits ×3, and settlement is ≤ the hold.
   - The larger hold is released at settlement, so the caps then read the settled `billed_credits`.
   - Concurrency: the balance admits one of two takes (r1-D).

## What I ran (logs in /private/tmp)

| Run | Result | Log |
|---|---|---|
| `npm ci` | ok | `claude-review-540-npmci.log` |
| Probes r1 (A–D) | 4 passed | `claude-review-540-probe-r1.log` |
| Probe r2 | passed | `claude-review-540-probe-r2.log` |
| Probe r3 | E failed (M1); F and G passed | `claude-review-540-probe-r3.log` |
| Focused unit, no slot needed: demo-13a hold, demo-13a hold caps, cinemaStudio, cinemaSound, cinemaStudioControls, workspaceComposer, creditConversion, capSpend, tokenCreditCeiling, billingTerms, heldRelease | **128 passed, 0 failed** | `claude-review-540-focused.log` |
| Full unit, browser specs | **not run**: `slot.sh acquire review540` returned "none" for 45 minutes (23:38Z–00:23Z; the overnight limit is one slot, held by `d0fix`) | — |

## Housekeeping

- `W/review-524b` was removed after its probes were saved to `S/demo/review-524-probes/`.
- `W/review-540` was removed after its probes were saved to `S/demo/review-540-probes/`.

---

# Narrow re-check at 61dcb02c (6 Oct, ~01:45Z)

**Verdict: PASS on the code. M1 is fixed and L2 is fixed. #540 cannot merge yet:** CI's `core` job is red, from a new npm advisory unrelated to #540, and the browser shards had not finished.

## The commit's changes

The diff from 5c58f112 to 61dcb02c touches six files and nothing else (item 5):
- `lib/cinemaHold.ts`
- `lib/platformSpend.ts`
- `lib/generationRequests.ts`
- `components/graphite/GenView.tsx`
- `lib/workspace/use-composer.ts`
- the caps test file

## Checks

1. **Probe r3 test E now passes.** Take 2 is refused at admission (429) and in the reservation, and the settled total is 6 against an allowance of 10. Probes r1 A–D, r2, r3 F and G all pass.
2. **`allowanceUsdOf` (`lib/cinemaHold.ts:88-93`) counts each row once, never doubled.** Probe `r4-allowance-states.probe.ts`, new, passes.
   - A row with `status='running'` and `hold_band` above 1 counts at `engine_cost_usd × band`.
   - Every other row counts at its recorded `engine_cost_usd`. For a settled held take that is the settled, capped figure.
   - Admission (`platformSpend.ts:106-111`) replaces each id's record with `set`.
   - The reservation (`generationRequests.ts:456`) takes the larger of the record and `allowanceUsdOf`, rather than adding them.
   - r4 shows the sequence: a take running counts 3×; once settled at its estimate it counts 1×; a second take is then admitted (1× + 3× ≤ 5×); a refunded failure counts 0.
3. **Every state is counted correctly.**
   - Every reserved-but-unsettled state is `meter_events.status='running'` and counts at 3×. That covers queued, in flight, awaiting the provider, and a failed meter write that left the row running (the safe side).
   - A take held for credits or approval has no meter row (nothing is reserved) and counts 0.
   - Failures:
     - an interrupted or uncertain failure settles at N (no figure) and counts 1×;
     - a refunded failure (0) counts 0;
     - an outbox replay writes the settled figure, so a failed or refunded row is never counted at 3×.
4. **`modelId` changes display only.** It is set only on the shell's batch-follow record (`use-composer.ts:554`) and read only by `approvedTotal` (`GenView.tsx:64-68`). `holdBandOf(undefined)` is 1, so non-Cinema batches read exactly as before. Nothing priced or sent depends on it.
5. **Tests.** The PR's caps spec has 7 tests and mine have 4; all pass. Focused money unit files (12 files): **143 passed, 0 failed** (`/private/tmp/claude-review-540b-focused.log`).

## Gates and CI

- **Not run by me:** full unit and the browser specs. `slot.sh acquire review540` returned "none" for all 40 minutes (00:59Z–01:39Z), because `d0fix` held the single overnight slot.
- **CI run 37394165233** on 61dcb02c (`check-merge.py 540`: WAIT, in progress):
  - **unit 1–3 pass**, which is the full unit suite;
  - Vercel and 5 browser shards pass, and 11 shards were pending;
  - **`core` FAILED** at `npm audit --omit=dev --audit-level=high`: a new high advisory for `source-map-js` 1.0.0–1.2.1 (GHSA-68fv-2mgg-jv7q), "fix available via npm audit fix". Log: `/private/tmp/claude-review-540b-ci-core.log`.
  - That failure is **not caused by #540**, which changes no package files. It will fail on main and every PR until a dependency PR bumps `source-map-js` (lockfile only).

## Housekeeping

- Probes: r1–r4 are in `S/demo/review-540-probes/`.
- `W/review-540b` was removed.
