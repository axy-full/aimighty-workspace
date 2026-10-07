# Particl: master scope of work, v2 (6 October 2026)

Owner: Akshay. Repo: `axy-full/aimighty-workspace` (public). Live site: particl.si (Vercel).
This file replaces the order of work in `docs/handover-2026-10-05.md` Part B § B7. Everything else in that handover (rules, architecture B4, catalogue B5, platform runbook Part C, package prompts Part D) still applies unless this file changes it. Commit it as `docs/particl-sow.md` (no secrets, public repo).

---

## 0. How we work (applies to every phase)

**Reporting**
- One **integration preview** link that always shows the latest build of everything in progress.
- Reports at **09:00 and 21:00 IST**: the preview link, what changed, what's visible where, what's waiting on the owner. Nothing "coming" without a time.
- `docs/status-now.md` kept current; push at least hourly.
- Warn the owner **before** a usage limit stops work.

**Merging**
- Never push to `main`. One concern per PR. `main` deploys straight to particl.si.
- UI merges only after the owner's preview check. Money, sign-in, tenant separation, secrets, env vars, DNS and migrations wait for the owner's explicit yes, after the independent reviewer passes.
- Agents never run `git checkout -- <path>`, `git restore`, `git reset --hard` or `git clean` (enforced in `.claude/settings.json`). WIP commit first.

