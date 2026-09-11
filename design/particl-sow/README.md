# particl v2 — SOW surfaces (turn 12): Crew, Boards, Approve, Recipes, Deliver, Usage, Crew settings, Admin, Onboarding

Nine desktop screens (1440 × 900; 12i is 1440 × 620) in `design-references/Particl v2 - SOW Surfaces.dc.html`, badged 12a–12i. They cover every SOW surface the shipped boards (11a 10a 9b 9c 8a 8b 7a 7b 6a 4a 3a 3b) do not. Same tokens, same shell, same rules; `DESKTOP-README.md` is the design system of record and `particl-sow-v2.md` is the scope of record. Where the two disagree on a pixel the README wins; on scope, data or money the SOW wins.

Open the file in a browser (keep `support.js` beside it). 12b, 12c and 12d are interactive. The file is a design prototype, not code to lift — rebuild with the repo's primitives (`components/ui/`, `components/atomik/Ring.tsx`, `Loader.tsx`). Striped grey rectangles are image placeholders. All data is placeholder.

## Map

| Board | Screen | Route | SOW | Depends on (SOW §6 row) |
|---|---|---|---|---|
| 12a | Crew · call sheet + a proposal in the Atomik rail | `/productions/[prod]/[project]/crew` (a Crew tab beside the stepper) | §14.1–14.4 | 5, 7 |
| 12b | Boards | `…/boards` | §7.5 | 6, 8 (row 13) |
| 12c | Approve | `…/approve` | §7.5 | 8, 9 (row 15) |
| 12d | Rig · Recipes | `/rig/recipes` | §7.7 | 10 |
| 12e | Deliver on the Media tab + take rail (Made from, post tools) | `…/media` | §7.3, §9 | 7, 14, 15 |
| 12f | Usage | `/usage` (account menu only) | §7.12 | 9 (row 16) |
| 12g | Settings › Atomik › Crew | `/settings#crew` | §14.3 | 16 |
| 12h | Platform admin console | `/admin` (platform role) | §7.13 | 9 |
| 12i | Onboarding, the first five minutes | `(auth)/invite → account → workspace → /make/video` | §3.8, §9 | 9 |

## What each screen enforces

**12a Crew.** One row per crew member: role + tier, doing now (the AD row shows the run's stage track in miniature; a working member shows the 14px ring loader), waiting on (ink when it's you), spent. `Hire a role` adds a row. **Proposals are the only way the crew changes the production**; the rail shows one from the DOP as a card: eyebrow, one-sentence headline, the rows it would add, a Supervisor line (accent dot, "line held"), filled `Accept · adds 5 shots · 0 CR`, `Edit` / `No`, and a plain note that rendering is separate and asks first. The rail is in its compact state (360px) on the DOP's thread; the page primary is therefore outlined. Data: `crewMember`, `proposal`, `flag`, `callSheet` from SOW §14.5. The Supervisor flags; it never approves. Nothing on the crew spends, unlocks, deletes, approves or publishes.

**12b Boards.** Per shot: id + planned seconds + description; three 1-credit panels (click = pick; the picked one carries a `PICKED` chip, ink border); nudge chips under a picked shot (Tighter · Wider · Other side · Different hour · Again 1 CR); right column `Use as keyframe · 0 CR` (outlined) or `KEYFRAME SET` in accent once promoted — promotion writes the shot's KEYFRAME binding and Made-from. A generating shot shows the 36px ring loader. A Supervisor flag sits **between** the two shots it concerns, with two priced choices (`Flip SH05 · 1 CR`, `It's intended`). Animatic bar pinned at the bottom (play, one line, `Scratch voice · 9 CR`, `Export MP4 · 0 CR`). The one filled primary prices the unsketched shots (`Sketch the last 3 shots · 9 CR`). If a take is approved and the board no longer matches, the board updates from the take.

**12c Approve.** Left: the queue, need-you first, approved ones dimmed. Right: two takes side by side (2px ink border on the picked one; click to pick), **one playhead** under both, then the shot's **one thread** — every note tagged `WHO · TAKE · TIMECODE`; Supervisor notes in ink; the input pre-tags the picked take and the current frame. Footer: outlined `Send v2 back with a note` (returns the shot to draft, note attached, logged in history and Usage) and filled `Approve v2 · 0 CR · LOCKS SH03`. Approved shots are locked; rendering against one asks for a reason. The 3-up and A/B-wipe modes from the SOW are the same component with three players / a wipe handle; not drawn.

**12d Recipes.** Left: recipe cards (name, one-line blurb, scope PLATFORM or YOUR STUDIO, step count, total). Right: the steps table — `# · STEP · WHO DOES IT (engine · provider) · COSTS · ATOMIK` where the Atomik column is a plain phrase with a dot: **Asks first** (accent ring dot) / **Runs alone** / **Runs under the cap**. Below: the whole-run price and how many stops, then the filled `Run to the first stop · N CR` (N = the cost of the steps before the first "asks"). `Copy and change` forks; `Open as a board` goes to Canvas. Floor line: over 200 cr always asks; training, publishing, deleting always ask. Engine names come from the adapter registry (SOW §2), never typed.

