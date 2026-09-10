# particl + Atomik — master scope of work

Single source of truth for the build. Supersedes the earlier brief and folds in the node-graph design handoff. Where this document and any other artefact disagree, this one wins; where this document and the shipped code disagree, check the code and update this document.

---

## 1. The product

**particl** (particl.app) — an invite-only, multi-tenant production tool for anyone making film with generative engines: agencies, production houses, independent directors, brand teams. It makes shots, keeps them consistent across a production, and knows what every shot cost before and after it was rendered.

**Atomik** — the companion app on the same database. Atomik owns everything before the render: idea → treatment → breakdown → shot list. particl owns the render and everything after: takes, picks, approvals, masters, cost. The shot list is the contract between them, and it moves both ways.

The product started inside one production house. Some code and copy still assume one team, one set of keys, one owner's judgement. Every change moves it toward something a stranger with an invite can use, without losing the opinions that make it good.

**Positioning.** Two things no competitor has: a credit ledger that prices a change *before* it happens, and a real approval trail. Everything worth building leans on one or both. Model breadth and canvas flexibility are table stakes we need but never the pitch.

---

## 2. Engine map

Source of truth. The site's own copy has been wrong about this before; the Settings engines list must read from the adapter registry so it cannot drift again.

| Provider | Models | Notes |
|---|---|---|
| **ByteDance** (BytePlus ModelArk) | Seedance 2.5 | Video. Currently the default and only wired video engine. |
| **Google** | Nano Banana Pro | Stills. Called **directly on Google's APIs** — not via Vercel AI Gateway. |
| **fal** | Kling 3.0, Kling 3.0 Motion, Topaz, Soul ID, Flux character | One adapter, several **media** models behind it. `FAL_KEY` not set — nothing here works yet. **No LLMs through fal.** |
| **ElevenLabs** | Voice / audio | The Audio tab's engine. |
| **Vercel API** | Claude, GPT | **Every LLM call in either app.** Atomik's enhancement, idea builder and shot builder; anything in particl needing an LLM. |

**Credits are the unit. 1 credit = US$0.10, fixed.** Every price in either product is in whole credits — buttons, post tools, training, caps, statements. The ledger keeps exact `engine_cost` in USD and `billed_credits`; margin is the gap, set platform-side per engine, never shown. Estimates round **up** to the next whole credit per job; batches multiply before rounding. USD appears once, on the top-up screen (`500 credits · $50`), and nowhere else.

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

---

## 4. Design system

Full spec in `docs/handoff/nodegraph/DESKTOP-README.md` (shell, components, per-screen) and `README.md` (node-graph surfaces, light tokens). Both are **high-fidelity and final-intent** — colours, type, spacing, radii, copy and geometry. The graph geometry in the canvas surfaces is exact: node positions, port centres and wire endpoints were measured. Keep port-to-slot alignment when rebuilding; a wire that misses its port breaks the one idea the screen exists to show.

**Open decision — theme.** The handoff describes particl as dark (`#0B0D11` ground, `#F5F6F8` ink) and Atomik as light (`#FCFCFD`). The live site is light with an Auto appearance setting and per-scheme `theme-color`. Resolve this before building Rig: either particl is dark and the live light theme is the exception, or both themes are first-class and every new surface ships in both. Don't let it stay ambiguous — the node surfaces are token-heavy and reworking them later is expensive.

**Type.** Outfit for UI and body; Kode Mono 11px/0.12em tracking for eyebrows, costs, states and IDs. **Radius** 4–10 by component. **No motion, no shadows** — hover raises border alpha only.

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

Everything above is workspace-scoped.

---

## 6. Phase 0 — Mobile foundations · LARGELY COMPLETE

Verified fixed on particl.app at 390×844 and 360×640: no horizontal overflow on any route, no inputs under 16px, per-scheme `theme-color`, composer sheet opens with Close and Generate both in the viewport, vocabulary corrected (Request an invite / Takes / Productions / Generate), 1920×1080 replacing 1080P/1088, positional copy removed.

**Outstanding:**

