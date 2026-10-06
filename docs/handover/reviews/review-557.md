# Review of PR #557: turning off every feature that needs a Higgsfield sign-in

**VERDICT: PASS.** I found no high or medium findings. There are three low findings and three info notes.

- Head: `93cada234aafd18bbf41bcce10880013bc4fc8e2` on `fix/r1-higgsfield-signin-off`.
- Base: `release/1`. It has already merged the first three commits through `9d67e09b Merge 42dbc563`. The two commits still open change tests only.
- I reviewed the whole change, `2501698a..93cada23`: 41 files.
- I also checked whether `release/1` has moved since. `HEAD..origin/release/1` adds no new reference to `higgsfield-consumer`, `/api/higgsfield/consumer`, `SIGN_IN_OFF` or `signInOff`.

## Checks

### (1) No path can use a stored grant or reach the OAuth or MCP hosts: PASS
- **Network code.** Only three modules contact the sign-in hosts:
  - `lib/higgsfield-consumer/oauth.ts` (clerk.higgsfield.ai token and revoke);
  - `lib/higgsfield-consumer/mcp.ts` (mcp.higgsfield.ai);
  - `lib/higgsfield-consumer/developer-api.ts`.

  `store.ts` is the only code that reads the grant tables. Outside these, the only reference to clerk.higgsfield.ai is an address check in the client code (`HiggsfieldConsumerConnection.tsx`, which nothing mounts, and `workspace-view.ts`).
- **Who imports them.** `probes/reach.py` builds the reverse runtime-import closure; type-only imports are excluded. It finds 24 files and 8 entry points:
  - the 7 consumer routes that are now wrapped in `signInOff`;
  - `app/api/cron/sync`, where the stage is gated.

  Nothing else reaches them: no other route, page, layout, server action (there are none), MCP or Atomik route, worker, inngest or proxy.
- **Every entry point, forwards.** `probes/forward.py` follows the imports of all 265 `app/**` routes, pages and layouts. 257 are clean, and the 8 that reach the grant code are exactly the ones above.
- **Elsewhere.**
  - `lib/purge.ts:373` deletes grant rows only in the workspace-deletion purge, which this PR does not change.
  - `proxy.ts` does not match `/api`.
- **Client side.**
  - The collector is never made (`SIGN_IN_OFF`), and `listConnectedJobs` does nothing when there is no collector.
  - `useConnectedCapability` treats everyone as not the owner, so it reads nothing.
  - `WorkflowHost`, `AtomikVoiceTools`, `ConsumerShorts`, `ShortsPage`, `FormPage`, `ConnectedAccountRow` and `ConsumerCreditActivity` are all unmounted.
  - The callers of `take-batch`'s connected batch functions are not imported by `use-composer`.
- **In the browser.** As the owner, I visited 16 pages at 1440x900 and 390x844: `/suites`, `?shell=legacy`, `/workspace`, `/workbench`, Moleculr, `/subatomik`, `?page=shorts`, `/generate`, `/usage`, `/settings`, Connections, Engines, Usage, Atomik runs and `/atomik`. No page sent a request to `/api/higgsfield/consumer/*` or to any `*.higgsfield.ai` host (`probes/review557-pages-workbench.spec.ts`, 2 passed).

### (2) API-key features still work and don't import grant code: PASS
`forward.py` checked generate, identities, marketing/presets, soul, jobs, mcp, atomik, rig, workbench, usage, worker, inngest, chat, me, settings and workspaces, plus `lib/higgsfield.ts`, `genjutsu.ts`, `genjutsuVideo.ts`, `higgsfieldMarketing.ts`, `soulRender.ts` and `engines/higgsfield.ts`. None of them reaches `oauth`, `mcp`, `developer-api`, `store` or `sweep`. Full unit is green.

### (3) The callback is safe: PASS
- The route has no imports and its `GET()` takes no arguments, so it reads nothing.
- It answers 303 with the fixed, relative `Location: /suites?view=workspace&tab=connections`. Over live HTTP, a hostile `X-Forwarded-Host` and `?redirect=https://evil.example` leave the Location unchanged.
- It sets no cookie, and `POST` gets 405.

### (4) The cron still runs every other stage: PASS
`signinOffRelease1.spec.ts` runs the real cron route with recorders. It proves:
- the 9 other stages run in order;
- `lastCronStatus` is still `succeeded` (not failed, not deferred);
- `connected_jobs` would run in its old place if the switch were turned back on.

To check the test has teeth, I changed the gate to `if (true)`: the spec failed.

### (5) The 410 comes before auth, any service or any DB write, on every method: PASS
- **Unit probe** (`probes/review557-probe.spec.ts`, 14 tests). It loads all 14 consumer routes with every `@/lib` dependency (auth and tenant included) replaced by a recorder. It then calls every exported method as a signed-out caller, a cross-origin caller with a forged scope and bearer, and with hostile or malformed bodies. Every call answers 410 (the callback 303), and no dependency is called and no network is used. All 14 pass.
- **Mutation check.** I changed video's `GET = keptGET`. My probe failed, and so did 2 of the PR's own guard tests.
- **Live, signed-out HTTP.** `probes/http-probe.out`:
  - every exported GET, HEAD, POST and DELETE answers 410;
  - methods a route doesn't export get Next's 405, and OPTIONS gets 204;
  - so nothing reaches a handler.

