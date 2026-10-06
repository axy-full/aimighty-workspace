# Release 1 CI triage

Read-only triage, written 6 Oct 2026 (IST afternoon) for the lead to hand to fixers tonight. Nothing was run in a browser; every cause below comes from the CI logs and from reading the code at `origin/release/1` (348adf16, then 947c11d7) and `origin/demo/board-everyone` (c4c1ff7c). Where a cause is a reading of the code and not something a run showed, it says "reading".

Files: this note, and `ci-triage.py` beside it (`python3 ci-triage.py <run-id>` sorts any run's failures into the groups below; unknown failures print as UNMAPPED, never inside a group).

## 0. What exists to triage

| run | head | state at writing | failing |
|---|---|---|---|
| #535 `demo/board-everyone`, run 37415453599 | e292cf54 | finished, red | **170 failures = 58 tests in 24 spec files** (a test counts once per viewport). unit 3/3 green, core green, customer shards 4/4 green; 10 of 12 workbench shards red |
| #535, run 37431783846 | c4c1ff7c (current head) | workbench shards finished 14:03 (the two aggregate jobs were still queued), red | **171 = the same 170 plus one flake**, see §6 |
| #546 `release/1`, runs 37433932460 (348adf16) and 37436873715 (947c11d7, pushed 14:03) | 947c11d7 | **both still queued or pending, nothing has run** (b2cbd360 and d43fe250 were cancelled by newer pushes; the newest push will probably cancel the 348adf16 run too) | none yet |

**The CI pool is saturated, and release/1 is at the back of the queue.** At 14:06 IST there were 14 other runs ahead of release/1's (the seven plan runs #547 to #553, the five D0 re-runs, docs/sow-v2, the push to main), about 200 shard jobs between them, and the pool runs roughly 16 at a time; c4c1ff7c took 47 minutes alone. Unless some are cancelled, release/1's first result will not exist before the evening, so it will not exist before 16:30. The plan runs are docs only and the D0 re-runs are superseded by release/1 (it contains them); cancelling those from the Actions page (I am read-only) is the one step that would put release/1's result in front of tonight's fixers.

So the **confirmed** list below is #535's. Release 1 is #535 plus the D0 chain plus Make short form plus the deleted switch, so its first run will differ (§5 lists what I expect to be added). The script is there so that the moment release/1's run finishes, the lead gets the same table in one command.

The baseline run (demo/integration 08368b84, 1165 failures) is not needed any more: the 170 are all in the board PR's own list and every one has a cause below.

## 1. Counts by cause

(Tests = distinct tests; failures = test x viewport; the five viewports are 360x640, 390x844, 844x390, 1440x900, 1920x1080. **The shell treats 844x390 as a phone** (`COMPACT_QUERY` in `lib/shell/use-compact.ts`: below 768 px wide, or a coarse-pointer screen no taller than 500 px); several specs treat it as a desktop because it is wider than 768 px.)

| group | cause | tests | failures |
|---|---|---|---|
| **A** | the spec drives a page or state Release 1 deletes | 14 | 65 |
| A1 | the old Business pages (Brand, Product, Format, Hooks, Reference, Design, Setup, Image ads) | 12 | 60 |
| A2 | the switch spec (`demo-s01-switch`), already deleted on release/1 | 1 | 3 |
| A3 | the Crew room's old address `view=crew` (the board's Crew review replaced it) | 1 | 2 |
| **B** | old wording, names or expectations | 35 | 83 |
| B1 | a phone-width run of a spec written for the desktop screen: from compact widths the shell mounts the phone's own screens, which draw only Home, the project Record, plan approval, review, Make and Atomik's sheet | 33 | 79 |
| B2 | a selector that names a card or view the board no longer draws (`.bd-eyebrow`, `board-list`) | 2 | 4 |
| **C** | a real product bug on the board or the new screens | 3 | 10 |
| C1 | a Library file dropped on a shot card does nothing (Shots' take card lost the board's `accepts`) | 1 | 2 |
| C2 | Atomik's "Open the Library" offer does nothing on Home or the board | 1 | 3 |
| C3 | Make loses the words typed when you go Make, Recent, Make | 1 | 5 |
| **D** | test harness | 5 | 7 |
| D1 | the Inspector covers the second click of a two-card selection | 1 | 2 |
| D2 | the spec reads the first quote asked, not the edit quote | 1 | 2 |
| D3 | `redirectedFrom()` is one hop, the spec wants the first | 1 | 1 |
| D4 | `wide = width >= 768` where the shell says phone (844x390) | 2 | 2 |
| **E** | unknown, needs a local run | 1 | 5 |
| E1 | a link opened from another workspace stays on its "workspace" card after Switch | 1 | 5 |
| | **total** | **58** | **170** |

(c4c1ff7c adds one flake, D5 `suites-viral:148` at 390x844, see §6.) No cold-start or hard-coded-path failure is left in the 170: the `/private/tmp` screenshot folders were fixed in 2c2e5c2c and f0285238, and every timeout in the list is a spec waiting for an element the screen no longer draws, not a slow server.

Of the 58, **34 assert a price, money, an approval or "nothing is sent"** (20 say so in their title; the Business specs all end on `paid`, `account` and `store.refused` being empty) (§3). None of the fixes below may weaken one.

## 2. The groups: files, cause, recipe, owner