- **Safe area.** Dock `padding-bottom` reads 0px despite `viewport-fit=cover`. Apply `env(safe-area-inset-bottom)` to the dock, composer bar and every bottom sheet. Blocking for the iOS app.
- **Credits not in the composer.** The Generate button still reads `$2.86 · 244.8k TOK`. Should read `29 cr`. A Balance link to `/settings#credits` exists, so credits exist somewhere — establish whether the conversion is partial or absent.
- **Token count on the button** — noise once it's credits. Remove.
- **Vocabulary**: dock `GENERATE` vs segmented Video / Images / Audio.
- **Sticky context in the shot builder** — the assembled prompt and the `N OF 12 ROWS SET` counter scroll away, so tapping a chip far down the page gives no feedback. Put a one-line preview and the counter in the sticky bar.
- **`aria-pressed` on chips** — currently `is-on` class only.
- **`/images` hydration** — the SSR HTML previously carried the video composer. Confirm resolved.
- **Audio tab** — if ElevenLabs is wired, show its composer signed out like Video and Images; if not, hide the tab.
- **Usage signed out** is blank while the copy promises otherwise. Show the shape with placeholder numbers.

**Acceptance suite** (keep it green for every later phase): visits every route at three viewports signed out; asserts `scrollWidth === clientWidth`; opens the composer sheet and asserts Close and the primary are in-viewport; asserts dock `padding-bottom ≥` safe-area inset; asserts no input under 16px.

---

## 7. Phase 1 — Multi-tenant foundations, then engine breadth

### 1.0 Tenancy, billing, onboarding — gates everything

**Keys and metering.** Platform holds the keys; workspaces don't bring their own (design the adapter so a workspace key *can* override later; don't build the UI). Every engine call goes through one server-side **metering layer** stamping `workspace_id`, `project_id`, `shot_id`, `engine`, `model`, `engine_cost`, `billed_credits`, `multiplier_applied`, `duration`, `status`. The multiplier resolves per workspace then per engine, so an internal workspace at 1.0× and a customer at 1.5× go through identical code. No engine is ever called from a route that bypasses it. Also record **peak concurrency per engine**, sampled per minute and retained — that reading is what justifies a provider limit increase later, and it can't be backfilled.

**Billing.** Prepaid credit balance per workspace, bought in packs by card; invoicing for larger accounts later. Balance in the header beside the workspace switcher and on Usage. Project caps convert to credits; the workspace balance is the hard stop above them. At zero, renders queue with "top up to release", the owner and admins are notified, nothing is silently dropped. Statements per workspace / month / project, itemised by shot and take in credits with one USD line for the pack cost — this is how a workspace bills its own client.

**Onboarding.** Request an invite → platform admin queue → approve → expiring invite code → account → create or join a workspace → workspace seeded with platform Setup defaults, camera bank, rules and a copy of the demo production as a starter project → **a free credit grant** (≈50 cr, enough for three or four real shots) → first render. Time this path against rule 6. Owners and admins invite their team by email with a role; pending invites visible in Team & roles. Workspace switcher in the header lists every workspace the user belongs to.

**Platform admin console** — separate route, platform-role gated: invite queue, workspace list with spend / balance / margin, engine health and error rates, per-workspace suspend, content-policy flags, and a platform-layer editor for default Setup, camera bank, compiler rules and default caps.

**Isolation and lifecycle.** Per-workspace rate limits and a **fair-share queue** — per-workspace concurrency slots inside the global pool, so one customer's batch of forty stills can't starve nine others. This is what breaks first, long before any provider ceiling. Per-workspace storage quota shown on Storage & masters. Self-serve workspace export (all masters plus a CSV of every take, prompt and cost) and deletion with purge. Shared identity with Atomik: one account, one workspace list, one session, same scoping enforced on both sides.

**Policy.** Written content policy shown at signup. Engines refuse some prompts — failure reasons must say so plainly. Report path on review links, platform-side suspend for abuse, terms/privacy/retention visible from Settings → Account.

**Pricing is decided — see section 7A. Implement it as specified; the only open item is whether invoicing ships now or later.**

### 1.1 Model breadth per shot

One interface (`estimate`, `render`, `poll`, `fetchMaster`), one adapter per provider: ByteDance/Seedance and Google/Nano Banana Pro (existing), ElevenLabs, **fal** carrying Kling 3.0, Kling 3.0 Motion, Topaz and Soul ID / Flux behind one adapter, and **Vercel** as the single LLM adapter with the same shape so text calls meter like everything else. Every adapter goes through the metering layer.

Wiring `FAL_KEY` and the fal adapter properly unlocks 1.1, 1.2 and 1.3 at once — do it first and do it once.

A **model row in the composer**, defaulted from the workspace's Defaults & caps, overridable per shot, each with a one-line "what it's for" (`Kling: water, cloth, physics`). On touch this is a bottom-sheet picker, not a dropdown — the current dropdown lags on mobile; profile before guessing, but the usual causes are the composer re-rendering on open, a synchronous estimate recompute, or animating layout properties. Debounce the estimate. Assert no long task over 50ms on open.