### (6) No secret, token or env value: PASS
The only one is `CRON_SECRET="cron-test-secret"`, a test value that the test sets and then restores. No real value is read or logged. No vendor cost appears.

### (7) The tests prove (1)–(5): PASS
- `signinRetiredGuard.spec.ts` and `signinOffRelease1.spec.ts` cover the routes, the callback, the cron, the collector and the registries. I confirmed by mutation that they have teeth.
- `tests/signin-retired-workbench.spec.ts` checks the real routes and the UI. See L3 for a gap.

### (8) Nothing is deleted: PASS
- Disconnect (DELETE) now answers 410, so no grant is revoked or cleared.
- The PR has no migration and no DELETE SQL.
- The ledger history still shows: the browser spec counts 3 rows in Workspace › Usage.

## Findings
1. **LOW: stale comments that now say the opposite of what the code does.**
   - Where:
     - `lib/shell/use-connected-capability.ts` (the comment in `useConnectedCapability`) says "Workspace › Engines still shows the owner's grant (to Disconnect it) and the shell's collector still finishes jobs already running".
     - `app/api/higgsfield/consumer/connect/route.ts:6-8` says "A grant already held stays until the owner presses Disconnect in Workspace › Engines, so the jobs it started are still collected".
   - Both are false now. Nothing is reachable through them; the risk is that a future maintainer is misled.
   - Proof: reading the files.
2. **LOW: "every method answers 410" is literally untrue.**
   - Where: `lib/higgsfield-consumer/retired.ts:21-25` and the route comments.
   - Methods a route doesn't export (PUT and PATCH everywhere, and GET on the POST-only routes) get Next's 405, and OPTIONS gets 204. No handler is reached, so this is safe, but the wording is wrong.
   - Proof: `probes/http-probe.out`.
3. **LOW: no test seeds a stored grant row and shows it untouched after the routes and pages run.**
   - Where: `tests/signin-retired-workbench.spec.ts:20` says "this workspace holds no grant".
   - The grant tables are created lazily by `store.ts`, which nothing can reach now. The static closure and the recorder probes cover this, so it is a coverage gap, not a defect.
   - Proof: `reach.py` on `store.ts` finds only the 8 gated entry points.
4. **INFO: the callback's `Referrer-Policy: no-referrer` is replaced on the wire.**
   - `next.config` line 23 sets a global `strict-origin-when-cross-origin`, and that is what the response carries.
   - This was already true before the PR. Harmless: the route reads and stores nothing.
5. **INFO: dead references remain.**
   - `app/(app)/usage/page.tsx` still compares `tab === "higgsfield"` in 3 places, though the tab can no longer be chosen.
   - `SubatomikWorkspace` has `shorts = false`, so its branch can't run.
   - The unmounted sign-in components stay in place, as the PR intends.
6. **INFO: `components/workspace/mobile/pages/FormPage.tsx` still posts to the consumer genjutsu route.**
   - It is unmounted: the registry maps `form` to `RetiredFormPage`.
   - Phone Motion transfer and Object swap therefore have no form in the legacy mobile shell. That is outside this PR, and the API-key path is unaffected.

## What I ran
| Run | Result | Log (copied to `review-557-probes/`) |
|---|---|---|
| Typecheck: `tsc --noEmit -p .` | 0 errors | claude-review557-tsc.log |
| eslint on the changed files | 0 errors, 1 warning that was already there | claude-review557-lint.log |
| Targeted sign-in unit specs (10 files) | 85 passed | claude-review557-targeted.log |
| Full unit: `ENGINE_MOCK=1 PW_BASE_URL=http://localhost:4999 playwright test --project=unit --workers=1`, with my 14 probes included | **3698 passed, 6 skipped, 0 failed** (8.3 min); without the probes that is 3684 | claude-review557-unit.log |
| `tests/signin-retired-workbench.spec.ts` at 1440x900 and 390x844, fresh mock DB (`review557`, :4977) | **2 passed** | claude-review557-browser.log |
| Page-walk probe at the same sizes | 2 passed | claude-review557-pages.log |
| Live HTTP probe | as described above | http-probe.out |
| Mutation checks (video GET unwrapped; cron gate `if (true)`) | my probe and the PR's tests fail, as they should; both files restored by `cp` from a backup | not logged; the results are recorded here |

Environment:
- `node_modules` was an APFS clone of `W/d0-main-check`, whose lockfile is identical; `npm run postinstall` was run.
- The first browser attempt is discarded (`-discarded.log`): the Playwright headless shell is not installed. The rerun used `PW_CHANNEL=chrome` and `PW_PLATFORM_DATABASE_URL=file:/private/tmp/particl-suites/review557/platform.db`, as review-555c did.
- My first HTTP probe hung on `curl -X HEAD`. I stopped its background shell with TaskStop (no kill) and reran it with `-I` and `-m 60`.
- The mock server, PIDs 71090 and 71097, was stopped with `mock-server.py stop review557`. Slot-5 was held and then released.
- Worktree `W/review-557` was removed with `git worktree remove --force`. Nothing was pushed, committed or commented.
