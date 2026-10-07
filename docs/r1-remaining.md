# Release 1: what is left (7 October 2026, updated 23:59 IST)

Base: `release/1` @ ac03f878 plus open branches. Estimates are agent-hours (build + review); calendar assumes about 4 parallel lanes. Confidence is low where a screen has never been shot. Nothing merges to main without the owner's "go".

## A. Blocks shipping

| # | Item | State today | What is left | Blocked on | Estimate |
|---|---|---|---|---|---|
| 1 | CI green on `release/1` | Unit green on ac03f878. About 240 browser tests were red on 3ca30197; four fix lanes running (Make, Settings and credits, board, stale-tab money fix) | Finish the lanes, review each, merge in batches, one full uncancelled green run | Nothing (owner Q7 below for the money fix) | 25–40 h, 1.5–2.5 days |
| 2 | Make: second paid request from a stale tab | Found by the CI lane at 17:30; Opus lane confirming and fixing | Fix, ported test, Opus review, owner yes | Owner (question 2) | 6–10 h, 1 day |
| 3 | Owner's yes before main on reviewed money and sign-in work | In `release/1`, reviewed: #556 money states, #540/#559 Cinema (Make shows "about N cr, at most 3N cr"), sample paid-off, old pages (sign-in redirects). #558 already has the owner's yes | The owner's yes on each; a fresh delta review if anything moves before the train | Owner | 1–2 h per item |
| 4 | Five-minute test, desktop and phone | Spec exists; step 5 ("Start · up to N cr") is still `fixme` | Un-fixme, run both sizes on the mocked preview, fix what it finds | #1 | 4–8 h, 1 day |
| 5 | 3D blocking part B | 44cda874, Opus PASS; follow-up hides the sample's priced Remake (building) | Merge after Q7; the `production.blocking` field reaches live only in the train | Owner Q7 | 3–5 h |
| 6 | D0 right-click prices, Delete with Undo, pricing nav, sign-in wording | Merged with D0; never re-checked screen by screen | One pass at five sizes, shoot, fix | #1 | 3–5 h |
| 7 | Atomik run states | Cards exist; never shot against frames b, c, f, f2, k, j | One mocked run, desktop and phone; fix mismatches | Nothing | 6–10 h, 1 day |
| 8 | Lane 3 screens: Edit & Sound, phone Cut, Crew review, empty Ads/Social, post states | In code; never compared frame by frame | Frame-by-frame check and fixes | Owner Q4, Q5 (recommended yes) | 6–10 h, 1 day |
| 9 | Sample production (dunes film), Home waiting strip, sample card | Strip and card draw only with data; preview seed merged; film not made | Seed "Particl sample"; owner approves the draft; one paid run with the owner's yes per step | Owner: draft version and ceiling (SOW says v3 / 326 cr, handover says v4 / 233 cr) | 4–6 h plus run time with the owner |
| 10 | "Particl demo" cap field | Built, unmerged: `admin/workspace-cap-field` | Opus money review, merge | Owner: keep or retire "Particl demo" | 3–5 h |
| 11 | Guest Home on (#538) | Built and merged, setting OFF | Owner flips it on the preview and reviews; check invite-only, Request access, /signup | Owner | 3–5 h |
| 12 | Old pages: dead code and redirects | Pages gone; six temporary 307 redirects; unreachable old code remains | Owner confirms the six redirects; remove dead code; delete five unreachable "Save this project before…" messages | Owner (decision 21) | 5–10 h |
| 13 | Preview price check | Preview runs on staging | Owner signs in: Motion transfer and Object swap at 6 s, 720p (about 62 cr) | Owner | Owner time |

## B. "Complete" extras: owner to confirm scope

| # | Item | State | What is left | Blocked on | Estimate |
|---|---|---|---|---|---|
| ~~14~~ | ~~Image-ad variants and presets~~ (owner, 23:55: dropped from Release 1; after-release list) | Ad card and preset catalogue exist; variants not ported | Port to the board card, Product image naming, prices, five sizes | No variants frame found: may need Claude Design | 8–12 h, 1.5 days |
| 15 | Phone Make quick tools and Recent | Phone Make is the simple one; no phone frame for these | Draw in Claude Design, then build | Design | 6–10 h after frames |
| 16 | Phone Activity, Memory, Skills | "Open this on a larger screen" today | Draw three phone frames, then build | Design | 8–12 h after frames |
| 17 | Captions in the browser (Cut, "Use as captions") | Not built, hidden; frames in Gaps A | Browser caption layer and browser export | Owner scope | 12–20 h, 2 days |

## C. After-release list (owner: out of Release 1)

| # | Item | Why later | Estimate |
|---|---|---|---|
| 18 | Server "Render master" | Needs the render worker on the server (P4/P8). Release 1 shows nothing, or a disabled line | 30–50 h plus P3/P4 |
| 19 | Server burned-in captions | Phase 4 (E7/E7R) | weeks |
| 20 | Social posting | Needs a publisher, per-network apps and the owner's accounts | 30–50 h plus app review |
| 21 | Tripo prop from a photo | Decision 20: after the demo, needs the owner's key and terms | 12–20 h after the key |

## Totals
- A (ship-blocking): about 75–125 agent-hours, about 3–4 calendar days with 4 lanes, plus the owner's answers and preview review.
- B (if in scope): about 35–55 h, about 1.5 days after design frames.
- C: 2–4 weeks plus infrastructure and accounts.

## Progress since 18:00 (23:59 IST)
- A1 CI: about 240 failing tests at 16:00 → 2 test-side expectations left on release/1 ef7beb21 (being fixed).
- A2 stale-tab double payment: fixed, reviewed, in release/1.
- A4 five-minute test: passes on desktop (86–103 s) and phone (72–112 s); a phone review bug it found (Undo toast lost on the last take) is being fixed; phone tap budget is owner question 13.
- A5 3D blocking B: in release/1.
- A6 D0 shell: checked at five sizes, two bugs fixed, in release/1.
- A10 "Particl demo" cap: reviewed, in release/1 (owner: $0 cap, 100 cr grant on "run"; Atomik text counts).
- A12 old pages: 155 unreachable files deleted (in release/1); the still-mountable old Business/Crew/Inspector screens are being cut.
- After-release list now also holds: image-ad variants and presets; Atomik's idea draft; IPv6 /64 rate-limit buckets; a per-email sign-in slow-down; the guard and wording lows from tonight's reviews.