A **per-engine prompt compiler**: Setup rows are engine-neutral, the compiler renders each engine's dialect. Rules live in the platform layer with workspace overrides (2.5). Atomik's LLM path reads the same rule set — one source of truth, not two copies that drift.

Don't copy Higgsfield's model marketplace. Five well-wired engines beat thirty.

### 1.2 Post tools on an approved take

In order: **Reframe** (aspect change with content-aware fill, new take under the same shot, versioned, named by convention) · **Upscale** via Topaz on fal · **Motion control** via Kling 3.0 Motion — a cast still or approved frame plus a reference video, which is the one that stops you re-rolling a performance · **Extend / last-frame continuation** · outpaint and background removal for stills. Every post tool shows its credit price before pressing and files output against the same shot as a take, not a separate bucket.

### 1.3 Identities

Wire fal end to end: photo intake → Soul ID / Flux character training → status → available as a cast member. Credit price shown before pressing; training is asynchronous and appears in the queue. `@Name` resolves to the trained model for stills and the hero still for video, automatically. Trained identities are workspace-scoped and never shared, listed or reused across workspaces. The uploader confirms they have the right to train on that face; store that confirmation with the identity.

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

---

## 7A. Pricing — decided for launch

The governing rule: **every tier is profitable even if the customer uses everything included.** Cost every inclusion at full use, at engine cost plus 3% payment fees. Typical usage (40–60% of inclusions) is where the margin lives; worst case is the floor.

### Credits
- **1 credit = US$0.10, fixed.** Sell price = engine cost × 1.5, rounded up to the next whole credit per job. Batches multiply before rounding.
- The ledger stores `engine_cost_usd`, `billed_credits` and `margin_pct` per job. The rate card is generated from the adapter registry, never hand-edited.
- **Floor guard:** if any engine's rolling 7-day margin drops under 10%, its sell multiplier auto-raises to restore 1.5× and the platform admin is alerted. This runs in the metering layer, not in a spreadsheet.
- **The aimighty workspace is billed at cost.** For now, the aimighty workspace (and any other workspace flagged `internal: true` in the admin console) has its sell multiplier set to 1.0 — credits are charged at exact engine cost plus payment fees, with no platform margin, and no platform fee. It sits on the same ledger, the same metering, the same statements as every other workspace; the only difference is the multiplier. This is a per-workspace override on the same field that Phase B tunes per engine, so it costs nothing to build and nothing to remove. The admin console shows internal workspaces separately in spend and margin reporting so they never distort the platform's numbers.
- **Draft/hero split is a product default, not a pricing tier.** Recipes route boards to standard panels (1 cr), draft takes to Kling Standard or Wan (4–8 cr), and hero takes to Seedance or Kling Pro (25–45 cr). The composer's model row defaults from the shot's stage in the recipe. This is how a production stays competitive while per-clip prices sit above aggregators with volume rates.

Reference rate card at launch (regenerate from live engine costs before publishing):

| Action | Engine cost | Sells at |
|---|---|---|
| Standard panel (Nano Banana fast) | ~$0.04 | 1 cr |
| Keyframe still (Nano Banana Pro) | ~$0.15 | 3 cr |
| Wan 2.6 draft, 5s | ~$0.25 | 4 cr |
| Kling 3.0 Standard, 5s | ~$0.50 | 8 cr |
| Kling 3.0 Pro, 5s, audio | ~$1.68 | 26 cr |
| Seedance 2.5, 5s, 720p | ~$1.60 | 24 cr |
| Seedance 2.5, 5s, 1080p | ~$2.86 | 43 cr |
| Veo 3.1, 5s, audio | ~$2.00 | 30 cr |
| Topaz upscale, 5s | ~$0.40 | 6 cr |
| VO line (ElevenLabs) | ~$0.03 | 1 cr |
| Identity training | ~$2.00 | 30 cr |
| Prompt enhancement | ~$0.01 | 1 cr |

### Tiers

| Tier | Price | Included | Members | Worst-case cost | Worst-case gross |
|---|---|---|---|---|---|
| **Invite** | $0 | 50 cr once, 1 production, boards at 1 cr | 3 | $3.50 | marketing cost |
| **Studio** | $49/mo | 400 cr, 250 standard panels, review links, exports, post tools | unlimited | $38 | $11 · 22% |
| **Agency** | $199/mo | 1,600 cr, 1,000 panels, priority queue, branded review links, statements | unlimited | $153 | $46 · 23% |
| **Production** | $999/mo | 9,000 cr, 3,000 panels, admin console, setup hours | unlimited | $750 | $249 · 25% |

