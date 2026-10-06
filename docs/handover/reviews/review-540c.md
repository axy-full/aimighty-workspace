# PR #540 (money/cinema-hold) and PR #559 (money/cinema-in-r1): fresh money review of the owner's three decisions

Private. 6 Oct 2026. Read-only; I pushed nothing, commented nothing and merged nothing.

- **#540:** head `de29c356d62fb24142498d9bc1e7a5c583fc3d05`, worktree `W/rev-540c`.
- **#559:** head **`12122025468764ed321b7ddc6369eb1e2bc16027`**, worktree `W/rev-559`.
  - I started on 28e9ddfe. When the coordinator said the head had moved, I moved to 12122025, which merges `fix/r1-hide-cinema` (9064ead2), and re-ran every gate on it.
- Both worktrees are detached and left in place. `node_modules` is linked from `W/d0-main-check` (same lockfile, checked with `cmp`). `public/vendor` was copied in with the two copy scripts.
- Probes are saved in `S/demo/review-540c-probes/` and removed from the worktrees, so both are clean.

## Verdicts

- **#540: PASS.** No high or medium findings; four low ones.
- **#559: PASS.** No high or medium findings; one low one.

**One line for the owner:** Cinema Studio's hold now follows your three decisions exactly:
- a failed take is charged nothing, or its reported cost up to N;
- the extra above 3N never counts against the allowance;
- 24 hours with no answer is "Failed · not charged" and on the admin desk;

and Release 1's Make shows "about N cr, at most 3N cr" everywhere and reserves exactly that. Both PRs are ready to merge, #540 first.

## The owner's decisions, verified

### 1. A failed take

**No cost reported: charged 0, the rest of the hold released, "Failed · not charged", recorded for the admin.**
- **Code:**
  - `lib/meter.ts:94-97` (`heldSettlement`): a running held row that fails is charged 0 when its figure is null or 0.
  - `lib/meter.ts:179`: when the figure is null and the provider gave no outcome, the meter writes a `no_answer` outcome so the admin desk counts the take.
  - `lib/usageLedger.ts` (`withLedgerCharges`) marks `released` when the take is settled, its credits are ≤ 0 and `hold_band` > 1.
  - The chip and the reason say "not charged": `lib/errors.ts` `failedChip`, `failureChargeWord`, `chargeSentence`.
  - The Jobs tray label is "Failed · not charged" for a held engine in credits: `lib/jobsTray.ts` `engineTrayJob`.
- **Probe `r5` A:**
  - The 3N hold (90) comes back whole; balance change 0; billed 0.
  - The take is on `providerFailuresSince` with `kind: no_answer` and its message.
  - Settling it twice, then a third time with figure 0, changes nothing.
- **The provider's own failure:** `lib/genjutsuVideo.ts:72-81` meters `failedUsd`, which is 0 unless the provider stated a cost, with the provider's own outcome (`higgsfieldRequestOutcome`: failed, nsfw or canceled). The admin desk gets the count and the provider's message.

**Cost reported: charged that cost, capped at N.**
- **Code:** `lib/meter.ts:96`. A figure ≤ N is charged as reported. A figure > N is charged N, and `figure − N` goes to `overrun_usd`, which only the admin desk reads.
- **Probe `r5` B:**
  - 0.5N reported: billed 0.5N.
  - 5N reported: billed exactly N, overrun 4N.
  - A second settle: N again, and the overrun is not doubled.
- **Fact:** the Higgsfield poll (`lib/engines/higgsfield.ts:255`) never returns `costUsd`. So today every Cinema failure from the provider is charged 0, and the "capped at N" branch has no live input yet. It is correct and tested for when one appears.

### 2. The extra above 3N does not count against the monthly allowance

