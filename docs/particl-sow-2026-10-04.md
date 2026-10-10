# Particl: build SOW for Claude Code

> **Correction, 10 Oct 2026 (Inngest Cloud, not self-hosted).** Production's background work runs on **Inngest Cloud**, which calls the app at `https://particl.si/api/inngest` (`DISPATCH_MODE=inngest`, `INNGEST_SERVE_ORIGIN=https://particl.si`, `INNGEST_STREAMING=true`, `INNGEST_BASE_URL` unset), as `docs/selfhost-test.md` (8 Oct) set it up and the live settings confirmed on 10 Oct. Where this file plans a **self-hosted** Inngest (an internal `--sdk-url`, `INNGEST_BASE_URL` at an internal address), that plan was not carried out. `WORKER_ORIGIN` (127.0.0.1:3000) was never built: in the native-dispatch fallback the app calls its own `/api/worker` through the public `APP_ORIGIN`.

Amendment of 4 October 2026, written for Claude Code. Read it in full before any work, then `CLAUDE.md`.

It amends `docs/particl-sow-v1.md`. Where the two disagree, this file wins until the first PR (§9.1) folds it in. The owner keeps a planning copy, "Particl: scope of work…", in a Claude doc with a Scope tab and a Runbook tab; package names here (D0, U1, S1, A1, E1…) match it, and the Runbook holds a ready prompt for each package.

---

## 1. What Particl is, and what changed

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

## 2. Ground rules 11 to 17 (add to `CLAUDE.md` after rule 10)

**11. Every feature is agentic.** A feature ships as a tool in the registry (A1) before it gets a button. The button, Make, a board card, Atomik, a saved skill and an outside agent over MCP all call the same tool, at the same price, through the same approval gate. Each tool has a mocked test proving the agent can run it. Every screen that offers a feature also lets the person ask Atomik to do it; when Atomik fills a form, the fields visibly fill before anything is pressed. A few actions belong to people alone: approving spend, setting spend limits and the budget ceiling, topping up, approving a post, and recording consent for a real person's face or voice. Atomik and outside agents can prepare and explain these, never take them (rule 14).

**12. One board.** Productions, ad campaigns and social projects live on one board engine: the Rig's team canvas, extended in S1. New project work is a card kind, a group or a skill on that board, never a new page.

**13. Easy by default.**
- Auto is the default for agent, model, engine and settings, shown as one line with a Change link (for example "Seedance 2.5 · 1080p · 5 s · 43 cr · Change"). Advanced settings live folded in the Inspector.
- What the brief sets (aspect, frame rate, look, cast) carries into every shot and is not asked again.
- One primary button per screen, and it is the next step.
- Everything saves itself. No "save first" errors; today's live in `components/workbench/AtomikRunDialog.tsx`, `SoulIdentityPanel.tsx` and `Studio.tsx`.
- Undo instead of confirmation dialogs (nothing is ever erased already).
- Plain words in the UI (names in §3). Cut any sentence the screen could show instead (rule 9).

