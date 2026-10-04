# particl + Atomik — master scope of work

Single source of truth for the build. Supersedes the earlier brief and folds in the node-graph design handoff. Where this document and any other artefact disagree, this one wins; where this document and the shipped code disagree, check the code and update this document.

---

## September 13 production studio amendment

The authorized Particl production studio redesign supersedes older conflicting interface and workflow requirements below. `/workbench` is the main signed-in production surface, with the approved Particl logo and black, charcoal, white and grey palette. Desktop retains stages, canvas, inspector and Atomik; mobile supports creation and editing through bottom navigation and sheets.

Private collaborator drafts and versions share explicit production/shot records and an append-only published project bible. Publishing context is voluntary; the workbench does not introduce a creative approval requirement before assembly. Existing authentication, tenant boundaries, credit rules and protections on previously approved production shots remain enforced.

The workbench connects briefs/scripts, breakdown, boards, character and world references, editable node operations, priced generation jobs, takes and sequence assembly. Genie and seven individually selected crew roles produce persisted structured plans through the existing Gateway integration. Large uploads reuse the existing chunked upload client and streaming server assembly. Media jobs reuse `/api/generate` and the established adapters, worker and meter.

**EDL is restored by explicit request.** The workbench exports deterministic CMX3600 straight cuts at 24/25/30 integer fps with source assets and a JSON/CSV manifest. The older selects route remains unchanged. Browser source packages are capped at 200 MB.

**September 14 finished-video expansion.** Delivery opens a dedicated movie page and encodes locally: native H.264 with bundled AAC in MP4, or native VP9/VP8 and Opus in WebM. The pinned AAC encoder compensates its fixed priming frame and trims padding to the sequence end. Only that export page permits its bundled WebAssembly worker; the rest of the application retains its existing content policy. Selected takes use exact timeline frames at 24/25/30 fps, source trims, 720p/1080p aspect fit or crop, still holds and straight cuts. Original clip audio follows each trim; the sequence soundtrack starts at zero and ends at the final frame. The mix is reduced only to avoid clipping. This bounded SDR render supports up to 3 minutes, 200 MB of sources and a 200 MB output; keep the page open. No media is uploaded for rendering and no generation credits are charged. Unsupported codecs fail explicitly; transitions, HDR/colour-managed masters, fractional/drop-frame timecode and target-NLE conform validation remain outside this render.

**September 14 Gen and account redesign.** The user requested a separate redesigned Gen section and redesigned workspace, credit and account screens. `/generate?mode=video|images|audio` is the dedicated generation surface, with the old `/make/*` routes retained as compatible entries into the same interface. Studio / Gen / Workspace navigation, a creation desk and take browser, and shared management pages replace their prior layouts. Existing pricing, tenant isolation, scoped drafts, quote confirmation and paid-request recovery remain in place. The original eight-dot Atomik ring from the previous website replaces the prototype's orbital symbol. Stripe remains deferred.

See [Production workbench implementation](production-workbench.md) for integration details, verification commands and current limits. No tier pricing or provider credentials change with this release.

## 4 October 2026 amendment — the board, made easy

Folded in from [`particl-sow-2026-10-04.md`](particl-sow-2026-10-04.md), the owner's amendment of 4 October 2026, kept beside this document as the record. Where this section and older text below disagree, this section wins. Section numbers inside it (§1 to §10) are the amendment's own; ground rules 11 to 17 are in §3 of this document. Package names (D0, U1, S1, A1, E1…) match the owner's planning copy and its Runbook.

**Price of a credit.** The amendment was written at US$0.10 a credit. The owner confirmed on 4 October that US$0.80 a credit, charged in tenths (decided 28 September, launch chosen 2 October), stands, so prices here read at the public price of a credit and guardrail 4 is US$20 (25 cr at $0.80).

### 1. What Particl is, and what changed

Particl is a production studio for ad films and social content, running on the owner's own provider keys. A brief becomes a delivered film or campaign; Atomik, the agent, asks what it needs, plans, prices every paid step, waits for approval, makes the work and checks it.

Decisions since 2 October:

| Date | Decision |
|---|---|
| 3 Oct | particl.si is the live address (still on Vercel). The VPS move continues (P2 to P5). |
| 3 Oct | Background work moves to Inngest self-hosted on the VPS, sized for 1,000 jobs at once. Jobs per workspace go by plan: Invite 2, Studio 5, Agency 15, Production 50. |
| 3 Oct | One design: Graphite. Every older design file and style sheet is deleted (D0). |
| 4 Oct | Studio becomes one board per production (S1 to S3). Ads, Social and Crew move onto the same board (S4). |
| 4 Oct | Every feature is agentic (rule 11). |
| 4 Oct | No feature may need a Higgsfield sign-in. Every feature that did is replaced by provider APIs (§5.3). Higgsfield's API key stays allowed. |
| 4 Oct | The product must be much easier to use (rules 13 to 15, package U1). |
| 4 Oct | Open-source building blocks adopted (§5.2): React Flow, LangGraph.js, Tiptap, Yjs through Liveblocks, Langfuse; MCP stays the door for outside agents. |
| 4 Oct | A new design round in Claude Design ("the board, made easy") produces the handoff every UI package builds from (§6). |

The InVideo Agent Two and Luma boards were tested on 4 October with the same 15-second brief. Particl takes Luma's open board as the surface, InVideo's agent habits (questions first, a real production document, a price and an approval before spending, shot 1 first as the look anchor, reviewing its own results, a running project record), and keeps its own rules on money.

---

### 2. Ground rules 11 to 17

In §3 of this document, after rule 10, and copied verbatim into `CLAUDE.md`.

---

### 3. Product shape after the next handoff

The design handoff (§6) is the source of truth for screens; this is the intent it implements.

