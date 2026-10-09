# Plan: E7R, Remotion (Phase 4)

Status: plan only, written 6 October 2026. No product code. **Do not merge before Friday 9 October.**
Scope source: `docs/particl-sow.md` v2 (branch `docs/sow-v2`) § 5, row "E7R (new): Remotion", and § 8 (building blocks). The licence terms and figures are in that SOW and are **not restated here**; this plan points to them.
Rules that bind this package: CLAUDE.md rules 1, 2, 11, 14, 15; the SOW's § 0 (design, merging, secrets) and the rule that Claude Code never changes DNS, Cloudflare, Coolify, Vercel or hPanel settings.

## 1. Goal and done-when

**Goal.** Finished films and ads look designed, without a person opening an editor. Atomik, a button, a board card or an outside agent can add:
1. **Designed captions** from a transcript, in a few styles, kept inside the safe area of the frame.
2. **Title cards and end cards**, with the brand kit's colours, type and logo.
3. **Ad versions** of one finished video at **9:16, 1:1 and 16:9**, each with the brand kit, headline and call to action.
4. **A final cut with graphics**: the approved cut with titles, lower thirds, captions and an end card added.

Each template is a **registry tool** (A1), so the same tool, gate and result serve the button, Make, the board, Atomik, a skill and MCP. Previews are free and instant in the browser with `@remotion/player`. Final files are rendered on the server in the VPS worker through Inngest, **behind a flag until P4 is live**. Renders are free to customers; Particl reports monthly counts in `/admin` and flags the count at the SOW's threshold.

**Done when:**
1. Each of the five templates (captions, title card, end card, ad versions, final cut with graphics) is a registry tool with a price (free), a mock, and a test proving Atomik can run it.
2. A preview in the browser and the server render of the same inputs match frame for frame (a golden-frame test inside tolerance), including fonts.
3. Ad versions come out at 9:16, 1:1 and 16:9 from one master, with the brand kit, and none of them cuts the headline or the call to action off at any size.
4. A render runs on staging in the worker container, is queued with per-plan limits, survives a worker restart, can be stopped, can be retried, and lands in the Library under the workspace's own storage path.
5. The licence gate holds: with the owner's confirmation unset, **no workspace but the internal one can start a server render**, proven by a test. The owner has been told, in writing and before the first customer render, that he must buy the Company License.
6. `/admin` shows the month's server render count and flags it at the threshold in the SOW.
7. No prompt text, secret, media URL or customer content is in any log line the worker writes.

## 2. What exists today (and what is reused)

Nothing here is rebuilt. Remotion is added **beside** the existing export code, not in place of it.