- **Included credits and panels expire at cycle end. No rollover.** Breakage is real margin.
- **No seat fees on any paid tier.** Differentiate on credits, priority and features, never headcount.
- **Annual: 20% off.** Auto-cancel: if a workspace has generated nothing in the 60 days before renewal, don't renew — let it lapse and say so.
- Panel inclusions are on the standard engine only. Pro stills and all video draw credits regardless of tier.

### Packs
Unit stays $0.10. Discount only through bonus credits, capped at 20%. Purchased credits last 12 months.

| Pack | Price | Credits | Effective |
|---|---|---|---|
| Starter | $50 | 500 | $0.100 |
| Team | $200 | 2,000 + 200 | $0.091 |
| Studio | $500 | 5,000 + 750 | $0.087 |
| Agency | $2,000 | 20,000 + 4,000 | $0.083 |

### Guardrails in code
1. Free grant is one-time, never recurring. Invite approvals are capped per month by a platform setting (`grant_budget_usd`); each approval costs ~$3.50.
2. Bonus credits never exceed 20% of a pack.
3. Any workspace consuming more than 25% of the platform's monthly engine spend is flagged to the admin console.
4. Any single job estimated above 200 cr requires the workspace's cost approval rule to fire, regardless of the workspace's own setting.
5. Included-credit consumption is metered separately from purchased credits, so statements show what was free and what was paid.
6. Workspaces flagged `internal: true` bill at multiplier 1.0 and pay no platform fee. The flag is set only from the platform admin console, never from workspace settings, and its spend is excluded from margin reporting.

### What changes at volume (do not build now — flags only)
- **Phase B (~$20–50k/mo engine spend):** volume rates from ModelArk, Kling and fal at committed spend, target 20–30% off. **Hold sell prices flat**; margin rises to ~50%. Move standard panels to GPU-hour open weights (panel cost under 1¢). Per-engine multipliers tuned from the ledger: premium 1.7×, commodity 1.4×.
- **Phase C (300+ workspaces):** own GPU pool for open-weight draft video, enterprise contracts, BYOK for large studios on a higher platform fee, recipe marketplace with revenue share.

Build the adapter so the multiplier is per engine from day one, even though it launches at a flat 1.5×. That's a config change later, not a refactor.

### Milestones
Hard fixed costs ≈ $300/mo. Typical contribution: Studio ~$32, Agency ~$110, Production ~$550.
- Break-even on hard costs: ~10 Studio or 3 Agency.
- One salary (~$4k/mo): ~15 Agency + 30 Studio, or 4 Production + 10 Agency.
- ~$25k/mo contribution: ~40 Agency + 100 Studio + 8 Production — roughly where Phase B rates lift every number by ~15 points.

---

## 8. Phase 2 — The moat

Everything here exists because particl has a shot model and a cost model. Push until these are the reason a team picks it.

### 2.1 Takes as selects
Compare view — two to four sibling takes side by side, synced playback, one-tap pick or approve; this is the producer's phone screen. Approval trail: who picked, who approved, when. An approved shot is locked; generating against it asks for a reason. A send-back returns the shot to draft with the director's note attached, listed in History and in Usage's `SENT BACK` column. Notes on a take, one line, `@person` mentions, so "the 3rd one but with the pan slower" lives on the take and not in WhatsApp.

### 2.2 Cost that lives with the shot
Every shot on the wall shows `takes so far · spent so far` (`6 takes · 172 cr`). Per project: cap burn-down — spent against cap, projected finish from takes-per-shot so far, and which shots are burning it. `Which shot is taking the most takes` becomes the headline of Usage. Per workspace: balance and burn rate, days of runway at the current pace. The cost approval rule surfaces in the composer when it applies (`Over 50 credits needs an admin`). Statements cut by project and by client-facing shot names so a workspace bills its client directly from them.

### 2.3 Setup you can see and override
The composer shows a live diff: which rows are active, which the current shot overrides (`Setup: 35mm · Golden hour · Handheld — this shot overrides: Locked off`). Per-shot override without touching workspace Setup, and one-tap clear. **Four layers** — platform default → workspace → project → shot — each inheriting and overriding the one above, with the UI showing where every active value came from. The live composer already labels rows `PLATFORM`; extend that to all four.

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

**Export selects**: zip of approved masters named `{project}_{shot}_{version}_{w}x{h}.{ext}`, a CSV shotlist (shot, take, version, engine, credits, prompt), and an EDL/XML in order so an editor drops them into Resolve or Premiere.

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

