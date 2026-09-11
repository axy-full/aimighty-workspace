# The SOW surfaces — build plan

**Scope of record:** `docs/particl-sow-v2.md` (the v2 SOW; §6 delivery order, §7 surfaces, §14 the Crew). **Design of record:** `design/particl-sow/` (boards 12a–12i in `design-references/Particl v2 - SOW Surfaces.dc.html`; the READMEs are the same design system as `design/particl-v2/` and `design/particl-v2-mobile/`). Where a board and this plan disagree on a pixel the README wins; on scope, data or money the SOW wins; where the SOW and shipped code disagree, the code was checked and the document says so below.

Written 11 September 2026 after a read-only audit of every board against the repo (nine readers, one per board; their notes are in the session scratchpad). The v2 UI (SOW §6 rows 1, 4, 5, 7, 8, 10, 11, 12, 16, 17) is live on www.particl.app. Change request 1 items 6, 2 and 3 are in PRs #123–#125; item 4 (§3 models) is on its branch. This plan takes over from CR1's remaining order where a board covers the same ground, and folds the rest in where noted.

## What exists, what each board needs

| Board | Route | Exists today | Gap in one line | Size |
|---|---|---|---|---|
| 12i Onboarding | `(auth)/invite → signup → workspace → /make/video` | the whole flow works (invite code, account, workspace seeded with the starter production, grant); v1 styling on the auth cards | restyle the three auth screens on v2 tokens; land on Make with the demo cast in the prompt and `N LEFT AFTER` on Render; seed two recipes; a timed Playwright run of the five minutes | ~4.5 d |
| 12f Usage | `/usage` | the page and `/api/usage` exist with by-project/by-vendor figures | rebuild on v2 primitives; cycle-scoped headline; the shots taking the most takes; by production · person · engine; cap burn-down per project (`lib/burndown.ts` exists); statement download as the one primary; stop leaking vendor USD to members | ~6 d |
| 12h Admin | `/admin` | the desk exists (`app/(app)/admin`, `/api/admin/*`) with invites, engines health, workspaces, limits | rebuild as the four blocks on v2 tokens; batch-issue codes; per-provider engine rows with a kill switch (none exists); studios table with month-to-date margin excluding internal; grant budget + floor guard; platform-layer defaults editor | ~8.5 d |
| 12d Rig · Recipes | `/rig/recipes` | `/rig/recipes/[projectId]` with `recipes` / `recipe_stages` tables, `lib/runs.ts`, `Run to first checkpoint` | a workspace-wide list; the steps table with WHO DOES IT from the registry and an Atomik column (asks · alone · under the cap — a per-stage `mode`); `Run to the first stop` priced as the steps before the first ask; fork; open as a board (`recipes.board_id`); platform recipes seeded | ~6 d |
| 12e Deliver + take rail | `…/media` | the Media tab, `/api/export` (zip, CSV), review links (`/api/shares`), provenance (`take_ports`) | the Deliver band (masters named `{production}_{shot}_{version}`, CSV with Made-from, EDL/FCPXML rebuilt, review link minted from the tab); zip via signed Blob URLs; the take rail with Made from as links and three priced post tools that do not ask for a reason on an approved take | ~9 d |
| 12c Approve | `…/approve` | `review_state` on takes, `lib/compare.ts`, the shots API's approved-take rule; no route | the route; the queue selector (pure); two takes with one playhead; **one thread per shot** (`notes` are per take today — add `shot_id`, `take_id`, `timecode_ms`, `kind`); Send back as an API with history; Approve locks the shot; shortcuts | ~7 d |
| 12b Boards | `…/boards` | the stills path, shots with Setup and cast, bindings; no route, no panel role | the route; a `panel` role on stills; Sketch (three 1-cr panels per shot, batched); pick; nudge chips; **Use as keyframe** (see decision 4); Supervisor flag (`flags` table, §14.5); animatic (client-side sequencer; scratch voice via `/api/audio`; MP4 export is the open question); board-from-take; review link to panels | ~14 d |
| 12g Settings › Crew | `/settings#crew` | Settings with its index, rules (`workspace_rules`, platform layer), Atomik section | a Crew sub-section: the roster (§14.2) as a constant; per-role tier (Lite · Pro · Ultra → registry models) and per-skill checkpoint (`asks · alone · under N`) in a `crew_settings` table; role-scoped rules (`workspace_rules.role`, `production_id`); the playbook rows with source and switch; the compiler and Atomik read the role's rules | ~5 d |
| 12a Crew call sheet | `…/crew` | the Atomik rail, chats, steps, runs (`RunView` with stage states); nothing named crew | the Crew tab; `crew_members`, `proposals`, `flags` tables (§14.5); the call sheet API; one thread per member (`atomik_chats.crew_member_id`); the proposal card in the rail (Accept writes the change and Made-from); the AD row as the run's stage track in miniature; the Supervisor pass before a proposal reaches a person | ~8.5 d |