- A success past the hold settles `engine_cost_usd` at the cap (3N): `meter.ts` `heldSettlement`.
- The allowance reads `engine_cost_usd` only: `lib/platformSpend.ts` `platformSpendSince` and `lib/cinemaHold.ts` `allowanceUsdOf`. `overrun_usd` is read only by the admin functions.
- **Probe `r5` C:**
  - A success reported at 50N counts 3N.
  - A failure reported at 50N counts N.
  - A third take is still admitted under the remaining allowance.

### 3. 24 hours with no answer

The expiry is `lib/genjutsuVideo.ts:202-234` (`expireUnansweredCinemaTakes`), run by the cron.

**Selection:**
- only `model = higgsfield-cinema-studio-4.0`, `kind='video'`, `provider='higgsfield'`, `deleted=0`;
- status `queued` or `running`;
- `created_at <= at − 24h` (the clock restarts when a held take is released, `lib/held.ts:368`);
- no live collection lease (`higgsfieldVideoPollUntil < now`).

The UPDATE repeats every condition atomically, so a collector that claims the lease in between wins.

**Probe `r5` E:**
- **Expired:** the take at 25 h, the queued one at 26 h, the one at 24 h + 1 s, and the one whose lease had lapsed.
- **Untouched:** the take at 23 h, one under a live lease, a held take, a succeeded take, a Genjutsu take at 40 h, a Seedance take at 40 h, and a hidden one.
- **Repeat run:** a second run expires nothing.
- **Hold:** each expired take's full hold (90) comes back.

**A late answer after the expiry: the customer is never charged, the balance never goes negative, and nothing is refunded twice.**
- The collector cannot claim a failed row (`status IN ('queued','running')`), so no settlement is written. Probe: `reconcileGenjutsuVideo` on an expired take with a handle leaves the take failed and billed 0, with balance change 0.
- Even if a meter event did arrive, the settled basis is 0, so `heldSettlement` caps it at 0. Probe: a late success and then a late failure with 3N both bill 0, balance change 0.
- The platform absorbs whatever the provider bills, as the author says.

**The cron stage `cinema_unanswered`** (`app/api/cron/sync/route.ts`):
- It sits inside the `stage()` wrapper, which catches errors, before `held_jobs`.
- The PR's test runs the route with this stage failing and with an earlier stage failing. Every other stage still runs, and the visit reports failed.
- It is safe to run again: the work is idempotent, and the settlement outbox re-delivers.

### And

- **Hold admission:**
  - Unchanged since my last pass at 61dcb02c: 3N reserved before sending, atomically, in the same reservation as every render (balance, production and shot caps, monthly allowance at the hold, run limits).
  - Earlier probes r1, r3 and r4 still pass on de29c356.
  - r2 now fails on one line only: it asserted the old rule (no figure → N), which decision 1 replaced with 0. Its other checks pass: the 96 cap, units converted once, balance exact.
- **Settlement never charges above 3N, and never above N on a failure.** Probe `r5` D:
  - A success at 100N bills 3N, with overrun 97N recorded for the admin only.
  - A failure after a success is ignored.
  - A repeated success stays at 3N.
- **Only a person approves:** unchanged. Token and `agent:` ids are refused a hold.
- **No vendor cost shown to customers:**
  - `overrun_usd` and the admin cards (`HoldOverrunsCard`, `meterSummary`, `meterByWorkspace`, `engineHealth`) are reached only through `requireSuperAdmin` routes (`app/api/admin/engines`, `app/api/admin/invites`).
  - Customer strings are words only: "The engine charged more than you approved…", "Failed · not charged".
- **Non-Cinema engines are unchanged.** Probe `r5` F: a Seedance failure with no figure keeps its reservation, band null.

## Findings: #540

**L1. A Cinema failure whose outcome could not be read is not on the admin desk.**
- In `genjutsuVideo.ts:72-79`, `said` is `fundedOutcome(...).catch(() => null)`.
- If that read fails, the meter gets figure 0 (not null), so `heldSettlement` does not set `unreported` and nothing is recorded (`meter.ts:179`).
- `providerFailuresSince` (`meter.ts:408`) requires `provider_outcome IS NOT NULL`, so the take is left out of the admin count. The customer is still charged 0.
- Probe `r5` G fails as expected.
- **Fix:** in `heldSettlement`, set `unreported` for a failed held take with figure 0 as well as null. Or in reconcile, fall back to `higgsfieldRequestOutcome(state.raw)` without the funding when `fundedOutcome` throws.

