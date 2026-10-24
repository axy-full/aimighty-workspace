# CI: what runs when

`.github/workflows/verify.yml` runs on every pull request into `main` or `release/1`, and on every push (merge) to `main` or `release/1`. Which browser specs run is decided by its first job, `plan`, from `scripts/ci-select.mjs` (a dry run of it over example diffs is `tests/unit/ci-select.spec.ts`). The unit shards (3) and `core` run every time, in every mode.

## What runs when

| Event | Mode | Runs |
|---|---|---|
| push to `release/1` or `main` (every merge) | **full** | the whole browser suite: 16 `browser-shards` jobs (12 workbench, 4 customer), plus the five-minute test |
| pull request into `main` | **full** | the same |
| pull request into `release/1` that touches money, sign-in, tenant separation or shared code | **full** | the same |
| pull request into `release/1` that changes any browser spec (owner, 19 Oct 2026; below) | **full** | the same |
| pull request into `release/1` that only touches new-interface files and their unit tests | **slim** | the specs its changed paths map to, plus the fixed guard set, plus the five-minute test |
| pull request into `release/1` that only changes documentation | **docs** | no browser specs, no five-minute test |

When the plan cannot be made (the changed files cannot be listed) the run is full.

## Which paths run slim

A PR runs slim only if every changed path is **presentational** or a unit test, another non-browser test file, or documentation. **Anything else is a full run: when in doubt, full.**

**A browser spec is never slim (owner, 19 Oct 2026).** In the owner's words: "#840 merged with the browser suite skipped at its head, which is not 24/24; from now on any PR that touches tests/*.spec.ts or claims to fix the suite runs the full plan at its head before merge." So a pull request into `release/1` that changes any browser spec, meaning any `*.spec.ts` under `tests/` at any depth except `tests/unit/**` and `tests/ops/**` (top-level `tests/*.spec.ts`, the `*-v12-*` specs, anything under `tests/redesign/`), gets the full plan, and the plan's reason says `changes a browser spec (…): the full plan at its head (owner, 19 Oct 2026 …)`. A changed unit spec (`tests/unit/*.spec.ts`) runs in the unit shards, which every plan runs, so this rule does not make it full. A PR that "claims to fix the suite" without changing a spec cannot be told apart by `scripts/ci-select.mjs`: the lead runs the full plan for it.

Slim:

- `docs/**`, top-level `*.md`, `design/**`
- a new-interface **CSS** file under `components/v12/` that nothing outside it imports, or a `components/v12/**` `.ts`/`.tsx` file that is presentational: its text has no `fetch(`, no `/api/`, and none of `quote`, `price`, `cr`, `credit`, `charge`, `billed`, `hold`, `refund`, `cancel`, `approv`, `ledger`, `workspace_id` (checked on the file at the PR's head by `scripts/ci-select.mjs`), and **nothing outside `components/v12/` imports it**, directly or through other new-interface files (computed from the import specifiers of the repository at the PR's head)
- non-spec files under `tests/redesign/**` (the `*.shots.ts` captures), non-guard `tests/unit/**` specs, `scripts/redesign/**`

Always a full run:

- **any browser spec**: every `*.spec.ts` under `tests/` except `tests/unit/**` and `tests/ops/**` (owner, 19 Oct 2026; above)
- **everything in `lib/`, including `lib/v12/`**, and any `*.server.ts` anywhere
- `app/**`, `middleware*`, and every component outside `components/v12/` (`components/graphite/**` including `BoardView.tsx`, `components/workbench/**`, …), and `components/v12/ui/**` (shared primitives)
- a path naming money, sign-in or tenant separation: `quote`, `price`, `pricing`, `spend`, `unpriced`, `approval`, `credit`, `ledger`, `billing`, `budget`, `payment`, `stripe`, `topup`, `auth`, `session`, `signin`, `signup`, `invite`, `tenant`, `workspace`, `middleware`, `permission`, `privacy`
- a new-interface file that is not presentational by the text rule above, or that a file outside `components/v12/` imports, or that was deleted (it cannot be read); this includes **CSS**: a stylesheet that something outside `components/v12/` pulls in (`board.css` via `BoardView.tsx`, `v12.css` via the shell) is shared
- **any change to a guard or safety test** (`spend-buttons*`, `spend-ratchet.json`, `paidRoutes.ts`, privacy, switch-off, `newInterfaceSwitch`, `one-design*`, `ui-names*`, `v12-tooltip-audit`, `signin-retired*`, `audit-money*`, `r1-port-paid-sends*`): full, and the plan summary prints `guard test changed: owner review`
- `tests/helpers/**` and the guard tests (`tests/unit/spend*`, `ui-names*`, `one-design*`, `signin*`, privacy, tooltip, `ci-select`, `spend-ratchet.json`)
- `playwright*.config.ts`, `package.json`, `package-lock.json`, build configs, `scripts/ci-*`, and `.github/**` (the workflow itself)