Total ≈ 68 engineer-days at the boards' full scope. Nothing here calls an engine for real; every priced button is a quote from the rate table.

## The order

SOW §6 numbers the rows; the handoff's map gives each board its dependency row. Taken together, and with the rule that a board ships desktop and phone in one PR:

1. **12f Usage** (row 16) — data and a rebuild, no new tables; unblocks the headline the account menu already tries to show.
2. **12d Rig · Recipes** (row 10) — the steps table and the per-stage Atomik mode are what 12a's proposals and 12b's Sketch batch reuse.
3. **12i Onboarding** (row 9) — the five-minute run, measured; needs decisions 1–3.
4. **12h Admin** (row 9) — the desk on v2 tokens, kill switches, grant budget; needs decision 1.
5. **12e Deliver + take rail** (rows 7, 14, 15) — exports and the post tools on an approved take; the take rail is where CR1 §12's references panel (Seedance edit) lives.
6. **12c Approve** (row 15) — needs the shot thread (its data lands here and 12b, 12a reuse it).
7. **12b Boards** (row 13) — the largest; needs decision 4 and the `flags` table.
8. **12g Settings › Crew** (row 16 + §14.3) — roster, tiers, playbooks.
9. **12a Crew call sheet** (§14.1–14.5, build order §14.6 step 1) — roles as scoped threads, proposals, flags, the call sheet.
10. Then §14.6 steps 2–7 (Supervisor and Production office first).

CR1's remaining items are folded in: **§12 references panel** into 12e's take rail; **§1 character / element maker** stays its own PR after 12b (the Casting role of §14.6 step 3 is its home); **§2 + §8 pickers** with 12g's tier control (one registry-driven picker); **§4 carousels** with 12e; **§7 Runs rename and gating** with 12d.

## Decisions needed before their rows

1. **The welcome grant.** SOW v2 §2 and board 12i say **50 cr**; `CLAUDE.md` §7A (copied from `docs/particl-sow.md`, "decided for launch") and the code say **250** (`SIGNUP_CREDITS`). Money: the code keeps 250 until you say otherwise.
2. **Invite code life.** Admin invites last 14 days in code; the board's email says seven; team invites already say seven. Proposed: seven everywhere.
3. **The demo cast's name.** The boards and READMEs cite `@Noor`; the seeded starter cast is `@Mara` (and "Mara Reyes" is the *person* in the v2 mocks). Proposed: rename the starter character to Noor.
4. **The keyframe binding.** `Use as keyframe` writes a KEYFRAME binding, but `bindings.element_id` is NOT NULL and a panel is a still, not an asset. Two shapes: (a) a `keyframe_gen_id` column on `shots` (smallest, no bindings change); (b) allow `bindings.element_id` NULL with `gen_id` (the SOW's slot model). Proposed: (a) now, (b) when 12a's proposals need it.
5. **One word.** The board says `Run to the first stop`; the SOW and the shipped page say `Run to first checkpoint`. Proposed: keep *checkpoint* (SOW §8 vocabulary), the boards are the prototype's hand.
6. **The rail's width.** Board 12a draws the compact rail at 360; README §5 and `RAIL_WIDTHS` say 300. Proposed: 300; the proposal card fits.
7. **Animatic export.** No ffmpeg on the platform. Proposed: client-side WebCodecs/MediaRecorder, uploaded and filed as an `animatic` take; the server never encodes.

## PR discipline

Each PR states what it costs a workspace to use, how engines are mocked, what changed in the compiler, where the code is workspace-scoped, which viewports it was verified on (Playwright at 360×640, 390×844, 844×390, 1440×900, 1920×1080; the full suite alone), and which old route it deleted. Routes and `lib/*` are extended, never replaced; after a schema-touching PR, §5 of the v2 SOW is diffed and updated. The one filled primary per screen, the ring as the only loader, accent only on approved / done / running / checkpoint.
