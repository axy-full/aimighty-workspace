# CI: what runs when

`.github/workflows/verify.yml` runs on every pull request into `main` or `release/1`, and on every push (merge) to `main` or `release/1`. Which browser specs run is decided by its first job, `plan`, from `scripts/ci-select.mjs` (a dry run of it over example diffs is `tests/unit/ci-select.spec.ts`). The unit shards (3) and `core` run every time, in every mode.

## What runs when

| Event | Mode | Runs |
|---|---|---|
| push to `release/1` or `main` (every merge) | **full** | the whole browser suite: 16 `browser-shards` jobs (12 workbench, 4 customer), plus the five-minute test |
| pull request into `main` | **full** | the same |
| pull request into `release/1` that touches money, sign-in, tenant separation or shared code | **full** | the same |
| pull request into `release/1` that only touches new-interface files and their tests | **slim** | the specs its changed paths map to, plus the fixed guard set, plus the five-minute test |
| pull request into `release/1` that only changes documentation | **docs** | no browser specs, no five-minute test |

When the plan cannot be made (the changed files cannot be listed) the run is full.

## Which paths run slim

A PR runs slim only if every changed path is on this list, and none of them is on the full list below it. **Anything not on the slim list is a full run: when in doubt, full.**

Slim list:

- `docs/**`, top-level `*.md`, `design/**`
- `components/v12/**` except `components/v12/ui/**`
- `lib/v12/**` (except what the full list names)
- `tests/*.spec.ts` (a changed spec runs itself), `tests/redesign/**`, `tests/unit/**` specs other than the guards below
- `scripts/redesign/**`

Always a full run, even under the paths above:

- a path that names money, sign-in or tenant separation: `quote`, `price`, `pricing`, `spend`, `unpriced`, `approval`, `credit`, `ledger`, `billing`, `budget`, `payment`, `stripe`, `topup`, `auth`, `session`, `signin`, `signup`, `invite`, `tenant`, `workspace`, `middleware`, `permission`, `privacy` (so `lib/v12/quote.ts`, `lib/v12/useQuote.ts`, `lib/v12/billing.ts` and `components/v12/settings/**` billing files are full)
- `app/api/**`, `middleware*`, and everything in `lib/` outside `lib/v12/` (`lib/auth*`, `lib/session*`, `lib/credits*`, `lib/workbench/**`, …)
- `components/v12/ui/**` (shared primitives), and everything else outside `components/v12/` (`components/graphite/**`, including the board, `SpendButton` and `BoardView.tsx`; `components/workbench/**`, …)
- `tests/helpers/**`, and the guard tests: `tests/unit/spend*`, `ui-names*`, `one-design*`, `signin*`, privacy and tooltip specs, `spend-ratchet.json`
- `playwright*.config.ts`, `package.json`, `package-lock.json`, `next`/`tsconfig`/`eslint`/`postcss` config, `scripts/ci-*`, and `.github/**` (the workflow itself)

## What a slim run runs

1. **The specs the changed paths touch.** A changed spec runs itself. A changed path maps to its area's specs through the table `AREAS` in `scripts/ci-select.mjs` (for example `components/v12/rounds/**` and `lib/v12/rounds.ts` run `tests/rounds-v12-workbench.spec.ts`; `components/v12/board/campaign/**` runs `tests/campaign-v12-workbench.spec.ts`). A new-interface path no row names (shared CSS, a new area) runs every new-interface spec.
2. **The fixed guard set, every time:**
   - `tests/spend-buttons-workbench.spec.ts`: every paid control on the rendered pages carries its price (the file scan is `tests/unit/spend-buttons.spec.ts`, in the unit shards)
   - `tests/demo-board-everyone-audit-workbench.spec.ts`: the board, with the switch off, is the same for everyone
   - the switch-off test of every new-interface spec (`--grep "switch off"` over `tests/*-v12-*workbench.spec.ts`): customers see today's app
   - `tests/customer.spec.ts`: the customer smoke test
   - the five-minute test (`playwright.five-minute.config.ts`): a new person with an invitation reaches an approved first render, on a laptop and a phone
3. All of it on fresh dev servers in chunks of at most six spec files, each server warmed (`scripts/ci-run-specs.sh`).

Nothing here removes a test from a spec: a spec that runs, runs whole (except the switch-off pass, which is the switch-off tests by name).

## Required checks

The check names the repository can require are unchanged: `unit (1)`, `unit (2)`, `unit (3)`, `core`, `browser (workbench)` and `browser (customer)`. `browser (…)` is a gate that reads the plan: in a full run it needs every shard and the five-minute test to pass; in a slim run it needs the slim job and the five-minute test to pass and the full shards to be skipped; in a docs run it needs all three skipped; with no plan it fails. A skipped job is not a pass by itself: only the combination the plan asked for passes. The `browser-shards (…)` jobs are skipped in slim and docs runs, so they should not be required checks (they never were).

## Concurrency

A new push to a pull request cancels that PR's older run. A run on `release/1` or `main` is never cancelled by the next merge: its result is what says whether the last merge was safe.

## A red post-merge run comes before any other merge

The slim PR run can miss a failure in a spec it did not select (a shared effect of a new-interface change on another screen). The full run on `release/1` after each merge is what catches it, about 30 minutes later. Merges go one at a time, so the cause is the last merge: fix it or revert it before the next PR merges. A red `release/1` is never merged over.

## The five-minute test is new in CI

It was kept out of the shards (its own config, one worker, a warm server) and ran locally. This workflow runs it as its own job, `five-minute`, in every mode but docs.
