# Rig bug inventory (19 September 2026)

Read-only inventory of the workbench `canvas` stage ("Rig": `components/workbench/production-graph.tsx`, the canvas section of `components/workbench/Studio.tsx`, `lib/workbench/node-graph.ts`, `node-render.ts`, `canvas-selection.ts`) and of the separate legacy **/rig** board (`app/(app)/rig/canvas/[boardId]/page.tsx`, `components/rig/*`, `app/api/rig/*`). Ranked by user impact. Line numbers refer to `main` at `f71dd50`; the files are dense, so the identifier is the anchor. Items marked *suspicion* were not reproduced at runtime. This is the specification for PR E ("keep Rig as it is, squash all its bugs").

## P1 — data loss, money, core interaction

1. **Undo history floods per keystroke/slider tick; the 40-entry cap then destroys real history.** `Studio.tsx:501-510` (`change`, `remember=true`, `structuredClone` of the whole project per call, cap 40) driven by `production-graph.tsx:125` (`update`), `:144` (`opUpdate`), `:197`/`:202` (name/direction inputs), `:209-213` (sliders). The `remember` parameter exists but no caller passes `false`. Fix: coalesce continuous edits (one history entry per gesture / per field focus), and stop cloning the whole project per tick.
2. **`publishSelection` bypasses `change()`** (`Studio.tsx:910-943`, `:942` sets `pRef`/`setP` directly): publishes are not undoable, the redo stack is not cleared, and `next` mixes `pRef.current` with an earlier captured `project`. Redo after publish drops `sharedNodes`/`bibleVersion` locally → next publish fails with `bible_conflict`.
3. **Undo silently dead on the shared canvas; no Undo affordance on phones.** `Studio.tsx:751-752` swallows Ctrl+Z in shared scope with no feedback (private-scope entries would be safe to undo); the same edits *can* be undone from the edit stage. `mobile-handoff.css:117` hides the canvas Undo tool on phones.
4. **`undo()` discards entries from another project.** `Studio.tsx:512-516` pops first, then checks `last.id===pRef.current.id`; a mismatch eats one real step silently.
5. **/rig "Run unrun" has no credit ceiling and no idempotency.** `page.tsx:328` loops `runNode` (`:294-298` POSTs `/api/generate` without `maxCredits`), priced from a client-side table (`:147-158`). The workbench path always sends `maxCredits` and holds a localStorage claim (`GenerationDialog.tsx:318-345`).
6. **/rig board saves are fire-and-forget.** `page.tsx:129-136`: debounced PUT with `.catch(() => {})`, no revision check, no `beforeunload`, no save-state UI; last-writer-wins across tabs.
7. **/rig interrupted runs stick at "running"; polling survives unmount.** `page.tsx:291` commits `state:"running"`; `:304-309` polls up to 400× with no abort/unmount flag; state writes after unmount.

## P2 — wrong results, stuck UI