**12e Deliver.** Lives on the Media tab, above the media: a Deliver band with three cards — Masters (named `{production}_{shot}_{version}`), Shot list + edit file (CSV, EDL/XML), Client review link (tokenised, 7-day expiry, revocable, workspace-branded, comments write back to the shot thread) — and the filled `Download 2 masters · 0 CR` (Blob via signed URL). Media below by shot; the selected master has an ink border. Right rail for the open take: `SH02 · v1 · APPROVED · THE MASTER`, the frame, **Made from** (character + version, look, place + plate, engine, seed — each a link), **Do more with it** (Reframe to 9:16 · 4 CR, Upscale to 4K · 5 CR, Extend by 3 seconds · 11 CR — each outlined, each files as the next version; v1 stays the master).

**12f Usage.** From the avatar menu (Usage · Settings · Sign out — the only place these live). Headline: month, spent, left, days at this pace, filled `Download the statement · PDF · CSV`. First card: **the shots taking the most takes** — take blocks per shot (accent = approved, ink = picked, faint = draft, dim = sent back), count and send-backs, state, spent. Then By production · By person · By engine (Planning is its own bar), then **cap burn-down per project** (bright = spent, dim = projected end at the current takes-per-shot; the label says over or under and by how much). Statements are itemised in credits with one USD line for the pack; included and purchased credits are counted separately.

**12g Settings › Crew.** Sticky index (Studio and credits · Team · Engines and rates · Atomik · Crew · Storage · Account); the page's one filled primary, `Top up`, is in the first section. Crew table: role · model tier (Lite / Pro / Ultra segmented; registry models and rates named in the header line) · jobs as chips with `ASKS` / `ALONE` / `UNDER N` · rule count. The expanded DOP row lists its playbook: each rule in plain words, its source (`PLATFORM` / `YOUR STUDIO` / `THIS PRODUCTION`) and a switch; a dashed `+ Add a rule in plain words` row. Footer line restates the floor. Saves on change.

**12h Admin.** Platform role only; the header carries a `PLATFORM · ADMIN` chip and month totals (engine spend, margin excluding internal, grant budget). Four blocks: **Wants in** (invite queue; the one primary `Send 3 codes · 50 CR EACH` issues 7-day codes), **Engines** (dot, error rate, rate-limit room — ink when over 70% — and one kill switch each), **Studios** (tier, engine $, billed credits, margin, note: a studio over 25% of monthly spend is flagged; a margin under 10% resets the multiplier; `internal` bills at 1.0× and is excluded), **What every new studio starts with** (platform-layer defaults: Setup rows, rules, recipes, demo production, caps) with `Edit the defaults`.

**12i Onboarding.** Four cards on one timeline: the email with a 7-day code → account (name, password) → studio name (arrives seeded: demo production, camera vocabulary, two recipes, a 50-credit grant) → Make with the demo's `@Noor` already in the prompt and `Render · 19 CR · 31 LEFT AFTER`. First render at 4:10; the bar shows 4:10 of 5:00. Timed on every release (SOW rule 8). No Rig, no Settings, nothing to read.

## Rules that hold on every board
- One filled primary per screen, its price inline, a `quote` resolved before it enables; outlined while a rail or sheet is open.
- Accent `oklch(75% 0.12 200)` only on approved / done / running / checkpoint.
- The Atomik ring is the only loading indicator (14px in rows and buttons, 36px in wells).
- Nothing under 11px on desktop. No shadows, no gradients beyond the placeholder stripes, no motion beyond the ring.
- Vocabulary: assets, Made from, stale, "Ask Atomik". Crew members propose; people accept.

## Mobile
Not drawn for these nine. Build them as responsive variants using the chrome in `MOBILE-README.md`: dock, sheet, pinned primary. On a phone a crew member is a thread and a row on the call sheet, never a canvas (SOW §14.6); Approve on mobile is queue then compare with two takes stacked and one playhead (SOW §7.14).

## Files
```
README.md                                       this document
particl-sow-v2.md                               scope of record
DESKTOP-README.md                               design system of record (tokens, primitives, shipped boards)
MOBILE-README.md                                mobile chrome (dock, sheets, pinned primary)
design-references/Particl v2 - SOW Surfaces.dc.html   boards 12a–12i
design-references/support.js                    preview runtime only — do not port
assets/                                         particl mark, atomik ring (static fallback; render live from Ring.tsx)
```
