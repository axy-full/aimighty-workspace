# PR #523 (Cinema Studio: "about N cr, at most 3N cr", a 3N hold): independent money review

Private. Stream 14, 6 Oct 2026. Head `3018e5f8aa5985d2931e30f32a0b8009b21ed43c` on `d0/make-cinema-price` (merges main 3ce363d8 / #531). The worktree was `W/review-523` (detached), since removed. I pushed nothing. The probes are kept in `S/demo/review-523-probes/` and are run with `review-probes/pw.config.ts`.

## Verdict: FAIL

The hold mechanics are sound: 3N reserved in the ledger's unit, settlement capped at the hold, the unused hold released, no debt, correct with #524, concurrency safe. Three things block the merge:
- the caps admit a Cinema take at N, not at its 3N hold (H1);
- an existing browser test still asserts the old 1N approval, so CI cannot go green (H2);
- the branch carries D0 5a/5b screen work that the owner has not preview-checked (H3).

## Findings

**H1. Every cap admits a Cinema take at N, not at its 3N hold, so the take can settle up to 2N past an admin's cap.** Proved by probe `r1-caps-and-concurrency.probe.ts`, tests A, B and C, which fail on 3018e5f8.
- **Project cap, rule "stop" (test A):**
  - The admission check uses the estimate: `lib/generationAdmission.ts:2072` calls `checkCap(projectId, estUsd, modelId)`, and `lib/caps.ts:164` turns that into credits at 1N.
  - The reservation gate also uses 1N: `lib/generationRequests.ts:464` has `needs: charge(cost…)`, which is not `held`.
  - Scenario: cap 60 cr, N = 30. The take is admitted, its 90 cr hold reserved, and it settles at 90. The project then reads "spent 90" against a cap of 60, with no admin involved.
- **Shot cap, member under the "cap" rule (test B):** `lib/shotCap.ts:24` (`takeCredits = billCredits(takeUsd)`, called with `takeUsd: estUsd` at `generationAdmission.ts:2053`) and `generationRequests.ts:459` (`shotCredits + charge(cost)`). With a 60 cr shot cap and N = 30, a member's take is admitted without an admin.
- **Workspace monthly allowance (test C):** `lib/allowance.ts:70` (`spent + estUsd > cap`) and `generationRequests.ts:461` (`+ cost`). An allowance that covers 2N's dollars admits the take, which then settles at 3N.
- **Token ceilings:** `generationRequests.ts:481,489` have the same gap (they use `charge`, not `held`). There is no exposure today, because tokens are refused a hold at `generationAdmission.ts:2202`.
- **Fix:** in `reserveGenerationSpendLocked`, check the shot, project, monthly and token caps at the hold (`held`, or `cost * holdBand` for dollar caps). At admission, pass `band` into `checkCap`, `shotCapGate` and the allowance's dollar check, as is already done for `creditCheck`.
- Other running Cinema takes already count at 3N, because their `billed_credits` is the hold. Only the new take is under-counted.
- The project cap of 0 still means no cap (`lib/caps.ts:28`). That is known and owner-pending; I have not changed it.

**H2. CI cannot go green: an existing test still asserts the 1N approval.** `tests/project-generation-workbench.spec.ts:139` expects the canvas dialog button "Generate · about 35 cr" and `maxCredits: 35`.
- The PR correctly changed the dialog to "about 35 cr, at most 105 cr" and approves 105 (`components/workbench/GenerationDialog.tsx:368,627`), but did not update this test.
- It failed in CI on 62e456ce (run 37302678321, workbench shards 4 and 9) and fails locally on 3018e5f8 at 1440x900 and 390x844 (`/private/tmp/claude-review-523-browser-b3.log`).
- Fix: expect the two-run wording and `maxCredits: 105`.

**H3 (scope, not money). Merging #523 also ships D0 5a/5b.** `git range-diff` shows #523 carries the first five commits of `d0/pr5a-make-panel` and `d0/pr5b-quick-tools` (5f0ff4b0, cf843d5c, e6d52e43, a1c41292, 39385b2b):
- Make as a panel;
- the Gen page redirecting to Make;
- Motion transfer and Object swap as Make's quick tools.

These are older versions than #512/#514's current heads, and they would land on main without #511/#513. That bypasses the merge order and the owner's preview check that the brief requires for those PRs, and the overlapping files will conflict when #512/#514 are rebased onto main. Rebase #523 on main without them, or merge #511 → #513 → #512 → #514 first.

**M1. The 390x844 "Gen" browser tests fail locally** after the Gen → Make redirect navigates mid-test:
- `tests/cinema-controls-workbench.spec.ts:136`: "Execution context was destroyed" in the palette sheet, on two fresh runs;
- `tests/cinema-sound-workbench.spec.ts:162`: `gen-sound-toggle` not found after navigating to `/suites?…&make=video`.

These come from the stacked D0 5a work, not from the hold. They were not in CI's failure list for 62e456ce, so they may be specific to a cold local webpack server. Unconfirmed; check CI run 37380492257's results.

**L1. A re-reservation without `holdBand` would silently drop the hold.** `generationRequests.ts:513` has `ON CONFLICT … hold_band=excluded.hold_band`, so a second `reserveGenerationSpend` on a running Cinema take without the option resets the reservation to 1N and clears the band, and settlement would then be uncapped. Only admission (`:2356`) and Release (`held.ts:325`) reserve Cinema takes today, and both pass the band, so this is latent. Fix: `hold_band=COALESCE(excluded.hold_band, meter_events.hold_band)` and keep `held` for a prior row.

**L2. No dollar hover on the Cinema price** in Make (engine line), the composer button or the canvas dialog. The design and rule 11 say hovering a price shows its dollars at CREDIT_USD. Nothing wrong is shown; the hover is just absent.

**L3. An uncertain take now ties up 3N instead of N until its provider resolves.** A take whose poll never resolves keeps its whole hold, because polling is lease-based with no give-up (`lib/genjutsuVideo.ts`). This is the same semantics as before, at three times the size. A failure with no figure is charged N with 2N released, as § 4.2 asks.

## Verified (with the test that shows it)

- **Hold size:** exactly 3N in the workspace's unit (`generationRequests.ts:435`), recorded on the row (`hold_band`). Other engines keep band 1 (`cinemaHold.ts:24`; `heldInfo`, `heldPriceNow` and `creditCheck` multiply by 1). Tests: the PR's demo-13a "Make approves the hold…", and r1-D (N 30 → 90 held).
- **Settlement:**
  - Actual cost up to the hold, and the hold when past it (`meter.ts:84` heldSettlement, plus `cinemaStudio.ts` `cinemaStudioSettlement`). With no figure, N. A later figure can lower the charge but never raise it.
  - The over-hold amount is recorded once and only the platform admin route reads it (`app/api/admin/engines`, `requireSuperAdmin`). Customers see the words-only mark.
  - Whole credits, rounded up per job, and ceil(3x) ≤ 3·ceil(x), so the bill is never past the hold.
  - Every exit path goes through `meter()` and the same rule: success, failure with a provider figure, refunded (0), didn't say (null → N), interrupted or uncertain (null → N), and outbox replay. A double settle changes nothing (probe r2).
  - Tests: demo-13a "settles at its actual cost…", "past the hold…", "an overrun end to end…".
- **#524 interaction** (probe `r2-ledger-unit.probe.ts`, passes):
  - The pause refusal (`generationRequests.ts:419`) runs before the hold and leaves no row.
  - A take held at $0.80 (12 cr) converts to 96 cr.
  - Settled with an engine figure ten times the quote, it books 96: capped, with the unit applied once.
  - A take with no figure books 32 (N × 8).
  - The balance comes out exact.
- **Balance wall and concurrency:** both reservation and Release need 3N. Short of it, the take is held with Top up, never put into debt (demo-13a "the balance must cover the hold"). With a balance of 4.5N and two takes at once, one is admitted and the other refused 402 (probe r1-D).
- **Words:** "about N cr, at most 3N cr" is built from the same N admission holds (the batch total is per-take whole credits × count, so its "at most" equals the sum of the holds).
- **Approvals:** only a person approves a hold. Tokens and `agent:` ids are refused at admission (`:2202`) and at Release (`app/api/jobs/[id]/release/route.ts:38`).
- **No vendor cost, markup or margin** appears in any customer response, string or test name added. The overrun dollars are admin-only. The PR's admin-desk test uses fixture figures only.
- **The PR's 9 hold tests** cover hold size, settlement, the balance wall, overrun and approvals. They do **not** cover caps (H1), concurrency or #524 (my r1-D and r2 now prove those).

## What I ran (logs in /private/tmp)

| Run | Result | Log |
|---|---|---|
| Install: `NPM_CONFIG_CACHE=/private/tmp/review523-npm-cache npm ci` (lockfile differs from lead-1005) | ok | `claude-review-523-npmci.log` |
| Full unit: `env -u CREDIT_USD ENGINE_MOCK=1 PW_BASE_URL=http://localhost:4999 ./node_modules/.bin/playwright test --project=unit --workers=1` | **3,269 passed, 0 failed, 3 skipped** (bundle, no build) | `claude-review-523-unit.log` |
| Focused: demo-13a hold, cinemaStudio, cinemaSound, cinemaStudioControls, creditConversion | 82 passed | `claude-review-523-focused.log` |
| Probe r1 | A, B, C fail (H1); D passes | `claude-review-523-probe-r1.log` |
| Probe r2 | passes | `claude-review-523-probe-r2.log` |
| Browser, demo-13a hold + cinema-controls (1440x900, 390x844) | 13 passed, 1 failed (cinema-controls 390, M1); the 390 rerun on a fresh server failed again | `claude-review-523-browser-b1.log`, `-b1r.log` |
| Browser, cinema-sound + hf-batch-takes | 25 passed, 1 failed (cinema-sound 390, M1) | `claude-review-523-browser-b2.log` |
| Browser, project-generation "ceiling sent" | 2 failed (H2) | `claude-review-523-browser-b3.log` |

- The browser runs used my own mock server `review523` on :4722 with a fresh DB (`/private/tmp/particl-suites/review523`), started from my worktree rather than the author's. It was restarted between batches and then stopped (PIDs 67375/67379, 67884, 68260, 68696/68701).
- Slot-1 was held 22:22Z–22:40Z and then released. I got it on the 8th retry.
- CI run 37380492257 on 3018e5f8: core, unit 1–3 and Vercel passed; the 16 browser shards were still pending when I wrote this.