8. **Wire drags take no pointer capture** (`production-graph.tsx:186`): releasing outside the canvas leaves `wire` set — crosshair, `.ng-connecting`, banner and frozen dashed wire persist until Esc.
9. **`pointers` map leaks → a later single touch is treated as a pinch** (`:41`, `:123`, `:180` node body has no capture; deletions only at `:107`/`:176`). Also `viewport.current!` non-null assertions at `:123-124`.
10. **Space swallowed for every element inside the canvas** (`:150-155`, guard at `:152` omits `button`, ports, checkbox, combobox, slider); keyboard users cannot activate buttons. `Studio.tsx:746` gets the guard right — inconsistent.
11. **Held arrow keys push one history entry per repeat** (`:163`, same root cause as 1).
12. **`arrangeGraph` overlaps locked nodes and leaves holes** (`node-graph.ts:43`): row slot consumed before the `locked` early-return; depth capped at 12 puts a child in its parent's column; cyclic `linked` depth is traversal-order dependent. No unit test covers `arrangeGraph`.
13. **Three inconsistent zoom domains** — `fitCanvasNodes` (no floor, `canvas-selection.ts:6-24`), `zoomBy`/`movePinch` (clamp .25–1.6, `production-graph.tsx:124,127`), `focusNode` (no clamp, `:122`). Fit → "+" jumps ~3× at 844×390 (`tests/unit/canvasSelection.spec.ts:127-140` asserts fit zoom < .25).
14. **Ctrl/⌘+wheel zooms canvas and page; plain wheel scrolls the page** (`:176` onWheel never prevents default; zoom anchors on the viewport centre, so the node under the cursor drifts).
15. **`canConnect` validates topology only** (`node-graph.ts:26-34`): no kind compatibility (text into `grade`), no arity (`mix` uses inputs 0–1 of up to 100), no check that the target consumes inputs.
16. **Version cap mislabels: every save after the 30th is "Version 31"** (`:143` label from `length+1`, write `.slice(-30)`; Restore at `:220` pushes "Before restoring" through the same cap).
17. **Deleting a source that feeds a locked node fails without naming the blocker** (`canvas-selection.ts:96-104`, toast at `production-graph.tsx:72`); mixed selections report "Nodes removed" after a partial removal.
18. **Image tools allowed with no asset** (`:145`, `:216` gate on `!!asset && !visual`), producing "Attach an image…" only at render; `switch` accepts an `assetId` the resolvers ignore.

## P3 — moderate, mobile, cosmetic-but-wrong

19. "Add node" while panned lands the node off-screen on desktop (`:128` clamps to world 0,0; `focusNode` only on mobile).
20. Input-port connect double-handles pointerup + click (`:114`, `:186`); opens the inspector Inputs tab as a side effect; *suspicion* of a spurious "already connected" toast under load.
21. Monitor preview re-renders the whole graph on every autosave round-trip (`:146` deps include `p`; no abort path in `renderNode`).
22. No `lostpointercapture` handling: a node removed mid-drag leaves a ghost offset (`:84`, `:113` releases capture on the wrong element).
23. Marquee hit test inclusive at edges; collapsed node height 50 vs CSS 48 (`canvas-selection.ts:35-50`, `desk.css:20`); marquee border sub-pixel at fitted zoom.
24. Marquee drag calls `onSelect` per pointermove (`:104`) and the keyboard effect (`:150-164`) has no dependency array → listeners re-attached every render.
25. Box-select unreachable by touch except via a tool button that two CSS files hide/unhide in import order (`mobile.css:17`, `mobile-handoff.css:116`).
26. Canvas touch targets stay 28 px / 12 px at 844×390 (`desk.css:16,20`); the 44 px coarse-pointer bump is scoped to the edit workspace only.
27. `wideScreen` / `shortLandscape` / `mobile` are three stores that disagree at 760–1099 px (`production-graph.tsx:28-31`, `mobile-ui.tsx:9-13`).
28. 70 px dead strip at the bottom of the phone canvas: `mobile.css:18` reserves room for a nav that `four-suites.css:124-128` hides.
29. /rig "Fit" resets to `zoom=1, pan=0` (`page.tsx:454`); zoom cycle ignores pan (`:453`); dot grid ignores zoom (`:430`).
30. /rig pan listeners added inside pointerdown with no unmount/pointercancel cleanup (`:182-187`); uncleared `setTimeout` at `:218`.
31. /rig Backspace deletes with no undo/confirmation; guard ignores buttons/comboboxes (`:350-360`).
32. /rig right-click "Add node" ignores the click point (`:427`, `:380`, `:170`).
33. /rig wire drop targets are 8×8 px (`:506-512`, `:561`).

## P4 — low / suspicion