The node layer. Design handoff at `docs/handoff/nodegraph/`.

**Name.** The surface is **Rig** — Canvas is already taken by the sequence wall at `/projects/:id/canvas`. Rig works twice: on a set it's the wiring and mounting that holds a setup together; in animation, rigging is exactly binding a character's attributes to controls that everything downstream reads. Nav `RIG`, route `/projects/:id/rig`. Nouns inside it: recipes, runs, elements, ports, bindings, provenance.

**The seven rules the surfaces enforce — these are the acceptance criteria:**
1. The price is on the action, quoted before the button enables.
2. State vocabulary: `queued → running → done`, plus `needs you` for failure and `locked` for pinned.
3. Take states stay `draft → picked → approved`; only approved reaches assembly.
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

**Build order — data model first, mobile before desktop, canvas last:**
1. Schema and the migration from what 1.0 shipped. Be specific about how existing takes get backfilled with provenance, or why they can't.
2. The quote/impact engine — what a change costs before it happens. Everything visible depends on it.
3. Mobile: `1a` → `1b` → `1c` → `2c` → `2b`.
4. Desktop: `1d` → `2a`.
5. Chat drives the graph; the canvas is a view of what chat did, never the only way to edit.

**Where it lives.** Recipe authoring and the canvas belong in Atomik (planning); running recipes and their outputs belong in particl (rendering). Same graph, same scoping, one database.

**Constraints that don't relax:** rule 6 — a new user must never need to open Rig to make a first render. Rule 7 — five of seven surfaces are 390×844 and must pass the Phase 0 suite. Desktop canvas is min-width 1180px and may be hidden below that; the mobile surfaces may not.

**Known geometry trade-off.** With the chat panel restored, the graph viewport is ~878px against a 1040px graph, so ~162px scrolls off at rest and the collapsed stages node is partly cut. Acceptable for a scrollable canvas. If it must read at rest: pull the column x-positions in ~120px, or narrow the inspector to 240px. **Pick one before building** — the geometry is measured and exact.

---

## 10. Phase 4 — Desktop depth

particl is a workstation tool that happens to have a phone client. Everything below assumes a 27" display, a keyboard, a mouse and a user who is in the app for six hours. None of it exists yet.

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

**particl** — `/welcome`, `/login`, `/` (Video), `/images`, `/audio`, `/projects`, `/projects/:id/canvas` (sequence wall), `/projects/:id/rig` (new), `/all` (Library), `/studio` (Cast & identities), `/studio/shot` (Camera & shot builder), `/usage`, `/settings` (Team & roles · Engines & keys · Storage & masters · Atomik connection · Defaults & caps · Account), plus the platform admin console on its own gated route.

**Atomik** — Ideas, Treatment, Breakdown, Shot list. Plus the workflow map artboard, which is a product map and not a UI.

Per surface, state which of the three layouts it supports and what the mobile version is: full, read-only summary, or absent. A surface with no declared mobile behaviour ships broken on a phone.

---

## 13. How to work

1. Confirm or correct every assumption in sections 2 and 5 against the code before changing anything. Specifically: where keys live, whether `workspace_id` is on every table, whether the metering layer exists and **which call paths bypass it**, how Atomik shares auth and data, and what "its own database" means in the schema. Report back.
2. Resolve the two open decisions in section 4 (theme — and note that dark is the convention for desktop suites) and section 9 (graph geometry). Pricing is decided in 7A — implement it as written; the multiplier, tiers, packs and guardrails are config-driven so Phase B changes are settings, not code.
3. Phase order: finish Phase 0 → 1.0 → 1.1 → the rest of Phase 1 → Phase 2 (2.1 and 2.2 first, they're what a paying team feels) → Phase 3 → Phase 4 → Phase 5. Two things from Phase 4 can jump the queue because everything after them gets easier: the ⌘K command palette (4.2) and resizable persisted panes (4.1).
4. For anything schema-touching, summarise what changed as a diff against this document and update it. A scope of work that drifts from the code is worse than none.
5. Each PR states: what it costs a workspace to use, how it's mocked in tests, what changed in the prompt compiler, and where the new code is workspace-scoped.
6. Every mobile change keeps the Phase 0 suite green.
7. Where a decision gets built on by later sections — schemas, ledgers, scoping, inheritance, sync — give two or three structures, argue against your preferred one, and name what breaks. Don't write code until it's agreed.
8. Any task that would spend real money on an engine: stop and ask.