**Money (CLAUDE.md § Pricing is the only source)**
- 1 credit = **$0.10** (`CREDIT_USD`). Rate card: Seedance 2.5 1080p 5 s **43 cr**; Kling 3.0 Std 5 s **7**; Nano Banana Pro **3**; Nano Banana 2 **1**; Topaz **23 / 38**; identity **54**; enhance **1**.
- Plans: Invite $0 / 250 cr once; Studio $49 / 400; Agency $199 / 1,600; Production $999 / 9,000. Pack: Starter $50 / 500.
- Only a person approves spending. Agents and MCP callers prepare and quote, never approve. Approval line $20 = 200 cr. Ask is the default; Auto runs only drafts at or under the per-job line.
- A plan is approved once, up to its total, including a fix allowance of 2 × the plan's shot prices (at most two fixes per shot).
- Every button that spends shows its price in credits. Cinema Studio shows "about N cr, at most 3N cr" and holds 3N (only once #540 is merged; hidden until then).
- No real generation on customer workspaces or previews. Paid runs only in the internal workspace or "Particl sample", with the owner's yes per step.
- Rollback rule: never Instant Rollback to a deployment from before #524.

**Design**
- One design only: `design/particl-graphite/` and `app/graphite.css`. A screen the handoff lacks is drawn in Claude Design first; never invented in code.
- No invented names in anything that ships. No UI text says Moleculr, Subatomik, Rig, Genjutsu, Soul or Higgsfield; "Astra" only as Topaz's model name. CI fails on any of them, and on any spending button without a price.
- Text ≥ 12 px and ≥ 55% white; phone touch targets ≥ 44 px; Playwright at 360×640, 390×844, 844×390, 1440×900, 1920×1080.

**Agentic rule (rule 11)**
- Every feature is a tool in the registry (A1) before it is a button. Button, Make, board card, Atomik, skill and MCP call the same tool, at the same price, through the same approval. Each tool has a mock and a test proving Atomik can run it.
- People-only actions: approving spend, setting limits and the budget, topping up, approving a post, recording consent for a face or voice.

**Capacity**
- Up to 6 agents (5 while running on the owner's laptop). Opus/Fable at high effort only for money, approvals, sign-in and tenant separation; Sonnet for the rest.

**Secrets**
- Only in Vercel (and Coolify after P5). Never in code, logs, PRs, prompts or chat. The owner sets every key.

---

## 1. Where we are (6 October)

**Done and live**
- $0.10 credit live (#524, #529); nothing needed converting.
- Clean slate (#528), React Flow dependency (#526), git deny rules (#531), dependency fix (#541).
- Design handoff in `design/particl-graphite/` (#509); round-2 master with the guest Home on `design/master-round-2` (unmerged, docs only).

**Built on branches, not yet seen by the owner**
- `demo/s02-home`, `s03-board-canvas`, `s04-board-cards-plan`, `s05-board-cards-shots`, `s06-make`, `s07-atomik`, `s08-control-room`, `s09-settings`, `s10-phone`, `s11-ads-social`, `s12-sample`, `demo/board-everyone`, `demo/integration`.
- D0 chain #511 → #513 → #512 → #514 → #515, with the owner's 13 fixes in progress.
- Guest Home (`site/guest-home`), autosave, Make short form.

**Not started**
- The agentic core (A1, S1, P6b, S2), engines E1–E9, skills A2/A4, C2, the VPS move P3–P8, Remotion, payments.

---

## 2. Phase 1: Release 1, "New Particl" (the fresh design)

**Goal:** particl.si shows the new design for everyone, in one release. Integration preview **today by 18:00 IST**; owner review Wed 7 Oct; **merge Thu 8 Oct**; investor demo **Fri 9 Oct**.

**Scope**
1. **Shell (D0, fixes only):** header B (Home · project · Make · Atomik, ⌘K, Jobs, credits, avatar); avatar menu with name and "workspace · role"; ⌘K listing exactly the design's items; right-click prices and Delete-to-trash with Undo; phone bar Home · Record · Make · Atomik on every phone screen (hidden only on full-screen review and plan approval); pricing-page nav and sign-in fixed ("Request access", no "Create a workspace"). No more work on pages the board deletes.
2. **Home:** "What are we making?", templates (Film, Ad campaign, Social clips, Start from a script), projects with what needs you, "Waiting for you" with priced buttons, the sample production.
3. **The board on the canvas, for everyone (no switch):** Studio rail Brief · Looks · Storyboard · Shots · Cast · Cut · Deliver; Ads rail Brand · Product · Hooks · Formats · Ads · Adapt · Deliver; Social rail Source · Clips · Hooks · Effects · Posts. Bottom tool row (Select, Frame, Note, Text, Image, Video, Audio, Upload), side rail, regions, minimap, list view, cards (brief, looks, questions, plan "Make 3 shots · 93 cr · at most 186 cr", shots, takes, cut, deliver), Atomik docked right, Inspector on selection, Library drawer. Unbuilt Ads/Social sections say "Not in Particl yet" with no price.
4. **Make as drawn:** a panel over any screen (⌥M); engine line with price and Change; Advanced folded; the Edit tab removed; Recent with full engine names, "Again · N cr", "Use as reference", filters All · Takes · Unfiled · Filed; Motion transfer and Object swap as modes, priced once a source is added.
5. **Atomik:** the panel on every screen, ⌘K as search plus Atomik, how-to answers free, "Start · up to N cr" with the real figure from the code.
6. **Control room:** Approvals (one queue, batch approve, the spend-without-asking setting), Activity, Skills, Memory.
7. **Settings** in five sections: Team, Plan & credits, Spending rules, Connections, Advanced.
8. **Phone:** Home with what needs you, plan approval with the price as the button, full-screen review with swipe (never spends), project record, simple Make.
9. **Autosave:** no "Save this project before asking Atomik" anywhere.
10. **Guest Home** (behind its /admin "Guest Home" setting, off): signed-out Home, read-only sample from "Particl sample", invite-only sign-up enforced on the server, Request access stored in /admin, /signup on Graphite. The old homepage and its copy go when the owner turns it on.
11. **Sample production (the dunes film):** generated only after the owner approves draft v3, in "Particl sample" (engine cap $32.60 for the run, 326 cr balance wall, back to $0 after). Plan: Shot 1 and 2 Seedance 2.5 hero takes (43 cr each), Shot 3 Kling 3.0 draft (7 cr); 93 cr plan, up to 186 cr fixes; 326 cr ceiling.
12. **Demo workspace** "Particl demo" with the cap field in /admin.
13. **Deleted in the same release:** the ten stage pages, their routes (redirected to board regions), their styles, the old Gen and Viral pages, and the new-interface switch and its code.

**Done when**
- The owner has reviewed the integration preview screen by screen and approved.
- CI green, including the banned-names and price-on-every-spending-button checks.
- particl.si after the merge matches the preview; the five-minute test (new person with an invite reaches an approved first render, mocked) passes on desktop and phone.

---

## 3. Phase 2: the agentic core (target: end of October, starting Fri 9 Oct)

**Goal:** an InVideo-style run on the Studio board. Atomik asks its questions, writes the brief and shot list, prices a plan, waits for one approval, makes shot 1 as the look anchor, reviews it, makes the rest, fixes at most twice per shot, assembles the cut and delivers, with every paid step at its quoted price and the ledger matching.

**Packages, in order** (plans written on 6 Oct; build from 9 Oct; nothing merges before the demo)
1. **P4b, models on their own APIs:** every model on its provider's API, Vercel AI Gateway removed, a pinned and tested price list.
2. **A1, the tool registry:** engine tools generated from `lib/models.ts` and the task/still tables; app actions (board ops, Stop, Retry, approve, publish, consent) declared beside their handlers. Per tool: id, inputs and limits, provider, key, price function, mock, who may call it. One paid path: quote → approval → durable claim → poll → collect. A tool that can't be priced can't run. Consumers: buttons, Make, board cards, Atomik, skills, MCP.
3. **S1, the board backend:** card kinds doc, questions, plan, group, take, deliver; groups as real containers; versions with approve/reject (with reason) on every frame and take; the project record (brief version, every approval with quote and settled cost, open decisions, spend vs ceiling); regions; a board for every existing production; API with person-only approval. The Release 1 screens stay; S1 lands underneath.
4. **P6b, self-review wired in:** verify every frame and take against the anchor and locked masters; one-line note on each card.
5. **S2, Atomik on LangGraph.js:** questions → brief/shot list → plan → approval (interrupt) → anchor → review → remaining shots → cut → deliver; "Where to next?" after each step; checkpointer in each workspace's own libSQL database; Stop releases unspent holds; budget ceiling per production, asks at 80%; board ops as MCP tools behind the same gates; traces to Langfuse (ids, models, tokens, cost, never prompt text); thinking billed as rule 14 says.
6. **U1, the rest of the ease work:** the five-minute Playwright test on every UI PR; plan approval with fix allowance; balance check before a plan with Top up; "Nothing billed" with Retry; "Notify me when done" (Web Push); review mode with keyboard, compare and phone swipe; ease metrics as ids and timings only.

**Done when:** one real production (the owner's yes, internal workspace) runs from brief to an approved cut on the board by Atomik, every paid step approved at its quote, the ledger matches; a test proves an agent cannot take a people-only action.

---

## 4. Phase 3: the platform move (parallel; owner does the account steps)

Runbook: handover Part C. Order and gates:
1. **P2 finish:** Coolify keys saved, origin certificate, coolify.particl.si, GitHub App, Cloudflare-only firewall, real visitor addresses, outside monitor, VPS snapshots.
2. **P3 media:** R2 switched on, media.particl.si with signed links, thumbnails and posters (about a week).
3. **P4 beside Vercel:** Docker under Coolify, self-hosted Inngest sized for 1,000 jobs with per-plan limits (Invite 2, Studio 5, Agency 15, Production 50), staging.particl.si, all 12 smoke checks (about a week).
4. **P5 cutover:** only after the 1,000-job load test on staging; `CREDIT_USD` = 0.10 on Coolify; rollback is one DNS change; two weeks of watching; then Blob retired and exposed keys rotated.
5. **P8 many clients:** worker container, legacy-path guard, load test to 1,000 jobs, GlitchTip, Langfuse.

Rule: Claude Code never changes DNS, Cloudflare, Coolify, Vercel or hPanel settings; it prepares click-by-click steps for the owner.

---

## 5. Phase 4: engines and output (November)

| Package | Delivers |
|---|---|
| E1 | Veo 3.1 on Google's API; DoP moves on the Higgsfield API key; Kling Omni edit |
| E2 | Seedream 5.0, FLUX.2 and Kontext, Recraft V4, automatic engine choice |
| E3 | Video background removal, relight, deflicker as take actions (after P8) |
| E4 | Lip-sync, talking people (OmniHuman), FASHN try-on, consent records |
| E5 | Dubbing, voice change, voice cloning with consent, MMAudio, Seed Audio (first paid tests with the owner's yes) |
| E6 | Multi-view cast sheets; Identity (Soul Character on the API key once priced); props from a photo into 3D blocking |
| E7 | Burned-in captions, server-side renders, AAF export (FFmpeg, OpenTimelineIO) |
| **E7R (new): Remotion** | Designed captions, title and end cards, ad versions resized to 9:16, 1:1 and 16:9 with the brand kit, final cut with graphics. Each template a registry tool. Previews with `@remotion/player` free; server renders in the VPS worker via Inngest, behind a flag until P4. Build and test under Remotion's free evaluation terms; **tell the owner before anything renders for customers** so he buys the Company License ("Automators", 10,000 server renders, $100/month). Renders free to customers; report monthly counts in /admin and flag at 8,000. |

Every model goes in through the same door: a verified price, a mocked test, one paid qualification run in the internal workspace after the owner's yes. Nothing needs a Higgsfield sign-in (API key only).

---

## 6. Phase 5: suites and skills (November–December)

| Package | Delivers |
|---|---|
| E8 | Ads: product photoshoots, product and UGC video skills, ad versions, Adapt (no Marketing Studio video) |
| E9 | Social: effects library, clips from long videos, narrated videos, hook review, publishing behind flags |
| S4 | Ads and Social boards complete: the poster Designer from a card, Crew review on any board, every board connected to the control room |
| A2 | The 15 workflows (all but the website builder, per `tests/fixtures/connected-workflows.json` and the skills table) as Particl skills, each quoted as one run, copyable per workspace, one mocked end-to-end test each |
| A4 | Skills over MCP: `list_skills`, `quote_skill`, `run_skill`; run never spends on its own, it returns an approval link |
| C2 | Search by meaning across the board and Library, embeddings in each workspace's own database |

---

## 7. Phase 6: payments and close-out (last)

- **Payments:** Stripe/Razorpay wired as its own package. Credits granted = amount ÷ `CREDIT_USD` (e.g. $50 → 500 cr), never a number typed into Stripe or the code. Owner sets up the accounts.
- **Post-demo list:** password-less email sign-in link; a stock-footage library only if the owner adds it.
- **Review:** `docs/particl-sow.md` updated to what shipped.

---

## 8. Building blocks (what each solves)

| Block | Solves | Cost |
|---|---|---|
| React Flow | The board canvas | Free (MIT) |
| LangGraph.js | Atomik's flow, approvals as interrupts, safe resume | Free (MIT) |
| Tiptap (core) | Brief and shot-list cards | Free (MIT) |
| Yjs via Liveblocks | Several people editing one card | Free (MIT) |
| Liveblocks | Live board sync | Free or Pro $25/mo (yearly) |
| MCP + TypeScript SDK | Outside agents use Particl safely | Free |
| Langfuse | Agent run traces and cost | Hobby free; Core $29/mo |
| Inngest (self-hosted) | Background renders, 1,000 jobs, per-plan limits | Free |
| FFmpeg, OpenTimelineIO | Captions, clips, renders, AAF | Free |
| Remotion | Designed captions, cards, ad versions, final cut | $100/mo from go-live (10,000 renders) |
| Hostinger KVM 8 + Coolify | Own server and deploys | $25.99/mo (2-year term) |
| Cloudflare Pro + R2 | Domain, security; media storage, no egress fees | $20/mo; $0.015/GB-month |
| Turso | One database per workspace | Free / $4.99 / $24.92 |
| Resend, Web Push | Email; phone notifications | Free / $20/mo; free |
| GlitchTip, Uptime Kuma | Errors; uptime alerts | Free (self-hosted) |
| Playwright, k6 | Tests; load tests | Free |

Not used: tldraw, n8n, ComfyUI, LangChain beyond LangGraph, Vercel AI Gateway.

---

## 9. Owner decisions

**Decided:** header B; $0.10 per credit; Ask by default; Cinema Studio "about N, at most 3N"; one design only; the board for everyone (no switch); guest sample from "Particl sample"; dunes option (a), 326 cr ceiling; Remotion adopted (buy at go-live); Stripe last; demo Fri 9 Oct.

**Open:** final UI names (§ B3 stand until confirmed); whether the Auto line becomes a workspace setting; Atomik thinking billing per request or per plan; making the repository private; the dunes film's final title.

---

## 10. Done, for the whole programme

- The five-minute test passes for a new person on desktop and phone.
- One real production runs from brief to an approved cut on the board; every paid step approved at its quoted price; the ledger matches.
- Every registry tool reachable by Atomik, a skill and MCP at the same price and gate as its button; every engine reachable from Make and a board card; a test proves each; people-only actions provably stay with people.
- No banned names in the UI; nothing needs a Higgsfield sign-in; contrast and size minimums pass an automated check on every screen.
- The VPS runs 1,000 jobs at once without slowing pages.