34. Bare letter shortcuts (`n b v h`) fire inside a Radix Select type-ahead (`:161`, guard `:152`).
35. `Studio.tsx:742-744` uses `matches` not `closest` for the editing check (latent).
36. `generatingNodeId` is derived for the selected node only (`Studio.tsx:525`): selecting another node re-enables Generate while a job runs.
37. `onQueued` overwrites the user's Direction text with the accepted prompt (`Studio.tsx:3433`) — undocumented.
38. Project switch during an in-flight submit leaves a queued job with no node record (*suspicion*).
39. `/api/workbench/engines` effect in `GenerationDialog.tsx:171-196` lacks abort/active flag, unlike its siblings.
40. `duplicateSelectedNodes` resets an approved Review node to draft and keeps operation ids (`canvas-selection.ts:106-137`).
41. `transform` op renders into the source-sized canvas (crops on scale>100%/rotation); `mix` silently no-ops with one input.
42. Selection actions test `nodes` (shared) while operations act on `p.nodes` (masked by readonly guards).
43. `ProductionGraph` is not keyed by project (`Studio.tsx:1731`), so zoom/pan/tool/preview survive a project switch.

## Coverage gaps and diagnostics

- `tests/canvas-selection.spec.ts` runs only under `playwright.canvas.config.ts` (not in the default workbench suite); its drag/undo/delete test is desktop-only (`width < 1000` skip) and the PNG test is 1440-only. No test covers `arrangeGraph`, pinch/wheel zoom, wire drag/drop, `canConnect` type gaps, version caps, bypass, or `switch.activeInput`. The 190/60 px exact-integer drag assertions (`:249-253`) will flake if `fit()` zoom changes.
- The /rig board's only test (`tests/desktop.spec.ts:370`) skips when signed out and runs no node.
- No `console.error`/`warn` anywhere in the canvas code; failures are toasts or inline text only. /rig discards errors with `.catch(() => {})` at `page.tsx:134, 93, 97, 270, 273, 306`.
- `docs/handoff/nodegraph/README.md:128` records the ~162 px right-side overflow with the chat panel open.

## PR E plan

Fix P1 and P2 in the workbench canvas first (1–4, 8–18), add unit tests for `arrangeGraph`, zoom clamps, `canConnect` kinds/arity, version labels, and a canvas browser spec that runs in the workbench suite at all five viewports (drag with pointer capture, wire drop outside the canvas, pinch-state reset, undo coalescing). The legacy /rig board (5–7, 29–33) either gets the workbench safeguards (`maxCredits`, claim, revision, cleanup) or is retired behind the workbench Rig; decide with the owner.

## PR E status — workbench canvas (19 September 2026, branch `feat/rig-bug-pass`)

Commits: **A** `893b6ae` (`lib/workbench/node-graph.ts`, `canvas-selection.ts`, unit specs) and **B** `0c8043a` (`Studio.tsx`, `production-graph.tsx`, `desk.css`, `mobile-handoff.css`, `tests/rig-workbench.spec.ts`). The legacy /rig board (5–7, 29–33) is untouched pending the owner's decision. Everything else keeps its appearance.