- **Home.** A "What are we making?" box (attach a brief or references; aspect and length chips) with templates under it: Film, Ad campaign, Social clips, Start from a script. The person's projects as cards showing what needs them ("2 approvals waiting · 1 rendering"). A "Waiting for you" strip of approvals with their prices as buttons. A sample production to explore without spending credits.
- **The board** (one per project). The canvas in the centre; Atomik's panel docked right; the Inspector over the right edge only when something is selected; the Library as a drawer, closed by default; a bottom toolbar; regions and a minimap; a list toggle showing the same board as an ordered shot list. Card kinds in §4.1.
- **Make** (was Gen). A composer that opens over any screen. Auto engine choice shown as one line; results land in the current project's Library and, when a board is open, as cards on it. The takes wall becomes Make's history view.
- **Atomik.** The agent panel on every screen. ⌘K is search and Atomik in one box. A control room in four places: Approvals (one queue across projects, batch approve, the spend-without-asking setting), Activity (runs, settled spend per run and project), Skills, Memory. D1 builds it; S4 connects every board to it.
- **Settings** behind the avatar, in at most five sections: Team, Plan & credits, Spending rules, Connections (MCP for outside agents, publishing accounts), Advanced (models, tools).
- **Header.** The owner picks one in the design round. Option A: Home · Studio · Ads · Social · Make · Atomik. Option B: Home · the current project · Make · Atomik, with Studio, Ads and Social as templates on Home (Film and Start from a script open a Studio board, Ad campaign an Ads board, Social clips a Social board). `lib/shell/ia.ts` follows the handoff's IA table, and every old URL redirects to its new place.
- **Phone: judge, not make** (D1 owns these screens; U1's review mode supplies the swipe). Home with what needs you; plan approval with the price as the button (also from a push notification); full-screen review with swipe to approve or reject; the project record; a simple Make.

**Names in the UI** (code names may stay in code):

| Was | Now |
|---|---|
| Moleculr Business Suite | Ads |
| Subatomik Viral Studio | Social |
| Rig | Board |
| Astra | 3D blocking |
| Genjutsu | Motion transfer, Object swap |
| Gen | Make |
| Crew (a destination) | Crew review (a panel on any board) |
| Soul, Soul ID | Identity |
| Atomik | Atomik (unchanged: the agent's name) |

---

### 4. Architecture

#### 4.1 The board (S1): extend, don't rebuild

Already built and kept:
- `lib/workbench/team-canvas-model.ts`, `team-canvas.ts`: one shared canvas per production; last write wins per node; removed nodes and retired assets kept whole; every write records its writer (a person's id or `agent:<runId>`).
- `lib/workbench/canvas-ops.ts`, `canvas-ops-model.ts`, `canvas-push.ts`: idempotent server operations (create, move, wire, unwire, set, tidy, soft remove), pushed live through Liveblocks, with a 5-second fallback check.
- `lib/workspace/rig-board.ts`, `rig-graph.ts`: sections, snap to grid, Tidy.
- `lib/workbench/node-graph.ts` (`NODE_DEFS`), `lib/production/rig-build.ts`.

Add:
1. Card kinds with schemas in `NODE_DEFS`: `doc` (brief, shot list: rich text and a table, edited in place), `questions` (questions with chip options and answers), `plan` (steps, price per step, total, state), `group` (a labelled frame: shot, cast, cut; status computed from its cards; cost so far; stop), `take` (versions, approved or rejected per version, review note), `deliver` (spec check, master). Existing kinds stay.
2. Groups as real containers: a card's group id, its order in the group, Tidy laying groups out in production order.
3. Versions and approval on every frame and take: v1 to vn, one approved version per take, reject with a reason, all kept, recorded with who and when.
4. The project record per production: the brief version, every approval with its quote and settled cost, open decisions, spend against the ceiling.
5. Regions: named bookmarks (name and viewport).
6. A board for every existing production, built from its stored brief, beats and shots, boards, cast, environment and takes, without deleting or changing the old data.
7. API: read the board, apply ops, set approval (a person only; refused for `agent:*` writers and MCP callers), read the project record. Workspace-scoped everywhere (rule 2).

#### 4.2 The agent on the board (S2)

Already built and kept:
- `lib/workbench/rig-agent*.ts`: Atomik plans a board, waits for approval, builds it live, renders inside an approved limit, settles.
- `lib/workspace/run-engine.ts`: paid dispatch is impossible without an `ApprovedQuote`, minted only by the engine after approval and re-checked before dispatch.
- `lib/workbench/verify.ts`, `verify-server.ts`, `verify-judge.ts`, `master-lock.ts` (P6b wires them into the agent), `suite-agent*.ts`, `crew.ts`.

Add, as a LangGraph.js graph (`@langchain/langgraph`):
1. Nodes in order: questions → brief and shot list → plan → approval → anchor shot → review → remaining shots → cut → deliver. A "Where to next?" card after each step.
2. Every approval is an interrupt. Runs resume from a checkpointer adapted to the workspace's own libSQL database.
3. Money moves only through the run engine's `ApprovedQuote`, and paid steps run on registry tools (A1). A person approving a plan approves only its listed steps and its fix allowance, up to its total (rule 14).
4. Shot 1 first, marked the look anchor; the rest use it and the locked cast and environment masters as references.
5. Verify on every frame and take; a one-line note on the card; at most two targeted fixes per shot, paid from the plan's fix allowance, then it asks; never a silent retry.
6. Live group status; Stop cancels queued steps and releases unspent holds; the project record updated at every step.
7. A budget ceiling per production from a workspace setting; the agent stops and asks at 80% of it.
8. Traces to Langfuse with ids, models, tokens and cost, never prompt text.
9. Board operations exposed as tools on Particl's MCP server (`lib/mcp.ts`), behind the same gates.
10. Atomik's own thinking billed as rule 14 says: reserved against the limit approved when asking, settled at use, nothing billed when nothing came back.

#### 4.3 The tool registry (A1): the agentic backbone

- Two kinds of tool. Engine tools are generated from `lib/models.ts` and the task and still-tool tables, never a second hand-kept list. App actions (board operations, Stop, Retry, approve, publish, record consent and the rest) are declared in code beside their handlers. Per tool: id, kind, inputs and limits, provider, the key it needs, its price function (free for most app actions), its mock, and who may call it: anyone, people only (rule 11) or admins only.
- One paid path for everything: quote → approval → durable claim → poll → collect. A tool that cannot be priced is listed as unavailable, with the reason, and cannot run.
- Consumers: buttons, Make, board cards, Atomik, skills, and MCP. `lib/mcp.ts` is hand-written today and routes tools through the app's own HTTP API with the caller's token; keep that design. Adopt `@modelcontextprotocol/sdk` only where it removes code.
- A test per tool: it has a price, a mock, and the agent can run it; an unapproved run spends nothing; a tool without its key names that key.

#### 4.4 Words and money in the UI (U1)

- The names in §3 throughout the UI, copy cut to what the screen cannot show.
- Price display per rule 14. Estimates are fetched when a control becomes visible or focused and cached briefly; the server price stays the truth.
- Plan approval with its fix allowance, the spend-without-asking setting (Ask or Auto), the balance check before a plan, and "Nothing billed" with Retry.

#### 4.5 Platform services

| Need | Service | Package |
|---|---|---|
| Hosting | Coolify on the Hostinger VPS, behind Cloudflare | P2, P4, P5 |
| Background jobs | Inngest self-hosted (`--queue-workers 100`), per-plan limits; native dispatch fallback (`lib/dispatch.ts`) | P4, P8 |
| Media | Cloudflare R2, CDN at media.particl.si with signed links | P3 |
| Database | Turso, one per workspace | in use |
| Live collaboration | Liveblocks (board); Yjs through `@liveblocks/yjs` (doc cards) | in use, S3 |
| Email, billing, push | Resend, Stripe, Web Push (`lib/push.ts`, VAPID) for "Notify me when done" | in use, U1 |
| Review links | `lib/shares.ts`: client approve and comment, no sign-in | in use, U1 |
| Errors, traces | GlitchTip, Langfuse | P8, S2 |
| Uptime | Uptime Kuma plus an outside monitor | P2 |

---

### 5. Third-party catalogue

Every model goes in through the same door: a price verified from the provider's page or live estimate, a mocked test, then one paid qualification run in the internal workspace after the owner's yes. No model call goes through Vercel AI Gateway (P4b removes it).

#### 5.1 Models and services

| Capability | Provider and model | Key (env) | Package | Status |
|---|---|---|---|---|
| Hero video, reference to video, Seedance Edit | Seedance 2.5 and 2.0 (BytePlus ModelArk) | `ARK_API_KEY` | in use; camera control in E1 | in use |
| Draft and pro video, motion control | Kling 3.0 Standard, Pro, Motion Control (fal) | `FAL_KEY` | in use | in use |
| Text-driven video edit | Kling 3.0 Omni edit (fal) | `FAL_KEY` | E1 | add |
| Veo 3.1 and Veo 3.1 Fast, with sound | Google Gemini API | `GEMINI_API_KEY` | E1 | add |
| Grok Imagine video and image | xAI | `XAI_API_KEY` | in use | in use |
| DoP camera moves; Motion transfer and Object swap | Higgsfield API (key only, no sign-in) | `HF_API_KEY_ID`, `HF_API_KEY_SECRET` or `HF_CREDENTIALS` | E1; in use | in use |
| Fallbacks if Higgsfield's API changes | Runway Act-Two and Aleph (Runway API); Kling Motion Control and O1 edit (fal) | `RUNWAY_API_KEY` only if needed | later | standby |
| Stills | Nano Banana Pro and 2 (Google) | `GEMINI_API_KEY` | in use | in use |
| Stills | GPT Image 1 to 2.5 (OpenAI) | `OPENAI_API_KEY` | in use | in use |
| Stills, edits to 4K | Seedream 5.0 (BytePlus) | `ARK_API_KEY` | E2 | add |
| Style transfer, in-context edits | FLUX.2 and FLUX Kontext (fal) | `FAL_KEY` | E2 | add |
| Vector and type | Recraft V4 (Recraft API) | `RECRAFT_API_KEY` (new) | E2 | add |
| Automatic engine choice | Particl rule table over the registry | none | E2, U1 | add |
| Image ads | Marketing Studio Image on the Higgsfield API key; GPT Image, Nano Banana Pro, Seedream, Recraft as alternatives | as above | E8 | in use |
| Identity training and renders | Particl identities: training and Flux · Identity on fal | `FAL_KEY` | in use | in use |
| Multi-view cast sheets | Nano Banana Pro or Seedream from an identity | as above | E6 | add |
| Lip-sync | Sync Lipsync 2.0 (fal) | `FAL_KEY` | E4 | add |
| Talking person from a photo | OmniHuman 1.5 (fal) | `FAL_KEY` | E4 | add |
| Try-on | FASHN 1.5 (fal) | `FAL_KEY` | E4 | add |
| Speech, dialogue, effects, music, dubbing, voice change | ElevenLabs | `ELEVENLABS_API_KEY` | in use; first paid dubbing and voice-change tests in E5 | in use |
| Voice cloning, with a consent record | ElevenLabs, if the API plan includes it | `ELEVENLABS_API_KEY` | E5 | add |
| Sound from picture | MMAudio v2 (fal) | `FAL_KEY` | E5 | add |
| Audio scenes | Seed Audio (BytePlus) | `ARK_API_KEY` | E5 | add |
| Upscale | Topaz on fal: image, and video including Topaz's own "Astra" model (not Particl's 3D) | `FAL_KEY` | in use | in use |
| Reframe | Luma Ray 2 (existing integration) | as wired today | in use | in use |
| Outpaint, cut-out | Bria Expand, Bria cut-out (fal) | `FAL_KEY` | in use | in use |
| Video background removal | Bria VRMBG 3.0 (fal) | `FAL_KEY` | E3 | add |
| Relight | IC-Light v2 (fal) | `FAL_KEY` | E3 | add |
| Deflicker | FFmpeg in the worker container (free) | none | E3 | add |
| 3D blocking scenes | Blender in Vercel Sandbox today; Docker on the VPS later | `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID` | in use | in use |
| Props from a photo | Hunyuan3D 3.1 Pro (fal), into the Blender scene | `FAL_KEY` | E6 | add |
| Planner, writer, Atomik | Anthropic, OpenAI, xAI on their own APIs | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `XAI_API_KEY` | P4b | in use (moving off the gateway) |
| Verify judge, hook review | A vision model (Gemini or Claude) with a written rubric | as above | P6b, E9 | add |
| Search by meaning | Embeddings from OpenAI or Google, stored per workspace (libSQL vectors) | as above | C2 | add |
| Crew seats | Grok (xAI) | `XAI_API_KEY` | in use | in use |
| Transcripts | Grok transcript (`lib/transcription.ts`) | `XAI_API_KEY` | in use | in use |
| Burned-in captions, server renders | FFmpeg built without GPL or nonfree parts | none | E7 | add |
| AAF for Avid | OpenTimelineIO | none | E7 | add |
| Publishing | TikTok, YouTube and Instagram APIs, a flag per platform, on only after that platform's review; every post approved by a person | per platform | E9 | later |

#### 5.2 Open-source libraries

| Library | Use | Licence | Package |
|---|---|---|---|
| React Flow (`@xyflow/react`) | The board | MIT | S3 |
| LangGraph.js (`@langchain/langgraph`), checkpointer adapted to libSQL | The agent graph, interrupts, resume | MIT | S2 |
| Tiptap (core only, no Pro extensions) | Brief and shot-list cards, with tables | MIT | S3 |
| Yjs through `@liveblocks/yjs` | Several people editing a doc card at once | MIT | S3 |
| MCP TypeScript SDK (`@modelcontextprotocol/sdk`) | Only where it removes code from `lib/mcp.ts` | MIT | S2, A4 |
| Langfuse | Traces of agent runs | MIT core | S2, P8 |
| FFmpeg | Captions, clips, deflicker, server renders | LGPL build | E3, E7 |
| OpenTimelineIO | AAF out | Apache-2.0 | E7 |
| Playwright | Tests; website walk-through videos | Apache-2.0 | all, E8 |
| k6 | Load tests on staging only, never shipped | AGPL-3.0 | P8 |
| Coolify, Uptime Kuma, rclone, GlitchTip, Inngest (self-hosted) | Platform | as listed in the Scope tab | P2 to P8 |

Not used: tldraw (commercial licence or watermark), Remotion (paid company licence), ComfyUI (needs its own GPU), LangChain beyond LangGraph, Vercel AI Gateway.

#### 5.3 Every Higgsfield sign-in feature and what replaces it

| Higgsfield sign-in feature | Replaced by | Package |
|---|---|---|
| Veo 3.1 (catalogue) | Veo 3.1 on Google's API | E1 |
| GPT Image 2.5 (catalogue) | GPT Image on OpenAI's API | in use |
| Cinematic Studio | Particl's camera vocabulary on Nano Banana Pro and Seedream; camera control on Seedance and Kling; DoP moves on the Higgsfield API key | E1, E2 |
| Soul ID, Soul V2, Soul Cinema | Particl identities (training and Flux · Identity on fal), multi-reference stills, reference-to-video on Seedance and Kling Omni, multi-view cast sheets | in use, E2, E6 |
| Seed Audio (catalogue) | Seed Audio on BytePlus; ElevenLabs effects and music; MMAudio | E5 |
| Multi-Image to 3D | Hunyuan3D 3.1 Pro into the Blender scene | E6 |
| Marketing Studio video and Click-to-Ad | Ads skills: Particl reads the product page and brand (built: `lib/workbench/brand-extraction.ts`, `product-fetch.ts`, `product-extraction.ts`), Seedance and Kling Omni with product references, OmniHuman, FASHN, Sync, ElevenLabs, captions, Adapt | E4, E8, A2, S4 |
| higgsfield-brandkit | Particl's brand extraction, reviewed before use (built) | in use |
| Virality Predictor | Hook review: a scored review with reasons, never a prediction of views | E9 |
| Motion library | Particl's own effects library on Kling, Seedance or Pixverse effects, each priced | E9 |
| Supercomputer and its 16 workflows | Atomik on every board with the registry; 15 workflows as Particl skills (the website builder stays out) | A1, A2, S2, S4 |

What this table replaces is the sign-in side: the same names on a Higgsfield account. What already runs on Higgsfield's API key stays: Soul Standard, Soul 2 and Soul Cinema renders (`lib/soulRender.ts`), labelled "Identity still · Standard / 2 / Cinema" since D0 PR 2; Cinema Studio 4.0 (`lib/engines/higgsfield.ts`, §10.2); and Soul Character, which E6 switches on once its price is verified (`HF_SOUL_CHARACTER_*` in `lib/vendorRates.ts`).

---

### 6. The design round, and importing the handoff

1. The owner runs the "board, made easy" prompt in Claude Design on Particl Suites, one step at a time, and picks the header option at step 2.
2. The owner exports the handoff. In its own PR ("design: new handoff, board made easy"), replace `design/particl-graphite/` with it whole. The previous handoff stays only in git history.
3. Then Claude Code, before any UI work:
   - reads the new `README.md` in full, then `PROMPT.md` and `github.md`;
   - writes `docs/handoff-diff.md`: what changed against the previous handoff (IA, names, tokens, screens added, removed and changed, new states, the actions table);
   - updates the tokens in `app/graphite.css` to the README's values, in a small PR;
   - plans `lib/shell/ia.ts` against the README's IA table: each old URL and deep link gets its redirect in the same PR as the page that replaces it (Studio's when S3 ships), so no link on particl.si breaks in between;
   - proposes the PR order for D0 PR 3, PR 5 and PR 6, U1, S3, S4 and D1 against the new handoff, and waits for the owner's yes.
4. A screen the handoff lacks is drawn in Claude Design first. Never invent one in code.

---

### 7. Packages and order

Status on 4 October. Tracks run side by side where they don't share files. PRs merge one at a time, after the owner checks each Vercel preview.

#### Track A: Platform

| ID | Delivers | Needs | Status |
|---|---|---|---|
| P2 | Server finished: Coolify keys saved, origin certificate, coolify.particl.si, the GitHub App, Cloudflare-only firewall, real visitor addresses, outside monitor, VPS snapshots | P1 | In progress |
| P3 | R2 switched on; media.particl.si with signed links, thumbnails and posters | P1 | Not started |
| P4b | Every model on its own provider's API; Vercel AI Gateway removed; a pinned, tested price list | none | Not started |
| P4 | Docker under Coolify; self-hosted Inngest sized for 1,000 jobs with per-plan limits; tested at staging.particl.si | P2, P3 | Not started |
| P5 | particl.si's DNS to the VPS; particl.app redirected in Cloudflare; cron moved; rollback ready; Blob retired after two weeks | P4 | Not started |
| P8 | Worker container; load test to 1,000 jobs; GlitchTip; Langfuse; legacy guard | P5 | Not started |

#### Track B: Design system, shell and ease

| ID | Delivers | Needs | Status |
|---|---|---|---|
| D0 | 1a to 2: old design out, one token set, removals and renames (in review). PR 3: the shell from the new handoff with the chosen header. PR 4: dropped (Studio becomes the board). PR 5: Make (was Gen) from the new handoff. PR 6: everything else on the tokens | the new handoff for 3, 5, 6 | In progress |
| U1 | Ease of use: autosave and no "save first" errors; Auto defaults with the one-line engine summary; the names in §3; price display and live "up to" estimates; one approval per plan, the spend-without-asking setting (Ask or Auto), the balance check, "Nothing billed" with Retry; review mode (keyboard), compare, phone swipe; "Notify me when done"; Home with templates and the sample production; "Ask Atomik how"; the five-minute Playwright test (its first PR) and ease metrics | D0 PR 3, A1, the new handoff | Not started |
| D1 | Atomik's control room (Approvals, Activity, Skills, Memory), Settings in five sections, and the phone screens (D1 owns them; U1's review mode supplies the swipe), from the new handoff. Its last PR retires each old shell in `docs/old-shells.md` whose new page is live, redirecting the old route there; the rest retire with the package that replaces them | D0, U1 | Not started |

#### Track C: The board and the agent

| ID | Delivers | Needs | Status |
|---|---|---|---|
| S1 | Board backend (§4.1) | D0 PR 2 before it merges (planning starts now) | Starting |
| P6b | Verify and master locking wired into the agent | none | Not started |
| S2 | Atomik on the board, built on LangGraph (§4.2) | S1, P6b, A1 | Not started |
| S3 | Studio drawn as the board on React Flow, 1:1 with the new handoff: cards, groups, toolbar, docked agent panel, Inspector, regions, minimap, list view; on a phone the board opens in D1's screens (approvals and takes); old Studio links open the matching region; the ten stage pages retire one week after the board goes live | S1, S2, the new handoff | Not started |
| S4 | Ads as a campaign board, with the poster Designer opening from a card; Social's quick tools plus a clips board; Crew review on any board; every board connected to D1's control room | S3, E8, E9, and A2 for its skills | Not started |
| C2 | Search by meaning across the board and the Library, embeddings in each workspace's own database | P4b | Not started |

P6a (React Flow) is done inside S3. P6c (LangGraph) is done inside S2. C1 is S1 plus S3. C3 and C4 become cards in S3 and S4.

#### Track D: The agentic platform and engines

| ID | Delivers | Needs | Status |
|---|---|---|---|
| A1 | The tool registry (§4.3) | P4b | Not started |
| E1 | Veo 3.1 on Google's API; DoP moves on the Higgsfield API; Kling Omni edit | A1 | Not started |
| E2 | Seedream 5.0, FLUX.2 and Kontext, Recraft V4, automatic engine choice | A1 | Not started |
| E3 | Video background removal, relight, deflicker as take actions | A1, P8 | Not started |
| E4 | Sync lip-sync, OmniHuman talking people, FASHN try-on, consent records | A1 | Not started |
| E5 | First paid tests of dubbing and voice change; cloning with consent; MMAudio; Seed Audio | A1 | Not started |
| E6 | Multi-view cast sheets; Soul Character on the Higgsfield API key once its price is verified, shown as an Identity option; props from a photo into 3D blocking | E2 | Not started |
| E7 | Burned-in captions; server-side renders; AAF | P8 | Not started |
| E8 | Ads: photoshoots, product and UGC video skills, ad versions, Adapt (no Marketing Studio video) | E1, E4, E5, E7 | Not started |
| E9 | Social: effects library, clips from long videos, narrated videos, hook review, publishing behind flags | E3, E7 | Not started |
| A2 | The 15 workflows as Particl skills, each quoted as one run | E1 to E9 | Not started |
| A3 | Folded: S2's agent with each suite's tools, delivered through S2 and S4 | none | Folded |
| A4 | Skills over MCP: list, quote and run a skill, approval first | A2 | Not started |
| Review | `docs/particl-sow.md` and this file updated to what shipped | everything | Not started |

