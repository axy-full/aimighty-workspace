# particl + Atomik — master scope of work

> Scope v2 (6 October 2026) is `docs/particl-sow.md`; it sets the order of work. This file is the earlier master scope, kept for the rules and sections other files cite (CLAUDE.md §3 and §7A, among others).

Single source of truth for the build. Supersedes the earlier brief; the look of every surface is `design/particl-graphite/` (§4). Where this document and any other artefact disagree, this one wins; where this document and the shipped code disagree, check the code and update this document.

---

## September 13 production studio amendment

The authorized Particl production studio redesign supersedes older conflicting interface and workflow requirements below. `/workbench` is the main signed-in production surface, with the approved Particl logo and black, charcoal, white and grey palette. Desktop retains stages, canvas, inspector and Atomik; mobile supports creation and editing through bottom navigation and sheets.

Private collaborator drafts and versions share explicit production/shot records and an append-only published project bible. Publishing context is voluntary; the workbench does not introduce a creative approval requirement before assembly. Existing authentication, tenant boundaries, credit rules and protections on previously approved production shots remain enforced.

The workbench connects briefs/scripts, breakdown, boards, character and world references, editable node operations, priced generation jobs, takes and sequence assembly. Genie and seven individually selected crew roles produce persisted structured plans through the existing Gateway integration. Large uploads reuse the existing chunked upload client and streaming server assembly. Media jobs reuse `/api/generate` and the established adapters, worker and meter.

**EDL is restored by explicit request.** The workbench exports deterministic CMX3600 straight cuts at 24/25/30 integer fps with source assets and a JSON/CSV manifest. The older selects route remains unchanged. Browser source packages are capped at 200 MB.

**September 14 finished-video expansion.** Delivery opens a dedicated movie page and encodes locally: native H.264 with bundled AAC in MP4, or native VP9/VP8 and Opus in WebM. The pinned AAC encoder compensates its fixed priming frame and trims padding to the sequence end. Only that export page permits its bundled WebAssembly worker; the rest of the application retains its existing content policy. Selected takes use exact timeline frames at 24/25/30 fps, source trims, 720p/1080p aspect fit or crop, still holds and straight cuts. Original clip audio follows each trim; the sequence soundtrack starts at zero and ends at the final frame. The mix is reduced only to avoid clipping. This bounded SDR render supports up to 3 minutes, 200 MB of sources and a 200 MB output; keep the page open. No media is uploaded for rendering and no generation credits are charged. Unsupported codecs fail explicitly; transitions, HDR/colour-managed masters, fractional/drop-frame timecode and target-NLE conform validation remain outside this render.

**September 14 Gen and account redesign.** The user requested a separate redesigned Gen section and redesigned workspace, credit and account screens. `/generate?mode=video|images|audio` is the dedicated generation surface, with the old `/make/*` routes retained as compatible entries into the same interface. Studio / Gen / Workspace navigation, a creation desk and take browser, and shared management pages replace their prior layouts. Existing pricing, tenant isolation, scoped drafts, quote confirmation and paid-request recovery remain in place. The original eight-dot Atomik ring from the previous website replaces the prototype's orbital symbol. Stripe remains deferred.

See [Production workbench implementation](production-workbench.md) for integration details, verification commands and current limits. No tier pricing or provider credentials change with this release.

## 1. The product

**September 13 subscribed-workspace expansion.** The owner has authorized self-service subscribed workspaces for other production houses, retaining the existing plan and pack prices. The invitation-only acquisition flow below is superseded by verified-email registration plus the existing approved-invitation path. Direct registration and additional workspaces receive no automatic free grant; approved invitations retain the configured one-time welcome grant. Selecting a plan is never payment evidence. Invoice-funded monthly credit windows, source allocations and pause/resume pack expiry are implemented in the new ledger; Stripe provider connection and fulfillment remain a release dependency. See [Subscribed workspace implementation and launch gates](subscribed-workspaces.md). The remaining pack lifetime resumes after leaving a paid plan, matching the rule that only off-plan time counts.

**particl** (particl.app) — an invite-only, multi-tenant production tool for anyone making film with generative engines: agencies, production houses, independent directors, brand teams. It makes shots, keeps them consistent across a production, and knows what every shot cost before and after it was rendered.

**Atomik** — the companion app on the same database. Atomik owns everything before the render: idea → treatment → breakdown → shot list. particl owns the render and everything after: takes, picks, approvals, masters, cost. The shot list is the contract between them, and it moves both ways.

The product started inside one production house. Some code and copy still assume one team, one set of keys, one owner's judgement. Every change moves it toward something a stranger with an invite can use, without losing the opinions that make it good.

**Positioning.** Two things no competitor has: a credit ledger that prices a change *before* it happens, and a real approval trail. Everything worth building leans on one or both. Model breadth and canvas flexibility are table stakes we need but never the pitch.

---

## 2. Engine map

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