| # | Status | Where |
| --- | --- | --- |
| 1 | Fixed (B) | `change(fn, remember)` takes a coalescing key: name, direction, tool notes, sliders and held arrow keys record one entry per field focus / gesture (`onSettle` on blur, `onValueCommit`, arrow keyup); the previous project reference is the snapshot, no `structuredClone` per tick. |
| 2 | Fixed (B) | `publishSelection` computes the shared set from `old` inside `change()`: one snapshot, undoable, redo stack cleared. `publishBible` still applies the server's version outside history; undo/redo carry the current `bibleVersion` so a step back never offers a stale version. |
| 3 | Fixed (B) | Ctrl/⌘+Z in Shared view toasts "Undo is unavailable in Shared view…"; the Undo tool and context item are labelled with the reason when read-only; `mobile-handoff.css` no longer hides the Undo tool on phones. |
| 4 | Fixed (B) | `undo()`/`redo()` peek first and pop only when the entry belongs to the current project; an empty stack says "Nothing to undo". |
| 5–7 | Deferred | Legacy /rig board — owner decision (safeguards vs retire). |
| 8 | Fixed (B) | Output ports capture the pointer; release resolves the drop with `elementFromPoint`, otherwise resets `wire`/cursor wherever it happens (also on `pointercancel`/`lostpointercapture`). The wire help banner is `pointer-events:none` so it cannot sit over a drop target on short canvases. |
| 9 | Fixed (B) | Window-level `pointerup`/`pointercancel` cleanup of the touch pointer map; a pinch only exists with two live pointers; no `viewport.current!`. |
| 10 | Fixed (B) | Space is swallowed only when the target is not a button/link/checkbox/combobox/slider/switch/tab/menu item. |
| 11 | Fixed (B) | Arrow nudges coalesce under one key until keyup. |
| 12 | Fixed (A) | `arrangeGraph`: locked nodes take no slot, arranged nodes step below overlapping locked nodes, no depth cap, id-ordered DFS breaks cycles deterministically. Unit spec. |
| 13 | Fixed (A+B) | `clampCanvasZoom(next, current)`: one domain [.25, 1.6]; a fit below the floor is stepped from relative to itself. Used by `zoomTo`/`zoomBy`, pinch, wheel, `focusNode`. `fitCanvasNodes` unchanged (overview may still go below the floor). |
| 14 | Fixed (B) | Non-passive `wheel` listener on the viewport: always `preventDefault`; Ctrl/⌘ zooms anchored at the cursor (`zoomAround`), plain wheel pans. |
| 15 | Fixed (A) | `NODE_INPUTS` (accepts any/media, max 100/2/1) + `nodeOutputKind`; messages name the node type and the rule. Unit spec. |
| 16 | Fixed (A+B) | `nextVersionLabel` counts every save; `appendNodeVersion` reports the dropped version and the toast says so (save and restore). |
| 17 | Fixed (A+B) | `describeRemoval` names the locked blocker ("Alpha feeds locked Gamma…") and reports "n of m nodes removed" for mixed selections. |
| 18 | Fixed (B) | Image tools need a resolved still image at add time (dropdown items disabled, toast explains); `update()` refuses `assetId` on a switch and the Inputs tab shows a note instead of the picker. |
| 19 | Fixed (B) | Add-node position is the viewport centre in world space clamped to the canvas limits, not to 0. |
| 20 | Fixed (B) | Drag mode connects from the output port's `pointerup`; click mode from the input port's `onClick`; the canvas `pointerup` no longer hit-tests inputs; the post-drag click on the output port is suppressed. |
| 21 | Fixed (A+B) | `previewRenderKey` (upstream sources, routing, tool stacks, asset urls) drives the effect; `renderNode` takes an `AbortSignal` and the effect aborts on cleanup. |
| 22 | Fixed (B) | `onLostPointerCapture` on the canvas and node headers drops the draft; capture is released from the element that took it. |
| 23 | Fixed (A+B) | Strict inequalities in `marqueeSelection`; collapsed `nodeHeight` is 48 to match the header; marquee border is `1/zoom` px. |
| 24 | Fixed (B) | Marquee updates a pending local selection and announces once on release; keyboard/window listeners attach once via `useEffectEvent`. |
| 25 | Deferred | Touch box-select entry (CSS import order) — layout change, outside this pass. |
| 26 | Fixed (B) | `@media (min-width:760px) and (pointer:coarse)`: 44 px canvas tools, zoom readout and node menu, 44 px port hit area. |
| 27, 28 | Deferred | Breakpoint stores and the phone dead strip — layout work, not bug-for-bug safe. |
| 29–33 | Deferred | Legacy /rig board. |
| 34 | Deferred | Bare letter shortcuts inside a Select type-ahead — the guard already skips `[role="listbox"]`; not reproduced. |
| 35 | Fixed (B) | `Studio.tsx` editing check uses `closest`. |
| 36–42 | Deferred | P4 items, out of scope for "keep Rig as it is". |
| 43 | Fixed (B) | `<ProductionGraph key={p.id}>`. |

Tests: `tests/unit/nodeGraph.spec.ts` (arrangeGraph locked/depth/cycles, canConnect kinds/arity, version labels, preview key), `tests/unit/canvasSelection.spec.ts` (zoom clamp/anchor, strict marquee, removal messages), `tests/rig-workbench.spec.ts` in the default workbench suite at all five viewports (wire drag released outside resets, single touch after an interrupted drag pans, per-field undo, publish clears redo, add-node in view, Space activates a button).
