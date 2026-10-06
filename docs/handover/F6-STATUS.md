# F6 status (paused for handover, 6 Oct 2026 evening IST)

Branch `fix/r1-ci-f6` (worktree `W/r1-f6`), based on release/1 and merged with origin/release/1 e87181d6. CI run read: 37461676773 on fa9956d0 (951 failures = 275 tests; table of every failing test with first error: `F6-CI-TABLE-fa9956d0.txt`). Nothing of F6 was pushed before this pause; the lead merges the branch, never push to release/1.

## Fixed (verified locally unless marked)
| group | what | state |
|---|---|---|
| F6c | `hf-phone-chrome` rewritten to measure the phone app (header, tab bar, screen share, floors, last row, rotation, a desktop keeps its header) | passes at 360, 390, 844 and desktops (run A) |
| Workspace tabs | `suites-workspace` retargeted to the Settings sections (Connections, Advanced, Team, Plan & credits, Prompt rules, rename); `audit-money`, `entry-points-audit:52,:63`, `hf-usage-ledger`, `hf-credits-out`, `hf-plans-as-media` retargeted | audit-money, entry-points, suites-workspace (3 of 5) passed; the others edited, NOT yet re-run |
| F6a | helper `tests/helpers/projectName.ts` (header project segment; the Make panel opens over Home), `openAdvanced` now opens Change first; project-name waits replaced in ~35 spec files; compact (phone) skip with the covering phone spec named in ~25 composer specs | desktop re-run of the composer family was interrupted by the pause |
| F6b | `hf-error-boundaries` rewritten for Home/phone/Settings/atomik-panel boundaries; `hf-first-run` retargeted to the board's first-run card (Studio home deleted); `hf-jobs-tray`, `hf-shared-key` open Home | hf-first-run 3/3, hf-jobs-tray passed at 1440 |
| other | `demo-board-everyone-audit` phone twins (Record + phone Make price) pass at 360 and 390; `suites-viral` and `make-quick-tools` skip phones; screenshot folders default to os.tmpdir() (7 files, were hard-coded /private/tmp and failed on Linux CI); `make-short-form` rewritten for the new panel (not yet re-run); one product line: test ids `settings-reach-video|image` in `CreditsSection.tsx` |
| lint | `tests/unit/demo-s12-route.spec.ts:44` require(): already fixed upstream in f27f4e84; eslint on the branch: 0 errors |

## Failing by cause (CI 37461676773, tests) and what is left
- Composer specs of the old Gen panel (`?make=` family, ~60 tests): vehicle fixed; still need a desktop run to see assertions that drifted from the new Make (engine rows instead of the model sheet: hf-model-picker 10, make-prices 5, hf-recreate-recipe 13, hf-film-vocabulary 8, seedance-draft-final 6, suites-draft-merge 12, hf-batch-takes 4, suites-gen 4).
- Library / Inspector / Studio-page specs (~45 tests: suites-assets 5, suites-preview 6, suites-shortcuts 1, suites-recovery 4, suites-next-actions(-priced) 9, suites-shell 10, ui-floors-audit 6, hf-card-contract 4, suites-virtual-lists 1): no address mounts the old Library, Inspector, page head or strips any more. Needs a lead decision: delete these specs with a docs/old-shells.md line (the board's drawers are covered by demo-s03-drawers) or port. The money ones (suites-next-actions-priced: Inspector prices Upscale, Outpaint, Animate) must be ported to the board Inspector, never dropped.
- Old Atomik pages (page-title, tools-view, memory-view; ~25 tests: atomik-memory 4+5, atomik-skills 3, atomik-tools-connections 7, atomik-threads:314, atomik-audit:122, suites-atomik-gate 4): control room / Settings Connections now; not yet touched.
- Old Viral history (hf-viral-real-runs 6, suites-viral 3 at phones): History view unreachable; phone has no quick tools (fixme twin in demo-s10-phone-make).
- Not mine, seen: spend-buttons ratchet (21 files with unpriced spend controls), gaps-l1/l2 and r1-gap specs wrote to /private/tmp (fixed here), moleculr-marketing, video-frame, workspace-switchover, atomik-key-steps.
- CI `core` failed on `scripts/account-http-rehearsal.mjs` (not a spec).