| What | Where | Used how |
|---|---|---|
| Browser movie export: WebCodecs and Mediabunny, MP4 or WebM, 16:9 / 9:16 / 1:1 / 4:5, 720p or 1080p, fit or cover, mix, LUT; limits 3 minutes and 200 MB | `lib/workbench/movie.ts`, `render-movie.ts`, `mix-audio.ts`, `color.ts` | **Stays.** It is the fast, free, no-server path and the source of the finished master E7R decorates |
| Editorial packages (EDL, FCPXML, Premiere XML), export naming | `lib/workbench/editorial-xml.ts`, `studio-export.ts`, `export-names.ts` | Stays; ad versions reuse `withExportNames` so files are named like the rest of the workspace's downloads |
| Transcripts with **word timings** and speakers, plus an SRT | `lib/transcription.ts`, `lib/xaiVoice.ts` (`Transcript`, `transcriptSrt`) | Captions read the words directly; no new transcription |
| Brand kit: name, tagline, voice, audience, colours, font; a brand read from a web page with logo candidates; saved as a "brand kit" setup item | `lib/workbench/moleculr-creative.ts` (`BrandKit`, `EMPTY_BRAND_KIT`), `brand-extraction*.ts`, `lib/shell/business-own.ts` | The brand input of every template |
| The poster document and its Designer (editable type, images, shapes) | `lib/workbench/moleculr-poster.ts`; `components/graphite/board/ads/Designer.tsx` (branch `demo/board-everyone`) | Title and end cards share its type and layout vocabulary so a poster and a card from one brand match |
| The board: Cut and Deliver cards, Ads rail (Brand, Product, Hooks, Formats, Ads, Adapt, Deliver), Social rail | `components/graphite/board/cards/cut/*`, `deliver/*`, `board/ads/*`, `board/social/*` (branch `demo/board-everyone`) | Adapt and Deliver on Ads read "Not in Particl yet" today; E7R and E8 fill them. The Cut and Deliver cards get a graphics step |
| Background work: events, native and Inngest dispatch, per-workspace concurrency | `lib/dispatch.ts` (`EVENTS`, `WORKER_EVENT_NAMES`), `lib/inngest.ts`, `lib/workers.ts` (the `render` function caps provider work and one workspace's share), `lib/worker-handlers.ts`, `app/api/worker`, `app/api/inngest` | A new event and a new function, in the worker container |
| A precedent for a non-model server render that stores artifacts and registers them as Library assets | `lib/astra-blender/render-jobs.ts`, `render-storage.ts` (`registerAstraArtifacts`), `render-dispatch.ts`, with durable job rows and a request key | The shape of the render job table, quote-free claim, poll and collect |
| Storage behind one interface; R2 built but off | `lib/storage/*` (`STORAGE_BACKEND=r2`, Blob fallback), `docs/r2-migration.md` | Outputs written under the workspace's prefix; P3 adds media.particl.si and signed links |
| Bundle checks | `tests/unit/bundle.spec.ts` (what a browser is served) | Extended: the server renderer must never be in a browser chunk |
| Stack | Next 16.3.6, React 19.3.0, zod 4 (`package.json`) | Remotion's React and Next compatibility is checked first (PR 1) |
| Mock engines | `ENGINE_MOCK=1` (`lib/mock.ts`) | Every render tool has a mock answer |

**Not on `main`, so not assumed:**
- **FFmpeg on a server.** `lib/clipTrust.ts` says there is no decoder on the server. E7 (FFmpeg captions, server renders, AAF) and P8 (the worker container) are not built.
- **The tool registry (A1).**
- **Self-hosted Inngest, the Docker image, R2 on, media.particl.si** (P3, P4).
- **A final master "cut" artifact on the server.** Today the cut is exported by the browser; S2's "assemble the cut and deliver" produces it later.

## 3. The design

### 3.1 What Remotion does and does not do here
- **Does:** draw designed graphics (type, shapes, brand, motion) over or around video; resize one video into three shapes; render the result to MP4 with the video's own audio passed through.
- **Does not:** generate pictures or video from a model; replace the browser's free export; mix or grade audio and picture (the finished master is already mixed and graded); run any customer-written code. A template is **our code**; customers supply data (text, colours, a logo, a video, a transcript).
- Not used: Remotion Lambda, Remotion Studio exposed to customers, uploaded fonts or SVG logos in the first version.

### 3.2 Where the code lives
- `remotion/` at the repo root: the entry file, one folder per composition, shared layout and type helpers, the font files. **Pure React with a typed props schema** so the same composition renders in the Player and on the server.
- `lib/remotion/` (server glue): template list, props schemas (zod), brand-kit mapping, job table, enqueue and status, the licence gate and counts.
- The **renderer and bundler packages are installed only in the worker image**. The web app imports only the Player and the compositions, lazily, on the cards that preview. A bundle test fails if the renderer reaches a browser chunk.
- The render function is registered by the **worker container** (the one P8 builds), not by the Next app, so Chromium never runs inside a Vercel function.

### 3.3 Templates and their inputs
Every template has an id, a label (descriptive, to be confirmed with Claude Design; no invented product names), a zod props schema with hard limits, default props, a duration function, the aspects it supports, and the inputs it needs. Text is plain text with length limits; no markup.

| Template (registry id) | Inputs | Output |
|---|---|---|
| Captions (`render.captions`) | a video asset (the master), its transcript (words), a style (a few, e.g. words highlighted as spoken, a line at a time, boxed), brand kit, aspect | MP4 with captions burned in, same size and audio as the master |
| Title card (`render.title_card`) | title, subtitle, brand kit, aspect, length | short MP4 and a still poster |
| End card (`render.end_card`) | headline, call to action, logo, URL text, brand kit, aspect, length | short MP4 and a still |
| Ad versions (`render.ad_versions`) | one finished master, the aspects wanted (9:16, 1:1, 16:9), headline, call to action, brand kit, a focus point per aspect | one MP4 per aspect, named like the workspace's other downloads |
| Final cut with graphics (`render.final_cut`) | the approved master, a list of graphics (title at the start, lower thirds at times, captions on or off, end card), brand kit | one MP4: the master with the graphics and the end card appended |

### 3.4 Brand kit, fonts and legibility
- **Colours:** the kit's colours become the palette; text colour is chosen by contrast (at least 4.5:1 against its background) and the render is refused if no colour pair passes.
- **Fonts:** a small, licensed set bundled with the worker and loaded from files, never from the internet at render time, so a preview and a render use identical letters and the worker needs no network. The kit's font name maps to the nearest bundled font; "system" maps to the default. **Uploaded fonts are out of the first version** (a licence and safety question). Text in scripts the bundled fonts cannot draw is refused with a clear message rather than showing boxes (owner decision 7).
- **Logo:** PNG, JPEG or WebP, stored in the workspace. **SVG is refused** until sanitised (an SVG can carry scripts, and the renderer is a browser).
- **Safe areas:** per aspect and per placement. Captions and cards keep clear of the edges and of the lower band that apps cover on a phone. A unit test measures every template's text box against its safe area at each aspect with long and short strings.
- **Fitting:** headline and call to action shrink to fit, to a floor, then truncate with an ellipsis. A card never overflows its frame.

### 3.5 Previews with the Player
- Free and instant: no job, no queue, no count. The Player runs the composition in the browser with the real props.
- **Parity rule:** the same composition, props and fonts as the render. One **golden-frame test** renders a chosen frame of each template with the Player (Playwright screenshot) and with the server's still renderer, and compares them within a tolerance. A mismatch fails CI.
- The Player needs to read the master video from the browser: media must be served with the right cross-origin header for the app's address. That is a P3 step for the owner (CORS on the media bucket), listed in the go-live checklist.
- Phone: preview is view-only (play, scrub); editing text and choosing a style are on desktop and in Make, per the two-surface rule (rule 7).

### 3.6 Server renders
- **One event**, `remotion/render.requested`, added to `lib/dispatch.ts` (and `WORKER_EVENT_NAMES`), carrying ids only.
- **A durable job row per render** in the workspace's database (additive table): id, template, a hash of the props, a request key, status (`queued`, `rendering`, `done`, `failed`, `stopped`), attempts, progress, output asset id, bytes, frames, started and finished times, a short reason. The row is written **before** the event is sent, so a lost event is recovered by the existing recovery sweep, as with other renders.
- **Claim, poll, collect**, the same path every tool uses (A1): request key makes a repeat press return the same job; the client polls status; the finished file is collected as a Library asset. There is no quote step to approve because the price is free; the claim and the idempotency still apply.
- **The Inngest function** limits work the way the existing `render` function does (a global cap and a per-workspace cap), and the SOW's per-plan limits (Invite 2, Studio 5, Agency 15, Production 50) apply to concurrent renders. Retries are few and idempotent: a retry reuses the row and replaces the partial file.
- **The worker's steps:** load the job; resolve each input asset to a short-lived signed link scoped to the workspace (never a raw URL from the request); bundle the compositions once per release; select the composition; render at the requested size and frame rate; write MP4 and poster to `<workspace>/…` in storage; register the asset; mark done. Progress comes from the renderer's own callbacks.
- **Safety:** props validated again on the server; limits on length, pixels and frames (the browser export's 3 minutes and 200 MB are the starting limits, changed only by a measurement); a timeout and memory ceiling per render; the renderer runs as a non-root user; the browser inside it can fetch only the signed media host and nothing else; **no secret is in the worker's environment except what storage needs**; logs carry ids, template, durations and sizes, never props text or URLs.
- **Capacity:** rendering is CPU heavy. The worker caps simultaneous renders (a measured number, set in PR 12) and renders can be paused by one switch without touching the web app. The 1,000-job load test (P8) gains a render profile so renders cannot slow pages.
- **Flags:** `REMOTION_SERVER_RENDER` (default off) turns the pipeline on; the licence gate (below) is separate. Before P4 there is no worker, so on Vercel the flag stays off and **only previews exist**. That is by design.

### 3.7 The licence step (owner's, before any customer render)
- Building and testing run under Remotion's free evaluation terms, with internal workspaces only.
- **Gate in code:** a platform setting only the owner can set in `/admin`, "Remotion licence confirmed", default off. With it off, a server render for any workspace not flagged internal is refused with a plain message ("Designed renders are not switched on yet"). A unit test and a browser test cover both states, and a test confirms an agent or MCP call cannot set it.
- **Tell the owner:** PR 0 adds a short owner note (no figures; it points to the SOW § 5 row and § 8 line) and the weekly report carries one line, "Owner action before customers: buy the Remotion Company License, set its key in the worker's settings in Coolify, then switch on 'licence confirmed' in /admin". Claude Code does not buy anything and does not set the key.
- **The key** is set by the owner in Coolify only. The worker passes it to the renderer as Remotion documents (confirm the exact option name in the docs at build time).
- **Counts:** a platform-level table counts every server render attempt (start, template, workspace, outcome) so the month's total is read at a glance. The count is **conservative**: every start counts, including a failure and a retry, until Remotion confirms in writing how it counts (owner decision 3). `/admin` shows the month's total, per template and per plan, and a banner at the threshold in the SOW.
- **The Player is separate:** the SOW says previews are free. Because licence terms are Remotion's, the owner should have their written answer that showing the Player inside a hosted product is covered **before the first customer sees a preview** (owner decision 2). The Player is behind the same gate until he confirms.

### 3.8 Final cut with graphics, and why it does not mix audio
The finished master (mixed, graded, trimmed, from the browser export today and S2's cut later) is the input. The composition lays the graphics over it and appends the end card; **the master's own audio passes through unchanged**, so Remotion never has to reproduce the browser's mix or LUT. If the owner wants graphics inside the edit before mixing, that needs E7's server render and an overlay with transparency; it is a later option, not this plan (owner decision 8).

### 3.9 Ad versions
- From a 16:9 master: a 9:16 version crops to a **focus point** (default centre, set on the card by the person, or by Atomik proposing one and the person confirming), a 1:1 version crops the same way, and a 16:9 version is the master with the brand overlay. A second layout ("fit with a soft blurred fill") avoids cropping when a subject is wide.
- Headline and call to action are placed in each aspect's safe area. The end card is built for each aspect.
- **Not here:** smart subject tracking or AI re-framing (an existing model task, `reframe`, stays separate).
- 4:5 is already an export aspect; it can be added with no change to the design (owner decision 9).

### 3.10 Registry tools (A1)
Each of the five templates is declared once: id, inputs and limits, provider ("Particl render worker", no key), price function (**free**), mock, who may call (anyone with access to the project; none of these is a people-only action), and the flag it depends on. They are listed as **unavailable with the reason** ("Designed renders are not switched on yet") whenever the flag or the licence gate is off, so Atomik says so instead of failing. The mock returns a tiny fixture video and a poster after validating props. A test per tool: price is free, mock works, props over the limits are refused, an agent can run it and gets the same job a button would, a repeat press returns the same job.

## 4. PR-by-PR breakdown

One concern per PR. UI PRs: Playwright at 360×640, 390×844, 844×390, 1440×900 and 1920×1080 with no horizontal overflow, text at least 12 px and 55% white, phone targets at least 44 px, screenshots beside the handoff. Gates follow SOW § 0.

| # | PR | Tests | Gate |
|---|---|---|---|
| 0 | **Owner note and design frames list** (docs only): the licence step in plain words pointing to the SOW; the list of screens the handoff does not draw (template picker, caption style preview, ad versions card, graphics step on Cut and Deliver, render progress, `/admin` counts, licence banner), to be drawn in Claude Design first | Docs lint | Owner reads |
| 1 | **Evaluation spike** (dependencies in a separate package manifest for the worker, `remotion/` with one composition, local render and Player in a scratch page; no customer route): confirms React 19 and Next 16 compatibility, bundle sizes, bundled binary licences, the exact licence-key option, how the renderer counts a render | Spike notes in the PR; `npm audit` clean for shipped deps; bundle test: renderer absent from browser chunks | Owner's yes for adding the dependencies (supply chain) |
| 2 | **Template model, brand mapping, fonts, safe areas, registry declarations** (pure code and data) | Unit: schemas and limits; contrast picker; font mapping; safe-area measurement for every template at each aspect with long and short strings; SVG logo refused; non-Latin text refused with a message; tool declarations have price free and a mock | Independent review (props validation is the security boundary) |
| 3 | **Title card and end card compositions** (three aspects, still and short motion) | Unit for duration maths; golden-frame test Player vs still renderer; Playwright screenshot of each at three aspects | Owner's preview (look) |
| 4 | **Captions composition** (word-timed, three styles, line breaking, safe area) | Unit with transcript fixtures (fast speech, long words, no punctuation, two speakers, empty gaps); golden frames; check caption legibility ratio against a light and a dark frame | Owner's preview (look) |
| 5 | **Previews on the board** (Player in the Cut and Deliver cards and the Ads Formats and Adapt cards; style and text controls on desktop; view-only on phone; lazy loaded) | Playwright at five sizes: preview plays, scrubs, controls reachable, no overflow, no network request to a paid route; a performance budget on the lazy chunk; the licence gate hides the Player when off | Owner's preview (UI). Frames from Claude Design first. Needs P3's media CORS for real media |
| 6 | **Ad versions** (composition, focus point, three aspects, export names) | Unit: crop maths for focus points at the edges; headline and call to action inside the safe area at every aspect; golden frames; naming | Owner's preview |
| 7 | **Final cut with graphics** (graphics list, captions on or off, end card appended, audio passed through) | Unit: duration and offsets; audio track of output equals the master's (checked on a fixture); golden frames | Owner's preview |
| 8 | **Server render pipeline** (event, job table, enqueue and status API, worker function, storage, Library asset, stop, retry, flags, licence gate) | Unit with a fake renderer: idempotent repeat press; replay after a lost event; stop; retry replaces the file; per-plan and per-workspace limits; **tenant isolation** (a job cannot read another workspace's asset; the output path is prefixed); the gate refuses customers when off; logs contain no props text or URLs. Staging smoke test in the worker image | **Independent review + owner's yes** (new execution surface, tenant paths, worker image). The image and Coolify steps are the owner's; Claude Code prepares them |
| 9 | **Counts, `/admin` report and the threshold banner** | Unit for counting every start; admin-only read; banner at the threshold; the licence-confirmed setting is people-only and refused for agents and MCP | Independent review (a setting that opens customer renders) + owner's preview |
| 10 | **Registry activation** (the five tools go live behind the flag; Atomik, MCP and skills can run them; "Where to next?" offers captions and ad versions after a cut) | Per-tool mocked tests as in § 3.10; Atomik fills the fields visibly before pressing (rule 11); unavailable-with-reason when the gate is off | Needs A1. Independent review |
| 11 | **Render states on the surfaces** (progress, stop, retry, download, "Free", failure reasons; phone) | Playwright at five sizes with a mock that is slow, fails, and succeeds; Retry runs under the same job key | Owner's preview |
| 12 | **Load and caps on staging** (a render profile in the load test; the worker's simultaneous-render number; the pause switch; fair-use caps per plan) | k6 profile; a run at the target with 1,000 other jobs shows pages not slowing; numbers recorded in the PR | Owner reads the numbers |
| 13 | **Go-live checklist and first render** (docs): the owner's steps; one internal render with the mock off after the owner's yes | Checklist run on staging | **Owner's yes.** Customer renders only after he has bought the licence and switched it on |

PRs 0 to 4 need nothing from other packages and can start as soon as the plan is approved. 5 needs Release 1's board and the Claude Design frames. 8 needs P4 (Docker, self-hosted Inngest, staging) and, for real media, P3. 10 needs A1.

## 5. Dependencies

| Needs | For | If late |
|---|---|---|
| **A1** (registry) | The five tools | Templates are declared in `lib/remotion` with the registry's shape and registered when A1 lands; no button ships without its tool (rule 11), so PR 10 waits |
| **S1, S3, Release 1** (the board, Cut and Deliver cards, Ads rail) | Where the controls and previews live | PRs 5 and 11 wait; PRs 0 to 4 and 6 to 8 do not |
| **S2** (the agent) | "Assemble the cut and deliver", then "Where to next?" offers graphics; the finished master | Final cut works on a master exported by a person until S2 lands |
| **P3** (R2, media.particl.si, signed links, CORS) | Reading media in the Player and in the worker; output storage | Until then the Player reads the media the app serves today and the worker is staging-only |
| **P4** (Docker under Coolify, self-hosted Inngest, staging) | Server renders at all | **Server renders stay off; previews only.** This is the SOW's own order ("behind a flag until P4") |
| **P8** (worker container, load test, legacy guard) | The worker's home and the 1,000-job test | PR 12 waits |
| **E7** (FFmpeg captions, server renders, AAF) | Overlap: E7's plain captions are the cheap, always-on path; E7R's are the designed ones. An alpha overlay on top of an E7 render is a later option | E7R does not wait for E7; the two share the transcript and the safe-area rules |
| **E8 and E9** (Ads and Social) | Their cards use these tools: Adapt (ad versions), clips with captions | They consume E7R; they are not blockers |
| **Claude Design frames** | Every new screen | PR 0 lists them; the nearest handoff frame is followed until drawn (rule 9) |
| **Owner: Remotion Company License, key in Coolify, "licence confirmed" in `/admin`** | Any customer render | Customers see previews only (and only after decision 2) |
| Higgsfield | Nothing here needs it | |

## 6. Risks

1. **Licence.** Rendering for customers without the Company License is a breach of Remotion's terms. Mitigation: the gate in code (default off), the owner note in PR 0, the report line, counts, and the owner's step before customers. Showing the Player in a hosted product is a separate question and needs Remotion's answer in writing (decision 2).
2. **Counting.** How Remotion counts a "render" (a retry, a failed start, a still) is not settled here. Mitigation: count every start until they confirm; read the real counter in PR 1.
3. **Running a browser on our server.** Chromium executes our templates with customer text and a logo. Mitigation: our code only; props validated twice; raster logos only; no network except the signed media host; non-root; timeouts and memory ceilings; separate container from the web app; tenant-scoped inputs and outputs; independent review.
4. **CPU.** Free renders can starve the 1,000-job goal. Mitigation: simultaneous-render cap, per-plan limits, a pause switch, a render profile in the load test (PR 12), fair-use caps (decision 4).
5. **Preview differs from the file.** Mitigation: same composition, props and fonts, a golden-frame test in CI.
6. **Fonts.** Letters differ between preview and render, or a script cannot be drawn. Mitigation: bundled licensed fonts only; refuse what they cannot draw.
7. **Dependency weight and compatibility.** A large library on a new React and Next. Mitigation: PR 1 first; renderer only in the worker image; the Player lazy loaded; a bundle test.
8. **A dependency's own binaries** (a bundled video tool and a browser) carry their own licences. Mitigation: check them in PR 1, and in the image build apply the same "no GPL, no non-free" rule E7 sets for FFmpeg.
9. **Free means abused.** Invite-only sign-up and plan limits help; a daily cap per workspace backs them.
10. **Scope creep into an editor.** Mitigation: five templates, descriptive style options, no timeline editor, no custom code, no uploaded fonts or SVG.

## 7. Open owner decisions

1. **Buy the Company License, and when.** The step is his; this plan only guards the door. Which date: before PR 8's first internal render, or just before go-live.
2. **The Player.** Ask Remotion in writing whether showing `@remotion/player` to customers in a hosted product is covered by that licence. Until answered, previews stay behind the same gate.
3. **How Remotion counts a render.** Ask them; until then the count includes every start.
4. **Fair-use caps** per plan (renders per day and the largest file) to protect the server; the numbers come from PR 12's measurements.
5. **Caption styles and card styles.** Three each, described by what they do, drawn by Claude Design before code. No invented names.
6. **Where captions come from by default.** Recommended: use the saved transcript if there is one; if not, offer transcription as its own priced step first (the existing tool), then render.
7. **Languages.** Latin script first; confirm what to do with other scripts (refuse with a message, or add a font set later).
8. **Graphics inside the edit** (before the mix) versus on the finished master. Recommended: finished master first; revisit with E7.
9. **Add 4:5** to the ad versions (already an export aspect).
10. **Uploaded brand fonts and SVG logos:** not in the first version. Confirm.
11. **A monthly email when the count nears the threshold,** in addition to the banner in `/admin` (the code would send mail to the owner only; he decides).

## 8. Estimate

| PR | Agent-days |
|---|---|
| 0 Owner note and frames list | 0.5 |
| 1 Evaluation spike | 1.5 |
| 2 Template model, brand mapping, registry declarations | 2 |
| 3 Title and end cards | 2.5 |
| 4 Captions | 3 |
| 5 Previews on the board | 3 |
| 6 Ad versions | 3 |
| 7 Final cut with graphics | 3 |
| 8 Server render pipeline | 4 |
| 9 Counts and admin report | 1.5 |
| 10 Registry activation | 2 |
| 11 Render states on surfaces | 2.5 |
| 12 Load and caps | 2 |
| 13 Go-live checklist | 0.5 |
| Independent review, rework, preview fixes (about 20%) | 6 |
| **Total** | **about 37** |

Of these, about 15 agent-days (PRs 0 to 4, 6 and 7 as pure compositions) do not wait for any other package. The server pipeline (8, 9, 12) waits for P4 and P8; the surfaces (5, 11) wait for Release 1 and the Claude Design frames; PR 10 waits for A1. With 3 agents in parallel and the VPS packages on time, the whole package is about 3 calendar weeks after approval, in November as the SOW places it.