The full row-per-test table (spec:line, viewports, first error, locator) is the appendix. Owners are the streams that wrote the spec or the code (s01 shell and routes, s02 Home, s03 board canvas, s04 plan cards, s05 shot cards, s06 Make, s07 Atomik panel and palette, s08 control room, s09 Settings, s10 phone, s11 Ads and Social, board = the #535 integration, D0 = the shell chain).

### A1. The old Business pages (12 tests, 60 failures, batch F1, owner s11 + board)

Files: `tests/suites-business-workbench.spec.ts` (53, 146, 184, 224), `tests/suites-business-own-workbench.spec.ts` (47, 103, 161, 214, 249), `tests/suites-business-own-agents-workbench.spec.ts` (70, 123, 169), helper `tests/helpers/businessOwn.ts` (line 70 waits for `project-name`).

Cause: every `?suite=moleculr&page=marketing…` address is now a row to the Ads board (`lib/shell/ads-social.ts`: `…&sp=brand` becomes `?view=board&kind=ads&frame=1&card=brand`, `…&sp=dtc` becomes `…frame=2&card=image-ad`, and so on), applied for every workspace. The helper opens the old page and waits for `project-name` (the old page head's test id, which the board never draws); the Image ads page (`image-ads-view`) cannot be reached. The tools themselves (`BrandTool`, `ProductTool`, `FormatTool`, `HooksTool`, `ReferenceTool`, `DesignTool`) are still used: the board's `AdsOverlay.tsx` mounts them as the card's Edit panel and opens the Campaign agent's run dialog.

Recipe:
1. `businessOwn.openBusiness`: go to the board address of the card (`/suites?project=<id>&view=board&kind=ads&frame=<n>&card=<card>`, the same rows) and wait for `board` and the panel's own test id, not `project-name`. The tools' inner test ids (`design-create`, `atomik-run-estimate`, …) are unchanged, so most assertions after the open stay as they are.
2. Delete what only tested the page shell: `suites-business-workbench:53` (the Business landing, the old-address redirect: covered by the redirect unit specs `tests/unit/demo-s11-links.spec.ts` and `demo-board-stage-redirects`; keep its "nothing asks the connected account" line by moving it onto the Ads board open), `suites-business-own:249` ("the pages are there, no retired card, no Ads page": there are no pages). Say so in `docs/old-shells.md`.
3. **Money, keep and move (do not delete): 146, 184, 224 (Image ads estimate and variant), own-agents 70 and 123 (Campaign agent and reference review priced before they run), own 161 (a Format brief shows its price before anything runs).** 146 retargets to the card `ads-image-ad` (`board/ads/cards/AdCards.tsx:63`: engine, prompt, `ads-image-ad-make` with the estimate on it); `demo-s11-ads:114` already covers the estimate on the button and "nothing sent until pressed", so 146 adds "one send, at that figure, the still lands".
4. **One product question for the lead, not for the fixer:** the board's image-ad card has no variant name (Flare at extra high) and no preset catalogue; `ImageAdsView` and `PresetPicker` live only in `components/graphite/business/BusinessView.tsx` (lines 237 and 280), which no address reaches. `suites-business:184` and `:224` test exactly those. Either the owner accepts losing them in Release 1 (then 184 and 224 go, with a line in `docs/old-shells.md`, and their price assertions already live in the retargeted 146), or they are ported to the card (product work, not tonight). Do not park them with `fixme`.

### A2. `demo-s01-switch` (1 test, 3 failures; owner s01)

Deleted on release/1 (`d43fe250`). Nothing to do; its 3 failures leave with the file.

### A3. The Crew address (1 test, 2 failures, batch F4, owner s04)

`demo-s04-looks-next:151` clicks "Crew review of the cut" and expects `/view=crew/`. The URL is now `…&view=board&frame=m` (`lib/board/routes.ts:18`: `?view=crew&cp=room` is `?view=board&frame=m`), which is the new, correct place. Change the expectation to `/view=board.*frame=m/` (and check the Crew panel opens: `board-agent` Crew review). The "Where to next? sends nothing" part stays.

### B1. Phone-width runs of desktop-screen specs (33 tests, 79 failures)

Cause (read, and consistent with every log): `components/graphite/SuitesShell.tsx` mounts `PhoneApp` instead of the header, strip and body whenever `COMPACT_QUERY` matches. `components/graphite/phone/phone-model.ts › readPhone` then draws only: Home, the project Record (the board's address on a phone), plan, review, Make (`make=`), Atomik's sheet (`atomik=`), and Settings as a page under the phone header. **Any other address opens Home**: the control room's Activity, Memory and Skills, the Ads and Social boards (they open the Record), `view=home`'s desktop Home, the board's List view. Specs still carry comments like "until stream 10's Record lands" and run at all five viewports, so they look for `home`, `board-list`, `make-panel`, `atomik-panel-global`, `page-title`, `control-room` and find none.

Recipe, one rule for the group: a spec for a screen the phone does not draw gets `test.skip(COMPACT.includes(info.project.name), "<what the phone does instead, and the spec that covers it>")` at the top of each affected test, where `COMPACT = ["workbench-360x640","workbench-390x844","workbench-844x390"]`. A spec for a screen the phone does draw is **retargeted to the phone's test ids**, not skipped. Never skip a desktop viewport. Put `COMPACT` and `isCompact(info)` in `tests/helpers/shellMode.ts` (F2 writes it first, tiny, within the first 20 minutes; others may inline the array until it lands).

| spec (tests) | what a phone does | disposition | covered on the phone by |
|---|---|---|---|
| `demo-s02-home` (97, 158, 215, 228, 243, 300, 321) | phone Home is `phone-home`: what needs you, then projects | skip at compact | `demo-s10-phone-workbench` 95, 119, 128; `suites-phone-home` |
| `demo-s02-waiting` (78, 117, 186, 200) | no "What are we making?" box, no Start; the waiting rows are `phone-row-approve` with the price as the button | skip at compact | 78, 117, 186 are the box (no phone twin by design, SOW §2.8); 200's approvals are `demo-s10-phone-workbench` 95 and 119 (price on the button, approved alone through its own route) |
| `demo-s03-board` (15, 106) | the board's address is the project's Record | retarget: expect `phone-record`, no `.react-flow`, no sideways scroll | `demo-s10-phone-record` ("the board's address opens that project's Record") |
| `demo-s06-make` (88, 164, 225, 258, 281, 307) | Make is the phone's own screen (`phone-make-*`). **Recent (258) and the quick tools (281) are not drawn on a phone at all** (`SuitesShell.tsx` mounts `MakePanel` only when `!phoneOn`; `PhoneApp` says they "stay the panel's" but nothing mounts it: `?make=recent`, `?make=motion`, `?make=swap` show Home) | skip at compact **and add the phone twins below**; 258 and 281 have no phone twin (see decisions) | `demo-s10-phone-make` 53, 103, 118 |
| `demo-s07-palette` (85) | "make …" opens the phone's Make (`phone-make-prompt`) | retarget: the prompt locator is `gen-prompt` or `phone-make-prompt`; keep "nothing posted" | `demo-s10-phone-make` |
| `demo-s07-panel` (51) | Atomik is the sheet (`phone-atomik*`) | skip at compact | `demo-s10-phone-make` 131, 165, 181 |
| `demo-s08-activity` (46, 79), `-approvals` (81, 145), `-memory` (38), `-skills` (72) | Approvals is Home's queue; Activity, Memory and Skills are not drawn (Home opens) | skip at compact | Approvals: `demo-s10-phone-workbench` 95, 119. Activity, Memory, Skills: none; SOW §2.8 lists none on the phone. **Lead to confirm** that is intended (today the address silently shows Home) |
| `demo-s09-settings` (372, 439) | Settings is a page under the phone header; there is no avatar menu; the "thinking" Change opens the phone sheet (`screen=atomik`) | 439: skip at compact. 372: accept `screen=atomik` in the poll (`param(page,"atomik")==="1" \|\| param(page,"screen")==="atomik" \|\| page=agent`) | `demo-s10-phone-workbench` 128 (Top up opens Settings › Plan & credits) |
| `demo-s11-ads` (170) | Ads and Social boards open the Record | retarget: at compact assert `phone-record` and no sideways scroll for both kinds | `demo-s10-phone-record` |
| `hf-phone-chrome` (210, 378, 394) | the chrome it measures (header island, strips, tab bar, `toggle-library`, the old page head) is not mounted; the phone's own bar is | batch F6, see §5: rewrite as a measurement of `phone-app` or delete with a line in `docs/old-shells.md`; do not just skip | `demo-s10-*` floors checks (`smallTargets`, `dimLabels`) |

**Phone twins that do not exist yet and must be written (these keep money assertions the skips would otherwise drop):**
1. Phone Make, short balance: "Short by N cr · Top up", Make still pressable, nothing sent (replaces `demo-s06:225` on phones; test ids `phone-make-short`, `phone-make-topup`, `phone-make-go`). Add to `demo-s10-phone-make-workbench.spec.ts`.
2. Phone Make, engines priced: the Change list rows (`phone-make-engine-row`) each end in `N cr` (replaces `demo-s06:164`'s "engines priced in cr").
3. Atomik's phone sheet, a request: the send button reads `Ask · up to N cr`, the turn is sent with `maxCredits` equal to N, answered in the thread; how-to answers read "Ask · free" and send nothing paid (replaces `demo-s07-panel:125` and `:102`, which today only run at desktop widths and at 844x390). `phone-atomik-send`, `phone-atomik-cost`.

### B2. Two selectors the board no longer draws (2 tests, 4 failures, batch F4, owner s03 + s05)

- `demo-s03-arrange:67` reads `[data-card-id="node-shot0001"] .bd-eyebrow` to see "Shot 1". Shot cards are Stream 5's `TakeCard` (`components/graphite/board/cards/take/TakeCard.tsx`), which draws `gx-take-name` and `gx-take-line`; `.bd-eyebrow` exists only on the fallback cards. Read the take card's own order text and keep the reorder and Undo assertions as they are.
- `demo-s03-board:55` clicks `board-list-toggle` and waits for `board-list`; the List view is Stream 4's `ShotListDoc` (`board-shotlist`, rows `board-shotlist-row`, `board-shotlist-add`), built from the production's beats. `seedBoard` seeds canvas nodes, not beats, so assert `board-shotlist` visible and either seed beats in `tests/helpers/s03-board.ts` or assert `board-shotlist-empty`; `L` still returns to the board.

### C1. Dropping a Library file on a shot does nothing (1 test, 2 failures, batch F4, owner s05)

`demo-s03-drawers:20` drags a Library tile onto `node-shot0001` and expects the toast "… is a reference for Opening wide". `BoardView.dropOn` needs `registry.defs.get(card.kind).accepts`; Stream 3's plain take card had it (`cards/set-board.ts:132`), Stream 5's `takeDef` (`cards/take/TakeCard.tsx:220`) replaces that definition (later sets win, `cards/index.ts`) and has no `accepts`. Reading, high confidence. Fix: give `takeDef` the same `accepts` (an image or video asset on a card with a `nodeId` returns `{type:"reference", shotId, assetId}`); add a unit line in the card-registry spec that kind `take` accepts an image drop.

### C2. "Open the Library" is a no-op where there is no Library (1 test, 3 failures, spec in F2, code in F5, owner s07 + board)

`demo-s07-panel:78` presses the offer under "How do I add a reference to a shot?" and waits for `library`. `usePlaces.library()` calls `shell.openLibrary("assets")`, which opens the Library only below `WIDE_FROM`; on Home and the board (full-screen screens) there is none to open, so the offer, which the answer promises ("I can open the Library for you"), does nothing. Reading, medium-high. Fix in code (F5): on the board, open the board's Library drawer (`drawer=library`); on Home, go to the board with the drawer open; on the phone sheet hide the offer or map it to Make's reference picker. Then the spec (F2) waits for `board-library`. Do not only change the spec. (At 844x390 the same test fails for D4's reason: the phone sheet answers the address, so it needs `COMPACT` skipped there too.)

### C3. Make loses the typed words across Make, Recent, Make (1 test, 5 failures, batch F5, owner s06 + D0)

`hf-error-boundaries:289` types "a fox crossing a frozen harbour", switches to Recent and back, types " at dawn" and finds the box holding only " at dawn" (log: `Received: " at dawn"`, all five viewports on e292cf54; on c4c1ff7c so far at 1440 and 1920). The spec's own comment states the contract: "the composer keeps its words across the switch". `components/graphite/make/Make.tsx` stays mounted across the tab (`shell.setMake`), so look at what `useMake`'s composer state does when `make=` changes (`components/make/Composer.tsx:202` `promptState`, `components/graphite/make/use-make.ts` effect around line 131 that dispatches a prompt). First step, locally: run the test with the `arm()` faults taken out; if the words are still lost, it is a plain product bug (a person loses what they typed), and it is the more serious one in this list; if not, the fault wall (`take:generation:gen_wide`) is resetting Make. Spec update already landed on release/1 (`Images` became `Takes`).

### D1. Inspector covers the second click (1 test, 2 failures, batch F4)

`demo-s03-arrange:108` clicks `node-note0002`, which opens the Inspector over the right edge, then Shift-clicks `node-note0003` (x 1611) under it: the log shows `p.gx-insp-prompt … intercepts pointer events` for 120 s. The Inspector floating over the canvas is the design. Select the right-hand card first (`two.click()`, then `one.click({modifiers:["Shift"]})`), or lasso both on the empty pane (the test's title says lasso).

### D2. The first quote is not the edit quote (1 test, 2 failures, batch F4)

`demo-s05-shots:247` does `asked[0]` and gets `{model:"gemini-3-pro-image"}`: another quote (the shot's still) reached the route first. Use `asked.find((q) => q.task === "edit")` and wait for it (`expect.poll`). The price assertion `insp-change-price` "up to 12 cr" and `paid === []` stay exactly.

### D3. `redirectedFrom()` (1 test, 1 failure, batch F5)

`entry-points-audit:41` expects the response's `redirectedFrom().url()` to contain `/workbench?stage=brief`; the chain is now two 307s (`/workbench?stage=brief` to `/suites?suite=particl&page=brief` to the board), and Playwright returns the previous hop. Walk `redirectedFrom()` to the root before the `toContain`. Line 43's final URL assertion is already right.

### D4. 844x390 is a phone (2 tests, 2 failures, batch F2)

`demo-s07-panel` 102 and 125 skip when `!wide(page)` with `wide = width >= 768`, so 844x390 runs them, finds no `atomik-panel-global` (the shell mounted the phone sheet) and times out at 120 s. Replace `wide` with the project-name check `COMPACT.includes(info.project.name)`. The same `wide` also lets 844x390 into test 78 (that one is C2) and gives test 51 its stale "until stream 10's sheet lands" branch.

### E1. Link opened from another workspace (1 test, 5 failures, batch F5, owner board / asset link)

`suites-asset-link:183`: the member presses `link-switch`; the page navigates to `…&view=board&ws=…&production=…&region=shots` and `link-card` still reads `data-phase="workspace"` where the spec waits for `no-draft`. The address after the switch no longer carries `asset=` (the log's navigation line), which is where I would start: the stage row `page=takes` becomes `?view=board&region=shots` and the workspace switch reloads on it (`lib/shell/use-asset-link.ts`, `components/graphite/AssetLinkCard.tsx:24`). Not confirmed; needs a local run with the member's session. The sibling test (125) passes on this run, so the link itself is fine. Do not relax the phase assertion.

## 3. Tests that assert a price, money or an approval (flag list)

`$` in the appendix. How each is kept:

- **Moves to the board, same assertions** (never weaken): `suites-business` 146, 184*, 224* and `suites-business-own-agents` 70, 123, `suites-business-own` 161, 47, 103, 214 (their "nothing paid is sent, nothing asked of the connected account, nothing refused by the store" lines, and the Format brief's price on the Make button) onto the Ads board address of the card (A1). *184 and 224 depend on the owner's answer in A1.4.
- **Phone twin written before the phone skip lands** (B1): `demo-s06` 88, 164, 225, 307 (258 and 281 have no phone twin: decision 3b.3); `demo-s07-panel` 51, 102, 125; `demo-s07-palette` 85 (the "nothing posted" assertion is kept on the phone, retargeted); `demo-s02-waiting` 200. The three phone twins are listed under B1. A phone skip without its twin merged is a weakening: reviewers should refuse it.
- **Desktop keeps it, phone does not draw the screen** (skip is the whole fix): `demo-s02-waiting` 78, 117, 186 (the Start box); `demo-s08-approvals` 81 (approved through its own route at the price shown) and 145 (one tap approves only the listed items, one at a time, stops at the first refusal), `demo-s08-activity` 46, 79 (the ledger), `demo-s08-memory` 38 (reading is priced up to its quote), `demo-s08-skills` 72 (steps priced from the free preview). These keep running, unchanged, at 1440x900 and 1920x1080, where they pass today. The lead should say in the PR that Activity, Memory and Skills have no phone screen in Release 1.
- **Fixed in place, assertion untouched**: `demo-s05-shots` 247 (D2: still "up to 12 cr", still `paid === []`), `demo-s03-drawers` 20 (the board's `paid` stays `[]`), `demo-s04-looks-next` 151 ("sends nothing", stills card "N cr each").
- Every board spec ends with `expect(paid).toEqual([])` or `expect(sends).toEqual([])`; keep them in every retarget.

## 3b. Decisions only the lead or the owner can make (each blocks a recipe above)

1. **Image ads variants and presets (A1.4).** Port them to the board's image-ad card, or accept their loss in Release 1 (delete `suites-business:184` and `:224`, note in `docs/old-shells.md`). Everything else in F1 can start without the answer.
2. **Activity, Memory and Skills on a phone.** Not in SOW §2.8's phone list; today their addresses open Home with no message. If that is intended, F3 skips them at phone widths; if not, it is s08 product work.
3. **Recent and the quick tools (Motion transfer, Object swap) on a phone.** Same: SOW §2.4 draws Recent and the two modes for the panel, §2.8 lists only "simple Make" for the phone. Today `make=recent|motion|swap` on a phone shows Home with the address kept. F2 skips 258 and 281 at phone widths with that sentence as the reason, unless the owner wants them.
4. **Cancel the queued docs-only runs** (#547 to #553, the D0 re-runs, docs/sow-v2) and release/1's older run (37433932460, 348adf16) so that 37436873715 (947c11d7) starts; otherwise there is no release/1 result tonight (§0).

## 4. Batches (six, no shared files)

Batches are F1 to F6 (F for fixer; B1 and B2 below are cause groups). Sized by work, not only by count. Each batch owns its files exclusively. Do not run two heavy browser suites at once (slot rule); every fixer runs its own specs at all five viewports before pushing.

| batch | what | tests / failures | files it owns | owner streams |
|---|---|---|---|---|
| **F1** | Business pages to Ads board (A1) + Ads/Social on a phone | 13 / 63 | `tests/suites-business-workbench.spec.ts`, `tests/suites-business-own-workbench.spec.ts`, `tests/suites-business-own-agents-workbench.spec.ts`, `tests/helpers/businessOwn.ts`, `tests/demo-s11-ads-workbench.spec.ts`, `docs/old-shells.md` (one paragraph) | s11, board |
| **F2** | Make and Atomik panel on phones; the three phone twins | 10 / 26 (+ spec half of C2) | `tests/demo-s06-make-workbench.spec.ts`, `tests/demo-s07-palette-workbench.spec.ts`, `tests/demo-s07-panel-workbench.spec.ts`, `tests/demo-s10-phone-make-workbench.spec.ts`, new `tests/helpers/shellMode.ts` | s06, s07, s10 |
| **F3** | Phone Home, control room and Settings: skip with the cross-reference, one retarget | 19 / 41 | `tests/demo-s02-home-workbench.spec.ts`, `tests/demo-s02-waiting-workbench.spec.ts`, `tests/demo-s08-activity-workbench.spec.ts`, `tests/demo-s08-approvals-workbench.spec.ts`, `tests/demo-s08-memory-workbench.spec.ts`, `tests/demo-s08-skills-workbench.spec.ts`, `tests/demo-s09-settings-workbench.spec.ts` | s02, s08, s09, s10 |
| **F4** | The board on desktop, one product fix | 8 / 18 | `tests/demo-s03-arrange-workbench.spec.ts`, `tests/demo-s03-board-workbench.spec.ts` (all three tests, phone branches included), `tests/demo-s03-drawers-workbench.spec.ts`, `tests/demo-s04-looks-next-workbench.spec.ts`, `tests/demo-s05-shots-workbench.spec.ts`, `tests/helpers/s03-board.ts`, `components/graphite/board/cards/take/TakeCard.tsx` (C1) | s03, s04, s05 |
| **F5** | Product bugs and the unknown; needs local runs | 4 / 14 (+ the D5 flake, 1 / 1) | `tests/hf-error-boundaries-workbench.spec.ts`, `tests/suites-asset-link-workbench.spec.ts`, `tests/entry-points-audit-workbench.spec.ts`; code: `components/graphite/make/use-make.ts`, `components/make/Composer.tsx` (C3), `components/graphite/atomik/panel/use-places.ts` and `lib/shell/state.tsx › openLibrary` (C2), `lib/shell/use-asset-link.ts` (E1) | s06, s07, board, D0 |
| **F6** | Release-1-only, driven by its first run: F6a the `?make=` family (about 30 spec files, §5.1), F6b the Agent-page family (13 files, §5.1), F6c the old phone chrome (`hf-phone-chrome` now, then the others in §5.2) and the unit checks and unpriced controls (§5.4). Split into three fixers the moment release/1's run lands; today only F6c's `hf-phone-chrome` is in the 58 | 4 / 8 now; F6a and F6b are not in the counts | F6a/F6b: the files named in §5.1, no overlap between them; F6c: `tests/hf-phone-chrome-workbench.spec.ts`, `tests/unit/*` ratchets, the 21 files with unpriced controls (§5.4) | D0, s06, s10, integrator |

Order inside a batch: the cheap mechanical part first (so CI turns green early), the product question last. F2 pushes `shellMode.ts` first. F4's `TakeCard.tsx` and F5's `use-make.ts`/`use-places.ts` are in different files, no coordination needed; the only cross-batch dependency is C2 (F5 changes the offer, F2 then points test 78 at `board-library`).

Time guide (a fixer working alone): F3 about 1.5 h, F4 about 2 h, F1 about 4 h, F2 about 3 h, F5 4 h and may not finish, F6 depends on the first release/1 run.

**Rules for every fixer** (from SOW §0 and the pricing rules): one batch, its files only; a skip carries a written reason naming the spec that covers the same thing on the phone, and never a desktop viewport; a spend, price or approval assertion is moved or kept, never loosened (`toEqual([])` on `paid` and `sends` stays); no `fixme`, no raised ratchet; run the batch's specs at all five viewports before pushing, with `/private/tmp/claude-board-run.sh <label> <project|-> <grep|-> <files…>` (one heavy suite at a time); report the CI run id and the before/after counts per spec file.

**Not verified** (I ran nothing): every cause marked "reading", the whole of E1, whether C3 reproduces without the armed fault, and everything in §5.

## 5. Not in #535's list, expected on release/1 (unconfirmed until its run lands)

#535 still has the switch (default off), so every spec that signs in with `signInLocally` ran on the **old** shell and passed. On release/1 they all meet the new shell, and the phone shell from 767 px down. These are what I would expect to see; each has evidence in the tree. They are not in the counts above.

**5.1 Specs whose vehicle is an address that now lands elsewhere**
- The mechanism, confirmed on the Business group: `project-name`, `page-title`, `primary-action`, `toggle-library`, `toggle-inspector`, `library`, `inspector` and `shell-body` are drawn only by the old page layout (`SuitesShell.tsx`, the `gx-body` branch with `ProjectHead` and `PageHead`). Home, the board and the phone's screens are full-screen and draw none of them. Any spec that goes to an address that resolves to Home or the board and then waits for one of those fails.
- **`?make=…` (new at 14:03, release/1 947c11d7): "an address that only opens Make is Make over Home"** (`lib/shell/screens.ts`, `PLACE` no longer holds `make`). Until then `?make=video` kept the Studio overview and its `ProjectHead`; now it is Home. About 30 spec files open `/suites?make=…` and then wait for `project-name` (and several for `library`, `toggle-library`, `page-title`): `audit-other-ui`, `cinema-controls`, `cinema-sound`, `handoff-library-recovery`, `hf-batch-takes`, `hf-card-contract`, `hf-connected-jobs-finish`, `hf-error-boundaries` (line 311, before C3 is even reached), `hf-film-vocabulary`, `hf-gen-output-coverage`, `hf-model-picker`, `make-short-form`, `provider-billing-outcome`, `seedance-draft-final`, `suites-atomik-gate`, `suites-draft-merge` (7 tests), `suites-dragdrop`, `suites-gen`, `suites-prompt-attach`, `suites-recovery`, `suites-shell-audit`, `suites-shell`, `suites-workflows`, and, by the same address, `hf-credits-out`, `hf-role-aware-connected`, `make-prices`, `make-quick-tools`, `marketing-site`, `suites-project-new`, `suites-virtual-lists`, `hf-recreate-recipe`. Expect all five viewports red where they wait for the old chrome. Two fixes, pick one in a single PR: (a) a spec helper `projectName(page)` = `getByTestId("project-name").or(locator('[data-suite-tab="project"] .gx-seg-label'))` used for every `project-name` wait (mechanical, `sed`-able, F6); (b) the header's project segment carries `data-testid="project-name"` only when `ProjectHead` is not mounted (product change, two lines, avoids duplicate matches). The Library is not on Home at all: those specs open it through the board drawer or the Make panel's own picker instead.
- The Atomik Agent page: `components/graphite/atomik/panel/routes.ts` rewrites `?suite=atomik&page=agent` to `?atomik=1` (the panel over Home). Thirteen specs open `/suites?suite=atomik&page=agent&sp=agent` and then look for `project-name`, `page-title` "Agent", `primary-action`, `toggle-library` or the Library: `suites-assets`, `suites-atomik-gate`, `suites-load-errors`, `suites-next-actions`, `suites-preview`, `suites-project-new`, `suites-shortcuts`, `hf-shared-key`, `hf-usage-ledger`, `hf-first-run`, `atomik-threads`, `demo-autosave-before-atomik`, `suites-asset-link` (its other tests). Some were already adapted by D0 (`suites-assets` and `suites-atomik-gate` changed on release/1); the others are likely red. Fix pattern: open the board (`view=board`) or Home with the project, not the Agent page; keep every assertion.
- Old Viral and Business addresses (`suite=subatomik&page=motion|swap|history`, `suite=viral…`, `suite=business…`): `suites-viral`, `hf-viral-real-runs`, `make-quick-tools`, `suites-shell`, `hf-role-aware-connected`, `demo-s11-ads` hooks line. Quick tools are Make's modes and History is the board's drawer now.
- Crew: `demo-s07-crew` (`view=crew&cp=room` is `?view=board&frame=m`, same row as A3).

**5.2 Phone width, everywhere**
- Old compact chrome: `hf-phone-chrome` (all 7 tests at 3 phone widths pass today only because the old shell is still there), `suites-phone-home` ("the Studio tile opens the stage grid"), `hf-first-run`, `suites-shell-audit`, `suites-shell`, `hf-jobs-tray`, `ui-floors-audit` and `astra-phone-floors` (use `.gx-tabbar`, `suites-menu`, `tabbar-*`, `home-stage-*`). The phone shell draws none of those. Recipe is B1's rule.
- **The Make composer specs at the three phone widths.** Every spec of the desktop composer (`gen-prompt`, `gen-generate`, `gen-model`, `make-panel`) that runs at 360x640, 390x844 or 844x390 meets the phone's simple Make (`phone-make-*`) or, for `make=recent|motion|swap`, Home. That is the whole 5.1 `?make=` family at three of five viewports, plus `hf-recreate-recipe`, `cinema-*`, `hf-film-vocabulary`, `suites-prompt-attach`, `suites-gen`: B1's rule applies (skip at compact with the covering phone spec named, or retarget to `phone-make-*`), and their floors and price assertions need a phone twin where the phone's Make has the same control.
- Any other spec that goes to an address the phone does not draw (the list in B1's cause) at a phone viewport.

**5.3 Integration gaps in the merged Make** (reading)
- `make-short-form-workbench` (3 tests) expects `make-advanced-notes` ("2 takes" under a folded Advanced) and the label `Make 2 takes · N cr`; the short form's code is in `components/graphite/MakePanel.tsx` on `origin/make/short-form` (line 772), and release/1's `MakePanel.tsx` now only wraps `make/Make.tsx`, which has neither. Either port the two lines to `EngineList.tsx`/`Compose.tsx` or update the spec to what D0's Make draws; the price assertions stay.
- `hf-error-boundaries:289` (C3) and `demo-s06` use the same Make; a fix there may move several.

**5.4 Unit checks (the integrator's local run of 13:33, tree b2cbd360; 348adf16 says it lowers ratchets)**, 20 failed, 3641 passed:
- ratchets that must only go down and have gone down (`ui-names-guard` x7, `one-design-guard`, `spend-buttons` STRICT "fewer than allowed", `suitesShell`): lower with `UPDATE_UI_NAMES_RATCHET=1` / `UPDATE_ONE_DESIGN_BASELINE=1` / `UPDATE_SPEND_RATCHET=1`. Never raise.
- `spend-buttons` (3 tests): **real code, a spending control with no price on it** in 21 files: `atomik/panel/PaletteApprove.tsx`, `PaletteCards.tsx`, `board/ads/AdsOverlay.tsx`, `board/ads/cards/AdCards.tsx`, `HookCards.tsx`, `board/agent/BoardAgentPanel.tsx`, `CrewReview.tsx`, `RecordTab.tsx`, `board/cards/cast/CastCard.tsx`, `plan/NextCard.tsx`, `PlanCard.tsx`, `storyboard/DrawStoryboard.tsx`, `take/TakeCard.tsx`, `board/inspector/CastBody.tsx`, `TakeBody.tsx`, `control-room/ActivityView.tsx`, `ApprovalsView.tsx`, `make/Make.tsx`, `phone/MakeScreen.tsx`, `PlanScreen.tsx`, `settings/connections/ConnectionsSection.tsx` ("Make a token", line 97). Each gets `<SpendButton price>` or `{...spendAttrs(price)}` (`docs/ui-checks.md`); full per-file reasons in `/private/tmp/claude-r1-spend.log`. This is the "price on every spending button" gate of SOW §2 and cannot be waived. (`TakeCard.tsx` is also F4's C1 file: F4 and F6 must not edit it at the same time; F6 waits for F4's push.)
- `d0RetiredModels:78`, `demo-int-seams` (20, 30), `demo-s01-routes` (157, 205), `shellFault:235`: spec text still describes "switch on / switch off"; update to one behaviour (`demo-s01-routes:205` shows the chain `?view=home&atomik=how` → … → `?suite=atomik&page=agent` "nothing landed": a test of the pre-landed fallback that no longer exists).
- `screenplayOcr:238`: `public/vendor/tesseract-7.0.0/manifest.json` missing in the integrator's tree (the postinstall copy); check it in CI's tree before touching anything.

## 6. c4c1ff7c (#535's current head), run 37431783846

The head's one new commit fixes a phone-overlay measurement in `hf-error-boundaries` (a test that was not in the 58) and nothing else of the 58.

Finished at 14:03 IST: all 12 workbench shards done, **10 red (the same shard numbers as e292cf54: 2, 3, 4, 5, 6, 7, 8, 10, 11, 12)**; unit 3/3, core and customer 4/4 green. **171 failures = e292cf54's 170, unchanged, plus one**: `suites-viral:148` at 390x844 only ("the source's own tools: a frame saved to the project joins the references", `viral-source` never shows `walk.mp4` within 60 s after `dropFiles`). It passed on e292cf54 and the spec's other lines (`make-title` "Object swap") passed first, so on this tree it is a drop-timing flake (D5): rerun once before anyone touches it. Not a reason to relax anything. On release/1 the same test will fail for a different, deterministic reason: the phone shell mounts no quick tool (decision 3b.3), so it needs the compact skip with that sentence, and the desktop run (1440x900) stays.

`python3 ci-triage.py 37431783846` reproduces this: all 59 tests map to a group, D5 being the only one outside the 58.


## 7. Refreshing this

```
python3 ci-triage.py <run-id>          # gh-auth.py GETs the failed shard logs, prints the groups, UNMAPPED last
python3 ci-triage.py <run-id> --dir D  # re-read logs already saved in D
```
Rules are in `RULES` at the top of the script, keyed on spec file and title start, never the line. A failing test that matches no rule prints with its first error and a hint: phone widths only usually means B1 (the phone shell does not draw that address), a desktop failure needs a read.

## Appendix: the 58 tests of run 37415453599 (e292cf54)

Group letters as §1; `$` marks a price, money, approval or "nothing sent" assertion (§3). Sorted by batch.

| batch | group | spec:line | viewports | test | first error | locator | owner | price |
|---|---|---|---|---|---|---|---|---|
| F1 | A1 | `suites-business-own-agents:70` | all 5 | Hooks: twelve lines kept by hand; the Campaign agent is priced at abou | expect(locator).toHaveText(expected) failed | `getByTestId('project-name')` | s11 Ads + board | $ |
| F1 | A1 | `suites-business-own-agents:123` | all 5 | Reference: a project video is chosen; its review of twelve stills is p | expect(locator).toHaveText(expected) failed | `getByTestId('project-name')` | s11 Ads + board | $ |
| F1 | A1 | `suites-business-own-agents:169` | all 5 | Design: a poster of editable text, shape and image layers is saved wit | expect(locator).toHaveText(expected) failed | `getByTestId('project-name')` | s11 Ads + board | $ |
| F1 | A1 | `suites-business-own:47` | all 5 | Brand: the website is read once, reviewed and applied; the logo is imp | expect(locator).toHaveText(expected) failed | `getByTestId('project-name')` | s11 Ads + board | $ |
| F1 | A1 | `suites-business-own:103` | all 5 | Product: a page is read and reviewed, its image imported, a Library st | expect(locator).toHaveText(expected) failed | `getByTestId('project-name')` | s11 Ads + board | $ |
| F1 | A1 | `suites-business-own:161` | all 5 | Format: one of the eighteen briefs, made with Particl's product, brand | expect(locator).toHaveText(expected) failed | `getByTestId('project-name')` | s11 Ads + board | $ |
| F1 | A1 | `suites-business-own:214` | all 5 | Setup lists what Particl made in the project — products, the brand kit | expect(locator).toHaveText(expected) failed | `getByTestId('project-name')` | s11 Ads + board | $ |
| F1 | A1 | `suites-business-own:249` | all 5 | a member works in Business's own tools: the pages are there, with no r | expect(locator).toHaveText(expected) failed | `getByTestId('project-name')` | s11 Ads + board | $ |
| F1 | A1 | `suites-business:53` | all 5 | Business opens on Image ads, an old Ads link lands there, Setup is Par | expect(locator).toHaveText(expected) failed | `getByTestId('project-name')` | s11 Ads + board | $ |
| F1 | A1 | `suites-business:146` | all 5 | Image ads runs Marketing Studio Image on the API key: the product firs | expect(locator).toBeVisible() failed | `getByTestId('image-ads-view')` | s11 Ads + board | $ |
| F1 | A1 | `suites-business:184` | all 5 | Image ads on a 2.5 build: Flare at extra high names its variant, is pr | expect(locator).toBeVisible() failed | `getByTestId('image-ads-view')` | s11 Ads + board | $ |
| F1 | A1 | `suites-business:224` | all 5 | Image ads: the key's preset catalogue, searched, on its own shelves wi | expect(locator).toBeVisible() failed | `getByTestId('image-ads-view')` | s11 Ads + board | $ |
| F1 | B1 | `demo-s11-ads:170` | 3 phones | at every size the Ads and Social boards open without errors and withou | expect(locator).toBeVisible() failed | `getByTestId('board')` | s11 + s10 |  |
| F2 | B1 | `demo-s06-make:88` | 3 phones | Make, new interface: the panel as drawn, the type inferred from the wo | locator.click: Test timeout of 180000ms exceeded. | `` | s06 + s10 | $ |
| F2 | B1 | `demo-s06-make:164` | 3 phones | Change: the type's engines priced in cr with dollars on hover, the dra | expect(locator).toHaveAttribute(expected) failed | `getByTestId('make-panel')` | s06 + s10 | $ |
| F2 | B1 | `demo-s06-make:225` | 3 phones | a balance short of the price says by how much, with Top up, and Make s | expect(locator).toHaveAttribute(expected) failed | `getByTestId('make-panel')` | s06 + s10 | $ |
| F2 | B1 | `demo-s06-make:258` | 3 phones | Recent: the master's chips, and an empty project teaches by doing | expect(locator).toHaveAttribute(expected) failed | `getByTestId('make-panel')` | s06 + s10 | $ |
| F2 | B1 | `demo-s06-make:281` | 3 phones | the quick tools open over the new panel, and with the switch off Make  | expect(locator).toHaveAttribute(expected) failed | `getByTestId('make-panel')` | s06 + s10 | $ |
| F2 | B1 | `demo-s06-make:307` | 3 phones | a press the server accepts: Make closes, the toast says rendering, and | locator.click: Test timeout of 180000ms exceeded. | `` | s06 + s10 | $ |
| F2 | B1 | `demo-s07-palette:85` | 3 phones | make …: Make opens filled with the words; nothing is made | expect(locator).toHaveValue(expected) failed | `getByTestId('gen-prompt')` | s07 + s10 | $ |
| F2 | B1 | `demo-s07-panel:51` | 3 phones | the panel over a page: the control room's places, Ask Atomik how, and  | expect(locator).toBeVisible() failed | `getByTestId('atomik-panel-global')` | s07 + s10 | $ |
| F2 | D4 | `demo-s07-panel:102` | 844x390 | commands never spend: approve opens ⌘K's list, remember keeps a line o | locator.click: Test timeout of 120000ms exceeded. | `` | s07 | $ |
| F2 | D4 | `demo-s07-panel:125` | 844x390 | a request: Ask · up to N cr from the server, sent with N as its ceilin | locator.fill: Test timeout of 120000ms exceeded. | `` | s07 | $ |
| F3 | B1 | `demo-s02-home:97` | 3 phones | Home as drawn: the box, its chips, the templates and the projects, eve | expect(locator).toBeVisible() failed | `getByTestId('home')` | s02 + s10 |  |
| F3 | B1 | `demo-s02-home:158` | 390x844 | a template makes the project at once with what the box holds, then ope | expect(locator).toBeVisible() failed | `getByTestId('home')` | s02 + s10 |  |
| F3 | B1 | `demo-s02-home:215` | 390x844 | + New project makes an untitled Studio project | expect(locator).toBeVisible() failed | `getByTestId('home')` | s02 + s10 |  |
| F3 | B1 | `demo-s02-home:228` | 390x844 | a project the plan can't hold is refused under the templates, in the s | expect(locator).toBeVisible() failed | `getByTestId('home')` | s02 + s10 |  |
| F3 | B1 | `demo-s02-home:243` | 390x844 | Attach a brief reads a PDF or a text file on this device into the box; | expect(locator).toBeVisible() failed | `getByTestId('home')` | s02 + s10 |  |
| F3 | B1 | `demo-s02-home:300` | 390x844 | a card opens its project; with many projects the first nine show, then | expect(locator).toBeVisible() failed | `getByTestId('home')` | s02 + s10 |  |
| F3 | B1 | `demo-s02-home:321` | 390x844 | a workspace with no projects shows the box and the templates; a list t | expect(locator).toBeVisible() failed | `getByTestId('home')` | s02 + s10 |  |
| F3 | B1 | `demo-s02-waiting:78` | 3 phones | Start shows Atomik's thinking at the server's figure, the dollars on h | expect(locator).toBeVisible() failed | `getByTestId('home')` | s02 + s10 | $ |
| F3 | B1 | `demo-s02-waiting:117` | 390x844 | Start makes the project, checks the figure for it, and asks Atomik onc | expect(locator).toBeVisible() failed | `getByTestId('home')` | s02 + s10 | $ |
| F3 | B1 | `demo-s02-waiting:186` | 390x844 | with Atomik off for the workspace, Home says so and Start can't be pre | expect(locator).toBeVisible() failed | `getByTestId('home')` | s02 + s10 |  |
| F3 | B1 | `demo-s02-waiting:200` | 3 phones | Waiting for you: each item at its own price, approved alone through it | expect(locator).toBeVisible() failed | `getByTestId('home')` | s02 + s10 | $ |
| F3 | B1 | `demo-s08-activity:46` | 3 phones | the real read answers for this person's own fresh workspace | expect(locator).toHaveText(expected) failed | `getByTestId('page-title')` | s08 + s10 | $ |
| F3 | B1 | `demo-s08-activity:79` | 3 phones | projects, runs, the filter and a run's steps read as the ledger has th | expect(locator).toHaveCount(expected) failed | ` getByTestId('project-tile')` | s08 + s10 | $ |
| F3 | B1 | `demo-s08-approvals:81` | 3 phones | a held take in this workspace is approved through its own route at the | expect(locator).toBeVisible() failed | `getByTestId('control-room')` | s08 + s10 | $ |
| F3 | B1 | `demo-s08-approvals:145` | 3 phones | every kind of wait reads as the code has it; one tap approves only the | expect(locator).toHaveCount(expected) failed | ` getByTestId('approval-row')` | s08 + s10 | $ |
| F3 | B1 | `demo-s08-memory:38` | 3 phones | memory: keep what waits, add a line, forget one in place; reading is p | expect(locator).toHaveText(expected) failed | `getByTestId('page-title')` | s08 + s10 | $ |
| F3 | B1 | `demo-s08-skills:72` | 3 phones | skills: search, a skill's steps priced from the free preview, Edit and | expect(locator).toHaveText(expected) failed | `getByTestId('page-title')` | s08 + s10 | $ |
| F3 | B1 | `demo-s09-settings:372` | 3 phones | Advanced: Models, Tools and Workspace in folds, from the routes that s | expect(received).toBe(expected) // Object.is equality | `` | s09 + s10 |  |
| F3 | B1 | `demo-s09-settings:439` | 3 phones | the avatar menu opens the sections and opens itself once from settings | expect(locator).toBeVisible() failed | `getByRole('menu', { name: 'Settings' })` | s09 + s10 |  |
| F4 | A3 | `demo-s04-looks-next:151` | 2 desktops | Where to next? appears once every shot is approved: three cards that o | expect(page).toHaveURL(expected) failed | `` | s04 | $ |
| F4 | B1 | `demo-s03-board:15` | 3 phones | a production opens as a board: rail, regions in bands, groups, free no | expect(locator).toBeVisible() failed | `getByTestId('board-list').getByRole('button', { name: /Wide ` | s03 + s10 |  |
| F4 | B1 | `demo-s03-board:106` | 3 phones | an empty production opens on 'What are we making?' | expect(locator).toBeVisible() failed | `getByTestId('board-list')` | s03 + s10 |  |
| F4 | B2 | `demo-s03-arrange:67` | 2 desktops | a shot dragged to a new place in Shots reorders the draft; ⌘Z puts the | expect(locator).toHaveText(expected) failed | `locator('[data-card-id="node-shot0001"] .bd-eyebrow')` | s03 + s05 |  |
| F4 | B2 | `demo-s03-board:55` | 2 desktops | the board's controls: glide, zoom, Board / List, a note placed and typ | expect(locator).toBeVisible() failed | `getByTestId('board-list')` | s03 |  |
| F4 | C1 | `demo-s03-drawers:20` | 2 desktops | a file added on the board lands in the Library drawer, and dragged ont | expect(locator).toBeVisible() failed | `getByText(/market-stall.* is a reference for Opening wide/)` | s05 (TakeCard) | $ |
| F4 | D1 | `demo-s03-arrange:108` | 2 desktops | a lasso of free cards moves together onto the dots, and ⌫ takes them o | locator.click: Test timeout of 120000ms exceeded. | `` | s03 |  |
| F4 | D2 | `demo-s05-shots:247` | 2 desktops | Change with words on a clip carries the free quote's price, and openin | expect(received).toMatchObject(expected) | `` | s05 | $ |
| F5 | C2 | `demo-s07-panel:78` | 844x390,1440x900,1920x1080 | Ask Atomik how: answered free, and the offer does the thing | expect(locator).toBeVisible() failed | `getByTestId('library')` | s07 (+ board) |  |
| F5 | C3 | `hf-error-boundaries:289` | all 5 | Gen: one bad take costs its tile, a failing results grid keeps the com | expect(locator).toHaveValue(expected) failed | ` getByTestId('gen-prompt')` | s06 / D0 Make |  |
| F5 | D3 | `entry-points-audit:16` | 1440x900 | entry points: a workspace goes straight to Suites; a visitor signs in  | expect(received).toContain(expected) // indexOf | `` | D0 shell |  |
| F5 | E1 | `suites-asset-link:183` | all 5 | a link from a workspace the reader is not in resolves nothing there; o | expect(locator).toHaveAttribute(expected) failed | `getByTestId('link-card')` | board (asset link) |  |
| F6 | A2 | `demo-s01-switch:113` | 3 phones | switch ON: landed screens mount, the rest open today's page; the new-i | expect(locator).toHaveText(expected) failed | `getByRole('tablist', { name: 'Suites' }).getByRole('tab')` | s01 |  |
| F6 | B1 | `hf-phone-chrome:210` | 844x390 | phone chrome: every layer measured, and the page gets most of the scre | locator.click: Test timeout of 120000ms exceeded. | `` | s10 / D0 phone bar |  |
| F6 | B1 | `hf-phone-chrome:378` | 844x390 | phone: the chrome keeps the floors on every page — 44px targets, no la | locator.click: Test timeout of 120000ms exceeded. | `` | s10 / D0 phone bar |  |
| F6 | B1 | `hf-phone-chrome:394` | 3 phones | phone: the Suites and Search wait behind the context badge, one tap aw | expect(locator).toHaveText(expected) failed | ` getByTestId('primary-action')` | s10 / D0 phone bar |  |