## What a slim run runs

1. **The specs the changed paths touch.** (A changed browser spec makes the run full, so it never reaches a slim run.) A changed path maps to its area's specs through the table `AREAS` in `scripts/ci-select.mjs` (for example `components/v12/rounds/**` and `lib/v12/rounds.ts` run `tests/rounds-v12-workbench.spec.ts`; `components/v12/board/campaign/**` runs `tests/campaign-v12-workbench.spec.ts`). A new-interface path no row names (shared CSS, a new area) runs every new-interface spec.
2. **The fixed guard set, every time:**
   - `tests/spend-buttons-workbench.spec.ts`: every paid control on the rendered pages carries its price (the file scan is `tests/unit/spend-buttons.spec.ts`, in the unit shards)
   - `tests/signin-retired-workbench.spec.ts`, `tests/r1-port-paid-sends-workbench.spec.ts`, `tests/audit-money-workbench.spec.ts`: the retired sign-in, paid sends, and the money audit
   - `tests/demo-board-everyone-audit-workbench.spec.ts`: the board, with the switch off, is the same for everyone
   - `tests/marketing-site-workbench.spec.ts` and `tests/demo-s15-guest-home-workbench.spec.ts`: the visitor pages
   - the switch-off pass (`--grep "switch off" --pass-with-no-tests` over those spec files only): customers see today's app. It runs `tests/switch-off-customers-workbench.spec.ts` when it exists (`GUARDS.switchOff`, the switch-off browser check every build behind the new-interface switch is held to; it stays when a build is deleted, as the prototype-12 build's own switch-off specs were on 23 Oct 2026) plus the switch-off test of every new-interface spec that has one. A spec with no switch-off test is never put in this pass.
   - `tests/customer.spec.ts`: the customer smoke test
   - the five-minute test (`playwright.five-minute.config.ts`): a new person with an invitation reaches an approved first render, on a laptop and a phone
3. All of it on fresh dev servers in chunks of at most six spec files, each server warmed (`scripts/ci-run-specs.sh`): its routes answered once (`scripts/warm-dev-routes.mjs`), and then, before the first workbench spec of each run, the main screens opened once in a browser by a throwaway person (`tests/workbench.warmup.ts`, the workbench config's global set-up). A cold dev server compiles a screen's client chunks on the first browser visit, and the page rebuilds and reloads while it does; a spec that opens a menu in that window finds the page gone. The walk ends when the server answers `/api/health` quickly five times in a row. `PW_NO_WARMUP=1` skips it on a server that is already warm.

Nothing here removes a test from a spec: a spec that runs, runs whole (except the switch-off pass, which is the switch-off tests by name).

`tests/unit/ci-select.spec.ts` runs these rules on a fixture of the new interface (its specs, components and the files outside it that import from it), not on whatever `components/v12` holds today; `exposedFrom` in `scripts/ci-select.mjs` is the import reading it shares with `exposedV12`, which the plan job runs on the repository.

## Required checks

The check names the repository can require are unchanged: `unit (1)`, `unit (2)`, `unit (3)`, `core`, `browser (workbench)` and `browser (customer)`. `browser (…)` is a gate that reads the plan: in a full run it needs every shard to pass; in a slim run it needs the slim job to pass and the full shards to be skipped; in a docs run it needs the shards and the slim job skipped; with no plan it fails. A skipped job is not a pass by itself: only the combination the plan asked for passes. The `browser-shards (…)` jobs are skipped in slim and docs runs, so they should not be required checks (they never were).

## Concurrency

A new push to a pull request cancels that PR's older run. A run on `release/1` or `main` is never cancelled by a later merge. GitHub keeps only one pending run per concurrency group, so with several quick merges a **middle post-merge run can be dropped** while an earlier one is still running; the latest merge still gets its full run on the newest `release/1`, which includes every earlier merge. So a red run always points at "the last merge, or one of the quick ones before it": check the merges since the last green full run.

## A red post-merge run comes before any other merge

The slim PR run can miss a failure in a spec it did not select (a shared effect of a new-interface change on another screen). The full run on `release/1` after each merge is what catches it, about 30 minutes later. Merges go one at a time, so the cause is the last merge: fix it or revert it before the next PR merges. A red `release/1` is never merged over.

## The five-minute test is new in CI

It was kept out of the shards (its own config, one worker, a warm server) and ran locally. This workflow runs it as its own job, `five-minute`, in every mode but docs, and the browser gate reports its result in the summary. It is **not required yet**: it has never run in CI, so a slow or flaky first run must not block every PR. **It becomes required after 3 consecutive green runs on `release/1`** (the owner changes the gate then).