**14. Money without anxiety.**
- Prices read `N cr`, `up to N cr` (a live estimate) or `free`. Never the bare word "quoted". Hovering a price shows its dollar value at the public $0.10 a credit. Prices come only from the rate card (CLAUDE.md § Pricing, through the server's price path); every price in a design is a sample.
- Only a person approves spending. Atomik and outside agents can prepare, price and explain an approval, never grant one; an approval written by `agent:*` or an MCP caller is refused. When a person tells Atomik in words to approve ("approve everything under 10 cr"), Atomik lists exactly what that covers and its total, and the person confirms with one tap.
- A plan is approved once: one tap approves its listed steps at their listed prices, up to its total, including a stated fix allowance (at most two fixes per shot). Anything outside it (a new shot, a fix past the allowance, another engine) asks again. A plan's approval follows the workspace's rule in `lib/approvalRule.ts`: a step over the rule's cap needs an admin, and the plan card says which steps need whom.
- Outside a plan, every paid step asks, unless the workspace allows spending without asking. Today's Ask and Auto modes (`lib/workbench/rig-agent-limits.ts`) become that setting: Ask is the default; in Auto, a draft priced at or under the per-job line runs without a tap. A job above guardrail 4 (`JOB_APPROVAL_LINE_USD`, 200 cr at $0.10) never runs without a tap. Only an admin changes the setting or the budget ceiling.
- Atomik's own thinking (questions, the plan, review notes) is billed as the planning turn is today in `lib/workbench/rig-agent.ts`: reserved against a limit the person approves when asking, settled at what it used, and not billed when nothing came back. Decision 7 in §10 may change this.
- The balance is checked against a plan's total before it starts, with Top up offered then, never halfway through.
- A failed step that cost nothing says "Nothing billed" and offers Retry, which re-runs it under the same approval; a failed step that was charged says what it cost.

**15. Readable dark.** Text people read is at least 12 px and at least 55% white on black (about 6:1; WCAG AA asks 4.5:1). Fainter text is for disabled things only. Focus rings are always visible. Touch targets are at least 44 px on phones. Separate areas with space and hairlines, not grey boxes.

**16. No Higgsfield sign-in.** Restates rule 10 for all new work: every replacement in §5.3 runs on a provider API key, and anything on Higgsfield runs on its API key (`api.higgsfield.ai`, with `HF_API_KEY_ID` and `HF_API_KEY_SECRET` or `HF_CREDENTIALS`). A PR that adds or keeps a Higgsfield tool names its endpoint. A tool that would need a Higgsfield account is not built.

**17. Measure ease.** The five-minute rule (rule 6) becomes a Playwright test, landed as U1's first PR and run on every UI PR after it: a new person with an invite reaches an approved first render. The product records time to first render, approvals per session and where people stop, as ids and timings only, never prompt text.

---

## 3. Product shape after the next handoff

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

## 4. Architecture

### 4.1 The board (S1): extend, don't rebuild

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

### 4.2 The agent on the board (S2)

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

### 4.3 The tool registry (A1): the agentic backbone

- Two kinds of tool. Engine tools are generated from `lib/models.ts` and the task and still-tool tables, never a second hand-kept list. App actions (board operations, Stop, Retry, approve, publish, record consent and the rest) are declared in code beside their handlers. Per tool: id, kind, inputs and limits, provider, the key it needs, its price function (free for most app actions), its mock, and who may call it: anyone, people only (rule 11) or admins only.
- One paid path for everything: quote → approval → durable claim → poll → collect. A tool that cannot be priced is listed as unavailable, with the reason, and cannot run.
- Consumers: buttons, Make, board cards, Atomik, skills, and MCP. `lib/mcp.ts` is hand-written today and routes tools through the app's own HTTP API with the caller's token; keep that design. Adopt `@modelcontextprotocol/sdk` only where it removes code.
- A test per tool: it has a price, a mock, and the agent can run it; an unapproved run spends nothing; a tool without its key names that key.

### 4.4 Words and money in the UI (U1)

- The names in §3 throughout the UI, copy cut to what the screen cannot show.
- Price display per rule 14. Estimates are fetched when a control becomes visible or focused and cached briefly; the server price stays the truth.
- Plan approval with its fix allowance, the spend-without-asking setting (Ask or Auto), the balance check before a plan, and "Nothing billed" with Retry.

### 4.5 Platform services

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

## 5. Third-party catalogue

Every model goes in through the same door: a price verified from the provider's page or live estimate, a mocked test, then one paid qualification run in the internal workspace after the owner's yes. No model call goes through Vercel AI Gateway (P4b removes it).

### 5.1 Models and services

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

### 5.2 Open-source libraries

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

### 5.3 Every Higgsfield sign-in feature and what replaces it

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

## 6. The design round, and importing the handoff

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

## 7. Packages and order

Status on 4 October. Tracks run side by side where they don't share files. PRs merge one at a time, after the owner checks each Vercel preview.

### Track A: Platform

| ID | Delivers | Needs | Status |
|---|---|---|---|
| P2 | Server finished: Coolify keys saved, origin certificate, coolify.particl.si, the GitHub App, Cloudflare-only firewall, real visitor addresses, outside monitor, VPS snapshots | P1 | In progress |
| P3 | R2 switched on; media.particl.si with signed links, thumbnails and posters | P1 | Not started |
| P4b | Every model on its own provider's API; Vercel AI Gateway removed; a pinned, tested price list | none | Not started |
| P4 | Docker under Coolify; self-hosted Inngest sized for 1,000 jobs with per-plan limits; tested at staging.particl.si | P2, P3 | Not started |
| P5 | particl.si's DNS to the VPS; particl.app redirected in Cloudflare; cron moved; rollback ready; Blob retired after two weeks | P4 | Not started |

Payments package (card checkout, wired at the very end, as its own package):
- Stripe (or another provider) is connected last. Until then packs stay requests approved in /admin (`lib/payments.ts` is `manual`).
- The credits a payment grants always come from `CREDIT_USD`: credits = amount paid ÷ `CREDIT_USD` (for example $50 → 500 cr at $0.10). Never a number typed into Stripe's products or metadata, and never a figure written in the code.

P4 and P5 notes (5 October):
- Staging shares the live database: no paid work there until the credit switchover is done on Vercel.
- When cleaning Vercel's settings for the VPS, keep `VERCEL_TOKEN`, `VERCEL_TEAM_ID` and `VERCEL_PROJECT_ID`: 3D blocking's Blender renders still run in Vercel Sandbox.
- Before P5, rework every paid route that can run past Cloudflare's 125-second limit before its response starts (202 and finish in the background, stream, or cap the work).

| P8 | Worker container; load test to 1,000 jobs; GlitchTip; Langfuse; legacy guard | P5 | Not started |

P4/P5 checklist, the price of a credit (owner, 5 October 2026): CREDIT_USD=0.10 must be set on Coolify before particl.si's DNS moves, and the database copied there must be the already-converted one. The conversion (`POST /api/admin/credit-unit`, `lib/creditConversion.ts`) runs once, on Vercel, before the move; a ledger whose unit differs from CREDIT_USD pauses paid work (`lib/ledgerUnit.ts`).

### Track B: Design system, shell and ease

| ID | Delivers | Needs | Status |
|---|---|---|---|
| D0 | 1a to 2: old design out, one token set, removals and renames (in review). PR 3: the shell from the new handoff with the chosen header. PR 4: dropped (Studio becomes the board). PR 5: Make (was Gen) from the new handoff. PR 6: everything else on the tokens | the new handoff for 3, 5, 6 | In progress |
| U1 | Ease of use: autosave and no "save first" errors; Auto defaults with the one-line engine summary; the names in §3; price display and live "up to" estimates; one approval per plan, the spend-without-asking setting (Ask or Auto), the balance check, "Nothing billed" with Retry; review mode (keyboard), compare, phone swipe; "Notify me when done"; Home with templates and the sample production; "Ask Atomik how"; the five-minute Playwright test (its first PR) and ease metrics | D0 PR 3, A1, the new handoff | Not started |
| D1 | Atomik's control room (Approvals, Activity, Skills, Memory), Settings in five sections, and the phone screens (D1 owns them; U1's review mode supplies the swipe), from the new handoff. Its last PR retires each old shell in `docs/old-shells.md` whose new page is live, redirecting the old route there; the rest retire with the package that replaces them | D0, U1 | Not started |