**AMENDED 4 October 2026 — D0 removals.** The Higgsfield row above is narrowed, and the vendor's name is no longer shown to customers anywhere:

- **Still running, on Particl's API key:** Motion Transfer and Object Swap (Viral), Marketing Studio Image (Business › Image ads), Cinema Studio 4.0 (Gen, priced "quoted" in the model sheet), and Soul Standard, Soul 2 and Soul Cinema (`lib/soulRender.ts`), shown as "Identity still · Standard", "Identity still · 2" and "Identity still · Cinema".
- **Cast renders with an identity and builds identities there** (owner's decision, 4 October): the select is **Identity**, the render button carries the live quote, and "Build identity" trains through `/api/soul/identities` for Standard, 2 or Cinema at the route's live price. The identity stills are reached from Cast, not listed in Gen.
- **Only the sign-in side is removed.** Nothing runs on a connected account; entries and identities built on one stay in the Library, read-only. No model is marked `retired` today; the mechanism (`lib/models.ts`) stays for the next retirement.
- **Removed from the product:** Business › Ads (Business opens on Image ads; an old Ads link lands there), Cast's reference-elements line, the connected-account billing source in Gen, and the unused `SoulIdHost` and `ConsumerGenjutsu` components. Results made on the retired connected account keep neutral names ("Video (earlier account)" and the like).
- **Names:** the Business suite is "Moleculr Business Suite"; Atomik is "Atomik Agent".


**Credits are the unit. 1 credit = US$0.10, fixed.** Every price in either product is in whole credits — buttons, post tools, training, caps, statements. The ledger keeps exact `engine_cost_usd` and `billed_credits`; margin is the gap, set platform-side per engine, never shown. Estimates round **up** to the next whole credit per job; batches multiply before rounding. USD appears on the top-up screen — each pack as `2,200 credits / $200 · 200 free` — and in one line on Settings › Vendors for a platform-keyed workspace, stating what a credit costs and the monthly cap. **Nowhere else, and never on anything that spends.**

Format: `N cr` lowercase in body, `N CR` in mono eyebrows. Currency is derived (`credits × creditUsd()`, US$0.10 a credit unless `CREDIT_USD` says otherwise) and only ever secondary.

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

---

## 4. Design system

**AMENDED 4 October 2026 — one design.** The look of every surface is `design/particl-graphite/` ("the board, made easy", 4 October 2026): dark only, flat, one token set — `app/graphite.css`, at the values of its README §2. It replaces every earlier design, which is no longer in the repo. Type, radii, motion, shadows, state dots, components and screens are the README's (§2, §3); this section keeps only the rules that are not visual.

**Wires land on ports.** On a node canvas a wire ends on its port's slot, never on the node (§9, rule 6). Keep port-to-slot alignment when a canvas surface is rebuilt; a wire that misses its port breaks the one idea the screen exists to show.

**Placeholders.** Striped rectangles in the design are image wells. In production they are real keyframes, take thumbnails, reference photos, location plates and turntable views. Never ship a surface with text where a thumbnail belongs.

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

The node layer. Its look is `design/particl-graphite/` (README §3.1, the Studio board).

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

**Known geometry trade-off.** With the chat panel restored, the graph viewport is ~878px against a 1040px graph, so ~162px scrolls off at rest and the collapsed stages node is partly cut. Acceptable for a scrollable canvas. If it must read at rest: pull the column x-positions in ~120px, or narrow the inspector to 240px. **Pick one before building.**

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

**particl** — `/welcome`, `/login`, `/` (Video), `/images`, `/audio`, `/projects`, `/projects/:id/canvas` (sequence wall), the Rig in the Suites (`/suites`, Studio › Rig), `/projects/:id/rig/elements` (element library), `/rig/canvas/:board` (old boards, each opening in the new Rig), `/all` (Library), `/studio` (Cast & identities), `/studio/shot` (Camera & shot builder), `/usage`, `/settings` (Team & roles · Engines & keys · Storage & masters · Atomik connection · Defaults & caps · Account), plus the platform admin console on its own gated route.

**Atomik** — the Atomik Agent suite in the Suites, which `/atomik` opens: 01 Agent · 02 Runs · 03 Approvals · 04 Budget · 05 Models · 06 Tools (Tools & connections) · 07 Memory · 08 Skills. The older planning pages stay at `/atomik/ideas`, `/atomik/treatment`, `/atomik/breakdown` and `/atomik/shots` (Ideas, Treatment, Breakdown, Shot list). Plus the workflow map artboard, which is a product map and not a UI.

Per surface, state which of the three layouts it supports and what the mobile version is: full, read-only summary, or absent. A surface with no declared mobile behaviour ships broken on a phone.

---

## 13. How to work

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
`bindings UNIQUE (shot_id, slot, ordinal)` could not represent that
sentence: one slot held one row, so pinning WARDROBE replaced the bundle,
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
