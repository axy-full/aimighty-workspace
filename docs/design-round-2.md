# Design round 2: the frames the handoff does not draw

The brief for a Claude Design round before U1 (owner's answer 15, 5 October 2026). It lists every frame the 4 October handoff (`design/particl-graphite/`) leaves out. Sources: the overnight report's "Frames the handoff does not draw", `docs/handoff-diff.md` §5, §6 and "Where the repo wins", and the owner's answers of 5 October. Prices are at **1 credit = US$0.10**, the handoff's own samples.

## Rules for the designer

- **Tokens:** only `app/graphite.css`, which is README §2. Never add a value. Draw the dot grid as an SVG pattern, not a gradient. Use no gradients except project swatches and avatars.
- **Floors:** text is at least 12 px and at least 55 % white on desktop and phone, except disabled controls and the logo. Phone targets are at least 44 px. No nowrap row may be wider than its column at 360 px.
- **Sizes:** draw the desktop at 1440 × 900 and the phone at 390 × 844. Every layout must hold at 360 × 640, 844 × 390 and 1920 × 1080 with no sideways scroll. Sheets slide up, and the dock and sheets stay clear of the home indicator.
- **Names:** use generic placeholders only. No real person, studio, client, brand, voice or token prefix (ground rule 3). Product words come from README §7 (Board, Make, Motion transfer, Object swap, 3D blocking, Identity, held, settled). The Make shortcut is **⌥M**.
- **Prices:** write "N cr", "up to N cr", "about N cr, at most 3N cr" or "free", in whole credits, and never "quoted". Hovering a price shows dollars at 1 cr = $0.10. Take every figure from the price key below.
- **No invented features.** Draw only what the code does or what the owner has decided. A control not listed here stays out.
- **Money:** only a person approves spending. Atomik and MCP agents prepare. A step over the per-shot cap carries an admin marker and is left out of one-tap approvals.
- **No prose.** One action and a short label beat a paragraph (rule 9). Empty states show one action and a template.

## Price key

The handoff's figures, checked by running the repo's pricing code at `CREDIT_USD=0.10`.

| Figure | Price | Where the code differs at $0.10 |
|---|---|---|
| Seedance 2.5 · 1080p · 5 s | 43 cr | Same |
| Seedance 2.5 · 480p · 5 s (Draft first) | 8 cr | Not in the handoff |
| Kling 3.0 Standard · 5 s (· with sound) | 7 cr (· 10 cr) | Same; a 10 s take is 13 cr, not 14 |
| Nano Banana Pro · 1K / Nano Banana 2 · 512 | 3 cr / 1 cr | Same |
| Takes × 2 / × 4 (batches multiply before rounding) | Seedance 86 / 172 cr · Kling Std 13 / 26 cr · NB Pro 5 / 9 cr | Not in the handoff |
| Looks · 4 frames / Storyboard · 3 frames | 12 cr / 9 cr | Same as separate jobs; sent as one batch of the same prompt, they would be 9 cr and 7 cr |
| Video upscale (Topaz) · 5 s | 23 cr at 1080p in the handoff | The code offers only 4K, so 5 s reads **38 cr** |
| Image upscale (Topaz) | "up to 23 cr" in the master | 2 cr (24 MP) or 3 cr (48 MP) |
| Seedance Edit / Select & edit a region | up to 43 cr | Live estimate; no card row |
| Identity training · 1,500 steps | 54 cr | Same |
| Prompt enhance | 1 cr | Same |
| Voice, music, effects (ElevenLabs) | up to 1 cr | Estimate |
| Atomik's thinking | up to 4 cr | The ask form's planning ceiling is about 14 cr on an empty board at the auto model's rate (24 cr at the snapshot limits) |
| How-to answers | free | Same |
| Cinema Studio 4.0 · 720p · 5 s | about 35 cr, at most 105 cr | The 3× bound is the settlement band in `lib/cinemaStudio.ts` |
| Motion transfer / Object swap | up to N cr | The provider's live estimate; no figure until it answers |
| Plan "Make 3 shots" (43 + 43 + 7) · fixes | 93 cr · at most 186 cr | Same; board frame e's 114 is a design error |
| Plan "/hero-takes" (9 + 43 + 7 + 7) · fixes | 66 cr · at most 114 cr | Same |
| Per-shot admin cap | 40 cr sample | A workspace setting; the code's default is 50 cr |
| Production budget · 80 % pause | 200 cr · 160 cr | Same; frame f2's 161 is wrong |
| Approval line (every job above it needs a person) | 200 cr ($20) | Same (`JOB_APPROVAL_LINE_USD`) |
| Auto limit | 10 cr sample | In code, the per-job line, which falls back to the 200 cr approval line |
| Top up | Starter · 500 cr · $50 | The sheet lists every pack: 500 · 2,000 + 200 · 5,000 + 750 · 20,000 + 4,000 |
| Failed / short balance samples | Retry · 7 cr · Short by 26 cr | Same |

## Make

- **Film chips and shot control:** chips folded under the engine line, with chips set, chips cleared and the Advanced fold open. Desktop panel at 440 px, plus the phone sheet. Price on Make · 43 cr.
- **Enhance and Auto:** Enhance off, on, and running ("Enhancing"), plus the Auto default. Price: Enhance · 1 cr.
- **Aspect, resolution, length:** chip rows. Show the price changing with each, e.g. Kling Std 5 s 7 cr → 10 s 13 cr, and Seedance 2.5 1080p 43 cr → 720p 18 cr. Desktop and phone.
- **Draft first:** off, then on (Make · 8 cr for the 480p draft), then "Draft done" with "Make the final · 43 cr" awaiting approval.
- **Sound:** a toggle on the engine line, e.g. Kling Std 7 cr → 10 cr.
- **Voice and music:** the voice picker, music length and Instrumental. Price: Make · up to 1 cr.
- **Takes count:** 1, 2 and 4 takes. Seedance reads 43, 86 and 172 cr; Kling Std reads 7, 13 and 26 cr.
- **Footer lines:** the balance after the take and the engine line with Change. The hover dollar reads 43 cr = $4.30.
- **Edit tab:** a take loaded for editing, with "Change with words · up to 43 cr" and "fix 1 of 2".
- **Cinema Studio 4.0:** chosen on the engine sheet, reading "Make · about 35 cr, at most 105 cr" at 720p 5 s. Desktop and phone.
- **Upscale (card action):** idle, running, done and failed. Video reads "Upscale to 4K · 38 cr" at 5 s. Image reads "Upscale · 2 cr" (24 MP) or "3 cr" (48 MP).
- **Seedance Edit (card action):** select a region, then Edit · up to 43 cr, then running and done.
- **Failed:** "Nothing billed · Retry · 43 cr" when nothing was charged, otherwise the charged figure with Retry. Desktop panel and card.
- **Insufficient credits:** "Short by N cr", with Top up · 500 cr · $50 beside a Make that waits. Desktop and phone.
- **Empty prompt:** Make disabled, with the reason in one line.
- **Close:** "Close · ⌥M" on the panel.

## Motion transfer / Object swap

- **Source video:** empty, uploading, loaded (with length) and removed. Desktop and phone sheet.
- **Start and end frame:** both empty, one set, and both set.
- **References:** Motion transfer takes 1–8 images, reorderable by drag (desktop) or long-press (phone). Object swap replaces **one element per run**; reference images of that one element are allowed.
- **Run:** a price of "up to N cr" while the estimate loads, then the figure. Running with progress and Cancel, then cancelled ("Nothing billed" when nothing was charged).
- **Rendered row:** the result with Use as reference · Download · Versions, all free.
- **Recent:** the variant's own Recent list, both empty and filled.

## Board money states (desktop)

- **Short balance on the plan card:** "Short by 26 cr" against a 66 cr plan, with Top up · 500 cr · $50 and an Approve that waits.
- **Failed step in a group:** "Nothing billed · Retry · 7 cr", and a second variant where something was charged and that cost is shown.
- **Unavailable engine:** "Unavailable · no key for Kling 3.0" on the engine line, and the plan step skipped with its reason.
- **Admin markers:** a step over the 40 cr cap is marked "Needs an admin" (hero take 43 cr). Draw it as a member sees it and as an admin sees it.
- **Stopped:** the group header reads "Stopped · 50 cr spent", and finished slots keep their takes.
- **The 80 % pause:** "160 of 200 cr settled · continuing holds 43 cr more", with Continue · 43 cr and Stop.
- **Offline:** the board is read-only, with "Offline · changes queue" top right and every spending button disabled.
- **Undo toast:** the dot is green only for success with Undo or Open. Errors get no green dot.
- **Reject with a reason:** the reason chips and free field, then the dimmed card reading "Rejected · nothing more spent".
- **Jobs tray:** status dots (rendering, held, failed, done) with the held and settled figures in cr.

## Boards

- **Sample board:** the sample production from Home, reading "Sample · spends nothing" with every price shown but disabled.
- **Operator and flow cards with wires:** card-to-card wiring on the board, with connect, a selected wire and delete.
- **Empty Ads board and empty Social board:** one action and a template each. Ads "Read the site · up to 3 cr", Social "Find clips · up to 4 cr".
- **Post states (Social and Ads):** waiting for approval, approved and failed. Approve post is free and **person only**.
- **Identity training:** no consent, consent recorded, training (with progress), ready, failed. Price: Build identity · 54 cr.
- **Consent capture:** record consent (person only, free), the record card, an expired consent, and a consent that blocks Build identity.

## Review links

- **Create a link:** pick the project, add a label, set the expiry, then copy. Free. Draw the created, expired and revoked states.
- **The client's page:** the project's approved takes in shot order, under the workspace's logo, with a comment box (name and text) on each take. No prices, no balance. Desktop and phone; also draw the empty state, "Nothing has been approved yet".
- **Back on the board:** the client's comments in the take's notes, marked as the client's.
- **Client approval:** the overnight list asks for an approve button, but the code has comments only. Leave it out unless the owner adds it.

## Settings

- **Connections › MCP token creation:** name it, choose the scope ("read-only" or "Can prepare jobs · a person approves each"), show the token once, then revoke. A revoked token is shown too.
- **Team › security:** two-factor on and off, sessions, and removing a member.
- **Advanced › General:** the workspace name and export.
- **Spending rules, editing:** the per-shot cap (40 cr sample) and the budget (200 cr, pause at 80 % = 160 cr), each with editing, saved and refused (not an admin) states. Ask is the default and Auto is admin only. The approval line reads 200 cr as fixed, not editable.
- **Plan & credits › Top up:** the pack sheet (Starter 500 cr · $50, Team 2,000 + 200, Studio 5,000 + 750, Agency 20,000 + 4,000), then "Requested · waits for the platform". The balance hovers as cr = $ at $0.10.

## Editors

- **Edit & Sound in the new IA:** opened from Cut with "Open Edit & Sound", with the timeline, tracks, mix, and Render master · free.
- **3D blocking:** opened from a shot card (Inspector › Advanced), showing the scene, camera, and "Use as reference" back on the shot. Free; renders from it carry their engine's price.

## Phone

- **Review link (client):** watch the approved takes and comment. No prices.
- **Reject with a reason:** a slide-up sheet, then the Undo toast (green dot only for success).
- **Unavailable engine and stopped group:** shown on the plan and record screens. The stopped group reads "Stopped · 50 cr spent".
- **Make controls in the sheet:** takes count, Draft first (8 cr), Sound, and Cinema Studio "about 35 cr, at most 105 cr".
- **Motion transfer / Object swap:** a source, one element, then "up to N cr", then running with Cancel.
- **Atomik sheet:** "Ask · free" for how-to questions, otherwise "Ask · up to 4 cr" (see the price key).
- **Unlock a cap:** an admin raises the per-shot cap or the budget from the pause card. Continue · 43 cr.