### Track C: The board and the agent

| ID | Delivers | Needs | Status |
|---|---|---|---|
| S1 | Board backend (§4.1) | D0 PR 2 before it merges (planning starts now) | Starting |
| P6b | Verify and master locking wired into the agent | none | Not started |
| S2 | Atomik on the board, built on LangGraph (§4.2) | S1, P6b, A1 | Not started |
| S3 | Studio drawn as the board on React Flow, 1:1 with the new handoff: cards, groups, toolbar, docked agent panel, Inspector, regions, minimap, list view; on a phone the board opens in D1's screens (approvals and takes); old Studio links open the matching region; the ten stage pages retire one week after the board goes live | S1, S2, the new handoff | Not started |
| S4 | Ads as a campaign board, with the poster Designer opening from a card; Social's quick tools plus a clips board; Crew review on any board; every board connected to D1's control room | S3, E8, E9, and A2 for its skills | Not started |
| C2 | Search by meaning across the board and the Library, embeddings in each workspace's own database | P4b | Not started |

P6a (React Flow) is done inside S3. P6c (LangGraph) is done inside S2. C1 is S1 plus S3. C3 and C4 become cards in S3 and S4.

### Track D: The agentic platform and engines

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
| Review | `docs/particl-sow-v1.md` and this file updated to what shipped | everything | Not started |

### Sequence

The owner's estimate for two people: the full scope by 26 February 2027.