**L2. Customer copy contradicts the new rule on an uncertain Cinema submit.**
- `lib/submitVideo.ts:346` says "…its estimated cost remains reserved until the provider outcome is reconciled", but a Cinema take now settles at 0 with its hold released (`meter.ts:94-95`).
- The tenant row also keeps `cost_usd = N` (`submitVideo.ts:178`), while the ledger says 0.
- It errs in the customer's favour; it is display only.
- **Fix:** for held models, say nothing was charged.

**L3. The admin card's copy covers successes only.**
- "Over the hold · absorbed" (`app/(app)/admin/page.tsx:581`) says "charged more than the person approved… charged the hold".
- A failure reported above N is also listed there, with `figure − N` absorbed. That take was charged N, not the hold, and its figure may be below 3N.
- Admin-only.
- **Fix:** reword, or split failures into their own row.

**L4 (informational).** An expired take can be reopened in one case.
- If the expiry's ledger delivery fails (the platform database is down), the Higgsfield receipt stays unsettled.
- `restoreHiggsfieldGenerationReceipt` (`lib/higgsfieldGenerationReceipts.ts:79`) can then set `failed → running` and collect again.
- This is the existing design for unconfirmed requests, and it cannot overcharge:
  - a later success replaces the pending failed event and settles at most 3N, consistently;
  - a take whose ledger row already settled at 0 is capped at 0.
- Separately, a take whose provider keeps answering "in progress" for 24 h is also expired. That is my reading of "no answer"; the owner may want to confirm it.

## Findings: #559

**L5. The 390x844 run of demo-13a test 1 fails on the first test after a cold webpack server start.**
- It failed twice: once on a click stuck in "scrolling into view", once while the page was still navigating.
- On the warm server it passes 2/2, and my probe, which uses the identical flow, passes.
- It does not come from the code. CI's sharded runs may see the same thing on a cold shard.
- **Fix, optional:** wait for `networkidle` after `goto` in `open()`.

**Verified on 12122025:**
- **The flag:** `MAKE_SHOWS_CINEMA = true` (`lib/shell/make-price.ts:22`). `hiddenInMake` is only `!flag && isCinema`, so with the flag on it hides nothing.
- **The hide branch's two files:**
  - Make passes `hide: hiddenInMake` to `useComposer` (`components/graphite/make/use-make.ts:92`, the one import kept).
  - `lib/shell/recreate-price.ts:58` filters hidden engines, so Again or Recreate on a Cinema take quotes Make's default engine while the flag is off, and Cinema's own held price while it is on.
  - The new `tests/r1-hide-cinema-workbench.spec.ts` passes at 1440 and 390, and the new unit test passes.
- **Hold wording wherever a Cinema price shows:**
  - Make on desktop: the button, through `composerButtonParts` and `cinemaPriceWords`.
  - The engine list row (`EngineList.tsx:47`, `rowValue` in `use-make.ts`).
  - The takes chips (`EngineList.tsx:247-250`).
  - The phone's engine sheet row (`phone/MakeScreen.tsx:136`) and button.
  - The model sheet: `rowPrice` (`lib/workspace/model-picker.ts:193-199`) prices Cinema from the server's rate, says it as "about N cr, at most 3N cr", and no longer reads "quoted".
  - Recreate and Retry: `priceWords` and `ctxPrice` in `recreate-price.ts`, plus `AssetInspector`, `SuitesShell` and the phone's `StatesScreen` Retry, which shows `{cr, atMost: 3N}`. Again on Recent's card shows no price; it hands the recipe back to Make's button.
  - The Jobs tray's Release.
  - The Rig agent's approval and credit lines (`lib/workbench/rig-agent-runs.ts:207-210,431,440,450`). Its third, "draft over the line" branch still says "about N", but it cannot happen for Cinema: `supportsDraft` is off and admission refuses `draft`.