#### Sequence

The owner's estimate for two people: the full scope by 26 February 2027.

1. Now: D0 PRs 1a to 2 (review and merge), P2, P4b then A1, and S1, while the owner runs the design round.
2. When the new handoff lands: the handoff PR and diff (§6), then D0 PRs 3, 5 and 6; P3 and P4 alongside.
3. From the cutover (P5 and its two weeks of watching): U1, then D1; E1 and E2, then E4 and E5.
4. Then: P8, then E3; P6b, E6 and S2.
5. Across the year-end break: E7, then E8 and E9; S3, then C2.
6. Then: A2, with S4 alongside it, taking each skill as it lands; A4 after A2.
7. Last: Review.

---

### 8. Done, for the whole programme

- The five-minute test passes for a new person on desktop and on a phone.
- One real production runs from brief to an approved cut on the board; every paid step was approved at its quoted price, and the ledger matches.
- Every registry tool is reachable by Atomik, a skill and MCP at the same price and through the same gate as its button; every engine in §5.1 is also reachable from Make and a board card; a test proves each. Actions that belong to people (rule 11) stay theirs, and a test proves an agent cannot take them.
- No UI text says Moleculr, Subatomik, Rig, Genjutsu, Soul or Higgsfield, and "Astra" appears only as Topaz's model name ("Topaz Astra"), never for 3D blocking.
- Nothing needs a Higgsfield sign-in.
- The contrast and size minimums pass an automated check on every screen.
- The VPS runs 1,000 jobs at once without slowing pages (P8's load test).

---

### 9. Working rules for Claude Code

1. **First PR, docs only:** fold this amendment into `docs/particl-sow.md`; add ground rules 11 to 17 to `CLAUDE.md` after rule 10; keep this file as `docs/particl-sow-2026-10-04.md` for the record.
2. **Plan first** for every package. The owner reviews the plan before any code.
3. **One branch per PR**, off main, in its own worktree. Never push to main. Never merge. One concern per PR, small.
4. **Every UI PR:** Playwright at 360×640, 390×844, 844×390, 1440×900 and 1920×1080 with no horizontal overflow; the five-minute test (rule 17) once U1's first PR has landed it; screenshots beside the handoff. The owner checks the Vercel preview before merging, because main deploys straight to particl.si.
5. **Money:** engines mocked in tests (`ENGINE_MOCK=1`). A paid qualification run only in the internal workspace, only after the owner's yes, with its cost stated first. Never a real generation on a customer workspace (rule 1). Prices only from the rate-card path; never invent a figure.
6. **Tenant isolation** on every query, storage path and signed URL (rule 2).
7. **Secrets** only in Vercel and Coolify settings; never in code, logs, model prompts or chat. Never rotate `KEYRING_SECRET` without a re-encryption script.
8. **Agentic first** (rule 11): a feature's registry tool and its agent test land before or with its button.
9. **Keep the SOW true:** update `docs/particl-sow.md` when a change makes it wrong.
10. **One model per package**, as the Runbook's prompt for it says: Fable at high effort for D0, A1 and S2; Opus at high effort for S1, S3, S4, U1, P6b and the platform packages; opusplan at medium for the engine packages, D1, C2, A2 and A4. Whatever the package, a plan that changes the approval path, a price function, sign-in or tenant separation is written at high effort on Opus or Fable, and the owner reviews it before any code.

---

### 10. Open decisions for the owner

1. Header option A or B (design round, step 2).
2. Cinema Studio 4.0 stays in Make, without the Higgsfield name (the owner's answer in D0 PR 2); it runs on the API key. Still open: how its price reads. Its quote is approximate and the take settles at 0.5 to 3 times it (`lib/cinemaStudio.ts`), so an honest "up to" is three times the quote. Either show "about N cr, at most 3N cr" and approve the 3N figure, or remove it.
3. The final UI names (§3), confirmed in the design round.
4. The spend-without-asking default. Today every paid step asks (Ask), and in Auto a draft at or under the per-job line runs without a tap; that line is guardrail 4, US$20 (25 cr at $0.80; the owner's decision of 29 September). Suggested: Ask stays the default; admins can switch a workspace to Auto, with a lower line if they choose.
5. The sample production's content: invented and neutral, approved by the owner before it ships.
6. Whether to make the repository private before P4.
7. Whether Atomik's thinking costs credits. Today the planning turn is billed within a limit the person approves when asking (rule 14). Keep that, shown as one line under "What are we making?" ("Atomik's thinking: up to N cr"), or make thinking free up to a daily cap per workspace, with the cost carried by the margin.

---

## 1. The product

**4 October 2026.** The live address is particl.si (still on Vercel; the move to the VPS continues, P2 to P5): read particl.app below as particl.si. Studio becomes one board per production. See the 4 October 2026 amendment above.

**September 13 subscribed-workspace expansion.** The owner has authorized self-service subscribed workspaces for other production houses, retaining the existing plan and pack prices. The invitation-only acquisition flow below is superseded by verified-email registration plus the existing approved-invitation path. Direct registration and additional workspaces receive no automatic free grant; approved invitations retain the configured one-time welcome grant. Selecting a plan is never payment evidence. Invoice-funded monthly credit windows, source allocations and pause/resume pack expiry are implemented in the new ledger; Stripe provider connection and fulfillment remain a release dependency. See [Subscribed workspace implementation and launch gates](subscribed-workspaces.md). The remaining pack lifetime resumes after leaving a paid plan, matching the rule that only off-plan time counts.

**particl** (particl.app) — an invite-only, multi-tenant production tool for anyone making film with generative engines: agencies, production houses, independent directors, brand teams. It makes shots, keeps them consistent across a production, and knows what every shot cost before and after it was rendered.

**Atomik** — the companion app on the same database. Atomik owns everything before the render: idea → treatment → breakdown → shot list. particl owns the render and everything after: takes, picks, approvals, masters, cost. The shot list is the contract between them, and it moves both ways.

The product started inside one production house. Some code and copy still assume one team, one set of keys, one owner's judgement. Every change moves it toward something a stranger with an invite can use, without losing the opinions that make it good.

**Positioning.** Two things no competitor has: a credit ledger that prices a change *before* it happens, and a real approval trail. Everything worth building leans on one or both. Model breadth and canvas flexibility are table stakes we need but never the pitch.

---

## 2. Engine map

**4 October 2026.** Every model moves to its own provider's API and the Vercel AI Gateway is removed (P4b); the "Vercel API" row below describes today. Models to add are in the 4 October 2026 amendment, §5.

Source of truth. The site's own copy has been wrong about this before; the Settings engines list must read from the adapter registry so it cannot drift again.

| Provider | Models | Notes |
|---|---|---|
| **ByteDance** (BytePlus ModelArk) | Seedance 2.5, Seedance 2.0 | Video. Seedance 2.5 is the default (`DEFAULT_MODEL_ID`). Not the only wired video engine — fal's four are wired too, and so are Higgsfield's and xAI's below. |
| **Google** | Nano Banana Pro, Nano Banana 2 | Stills (`gemini-3-pro-image`, `gemini-3.1-flash-image`). Goes **direct to Google whenever a `GEMINI_API_KEY` is set** and bills as a Google AI charge (owner, 2026-09-23); through the Vercel AI Gateway (gateway credit) only when there is no key; `STILLS_VIA` no longer changes the door. See `stillsDoor()`. |
| **fal** | Kling 3.0, Kling 3.0 Pro, Topaz Astra, Luma Ray 2 (reframe), Bria Expand + Cutout (hidden still tools), Flux · Identity | One adapter, several **media** models behind it. Built end to end (`lib/engines/fal.ts`, `lib/falVideo.ts`, `lib/falImage.ts`). `FAL_KEY` is unset in local dev, so fal renders only run against the mock — nothing about the wiring is outstanding. **No LLMs through fal.** |
| **ElevenLabs** | Voice / audio | The Audio tab's engine. Spoken lines can also use Grok Voice (xAI). |
| **Higgsfield** | Soul Standard, Soul 2, Soul Cinema; Motion Transfer, Object Swap; Marketing Studio Image (2.0 Alpha, 2.5 Flare, 2.5 Sunburst); Cinema Studio 4.0 | On Particl's API key only; nothing needs a sign-in (rule 10). Soul IDs are trained and rendered for Cast. Motion Transfer and Object Swap run Viral. Marketing Studio Image runs Business › Image ads. Cinema Studio 4.0 is a video engine in Gen. Workspaces on the platform's key share it through one pool (1.0). |
| **OpenAI** | GPT Image 2, GPT Image 2.5 Flare, GPT Image 2.5 Sunburst, GPT Image 1.5, GPT Image 1, GPT Image 1 Mini | Stills, in Gen's image list, Storyboards and still re-edits. |
| **xAI** | Grok Imagine Image 2.0, Grok Imagine Image, Grok Imagine Video 1.5, Grok Imagine Video, Grok Voice | Stills, short clips and spoken lines. |
| **Vercel API** | Claude, GPT | **Every LLM call in either app.** Atomik's enhancement, idea builder and shot builder; anything in particl needing an LLM. |

**Credits are the unit. 1 credit = US$0.10, fixed.** Every price in either product is in whole credits — buttons, post tools, training, caps, statements. The ledger keeps exact `engine_cost_usd` and `billed_credits`; margin is the gap, set platform-side per engine, never shown. Estimates round **up** to the next whole credit per job; batches multiply before rounding. USD appears on the top-up screen — each pack as `2,200 credits / $200 · 200 free` — and in one line on Settings › Vendors for a platform-keyed workspace, stating what a credit costs and the monthly cap. **Nowhere else, and never on anything that spends.**

Format: `N cr` lowercase in body, `N CR` in mono eyebrows. Currency is derived (`credits × 0.10`) and only ever secondary.

---

## 3. Ground rules

1. **Other people's money.** Every render bills a customer workspace in credits they paid for. Never trigger a generation, training run or upscale against a customer workspace. Development uses mocked engine responses; if a test needs a real call it runs in a dedicated internal workspace, and you state the cost and wait for a yes.
2. **Tenant isolation is the floor.** Every table carries `workspace_id`; every query filters on it; every Blob path is prefixed by it; every signed URL is scoped to it. Identities, cast, masters, prompts, costs and rules never cross a boundary. If you can't point at where a query is scoped, it's a bug.
3. **Nothing tied to one studio in the code.** Rules, defaults and the camera bank become the **platform layer** — inherited by every workspace, overridable by each. No workspace, client or person names in source, seed data or copy.
4. **Don't redesign what works.** Shot/take, draft → picked → approved, cost-on-the-button, Setup carried into every shot, `@cast`, file naming, caps. Extend; don't replace.
5. **One vocabulary.** Enforced in code, decided once. Current state on particl.app is close: Takes / Productions / Generate. Remaining drift: the dock says `GENERATE` while the segmented control says Video / Images / Audio.
6. **Five minutes.** A stranger with an invite gets from email to first render in five minutes without reading a paragraph. Every screen is judged against that person.
7. **Two first-class surfaces, different jobs.** Desktop is where work is made: composing, wiring Rig, reviewing at speed, bulk actions, admin. Mobile is where work is judged: watch a run, compare, approve, unlock a cap. Neither is a shrunken version of the other. Every change ships with Playwright checks at 360×640, 390×844, 844×390, 1440×900 and 1920×1080. No horizontal overflow at any width; primary actions reachable without panning; dock and sheets clear of the home indicator; no fixed-width layout stranding whitespace above 1600px.
8. **Small PRs**, one concern each, in phase order.
9. **Prose in the product is a cost.** The copy voice is good; there's too much of it. Where a paragraph explains what the UI should make obvious, fix the UI and cut the paragraph.
10. **Provider APIs and loginless MCP only.** Particl uses provider APIs and loginless MCP only — nothing that needs a Higgsfield sign-in (the account's OAuth MCP, its CLI or a website account). Higgsfield work runs on the API key. Owner's decision, 28 September 2026. Since 2 October 2026 the sign-in features are off: nothing new starts on a Higgsfield account, and past results stay in the Library.
11. **Every feature is agentic.** A feature ships as a tool in the registry (A1) before it gets a button. The button, Make, a board card, Atomik, a saved skill and an outside agent over MCP all call the same tool, at the same price, through the same approval gate. Each tool has a mocked test proving the agent can run it. Every screen that offers a feature also lets the person ask Atomik to do it; when Atomik fills a form, the fields visibly fill before anything is pressed. A few actions belong to people alone: approving spend, setting spend limits and the budget ceiling, topping up, approving a post, and recording consent for a real person's face or voice. Atomik and outside agents can prepare and explain these, never take them (rule 14).
12. **One board.** Productions, ad campaigns and social projects live on one board engine: the Rig's team canvas, extended in S1. New project work is a card kind, a group or a skill on that board, never a new page.
13. **Easy by default.**
    - Auto is the default for agent, model, engine and settings, shown as one line with a Change link (for example "Seedance 2.5 · 1080p · 5 s · 43 cr · Change"). Advanced settings live folded in the Inspector.
    - What the brief sets (aspect, frame rate, look, cast) carries into every shot and is not asked again.
    - One primary button per screen, and it is the next step.
    - Everything saves itself. No "save first" errors; today's live in `components/workbench/AtomikRunDialog.tsx`, `SoulIdentityPanel.tsx` and `Studio.tsx`.
    - Undo instead of confirmation dialogs (nothing is ever erased already).
    - Plain words in the UI (names in the 4 October 2026 amendment, §3). Cut any sentence the screen could show instead (rule 9).
14. **Money without anxiety.**
    - Prices read `N cr`, `up to N cr` (a live estimate) or `free`. Never the bare word "quoted". Hovering a price shows its dollar value at the public price of a credit. Prices come only from the rate card (CLAUDE.md § Pricing, through the server's price path); every price in a design is a sample.
    - Only a person approves spending. Atomik and outside agents can prepare, price and explain an approval, never grant one; an approval written by `agent:*` or an MCP caller is refused. When a person tells Atomik in words to approve ("approve everything under 10 cr"), Atomik lists exactly what that covers and its total, and the person confirms with one tap.
    - A plan is approved once: one tap approves its listed steps at their listed prices, up to its total, including a stated fix allowance (at most two fixes per shot). Anything outside it (a new shot, a fix past the allowance, another engine) asks again. A plan's approval follows the workspace's rule in `lib/approvalRule.ts`: a step over the rule's cap needs an admin, and the plan card says which steps need whom.
    - Outside a plan, every paid step asks, unless the workspace allows spending without asking. Today's Ask and Auto modes (`lib/workbench/rig-agent-limits.ts`) become that setting: Ask is the default; in Auto, a draft priced at or under the per-job line runs without a tap. A job above guardrail 4 (`JOB_APPROVAL_LINE_USD`, US$20: 25 cr at $0.80) never runs without a tap. Only an admin changes the setting or the budget ceiling.
    - Atomik's own thinking (questions, the plan, review notes) is billed as the planning turn is today in `lib/workbench/rig-agent.ts`: reserved against a limit the person approves when asking, settled at what it used, and not billed when nothing came back. Decision 7 in the 4 October 2026 amendment's §10 may change this.
    - The balance is checked against a plan's total before it starts, with Top up offered then, never halfway through.
    - A failed step that cost nothing says "Nothing billed" and offers Retry, which re-runs it under the same approval; a failed step that was charged says what it cost.
15. **Readable dark.** Text people read is at least 12 px and at least 55% white on black (about 6:1; WCAG AA asks 4.5:1). Fainter text is for disabled things only. Focus rings are always visible. Touch targets are at least 44 px on phones. Separate areas with space and hairlines, not grey boxes.
16. **No Higgsfield sign-in.** Restates rule 10 for all new work: every replacement in the 4 October 2026 amendment's §5.3 runs on a provider API key, and anything on Higgsfield runs on its API key (`api.higgsfield.ai`, with `HF_API_KEY_ID` and `HF_API_KEY_SECRET` or `HF_CREDENTIALS`). A PR that adds or keeps a Higgsfield tool names its endpoint. A tool that would need a Higgsfield account is not built.
17. **Measure ease.** The five-minute rule (rule 6) becomes a Playwright test, landed as U1's first PR and run on every UI PR after it: a new person with an invite reaches an approved first render. The product records time to first render, approvals per session and where people stop, as ids and timings only, never prompt text.

---

## 4. Design system

**4 October 2026.** One design: Graphite. Every older design file and style sheet is deleted (D0), and the new "board, made easy" handoff from Claude Design is the source of truth for screens (4 October 2026 amendment, §6).

Full spec in `docs/handoff/nodegraph/DESKTOP-README.md` (shell, components, per-screen) and `README.md` (node-graph surfaces, light tokens). Both are **high-fidelity and final-intent** — colours, type, spacing, radii, copy and geometry. The graph geometry in the canvas surfaces is exact: node positions, port centres and wire endpoints were measured. Keep port-to-slot alignment when rebuilding; a wire that misses its port breaks the one idea the screen exists to show.

**Historical theme discussion — resolved by the September 13 amendment.** The handoff describes particl as dark (`#0B0D11` ground, `#F5F6F8` ink) and Atomik as light (`#FCFCFD`). The live site is light with an Auto appearance setting and per-scheme `theme-color`. Resolve this before building Rig: either particl is dark and the live light theme is the exception, or both themes are first-class and every new surface ships in both. Don't let it stay ambiguous — the node surfaces are token-heavy and reworking them later is expensive.

**Type.** Outfit for UI and body; Kode Mono 11px/0.12em tracking for eyebrows, costs, states and IDs. **Radius** 4–10 by component. **No motion, no shadows** in the sense that matters: nothing slides, nothing drops a soft shadow. Literally there are transitions and `box-shadow` in the stylesheet — the shadow tokens paint HAIRLINES (`0 0 0 1px`) rather than depth, and transitions are short and limited to colour and border alpha. Hover raises border alpha only.

**Components** (spec'd in the handoff): app shell header with project switcher and cap readout, project sub-nav, segmented filter, primary button with cost inline, secondary, dashed add, dropdown chip, toggle, cast chip, `@mention` inline, state dot, take card, search field, composer rail, and for Rig: node with ports, wire layer, inspector, impact sheet, stage card.

**State dots.** approved = filled accent; picked = filled ink; draft = 1.5px solid outline; no take yet = 1.5px dashed; rendering = word plus a 3px determinate bar. Rig adds: queued = dashed muted, running = 2.5px accent ring, done = filled accent, needs-you = filled ink on `#F7F5EC`, locked = lock glyph, no dot.

**Placeholders.** Striped rectangles in the references are image wells. In production they are real keyframes, take thumbnails, reference photos, location plates and turntable views. Never ship a surface with text where a thumbnail belongs.

**Do not port `support.js`** — it is a preview runtime for opening the HTML standalone. Recreate every surface in the existing Next/React components, routing and styling.

---

## 5. Data model

Existing (verify against the schema before relying on it):

```
workspace     { id, name, plan, creditBalance, storageQuotaBytes, concurrencyLimit }
project       { id, workspaceId, name, kind, runtimeTarget, cap, spend, team[],
                stage: rendering|in-review|delivered|brief-only, origin: atomik }
shot          { id, projectId, sceneId, title, description, plannedSecs, cast[],
                setup{size,angle,move,lens,lighting,hour,look,technique,mood,motion,sound,titles},
                refs[], takes[], state: none|draft|picked|approved, syncDirty }
take          { id, shotId, kind: video|still|audio, version, model, spec, durationSecs,
                credits, engineCostUsd, tokens, by, createdAt, state,
                rendering{progress}, sentBackNote, masterUrl }
cast          { name, kind: character|location|prop|look, description, stillUrl,
                identity{status,photos,progress,credits}, scope: project|workspace }
setupDefaults per project, inheriting workspace, inheriting platform
usage         { byProduction[], byPerson[], byShot[], byEngine[], period }
settings      { team[], engines[], storage, atomikConnection, defaults }
```

Added by Rig (Phase 3):

```
recipe        { id, projectId, draft, stages[], estimateCredits }
stage         { id, num, name, engineId, params{}, inputs[ref], state, credits, perUnit, results[] }
run           { id, recipeId, startedAt, state, spentCredits, estimateCredits,
                stageRuns[{ stageId, state, progress, spent, failure }] }
failure       { stageId, unit, reason, fixes[{ id, label, note, credits, kind }] }
element       { id, kind: character|location|prop|look|voice, name, locked, lockedBy, lockedAt,
                attributes[], plates[], views[], createdFrom{shotId,takeId}|null }
attribute     { id, elementId, kind: face|hair|wardrobe|voice, versions[], currentVersionId, locked }
version       { id, label, thumbUrl, createdAt, usedByShotIds[] }
binding       { shotId, slot: character|background|element|look|keyframe,
                elementId, versionId, overridden: bool }
provenance    { takeId, bindings[], setup{}, engineId, engineParams{}, seed, rules[], credits, by, at }
impact        { elementId, versionId, dependents[{shotId,state}],
                options[{key, shotCount, credits, consequence}] }
quote         { unitCredits, units, totalCredits }   // resolved before any action enables
```

**Port identity is `elementId:attributeId:versionId`.** That triple is what a wire carries and what provenance records. It is the single most important line in this document; everything else in Rig is bookkeeping on top of it.

Added on 2 October 2026. All of it is additive; nothing is deleted or rewritten.

- `element_lock_events`: the append-only history of every lock and unlock of a master (§9). `attribute_versions.sha256` records the source a lock froze.
- `take_verifications`: one finished Verify check per take, set of wired cards, rubric and set of frames (§9).
- `rig_agent_runs` and `rig_agent_steps` gain a run's limit, its approvals, and each render's price, approval and settlement. In the platform ledger, `generation_reservations.run_id` names the run a hold belongs to.
- `boards.imported_at` and `boards.imported_to`: when an old board's cards last came across to the new Rig, and where they went.
- Team-canvas cards gain three optional fields: `master` (written only by a lock), `section` and `imported`.
- `atomik_skills` and `atomik_skill_versions`: each Atomik skill, and every version of it (1.8).
- `atomik_chats.archived_at` and `atomik_chats.archived_by`: a thread's archive flag and who set it; Restore clears both (1.8). `atomik_steps.request_key`: the key a step's latest approval rendered under, which names its thread. A new index on `atomik_chats(project_id, updated_at)` lists a project's threads by newest activity.
- `provider_pool` and `provider_key_alerts`, in the platform database: the shared provider key's line, and takes waiting on a key that changed (1.0). Each row names its workspace.

Everything above is workspace-scoped.

---

## 6. Phase 0 — Mobile foundations · LARGELY COMPLETE

Verified fixed on particl.app at 390×844 and 360×640: no horizontal overflow on any route, no inputs under 16px, per-scheme `theme-color`, composer sheet opens with Close and Generate both in the viewport, vocabulary corrected (Request an invite / Takes / Productions / Generate), 1920×1080 replacing 1080P/1088, positional copy removed.

**Outstanding:**

- ~~**Safe area.** Dock `padding-bottom` reads 0px despite `viewport-fit=cover`.~~ **Shipped.** `env(safe-area-inset-bottom)` is on the tab bar, the composer and the bottom sheets (`app/globals.css`), and the phone suite asserts it.
- ~~**Credits not in the composer.**~~ **Shipped.** The Generate button reads credits alone — `43 cr` for a 5-second Seedance 1080p take, no dollars and no token count. The margin no longer reaches the browser at all (`CreditState` dropped it, 10 September).
- ~~**Token count on the button**~~ **Shipped.** Gone; the button carries the credit figure alone.
- **Vocabulary**: dock `GENERATE` vs segmented Video / Images / Audio.
- **Sticky context in the shot builder** — the assembled prompt and the `N OF 12 ROWS SET` counter scroll away, so tapping a chip far down the page gives no feedback. Put a one-line preview and the counter in the sticky bar.
- ~~**`aria-pressed` on chips**~~ **Shipped.** `aria-pressed` is on the toggles in Theatre, Feed, ShotRow, Studio and the identity sheet.
- **`/images` hydration** — the SSR HTML previously carried the video composer. Confirm resolved.
- ~~**Audio tab**~~ **Shipped.** Signed out, the audio composer renders against `VISITOR_SETUP`, the same way Video and Images do.
- **Usage signed out** is no longer blank — it explains that the ledgers are for the team — but it still does not SHOW the shape with placeholder numbers.

**Acceptance suite** (keep it green for every later phase): visits every route at three viewports signed out; asserts `scrollWidth === clientWidth`; opens the composer sheet and asserts Close and the primary are in-viewport; asserts dock `padding-bottom ≥` safe-area inset; asserts no input under 16px.

---

## 7. Phase 1 — Multi-tenant foundations, then engine breadth

### 1.0 Tenancy, billing, onboarding — gates everything

**Keys and metering.** Platform holds the keys; workspaces don't bring their own (design the adapter so a workspace key *can* override later; don't build the UI). Every engine call goes through one server-side **metering layer** stamping `workspace_id`, `kind`, `model`, `engine_cost_usd`, `billed_credits`, `paid_by_platform`, `duration_ms`, `status` and `created_by` (`meter_events`, `lib/meter.ts`). **What is NOT there, so it is not assumed:** there is no per-workspace pricing override, so §7A's internal-workspace case is unbuilt. (`project_id` and `shot_id` ARE columns and are written — an earlier note here claimed otherwise and was wrong.) The margin is derivable per row rather than stored. The intent below stands: no engine is ever called from a route that bypasses the meter. Still to build: the per-workspace pricing override. **Peak concurrency per engine is NOT a sampler and never needed to be** — every job already records when it began and how long it ran, so the peak is derived from the intervals themselves, exactly and for all history. That is strictly better than sampling, which can only see the instants it happens to look at. The line below asked for it sampled per minute and retained — that reading is what justifies a provider limit increase later, and it can't be backfilled.

**Billing.** Prepaid credit balance per workspace, bought in packs by card; invoicing for larger accounts later. Balance in the header beside the workspace switcher and on Usage. Project caps convert to credits; the workspace balance is the hard stop above them. At zero, renders queue with "top up to release", the owner and admins are notified, nothing is silently dropped. Statements per workspace / month / project, itemised by shot and take in credits with one USD line for the pack cost — this is how a workspace bills its own client.

**Onboarding.** Request an invite → platform admin queue → approve → expiring invite code → account → create or join a workspace → workspace seeded with platform Setup defaults, camera bank, rules and a copy of the demo production as a starter project → **a free credit grant** (250 cr by default — `signupCredits()`, overridable per deployment and from the platform layer) → first render. Time this path against rule 6. Owners and admins invite their team by email with a role; pending invites visible in Team & roles. Workspace switcher in the header lists every workspace the user belongs to.

**Platform admin console** — separate route, platform-role gated: invite queue, workspace list with spend / balance / margin, engine health and error rates, per-workspace suspend, content-policy flags, and a platform-layer editor for default Setup, camera bank, compiler rules and default caps. **Built, 2 October 2026:** a Shared provider key card, for the platform owner alone. It shows the pool and who holds what, takes waiting on a key that changed, and each recent request's id beside the provider's correlation id. The owner is emailed once when takes start waiting on a changed key.

**Isolation and lifecycle.** Per-workspace rate limits and a **fair-share queue** — per-workspace concurrency slots inside the global pool, so one customer's batch of forty stills can't starve nine others. This is what breaks first, long before any provider ceiling. Per-workspace storage quota shown on Storage & masters. Self-serve workspace export (all masters plus a CSV of every take, prompt and cost) and deletion with purge. Shared identity with Atomik: one account, one workspace list, one session, same scoping enforced on both sides.

**Built for the shared provider key, 2 October 2026.** Higgsfield work on the platform's key shares one pool of requests in flight, and one workspace holds at most its share. A take that finds the pool full waits in line ("Queued — starts when a slot frees"). Nothing is reserved, charged or sent while it waits; it starts once, at the price it was quoted. The next free slot goes to the waiting take whose workspace has the fewest takes in flight; a tie goes to the take that has waited longest. Each job keeps the one-way fingerprint of the key it was sent on and is collected on that key, so a key rotation never sends it again.

**Policy.** Written content policy shown at signup. Engines refuse some prompts — failure reasons must say so plainly. Report path on review links, platform-side suspend for abuse, terms/privacy/retention visible from Settings → Account.

**Pricing is decided — see section 7A. Implement it as specified; the only open item is whether invoicing ships now or later.**

### 1.1 Model breadth per shot

One interface (`estimate`, `render`, `poll`, `fetchMaster`), one adapter per provider: ByteDance/Seedance and Google/Nano Banana Pro (existing), ElevenLabs, **fal** carrying Kling 3.0, Kling 3.0 Pro, Topaz Astra, Luma Ray 2 and Flux · Identity behind one adapter, and **Vercel** as the single LLM adapter with the same shape so text calls meter like everything else. Every adapter goes through the metering layer.

Wiring `FAL_KEY` and the fal adapter properly unlocks 1.1, 1.2 and 1.3 at once — do it first and do it once.

A **model row in the composer**, defaulted from the workspace's Defaults & caps, overridable per shot, each with a one-line "what it's for" (`Kling: water, cloth, physics`). On touch this is a bottom-sheet picker, not a dropdown — the current dropdown lags on mobile; profile before guessing, but the usual causes are the composer re-rendering on open, a synchronous estimate recompute, or animating layout properties. Debounce the estimate. Assert no long task over 50ms on open.

A **per-engine prompt compiler**: Setup rows are engine-neutral, the compiler renders each engine's dialect. Rules live in the platform layer with workspace overrides (2.5). Atomik's LLM path reads the same rule set — one source of truth, not two copies that drift.

Don't copy Higgsfield's model marketplace. Five well-wired engines beat thirty.

### 1.2 Post tools on an approved take

In order: **Reframe** (aspect change with content-aware fill, new take under the same shot, versioned, named by convention) · **Upscale** via Topaz on fal · **Motion control** via Kling 3.0 Motion — a cast still or approved frame plus a reference video, which is the one that stops you re-rolling a performance · **Extend / last-frame continuation** · outpaint and background removal for stills. Every post tool shows its credit price before pressing and files output against the same shot as a take, not a separate bucket.

**Built, 2 October 2026.** The Next row on a finished still or clip makes a new take from it, and each action is priced first ("about N cr"). A still can be upscaled (Topaz), outpainted to another aspect (Bria Expand) or animated from its first frame (Seedance 2.5). A clip can be upscaled (Topaz Astra 2), reframed (Luma Ray 2) or extended (Seedance 2.5). Made from a take, the new take is filed under that take's shot as its next version; made from an upload, it goes to Takes without a shot. The source is never changed. On the Rig, an Element card can be cut out (Bria background removal), priced and approved first; the cut-out becomes the card's next version, and the original stays.

### 1.3 Identities

Wire fal end to end: photo intake → Flux · Identity (`fal-ai/flux-lora`) training → status → available as a cast member. Credit price shown before pressing; training is asynchronous and appears in the queue. `@Name` resolves to the trained model for stills and the hero still for video, automatically. Trained identities are workspace-scoped and never shared, listed or reused across workspaces. The uploader confirms they have the right to train on that face; store that confirmation with the identity.

### 1.4 Visual camera bank

A short looping preview per camera move and technique, generated **once at platform level** from a fixed neutral scene, stored as platform assets, served to every workspace, never regenerated per workspace. Sort by used-in-this-production → used-in-this-workspace → alphabetical; a used move shows the workspace's own last take as its thumbnail. Search across all rows (`dolly` finds Dolly zoom and Push in). Platform defaults so a new production doesn't start at "0 of 12 rows set".

### 1.5 Queue and job state

A queue strip on the make screen: rendering / queued / failed, per-job credits and shot, tappable. Failures say why — engine refused the prompt, engine error, project cap hit, balance at zero — and offer the right action: retry, edit prompt, ask an admin to unlock, top up. Show the workspace's concurrency limit and where it stands.

### 1.6 Batch variations

Count control on the composer (1–4 video, 1–8 stills) — **shipped**; the button multiplies credits. Siblings file under the same shot; the wall groups them so picking is one screen.

### 1.7 Demo and starter production

One platform demo production visible signed out and from every empty state: three shots, a few takes each, one approved, real credit numbers, a cast of two, Setup filled, read-only, generic and rights-clear. The same production copied into every new workspace as its starter, editable and deletable. The "sign in to generate" gate stays where it is.

### 1.8 Atomik — idea builder, shot builder, prompt enhancement

Every LLM call goes through the **Vercel API** adapter, metered in credits, so thinking and rendering draw on one balance.

- **Prompt enhancement** as a first-class engine: `enhance(prompt, targetEngine, setup, cast, rules)` → engine-dialect prompt. Reads the rule library (2.5) and the target engine's dialect, so a shot written once comes out ready for Seedance, Kling or Nano Banana. Priced in credits — small, never free, never hidden.
- **Idea builder**: logline or brief → treatment and scene list in the workspace's voice. Versioned documents, not chat transcripts. Edit any line, re-run only from there.
- **Shot builder**: scene → shot list with every Setup row pre-filled, cast tagged `@Name`, recommended engine per shot, and estimated credits per shot and per scene **before anything renders**. This is the planned budget that flows to particl.
- Use **structured output** so Setup rows land as fields, not prose to parse. Use **prompt caching** for the rule library and workspace Setup, identical on every call. Propose which Claude/GPT model per job with per-call credit cost — enhancement is high-volume and wants something fast and cheap; idea and shot building can afford stronger.
- Every generated line shows which model wrote it and can be regenerated alone. Nothing auto-overwrites a human edit. Same workspace scoping and content policy as particl.
- **Memory (rules as of 2 October 2026).** Atomik › Memory keeps what a workspace wants Atomik to know: brand, audience, identities and notes. It refuses only amounts of money, such as a price, a cost or a number of credits, and keeps descriptive words such as "a premium price point". An identity points at a Cast & Elements entry or a Soul ID by reference, never as a copy, and Atomik reads the name it has now. Lines can be picked from the project's brand kit. Anyone in the workspace may forget any entry; forgetting archives it. All of this is free. The one paid step is Read with Atomik, which sorts a long paste or a document into proposed entries. It is priced first ("about N cr"), and nothing is saved until a person ticks lines and presses Keep.
- **Skills (2 October 2026).** A finished Atomik run can be saved as a skill: its steps, engines and settings, with the person's own words as named parameters, and nothing the run made. `/` in the composer, or Atomik › Skills, runs it with new words. Each step still waits for its own quote and a person's Continue. Library steps and steps with attached media are left out, with the reason. A skill is Just me or Workspace. Each edit is a new version, and Archive hides a skill without deleting it. Saving, editing and planning a skill's steps are free.
- **Threads (2 October 2026).** A project can have several Atomik threads. Each is its own conversation, with its own plan, steps and thinking model; Memory, the cast, the production's cap and the workspace's rules and engines are shared. The project's earlier conversation is thread 1, under the same id. The Threads row at the top of the rail and the phone sheet lists them, newest activity first, and starts, renames, archives and restores them; Atomik › Agent in the Suites shows the same. Any member may archive or restore any thread, as with Memory. Archive hides a thread and keeps every message and step; an archived thread refuses turns and approvals until it is restored. In a new tab, a link that names a thread (`?thread=<id>`) opens it. A link that names none opens a thread whose planning turn waits to be recovered, else the one with the newest activity. Threads are free; each paid step is still quoted and approved on its own.

---

## 7A. Pricing — decided for launch

Pricing policy (multipliers, margins, floor guard, volume phases) is kept privately by the owner; it is not in this repo. What follows is what customers see and what the code must guarantee. Anything that changes what a workspace is charged needs the owner's approval.

### Credits
- **1 credit = US$0.10, fixed**, the public price. A credit's price is `creditUsd()` (`lib/creditTerms.ts`, overridable by `CREDIT_USD`).
- Every job is priced from engine cost through the margin table (`margins()` in `lib/creditTerms.ts`, overridable by the `CREDIT_MARGINS` env var) and rounded up to the next whole credit per job. Batches multiply before rounding. The table is keyed by engine, so pricing one engine differently is a config change, not a refactor.
- The ledger stores `engine_cost_usd` and `billed_credits` per job. The rate card is generated from the adapter registry, never hand-edited.
- Customers never receive vendor costs for work on the platform's keys: no engine cost or margin reaches anyone but a platform admin, and a vendor cost is never shown next to our price. A workspace on its own keys sees its own vendors' dollars.
- **Draft/hero split is a product default, not a pricing tier.** Recipes route boards to standard panels (1 cr), draft takes to Kling Standard or Wan (4–8 cr), and hero takes to Seedance or Kling Pro (25–45 cr). The composer's model row defaults from the shot's stage in the recipe.

Reference rate card at launch, in credits (regenerate from the code before publishing):

**CORRECTED 10 September 2026, from `lib/vendorRates.ts`.** The card below was
written from costs that did not match the code, and it was wrong in both
directions. Published, it would have over-quoted one row twofold and
under-quoted another fourfold. The app has always billed from the real rates;
it was the card that lied. Two rows named engines that do not exist and are
gone.

Every figure is computed, not asserted: per-second engines are
`rate x seconds` (`secondRateOf`), Seedance is token-priced off the billed
frame (`billedFrame` rounds each side up to a multiple of 16, which is why
1080p is metered at 1088), stills come from `imagePricing`, and every "sells
at" goes through `billCredits`.

| Action | Sells at |
|---|---|
| Standard still (Nano Banana 2, 512) | 1 cr |
| Keyframe still (Nano Banana Pro, 1K) | 3 cr |
| Kling 3.0 Standard, 5s 1080p | 7 cr |
| Kling 3.0 Standard, 5s 1080p, audio | 10 cr |
| Kling 3.0 Pro, 5s 1080p, audio | 13 cr |
| Seedance 2.0, 5s 1080p | 29 cr |
| Seedance 2.5, 5s 720p | 18 cr |
| Seedance 2.5, 5s 1080p | 43 cr |
| Topaz upscale, 5s 1080p | 23 cr |
| Topaz upscale, 5s 4K | 38 cr |
| Identity training (1,500 steps) | 54 cr |
| Prompt enhancement | 1 cr |

Gone from the card, because the engine is not in the product: **Wan 2.6** —
`alibaba/wan-v3.0-video` appears only in the gateway shortlist and gateway
video is explicitly unrunnable — and **Veo 3.1**, which is in neither
`lib/models.ts` nor `lib/vendorRates.ts`. A VO line is priced per character by
ElevenLabs rather than per call, so it has no single figure and is not a card
row; see the audio terms.

Identity training is priced per step (`TRAIN_STEPS`, `TRAIN_USD_PER_STEP` in
`lib/identities.ts`), with a 1,000-step floor.

### Tiers

**AMENDED 10 September 2026 — panels are out of the tier rows, and expiry is
on.** Two decisions taken after mapping §7A against the code:

1. **The panel inclusions are cut. Tiers differentiate on credits alone for
   launch.** "250 / 1,000 / 3,000 standard panels" is an allowance on a unit
   that does not exist: there is no panel object, table, column, route, count
   or cap anywhere in the code, nothing marks an engine "standard", and the
   board pipeline those panels would come out of (§2.8, stages 1–5) is
   entirely unbuilt. A standard board panel bills at exactly 1 credit, so the
   value of each row is re-expressible in credits with nothing lost. **Panel
   allowances wait for §2.8.** The original rows are kept below, struck
   through, so the intent is not lost.
2. **Credit expiry is no longer deferred; it comes first.** See §14.

Three words in §7A also collide with words the code already uses, and the
code's meanings are older. `tier` is a RESOLUTION BAND in the vendor rate
table (`RateTier`, `TableTier`). `allowance` is a monthly DOLLAR CEILING on
engine spend — a stop, not a grant, the opposite kind of object. `panel` is a
region of UI (`--color-panel`). Rule 5 says one vocabulary, decided once, so
the tier work uses **plan** for the subscription and keeps `tier` meaning what
it already means.

| Tier | Price | Included | Members |
|---|---|---|---|
| **Invite** | $0 | 250 cr once, 1 production | 3 |
| **Studio** | $49/mo | 400 cr, ~~250 standard panels~~, review links, exports, post tools | unlimited |
| **Agency** | $199/mo | 1,600 cr, ~~1,000 panels~~, priority queue, branded review links, statements | unlimited |
| **Production** | $999/mo | 9,000 cr, ~~3,000 panels~~, admin console, setup hours | unlimited |

- **Included credits expire at cycle end. No rollover.** (Panels struck, 10 September — see the amendment above.)
- **No seat fees on any paid tier.** Differentiate on credits, priority and features, never headcount.
- **Annual: 20% off.** Auto-cancel: if a workspace has generated nothing in the 60 days before renewal, don't renew — let it lapse and say so.
- ~~Panel inclusions are on the standard engine only.~~ Struck 10 September with the panel rows. Pro stills and all video draw credits regardless of plan — which, with panels gone, is simply: everything draws credits.

### Packs
Unit stays $0.10. Discount only through bonus credits, capped at 20%. Purchased credits last 12 months.

**AMENDED 10 September 2026 — a pack does not expire while the workspace is
on a plan.** The 12 months is time spent OFF a plan; a subscriber's purchased
credits sit still.

Why: with a plan's included credits spent first (which is what makes them
included), a subscriber who stays inside their monthly allowance never touches
their packs. A uniform 12-month lifetime would then expire credits the
customer paid cash for and was structurally prevented from spending. That is
not breakage, it is a charge for nothing. Breakage is meant to fall on a
balance somebody walked away from, and a subscriber has not walked away —
they are paying every month.

**This is a sequencing constraint, not just a rule.** The exemption is part of
the rule, and it cannot be honoured before plans exist to be exempt from. So
purchase expiry does not ship first: either it ships WITH plans, or after
them. Shipping the 12 months on its own would expire the credits of the exact
customers this amendment protects, with nothing in the code able to tell that
they should have been protected.

Still open, and only reachable once plans exist: whether leaving a plan
RESUMES the remaining months or restarts them. It has no answer today because
nothing can leave a plan, and the two differ only for someone who has.

| Pack | Price | Credits | Effective |
|---|---|---|---|
| Starter | $50 | 500 | $0.100 |
| Team | $200 | 2,000 + 200 | $0.091 |
| Studio | $500 | 5,000 + 750 | $0.087 |
| Agency | $2,000 | 20,000 + 4,000 | $0.083 |

### Guardrails in code
1. Free grant is one-time, never recurring. Invite approvals are capped per month by a platform setting (`grant_budget_usd`).
2. Bonus credits never exceed 20% of a pack.
3. Any workspace consuming more than 25% of the platform's monthly engine spend is flagged to the admin console.
4. Any single job estimated above 200 cr requires the workspace's cost approval rule to fire, regardless of the workspace's own setting.
5. Included-credit consumption is metered separately from purchased credits, so statements show what was free and what was paid.
6. Workspaces flagged `internal: true` carry a pricing override set by the private policy. The flag is set only from the platform admin console, never from workspace settings, and its spend is excluded from margin reporting.

---

## 8. Phase 2 — The moat

Everything here exists because particl has a shot model and a cost model. Push until these are the reason a team picks it.

### 2.1 Takes as selects
Compare view — two to four sibling takes side by side, synced playback, one-tap pick or approve; this is the producer's phone screen. Approval trail: who picked, who approved, when. An approved shot is locked; generating against it asks for a reason. A send-back returns the shot to draft with the director's note attached, listed in History and in Usage's `SENT BACK` column. Notes on a take, one line, `@person` mentions, so "the 3rd one but with the pan slower" lives on the take and not in WhatsApp.

### 2.2 Cost that lives with the shot
Every shot on the wall shows `takes so far · spent so far` (`6 takes · 172 cr`). Per project: cap burn-down — spent against cap, projected finish from takes-per-shot so far, and which shots are burning it. `Which shot is taking the most takes` becomes the headline of Usage. Per workspace: balance and burn rate, days of runway at the current pace. The cost approval rule surfaces in the composer when it applies (`Over 50 credits needs an admin`). Statements cut by project and by client-facing shot names so a workspace bills its client directly from them.

### 2.3 Setup you can see and override
The composer shows a live diff: which rows are active, which the current shot overrides (`Setup: 35mm · Golden hour · Handheld — this shot overrides: Locked off`). Per-shot override without touching workspace Setup, and one-tap clear. **Four layers** — platform default → workspace → project → shot — each inheriting and overriding the one above, with the UI showing where every active value came from. **Shipped:** all four labels exist — `lib/setupLayers.ts` carries `platform | workspace | production | shot` and the composer renders each.

### 2.4 Cast that carries
A cast member's page shows every take and still made with it across the workspace's projects, fast. Consistency check: a take rendered with `@Name` shows the cast still beside it so likeness drift is visible at a glance. Identical behaviour in stills and video composers. Never crosses a workspace boundary.

### 2.5 A rule library, not a hard-coded compiler
**Platform rules** (everyone inherits) + **workspace rules** (their own, editable in Studio) + per-engine scope. Rules show their source, and a workspace can switch off a platform rule it disagrees with. Seed the platform layer with:
- One camera move per shot; a travelling technique overrides the move row.
- Niche terms go out as term + what actually happens.
- Only subtitles and audio reliably accept a NO; everything else is described positively.
- Time of day and lighting are separate rows and never both say golden hour.
- All-caps section headers in an image prompt leak into the render as burned-in captions — write camera and subject direction as plain sentences and always append a no-lettering line.
- Relative edits on Nano Banana plateau ("make him smaller", "fade the colours a notch") — after two failed edit passes on a still, offer "regenerate fresh with the full final look specified" instead of a third edit.
- Kling for water, cloth and physics; Seedance for everything else — surface as the default model suggestion when those words appear.

Workspace rules are plain sentences a team writes ("our brand never shows logos in the first frame"); the compiler appends them to every prompt in scope.

### 2.6 Atomik ⇄ particl, and out
**The shot list is the contract.** Atomik sends order, planned durations, cast tags with stills and descriptions, references per shot, Setup defaults and the cap. particl writes back per shot: state, take count, cost to date, master link once approved. Prompts and takes stay in particl. Rows edited since the last send are tinted and read `edited since last send`; header shows `SYNCED n MIN AGO · BOTH WAYS`. Type-only shots never render and never cost.

**Client review link**: read-only page of a project's approved takes in shot order with notes. No login; tokenised, expiring, revocable from the project; carries the workspace's name and logo, never particl's branding in front of their client. A comment box writing back to the take's notes.

**Export selects**: zip of approved masters named `{project}_{shot}_{version}_{w}x{h}.{ext}` and a CSV shotlist (shot, take, version, engine, credits, prompt). The older selects route exports masters and CSV only. The September 13 workbench adds a separately validated CMX3600 EDL/source package at an explicitly selected frame rate.

### 2.7 Team on a phone
The four things a producer does on a phone: see what rendered, compare and approve, see the burn-down, unlock a cap or top up. Each one tap from the make screen, tested at 360×640. Push notifications for take finished, cap at 80%, approval needed, balance low — per-user, per-workspace preferences. **The push service is server-side work and gates the iOS app**: device token registration per user per workspace, an APNs key, and triggers on those four events.

### 2.8 The board pipeline

**The principle: the board is the cheap draft of the shot, and an approved panel becomes the keyframe.** A still on Nano Banana costs a fraction of a credit; a video take costs ~29. You can board seventy panels for the price of one take. So decide on the cheap layer and commit on the expensive one — and unlike every other boarding tool, the panel doesn't die at export. It is the frame Motion starts from.

That continuity is the whole differentiator. Boords, StudioBinder and the rest generate or draw a board, you export a PDF, and then you shoot separately; the board and the footage never share a source. Here the board, the keyframe and the take are three states of one object.

**Where it lives.** Boarding happens in **Atomik's Breakdown**, which already has the 16:7 board wells and the per-shot Setup chips. particl consumes the result. The board is not a separate app or a separate model of a shot.

**The stages:**

1. **Panel generation** — every shot in the breakdown generates 2–3 panels at once from its description, Setup chips and cast tags, on the stills engine at low resolution. Price the whole scene before it runs (`12 shots × 3 panels · 15 cr`). Auto-pick per shot by face-similarity against the cast still; show the alternates but don't make the user choose.
2. **Panel iteration** — this is where boarding actually happens. Re-roll one panel, nudge it by chips not prose (tighter, wider, other side of the line, different hour), or replace it with an uploaded reference or a drawing. Every re-roll is priced and cheap. Panel history is versioned per shot.
3. **Continuity check across the scene** — panels laid out in sequence with the crossing-the-line and eyeline direction flagged where consecutive shots contradict. This is what a board is *for* and no AI board tool does it. Start with screen-direction only; it's the error that survives to the edit.
4. **Promote to keyframe** — an approved panel becomes the shot's `KEYFRAME` binding in particl. The shot arrives on the wall with its first frame already decided, and provenance records which panel version it came from.
5. **Board → take → board.** If a take is approved and the board no longer matches, the board updates from the take, not the other way round. The board is always the current truth of the shot.

**Animatic.** A timed board with scratch audio answers pacing questions no static board can, and it is the single feature that separates a real boarding tool from a panel grid. Build it: panels held for their planned durations, scratch VO from ElevenLabs or a recorded track, a music bed, cuts on the beat, and a scrub bar. Atomik already computes runtime against scene lengths and flags a scene that runs over — the animatic is the audible version of that bar. Export as MP4.

**Consistency comes from the element model, not from prompting.** Panels bind to the same elements as takes — `@cast` with its versioned attributes, locations with their plates, looks locked with the brief. A character boarded in scene 1 and scene 9 is the same bound version, so it looks the same. This depends on Phase 3's element and binding schema; a simpler version can ship earlier off cast stills, but plan the schema so panels are first-class bindable objects from the start.

**Deliverables** — the board is a client-facing artefact, so it must leave the building well:
- Numbered panel PDF with shot number, description, Setup line, duration and cast, in scene order, with the workspace's branding.
- PNG sequence.
- MP4 animatic.
- The review link from 2.6, pointed at panels instead of takes, so a client approves the board before a credit is spent on video. **This is the highest-value use of the review link** — approval at the cheap stage is the entire economic argument for the product.

**Sequencing.** Panel generation and iteration can ship as soon as the stills engine is metered (after 1.0). The animatic needs ElevenLabs wired (1.1). Promotion to keyframe and full consistency want Phase 3's bindings. Ship in that order; don't wait for Rig to start boarding.

---

## 9. Phase 3 — Rig

**4 October 2026.** The Rig becomes the Board, one per production, in S1 to S3; "Board" is its name in the UI and "Rig" may stay in code (4 October 2026 amendment, §3 and §4.1).

The node layer. Design handoff at `docs/handoff/nodegraph/`.

**Name.** The surface is **Rig** — Canvas is already taken by the sequence wall at `/projects/:id/canvas`. Rig works twice: on a set it's the wiring and mounting that holds a setup together; in animation, rigging is exactly binding a character's attributes to controls that everything downstream reads. Nav **Rig**. The Rig lives in the Suites, as Studio › Rig (`/suites`). The `NODES` nav word of 10 September went with the old Nodes screen, which is deleted. The element library stays at `/projects/:id/rig/elements`, and an old board at `/rig/canvas/:board` stays readable and opens in the new Rig. Nouns inside it: recipes, runs, elements, ports, bindings, provenance.

**The seven rules the surfaces enforce — these are the acceptance criteria:**
1. The price is on the action, quoted before the button enables.
2. State vocabulary: `queued → running → done`, plus `needs you` when a stage stops and `skipped`. Five, not four — `lib/runState.ts` is the list. `locked` is NOT a stage state: it belongs to a pinned ELEMENT, which the stage layer draws in its own band.
3. Existing production take states stay `draft → picked → approved`. The September 13 workbench allows private sequence assembly from any available source without a mandatory creative approval gate.
4. A failure never restarts a run — it offers fixes in place, each priced.
5. Nothing re-renders silently; any edit to a shared element opens the impact panel first.
6. A wire lands on a slot, not a node. Ports are the unit of connection.
7. Versions are additive. A new version never alters an existing take; the *swap* is what costs.

**Seven surfaces:**

| Ref | Surface | Size | What it is |
|---|---|---|---|
| `1a` | **Run view** | 390×844 | The primary screen. Cost header (`74 of 118 credits`, progress bar, `4 of 8 stages complete · 1 stage needs you`), then eight stage cards — brief, scene, shot list, keyframes, motion, post, audio, assembly — each with output well, state dot, credits, and a progress bar while running. A failed stage tints, states the real reason, and offers three priced radio fixes that drive the bottom bar. |
| `1b` | **Impact panel** | 390×844 | Sheet over a dimmed edit screen. `You changed a look 14 shots are using.` Summary with split bar and shot pills. Three priced choices: re-render all (approved return to draft), re-render approved only (default), leave existing takes. Footer mirrors the choice with the consequence restated. |
| `1c` | **Provenance card** | 390×844 | From a finished take. `PRODUCED BY` — character, look, location, engine, rules in scope, each tappable. `SETUP · 12 VALUES CARRIED IN` as chips. `EXACT CONDITIONS` — resolution, duration, seed, rule summary, credits, author and time. One primary: `Make another from exactly this`, same versions and rules, new seed. |
| `2b` | **Character attributes** | 390×844 | A character is four versioned attributes, not one asset: face, hair, wardrobe, voice — each a port with its own lock and version history. Tapping a row expands to version cards in place. `WIRED INTO` shows which stages consume which ports and any per-shot override. |
| `2c` | **Shot bindings** | 390×844 | Five slots for one shot — character, background, element, look, keyframe — each pointing at a version. Change one and only this shot moves. Includes the plate picker and `THIS SHOT MADE AN ELEMENT` (a prop promoted from an approved take, now bound in other shots). |
| `1d` | **Rig · stage layer** | 1440×900 | The recipe as an editable stage graph, chat panel alongside. |
| `2a` | **Rig · asset layer** | 1440×900 | How characters, elements and backgrounds wire into shots. Chat left, graph centre, slot-scoped inspector right. |

The two desktop surfaces are **two layers of one screen** behind an `Assets | Stages | Runs` switcher, not two screens.

**Recipes.** A wired set of stages, saved and named (`30s TVC, 6 shots, Kling hero + Seedance coverage, Hindi VO`), reusable across projects, shareable in the workspace, seeded at platform level and forkable. This is what makes a team's tenth production faster than its first.

**Run-time resolution.** Running a recipe resolves every reference to a concrete version, prices the whole run in credits before a single job starts, and shows the per-stage breakdown. Caps and the approval rule apply to the run total, not just per job. A run is resumable — fix one stage and continue.

**Locks.** Any node can be locked (identity, voice, look, Setup). A locked node cannot drift between stages or scenes; the compiler re-asserts it at every stage. Unlocking is explicit and logged.

**Built, 2 October 2026 — locked masters.** On the Suites Rig (`/suites`, Studio › Rig), a Cast, Environment or Element card can be locked as the master for everyone. Locking is free and open to anyone in the workspace, and to Atomik. Unlocking needs an admin and a reason; Atomik never unlocks. Every lock and unlock is kept in an append-only history. Nobody (a person, a stale tab or Atomik) can change a master's source or kind, or take it off the board: the rest of the edit lands, and the page says why that part did not.

**Build order — data model first, mobile before desktop, canvas last:**
1. Schema and the migration from what 1.0 shipped. Be specific about how existing takes get backfilled with provenance, or why they can't.
2. The quote/impact engine — what a change costs before it happens. Everything visible depends on it.
3. Mobile: `1a` → `1b` → `1c` → `2c` → `2b`.
4. Desktop: `1d` → `2a`.
5. Chat drives the graph; the canvas is a view of what chat did, never the only way to edit.

**Where it lives.** Recipe authoring and the canvas belong in Atomik (planning); running recipes and their outputs belong in particl (rendering). Same graph, same scoping, one database.

**Constraints that don't relax:** rule 6 — a new user must never need to open Rig to make a first render. Rule 7 — five of seven surfaces are 390×844 and must pass the Phase 0 suite. Desktop canvas is min-width 1180px and may be hidden below that; the mobile surfaces may not.

**Known geometry trade-off.** With the chat panel restored, the graph viewport is ~878px against a 1040px graph, so ~162px scrolls off at rest and the collapsed stages node is partly cut. Acceptable for a scrollable canvas. If it must read at rest: pull the column x-positions in ~120px, or narrow the inspector to 240px. **Pick one before building** — the geometry is measured and exact.

**Also built on the Suites Rig, 2 October 2026.**

- **Atomik's runs.** Asking Atomik for a board carries a limit for the whole run ("up to about N cr") and a mode: Ask (the default) or Auto. The planning turn is metered inside the limit. After the build, each render the plan names is priced first. In Ask it waits for one tap; in Auto, only a draft priced at or under the per-job line goes on its own. The per-job line is the platform's approval line (§7A guardrail 4). The reservation refuses any job that would pass the limit, and a run's take is never held to start later. A refusal pauses the run at "Needs you", with Retry, Skip, Raise the limit or Stop. Atomik's board building stays off in production until the owner turns on `RIG_AGENT_ENABLED`.
- **Verify.** A Verify card checks one take against the Cast, Environment and Element cards wired into it: identity, wardrobe, environment, props, and artifacts such as extra limbs or warped text. It is one judge call on a vision model from the agent's menu (Claude, OpenAI or Grok), priced first and charged in credits at what it used. The judge only scores; the code turns each score into pass, fail or unsure against fixed thresholds. A failed check fails the card; otherwise any unsure check makes it "Needs you", so nothing passes on a guess. Checking the same take against the same cards again reads the stored scorecard, free. A new version of one of those cards needs a new, priced check.
- **A tidier board.** Cards snap to a 20 px grid; Alt places one exactly. Notes and section titles are written on the board itself. Each card sits in its kind's section (Cast, Environment, Elements, Refs, Looks, Direction, Shots, Finishing, Review and output) or in one a person made. Tidy lays the board out by sections for everyone, free, and locked cards keep their place. Atomik's build lays out its own cards the same way but adds no section titles.
- **Old boards.** "Open in the new Rig" on an old board (`/rig/canvas/:board`) brings its cards, inputs and places onto the production's shared canvas, free. The old board is only read and stays editable. Opening it again brings only what is new, and a card someone took off the new Rig stays off.

---

## 10. Phase 4 — Desktop depth

particl is a workstation tool that happens to have a phone client. Everything below assumes a 27" display, a keyboard, a mouse and a user who is in the app for six hours. Most of it does not exist yet — but **4.1 (resizable persisted panes), 4.2 (the command palette and shortcut registry) and most of 4.3 (the player, the filmstrip, comparison) have shipped**, and §14 records each.

### 4.1 Breakpoints and density
Three layouts, not two: **mobile** (<768), **compact desktop** (1024–1439, two-pane), **full desktop** (≥1440, three-pane — library, work surface, rail). Above 1920 the layout gains columns rather than margins; a 400px composer rail on a 2560px display is wasted real estate. Rig canvas requires ≥1180. Panes are **resizable and persisted per user per surface**; a director and an artist do not want the same split.

### 4.2 Keyboard-first
A production tool lives on shortcuts. Minimum set, discoverable through a `?` overlay:
- `⌘K` command palette — jump to a shot, production, cast member or setting; run an action by name. This is the single highest-value desktop feature and it makes every later addition discoverable for free.
- Review: `J K L` shuttle, `space` play/pause, `←/→` frame step, `↑/↓` between takes, `[ ]` between shots, `P` pick, `A` approve, `S` send back with a note.
- Compose: `⌘↵` generate, `⌘⇧↵` generate batch, `/` focus search, `⌘` + backslash toggles the rail, `esc` closes any sheet.
- Rig: `⌘1/2/3` switch Assets / Stages / Runs, `space` pan, `⌘0` fit graph, `⌘F` find node.
Every shortcut has a menu-bar equivalent in the Mac app.

### 4.3 Review at speed
The desktop version of 2.1, and the reason an editor keeps the app open.
- **Player**: scrub, frame-step, loop, in/out, and a comparison mode with synced playhead across two to four takes — side by side, or A/B wipe for two.
- **Filmstrip** of every take on the shot under the player; arrow through them without leaving playback.
- **Pop-out review window** to a second display. Studios review on a reference monitor; the grading suite is not a laptop screen.
- **Notes with a timecode** — click on the scrub bar to attach a note at 0:03. This is what a director actually gives back, and it feeds the send-back note in 2.1.

### 4.4 Bulk operations
Desktop is where someone acts on forty things at once. Multi-select with click, shift-click ranges and `⌘A`; a persistent selection bar showing count and total credits. Bulk: approve, send back, file against shots, download masters, add to a review link, delete drafts. Every bulk action that spends credits quotes the total before enabling, same as a single action.

### 4.5 Drag and drop, and local files
Drag references into the composer; drag a folder of stills into Studio to create cast entries; drag a take onto a shot to file it; drag to reorder the sequence canvas; drag a plate onto a slot in Rig. Batch upload with per-file progress and resumable failures. Download: pick a destination folder once and remember it; masters land named by the convention without a Save dialog each time.

### 4.6 Scale
A production reaches thousands of takes. Virtualised lists and grids, thumbnail sprite sheets or a poster-frame service rather than loading video, lazy provenance, and a Rig canvas that stays responsive at 200+ nodes. Set a budget: the library at 2,000 takes scrolls at 60fps and first paint stays under 1.5s on a cold load.

### 4.7 Desktop-only surfaces
Already listed elsewhere but spec'd as desktop-first and never shrunk: the platform admin console, Usage's full charts and tables, Settings, the Rig canvas layers, and Atomik's three-pane Treatment and Breakdown. On mobile these are read-only summaries or absent, and say so plainly rather than rendering a broken grid.

### 4.8 Colour and output correctness
Review happens on calibrated displays. At minimum: tag masters with their colour space, don't let the browser silently transform on playback, and state the delivery spec on the take card. A director who approves something that looks different in Resolve stops trusting the tool.

---

## 11. Phase 5 — Native apps

Only after Phase 0's safe-area fix, 2.7's push service, and Phase 4's keyboard and review work.

### 5.1 Mac — the one that matters more
The desktop surfaces are where the work happens, so ship Mac alongside or before iOS. **Tauri** wrapping the live URL: ~10MB against Electron's 150, WKWebView, native menus carrying every shortcut from 4.2, a dock badge for running jobs, deep links (`particl://shot/SH04`), native notifications, background download of masters to a watched folder, and multi-window so the review player can live on a second display. Minimum window 1440×900. Ship as a signed, notarised `.dmg` from your own site — no store review, no commission, and for an invite-only product with no in-app purchases that's the easier path. Mac App Store later if it's ever worth it. **Not Mac Catalyst** — it gives an iPad-shaped window, which is wrong for Rig.

### 5.2 iOS


Prerequisites: Apple Developer Program enrolment, Xcode, and push working server-side.

Capacitor shell pointing at the live site (`server.url`), since the app is server-rendered and won't export statically. Native plugins that make it an app rather than a wrapper and avoid a Guideline 4.2 rejection: push notifications (the actual reason for the app), camera (identity photos and references), share (review links), filesystem (masters to Files), haptics.

**Sell nothing in the app.** Credits are bought on the web by the workspace owner. No buy button, no price shown — this avoids Apple's 15–30% cut on digital goods entirely and is how every B2B tool works. Out of balance on mobile → "ask your admin to top up", with an offer to notify them.

**Submission needs:** a demo account with a seeded workspace, a demo production with takes and enough credits that Generate works — invite-only apps are rejected under Guideline 2.1 without it, plus a note explaining the invite model. Privacy labels covering face and voice if identity training is reachable on mobile, a public privacy policy URL, screenshots, a 1024px icon. Budget one to two weeks of review round-trips.

The iOS app deliberately does less than the web: watch a run, compare, approve, unlock, top-up prompt. Composing and Rig authoring stay on desktop.

---

## 12. Screen inventory

**4 October 2026.** Superseded by the IA table of the coming design handoff, which `lib/shell/ia.ts` will follow (4 October 2026 amendment, §3 and §6).

**particl** — `/welcome`, `/login`, `/` (Video), `/images`, `/audio`, `/projects`, `/projects/:id/canvas` (sequence wall), the Rig in the Suites (`/suites`, Studio › Rig), `/projects/:id/rig/elements` (element library), `/rig/canvas/:board` (old boards, each opening in the new Rig), `/all` (Library), `/studio` (Cast & identities), `/studio/shot` (Camera & shot builder), `/usage`, `/settings` (Team & roles · Engines & keys · Storage & masters · Atomik connection · Defaults & caps · Account), plus the platform admin console on its own gated route.

**Atomik** — the Atomik Agent suite in the Suites, which `/atomik` opens: 01 Agent · 02 Runs · 03 Approvals · 04 Budget · 05 Models · 06 Tools (Tools & connections) · 07 Memory · 08 Skills. The older planning pages stay at `/atomik/ideas`, `/atomik/treatment`, `/atomik/breakdown` and `/atomik/shots` (Ideas, Treatment, Breakdown, Shot list). Plus the workflow map artboard, which is a product map and not a UI.

Per surface, state which of the three layouts it supports and what the mobile version is: full, read-only summary, or absent. A surface with no declared mobile behaviour ships broken on a phone.

---

## 13. How to work

**4 October 2026.** The amendment's working rules for Claude Code (its §9) apply as well: plan first, one branch per PR in its own worktree, never push to main, never merge.

1. Confirm or correct every assumption in sections 2 and 5 against the code before changing anything. Specifically: where keys live, whether `workspace_id` is on every table, whether the metering layer exists and **which call paths bypass it**, how Atomik shares auth and data, and what "its own database" means in the schema. Report back.
2. Resolve the two open decisions in section 4 (theme — and note that dark is the convention for desktop suites) and section 9 (graph geometry). Pricing is decided in 7A — implement it as written; the margin table, plans, packs and guardrails are config-driven, so a pricing change is a setting, not code.
3. Phase order: finish Phase 0 → 1.0 → 1.1 → the rest of Phase 1 → Phase 2 (2.1 and 2.2 first, they're what a paying team feels) → Phase 3 → Phase 4 → Phase 5. Two things from Phase 4 can jump the queue because everything after them gets easier: the ⌘K command palette (4.2) and resizable persisted panes (4.1).
4. For anything schema-touching, summarise what changed as a diff against this document and update it. A scope of work that drifts from the code is worse than none.
5. Each PR states: what it costs a workspace to use, how it's mocked in tests, what changed in the prompt compiler, and where the new code is workspace-scoped.
6. Every mobile change keeps the Phase 0 suite green.
7. Where a decision gets built on by later sections — schemas, ledgers, scoping, inheritance, sync — give two or three structures, argue against your preferred one, and name what breaks. Don't write code until it's agreed.
8. Any task that would spend real money on an engine: stop and ask.

---

## 14. Built — state of the code, 10 September 2026

Appended, not part of the master as handed over: the master is written as a
plan, and a plan that does not say what already exists sends the next session
to rebuild it. Everything below is in `main` and deployed. Delete this section
whenever the master is reissued with the same facts folded in.

**§4 theme — no longer open. particl is dark; there is no appearance setting.**
Decided and shipped 10 September, after §4's own note asked for it to be
settled before Rig work. Not "dark by default": Auto and Light are gone from
the product, the `prefers-color-scheme` query is gone from the stylesheet, and
nothing is stamped on `<html>`. The paper ground is a route list —
`lib/ground.ts`, read by the shell and by the command palette — holding
atomik's stages and the statement page, which is a document before it is a
screen. `app/global-error.tsx` is written out dark because it renders when the
stylesheet never arrived. The rule that made this a default change rather than
a rework still stands and is now the only thing holding the theme together:
**no component hard-codes a colour; a literal hex in one is a bug.** Guarded at
`tests/desktop.spec.ts` by emulating a light machine.

**§5 bindings — a shot overrides one attribute without leaving the element.**
`bindings UNIQUE (shot_id, slot, ordinal)` could not represent the handoff's
own sentence: one slot held one row, so pinning WARDROBE replaced the bundle,
`portsForShot` emitted a single port, and the shot stopped citing the
character's face, hair and voice. Three shapes were put up; the key was
widened, so a bundle row and an override row coexist.

**§10 4.1 — panes resize and stay put.** Four surfaces carry a seam: the
composer rail, the canvas shot rail, Studio's rail and the shot builder's,
each with its own default and stops (`lib/panes.ts`). The seam is a
`role="separator"` with a live `aria-valuenow`. Widths are per browser and
clamped to the window as well as the spec, so a split chosen on a 27" display
cannot swallow a laptop.

**§10 4.2 — the command palette, the shortcut registry and the `?` overlay.**
`lib/shortcuts.ts` is the table as data, because 5.1 says the Mac menus carry
every shortcut and a menu can only carry what it can enumerate. Rows marked
`owner: "global"` are handled in `CommandPalette.tsx`; the rest record which
component owns the key. `?` reads the table, so a shortcut becomes
discoverable the moment its row is added. Eight rows are live, nine planned.

**§10 4.3 — the player, the filmstrip and comparison.** Theatre draws its own
transport on desktop (frame-stepped scrub, timecode, loop, mute, position read
every animation frame); the phone keeps the native bar, which carries
fullscreen and picture-in-picture. The filmstrip is every take on the shot,
oldest version first, derived from rows the browser already holds, and the
arrows walk it when it is on screen. Compare elects the longest take as the
clock and corrects the others past 125ms, rather than commanding every clip to
play and trusting them. **One frame rate: 24, decided 9 September.**

**Historical September 10 selects-route change (superseded for the workbench by the September 13 amendment).** That note used to end "no EDL export — not wanted" while an EDL export was in
fact being served, which the drift audit caught. **It is now gone for real,
10 September:** `edl()` and the `tc()` timecode helper are out of
`lib/selects.ts`, `?format=edl` is off the selects route, the file is out of
the zip, and the `EDL ↓` link is off the production page. The handover is the
masters and the shot list.

**§7A margin — done, 10 September.** `lib/creditTerms.ts` carried a per-engine
table dated 6 September, and every price it produced disagreed with §7A's rate
card, so the card and the buttons disagreed. The card is right. The table is now a single
`"*"` entry and stays keyed by engine, which is what §7A asks for, so pricing
one engine differently is a key added here, not a refactor. A test asserts the
published card line by line.

Two things the change exposed, fixed with it. `lib/creditSql.ts` built
`CASE model … ELSE … END` from the engine keys and emitted an **empty CASE** —
a SQL syntax error — once there were none; that expression is inlined into the
usage, admin and statement queries, so a one-entry table took all three down.
And `lib/held.ts` compared a take's **stored** estimate against the balance
while billing it at the current rate, so a take held at the old price would
release as soon as the balance covered it and then charge the new one. `needs` is
re-derived at release now.

**§7A ledger — the grant knows whether it was bought, 10 September.**
`credit_grants` recorded an amount and a note, so the platform could not tell
a credit it had sold from one it had given away — and the welcome grant goes
in through the same table, so a workspace spending its free credits reported
them as revenue on the admin console. Measured on the live local record after
the migration: **500 credits bought against 7,574 given**, a funded share of
0.06 where `marginUsd` had been assuming 1.0.

`kind` is `purchase | bonus | welcome | manual`, and only `purchase` is paid.
`grantCredits` takes it with no default, so a caller that has not decided does
not compile. `marginUsd` multiplies by `fundedFraction`, which apportions —
which credits a job spent is unknowable without dated lots drawn in order, and
those are deliberately not built (expiry is later, decided 10 September).
Apportioning differs from draw-order only in timing, so it is unbiased over a
workspace's life and wrong only about which month.

The migration is `NOT NULL DEFAULT 'manual'`, ALTERed in the migration block
rather than the schema array — that array replays FIRST, so anything naming a
new column belongs after it — and classified inside the same `try`, because
the ALTER succeeding is the one moment the database gains the column and
`platformReady` is memoised per process, not per deployment.

**The default is load-bearing, and it was exercised by accident.** A grant
written by an instance still running the old code against an already-migrated
database lands on the default. That happened here — a welcome grant written
during a branch switch came out `manual`, not `welcome` — and it is exactly
the window a rolling deploy opens. It is harmless because `manual` is unpaid:
the classification is imprecise, the funded share is not. Getting that
direction right is why the default is `manual` and not `purchase`.

**§7A packs — done, 10 September.** The four packs, priced as bought credits at
the unit rate ($50 / $200 / $500 / $2,000), with the discount as bonus credits
capped at 20% and granted as their own free `bonus` row. Approving a pack
writes both grants in one transaction, because the request is already marked
approved by the time either runs. `capBonus` is applied on the way out of the
database as well as in, since the number that reaches a grant is the one
frozen on the row.

**NEXT, AND FIRST: credit expiry and the billing cycle.** No longer deferred —
decided 10 September, because §7A's tiers cannot be built without it and the
reason is arithmetic rather than preference. Balance today is
`Σ credit_grants.credits − Σ meter_events.billed_credits` with **no date
filter anywhere** (`lib/credits.ts`, `lib/platform.ts` `creditsGranted`,
`lib/meter.ts` `creditsUsed`). Deliver a plan's monthly credits the obvious
way, as a grant row, and three idle cycles leave a Studio subscriber holding
1,200 credits: §7A's "no rollover" breaks on day 31 with nobody having written
a line of expiry code. Three independent designs were put up to avoid it and
all three were rejected; the one that escaped did so by refusing to put
credits in a plan at all, which satisfies none of §7A's four rows.

What it needs, from the mapping: a per-workspace cycle anchor (the code knows
only the UTC calendar month, computed inline in two places and never stored),
dated lots with a draw order (`lib/creditTerms.ts` currently records that draw
order is deliberately NOT built), and included-versus-purchased attribution at
SPEND time for guardrail 5 — `meter_events.billed_credits` is one number with
no source on it.

**Then plans**, credits-only, on top of that. Then guardrails 1, 3 and 4.

**BUILT — the cycle, 10 September.** `lib/cycle.ts`. The code knew one period,
the UTC calendar month, and worked it out inline in two files that cannot see
each other (`platformSpendThisMonth` walking a mutable Date back to the 1st,
`monthRange` building one from a string). They agreed by both being right
rather than by construction, and "expires at cycle end" is a rule about a
boundary. Both callers now take it from one function; anchored on the 1st a
cycle IS the calendar month, which is what the tests prove against the
replaced arithmetic rather than assert.

The anchor is a DAY, not a date, because a month-end anchor has to be the 28th
in February and the 31st again in March, and a stored date remembers only what
it was clamped to. `expires_at`, `drawn` and a `cycle_anchor` column are
deliberately NOT in that change: each belongs to one of the three competing
draw structures, two of which were rejected outright, and an unread column is
the same mistake as an unread function.

**Not built, and named here so it is not assumed:** §7A's plans/tiers, the
private policy's floor guard, the `internal: true` pricing override, guardrails
1 and 3–6; invoicing;
recurring billing of any kind (`startCheckout` throws for anything but
`manual`, so a $49/mo plan today is an admin remembering every month); panel
allowances and the §2.8 board pipeline they would count.

Guardrail 4's line now has one source, `lib/approvalRule.ts`. Since 2 October
2026 Atomik's Rig runs use it as the most one job may cost without asking
(§9); nothing else enforces it yet.
# September 2026 amendment: durable published-context pipelines

The additive pipeline executor introduces immutable versioned DAGs and private creator-owned runs from an explicit published production context. It never publishes a private draft. Each ready image/video/audio stage receives a batch quote and explicit approval; later stages require their own approval after inputs resolve. Permanent attempt keys, CAS revisions, fenced leases, and a persisted wakeup outbox prevent lost responses from creating replacement spend. Review selections become fixed once downstream attempts depend on them. Assembly produces an editorial timeline for the existing browser movie renderer, not a falsely completed movie. New tables and the full limits/recovery contract are documented in `docs/durable-production-pipelines.md`; historical recipes and runs remain compatible. This amendment does not introduce Stripe changes.


### 14 September 2026 — complete screenplay source import

Studio Script now accepts complete PDF, TXT and Fountain screenplays. The original file is a durable scoped asset; PDF page boundaries, scene numbering, reviewed intent and beat notes survive private saves and explicit bible publication. PDF extraction is local, bounded to 20 MB / 400 pages / one million characters, with explicit incomplete-page review and no silent truncation. Canvas selection replaces the old first-60-scenes behavior and enforces the remaining 250-node capacity as an all-or-nothing operation. Each selected scene can open the existing quoted Atomik shot-coverage flow with its complete source. See `docs/screenplay-import.md` for validation and limits. OCR and automatic whole-feature AI analysis remain separate work; no pricing or Stripe behavior changes.

### 14 September 2026 — Topaz image upscaling

Gen/Images gains Topaz precision upscaling from uploaded or generated originals. Standard V2, High Fidelity V2, Low Resolution V2, CGI and Text Refine offer 1×/2×/4× with optional face strength; creative face reconstruction remains zero. Original PNG/JPEG/WebP inputs are capped at 30 MB and outputs at 48 MP/16,384 pixels per side. Transparent or animated sources require a flattened still first.

The server inspects original dimensions, derives the output band, and binds source/settings/price in the existing quote and credit-reservation flow. The existing credit terms quote 2 cr up to 24 MP and 3 cr up to 48 MP. No plan or pack changes. A durable provider handle, per-job reconciliation lease, retained original, new reusable output and idempotent settlement support interrupted jobs. Details and verification limits: `docs/topaz-image-upscale.md`. Astra 2 video pricing/output controls remain a separate follow-up; image models are not branded Astra. No paid provider rehearsal is claimed.

### 14 September 2026 — saved sound mix and transport

Edit & sound now uses saved, asset-bound sound clips with frame timing, source trims, gain, pan, fades and mute/solo. Prepared playback follows the timeline, and the same mixer feeds final movies and 48 kHz stereo 24-bit PCM / 32-bit float WAV downloads. Audio source lineage accompanies the editorial package. The exact bounds and remaining professional audio requirements are in `docs/sound-mix.md`; this is not a long-form or mastering release. Stripe and the approved credit model are unchanged.

## September 14 amendment — Astra 2 output controls and reconciliation

Gen now has a dedicated Astra 2 video-upscale panel with original uploaded/generated sources, explicit 30/60 fps, creativity, realism and sharpness. Quotes inspect original track metadata and reserve the 4K rate rather than assuming that the provider obeys a requested 1080p size. Saved results retain measured output metadata and reconcile lower costs; over-budget output remains pending reconciliation without another paid request. Unsent legacy requests need a fresh quote, while existing paid claims and handles are preserved. See `docs/astra-video-upscale.md` for exact limits and remaining live-provider validation. The subscription tiers, credit formula and deferred Stripe scope are unchanged.

### 14 September 2026 — sequence color and imported LUTs

Edit gains a sequence color inspector, original .cube asset import/reuse, saved mix/bypass and display-referred brightness/contrast/saturation. Preview and final movie use one GPU trilinear processor; editorial packages retain LUT bytes and settings. The loader supports standalone 3D tables with 2–65 points and bounded 16 MB UTF-8 files. This is a sequence-wide SDR/8-bit workflow with explicit limits, not automatic log/ACES/HDR conversion or mastering. Official ARRI/Sony sourcing guidance and the pixel-level verification contract are in `docs/sequence-color.md`. Original assets, Stripe behavior and approved commercial pricing are unchanged.

### 14 September 2026 — workspace sign-in policy

Owners can require authenticator enrollment for workspace members through People. Enrollment gates private requests and server-rendered workspace pages, preserves account security and workspace switching, and checks existing API-token standing. Fresh owner password/factor checks, protection against disabling a required factor and transactional security history prevent policy changes from stranding an unenrolled owner. Existing workspaces remain optional until an owner enables their policy. See `docs/workspace-security-policy.md` for verification, previously authorized work, recovery-code behavior and the remaining SSO/passkey/SCIM scope. No customer policy, provider spend, email or Stripe configuration is changed by the release rehearsal.


## Editorial continuity — 15 September 2026

Private productions now retain named asset bins and immutable named cuts. The editor captures acknowledged saved revisions, retains original media and source lineage, and saves a safety cut before restoring a non-empty edit. The existing draft, request-scope, tenant, MFA and recovery protections apply throughout. See [editorial history](editorial-history.md) for verification, retention limits, restore conflicts and current export boundaries. Stripe and the approved credit model are unchanged.

### September 27 amendment — failure outcome reporting

Failed generations retain an additive `provider_outcome` record on the tenant's generation row and the platform meter event. Connected jobs retain the same optional record in their tenant database. Existing rows remain valid without one. This is reporting only: admission, reservations and settlement rules are unchanged.

Customer takes show the recorded Particl credit charge when available. Provider diagnostics for platform-funded work remain restricted to the platform administrator. Missing provider evidence remains unknown; token usage is not treated as a billing receipt. Connected-account transaction reconciliation is not enabled, and since 2 October 2026 no new connected job starts (ground rule 10). Failed takes retain their reason and can be reviewed without triggering another generation.

### September 27 — separately approved draft and final takes

Gen gains a watermarked draft and separately quoted final through the existing video admission, worker and ledger. The final inherits its original draft context; a transactional claim, expiry check and settle-first recovery prevent duplicate or stale submissions. Gen, Takes, Library and the inspector retain the pair. No pricing rule changes. See [draft-to-final behavior](seedance-draft-final.md) for boundaries and validation.

### 2 October 2026 — Higgsfield work on the API key only

The Higgsfield sign-in features are off (ground rule 10). An account route that would price, start or build work refuses it with one plain sentence. Past results stay in the Library and Takes, with their original files and charge lines. Jobs that were already running on the account are still collected; while the account's grant is held, Workspace › Engines lists them and offers Disconnect.

Viral (Motion Transfer, Object Swap and History) and Business › Image ads run on Particl's API key for every workspace and every member. Each take is priced first ("about N cr"), sent once with that figure as its ceiling, and charged in workspace credits. Image ads offers Marketing Studio Image 2.0 Alpha, 2.5 Flare and 2.5 Sunburst; a 2.5 take is settled on the delivered image. Viral's History and Atomik's Compare plan read the project's Library, so runs made earlier on the account stay readable. No workspace plan calls an account route.