1. Now: D0 PRs 1a to 2 (review and merge), P2, P4b then A1, and S1, while the owner runs the design round.
2. When the new handoff lands: the handoff PR and diff (§6), then D0 PRs 3, 5 and 6; P3 and P4 alongside.
3. From the cutover (P5 and its two weeks of watching): U1, then D1; E1 and E2, then E4 and E5.
4. Then: P8, then E3; P6b, E6 and S2.
5. Across the year-end break: E7, then E8 and E9; S3, then C2.
6. Then: A2, with S4 alongside it, taking each skill as it lands; A4 after A2.
7. Last: Review.

---

## 8. Done, for the whole programme

- The five-minute test passes for a new person on desktop and on a phone.
- One real production runs from brief to an approved cut on the board; every paid step was approved at its quoted price, and the ledger matches.
- Every registry tool is reachable by Atomik, a skill and MCP at the same price and through the same gate as its button; every engine in §5.1 is also reachable from Make and a board card; a test proves each. Actions that belong to people (rule 11) stay theirs, and a test proves an agent cannot take them.
- No UI text says Moleculr, Subatomik, Rig, Genjutsu, Soul or Higgsfield, and "Astra" appears only as Topaz's model name ("Topaz Astra"), never for 3D blocking.
- Nothing needs a Higgsfield sign-in.
- The contrast and size minimums pass an automated check on every screen.
- The VPS runs 1,000 jobs at once without slowing pages (P8's load test).

---

## 9. Working rules for Claude Code

1. **First PR, docs only:** fold this amendment into `docs/particl-sow-v1.md`; add ground rules 11 to 17 to `CLAUDE.md` after rule 10; keep this file as `docs/particl-sow-2026-10-04.md` for the record.
2. **Plan first** for every package. The owner reviews the plan before any code.
3. **One branch per PR**, off main, in its own worktree. Never push to main. Never merge. One concern per PR, small.
4. **Every UI PR:** Playwright at 360×640, 390×844, 844×390, 1440×900 and 1920×1080 with no horizontal overflow; the five-minute test (rule 17) once U1's first PR has landed it; screenshots beside the handoff. The owner checks the Vercel preview before merging, because main deploys straight to particl.si.
5. **Money:** engines mocked in tests (`ENGINE_MOCK=1`). A paid qualification run only in the internal workspace, only after the owner's yes, with its cost stated first. Never a real generation on a customer workspace (rule 1). Prices only from the rate-card path; never invent a figure.
6. **Tenant isolation** on every query, storage path and signed URL (rule 2).
7. **Secrets** only in Vercel and Coolify settings; never in code, logs, model prompts or chat. Never rotate `KEYRING_SECRET` without a re-encryption script.
8. **Agentic first** (rule 11): a feature's registry tool and its agent test land before or with its button.
9. **Keep the SOW true:** update `docs/particl-sow-v1.md` when a change makes it wrong.
10. **One model per package**, as the Runbook's prompt for it says: Fable at high effort for D0, A1 and S2; Opus at high effort for S1, S3, S4, U1, P6b and the platform packages; opusplan at medium for the engine packages, D1, C2, A2 and A4. Whatever the package, a plan that changes the approval path, a price function, sign-in or tenant separation is written at high effort on Opus or Fable, and the owner reviews it before any code.

---

## 10. Open decisions for the owner

1. Header option A or B (design round, step 2).
2. Cinema Studio 4.0 stays in Make, without the Higgsfield name (the owner's answer in D0 PR 2); it runs on the API key. Still open: how its price reads. Its quote is approximate and the take settles at 0.5 to 3 times it (`lib/cinemaStudio.ts`), so an honest "up to" is three times the quote. Either show "about N cr, at most 3N cr" and approve the 3N figure, or remove it.
3. The final UI names (§3), confirmed in the design round.
4. The spend-without-asking default. Today every paid step asks (Ask), and in Auto a draft at or under the per-job line runs without a tap; that line is guardrail 4, 200 cr (the owner's decision of 29 September). Suggested: Ask stays the default; admins can switch a workspace to Auto, with a lower line if they choose.
5. The sample production's content: invented and neutral, approved by the owner before it ships.
6. Whether to make the repository private before P4.
7. Whether Atomik's thinking costs credits. Today the planning turn is billed within a limit the person approves when asking (rule 14). Keep that, shown as one line under "What are we making?" ("Atomik's thinking: up to N cr"), or make thinking free up to a daily cap per workspace, with the cost carried by the margin.