- **Prices come from the server:**
  - Rows read the engines route's rates.
  - The send uses `/api/generate/quote`'s `ceilingCredits` as `maxCredits` (`lib/workspace/generate-submit.ts:140-143`), after checking it is a whole number ≥ the estimate.
- **The price on the button equals what is reserved.** demo-13a sends `maxCredits: 3N` and the fingerprint, single and as a batch of three, on desktop and phone. Admission reserves `heldCredits(N)` = 3N.
- **Nothing sends before a person's press.** My browser probe `review559-probe-workbench.spec.ts` waits 3 s with the button priced and sees no POST, then exactly one after the press, at 1440 and 390.
- **The phone sends Auto at the same held price.** The quote body and the sent body carry the same `cinema` (none set, i.e. Auto). The phone sends `maxCredits` 93 = 3 × 31.
- **Money code is the same as #540.** `lib/meter.ts`, `genjutsuVideo.ts`, `cinemaHold.ts`, `platformSpend.ts`, `allowance.ts`, `caps.ts`, `shotCap.ts`, `held.ts` and `errors.ts` are byte-identical to de29c356. The other differences are Release 1's own:
  - the sample production's spend guard;
  - renames;
  - the connected-jobs stage gated off for Release 1 (`SIGN_IN_OFF`).

  Probe `r5` gives the same results on #559.

## What I ran (logs in /private/tmp)

| Run | Result | Log |
|---|---|---|
| tsc #540 de29c356 | clean | `claude-review-540c-tsc.log` |
| Full unit #540 (`env -u CREDIT_USD ENGINE_MOCK=1 … --project=unit --workers=2`) | **3274 passed, 3 skipped, 0 failed** | `claude-review-540c-unit.log` |
| Probe r5 (owner's decisions), #540 | A–F pass; G fails (L1) | `claude-review-540c-probe-r5.log` |
| Earlier probes r1, r3, r4 on #540 | pass | `claude-review-540c-probe-r{1,3,4}.log` |
| Earlier probe r2 on #540 | fails on the old "no figure → N" line only (superseded by decision 1); rest pass | `claude-review-540c-probe-r2.log` |
| tsc #559 28e9ddfe / 12122025 | clean / clean | `claude-review-559-tsc.log`, `claude-review-559b-tsc.log` |
| Full unit #559 28e9ddfe | 3740 passed, 6 skipped, 0 failed | `claude-review-559-unit.log` |
| Full unit #559 **12122025** | **3741 passed, 6 skipped, 0 failed** | `claude-review-559b-unit.log` |
| Probe r5 on #559 | same as #540 (A–F pass, G = L1) | `claude-review-559-probe-r5.log` |
| Browser 12122025, 1440x900 and 390x844 (webpack mock server; PW_CHANNEL=chrome): demo-13a, r1-hide-cinema, my probe | 7 passed, 1 failed (demo-13a test 1 at 390, cold server, L5) | `claude-review-559d-b1.log` |
| demo-13a at 390, warm, `--repeat-each=2` | 2/2 passed | `claude-review-559d-b1r.log` |
| cinema-controls + cinema-sound, 1440 and 390 | **18 passed**, 8 skipped by the specs, 0 failed | `claude-review-559d-b2.log` |
| project-generation, 1440 and 390 (fresh server) | **5 passed**, 3 skipped, 0 failed | `claude-review-559e-b3.log` |

## Housekeeping

- I held slot-4 (`review540c`) for the whole run and have released it.
- Mock servers `review559c`, `review559d` and `review559e` were started and stopped with `mock-server.py`.
- I moved `W/rev-559` with `git switch --detach 12122025` (no checkout, restore or reset).
- Both worktrees are left in place and clean.
