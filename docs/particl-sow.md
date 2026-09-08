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
7. **Mobile is first-class.** Producers approve from a phone. Every change ships with Playwright checks at 360×640, 390×844, 844×390. No horizontal overflow, all primary actions reachable without panning, dock and sheets clear of the home indicator.
8. **Small PRs**, one concern each, in phase order.
9. **Prose in the product is a cost.** The copy voice is good; there's too much of it. Where a paragraph explains what the UI should make obvious, fix the UI and cut the paragraph.

---

## 4. Design system

Full spec in `docs/handoff/nodegraph/DESKTOP-README.md` (shell, components, per-screen) and `README.md` (node-graph surfaces, light tokens). Both are **high-fidelity and final-intent** — colours, type, spacing, radii, copy and geometry. The graph geometry in the canvas surfaces is exact: node positions, port centres and wire endpoints were measured. Keep port-to-slot alignment when rebuilding; a wire that misses its port breaks the one idea the screen exists to show.

**Theme — resolved 8 September 2026: both themes are first-class.** Appearance
is already Auto / Light / Dark per browser, stamped before first paint, and the
token set is emitted twice. Every Rig surface built so far uses those tokens
rather than the handoff's absolute values, so it follows whichever theme the
reader is in instead of being a light screen dropped into a dark app or the
reverse. The handoff's light values are read as the light-mode expression of
one system, not as a second system. The cost of this decision is that no
surface may hard-code a colour: a literal hex in a Rig component is a bug.

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

Added by Rig (Phase 3). **As shipped** — this block was updated against the code
on 8 September 2026 per §12.4; the differences from the original sketch are
called out because each was a decision, not a slip.

```
recipes        { id, projectId, name, draft }
recipe_stages  { id, recipeId, num, name, kind: write|render|assemble, engine, params{},
                 inputs[stageId], locks[elementId], position }
runs           { id, recipeId, projectId, num, state: running|paused|done,
                 estimateCredits, startedBy, startedAt, finishedAt }
stage_runs     { id, runId, stageId, state: queued|running|done|needs_you|skipped,
                 doneUnits, totalUnits, spentCredits, estimateCredits,
                 failure{unit,reason,fixes[]}|null, fixedWith, fixedLabel, fixedBy, fixedAt }
elements       { id, projectId|null, castId|null, kind, name, description,
                 locked, lockedBy, lockedAt, fromShotId, fromGenId, mirroredAt }
element_attributes { id, elementId, kind, label, currentId|null, locked, position }
attribute_versions { id, attributeId, elementId, label, status: pending|ready|failed,
                     uploadId | genId | identityId }        // exactly one source
bindings       { id, shotId, projectId, slot, ordinal, elementId,
                 attributeId|null, versionId|null }
take_provenance{ takeId, shotId, recorded{ engine, model, provider, ports[], cast[],
                 setup{}, rules[], conditions{...}, by, at } }
take_ports     { takeId, elementId, attributeId, versionId, slot, ordinal }
```

**What changed from the sketch, and why:**

- **`element` is its own row with a link back to the cast member**, not the cast
  row grown. Decided so a migration here cannot take the composer down with it,
  while `castId` keeps the two from being two truths about one face.
- **`binding.overridden: bool` is gone.** `versionId` carries it: null means
  *follow current*, a value means *pinned*. One nullable column replaces a flag
  plus a value that could disagree, and it is what draws the inherited wire and
  the override wire on the canvas.
- **`binding.ordinal`**, because a shot can hold two characters and a wire lands
  on a slot, not a node (rule 6).
- **`binding.attributeId` may be null** — the bundle: every current version at
  once. A swap must ask "which ports FOLLOW current", which is a different
  question from "which ports does this version reach", and conflating them
  prices shots a change cannot touch.
- **`version` has no `thumbUrl` or `usedByShotIds`.** Its source is exactly one
  of an upload, a take or a trained identity; what uses it is the reverse
  lookup on `bindings` and `take_ports`, which cannot go stale.
- **`provenance` is two tables.** The blob is one statement about one moment,
  read whole or not at all; `take_ports` is the one thing asked across takes —
  which takes used a given version — and the blob cannot answer it.
- **`failure` is JSON on `stage_runs`**, not a table: it is the reason this
  attempt stopped, replaced whole on the next, and it never outlives it.
- **`impact` and `quote` are computed, never stored.** Storing a quote would
  create a second ledger that could disagree with the first. A quote carries
  `pricedAt` and a stamp of its inputs, and a stale one is re-taken before
  anything is charged.
- **Not yet recorded:** the seed. The vendor path does not return one on the
  render route, so provenance stores it as absent rather than as zero, and the
  card says "not recorded" and drops the word *exactly* from its own button.

**Port identity is `elementId:attributeId:versionId`.** That triple is what a wire carries and what provenance records. It is the single most important line in this document; everything else in Rig is bookkeeping on top of it.

Everything above is workspace-scoped.

---

## 6. Phase 0 — Mobile foundations · LARGELY COMPLETE

Verified fixed on particl.app at 390×844 and 360×640: no horizontal overflow on any route, no inputs under 16px, per-scheme `theme-color`, composer sheet opens with Close and Generate both in the viewport, vocabulary corrected (Request an invite / Takes / Productions / Generate), 1920×1080 replacing 1080P/1088, positional copy removed.

**Outstanding:**

- ~~**Safe area.**~~ **Resolved — not a bug.** The dock already carries
  `padding: 0 6px env(safe-area-inset-bottom, 22px)` and `viewport-fit=cover` is
  set. The 0px reading is emulation: a probe with
  `padding-bottom: env(safe-area-inset-bottom, 99px)` also computes to 0px, so
  Chrome defines the variable as zero and the fallback is never reached. A Face
  ID iPhone reports 34px. The mobile suite asserts the *declaration* for exactly
  this reason. Nothing to do; re-check on device before the iOS build if you
  want belt and braces.
- **Credits not in the composer — established: neither partial nor absent.** The
  conversion works and is gated on `creditsApply(ws)`, which needs a workspace on
  the platform's keys. Signed out there is no workspace, so it falls through to
  dollars; the same button in a platform-keys workspace reads
  `Generate 40 cr + 1 cr writer`. **The part that matters is what those dollars
  are:** $2.86 is the platform's *vendor* cost against a 40 cr charge, so the
  margin is a subtraction away for anyone who opens the page. Fix: price the
  signed-out composer in credits at the platform's default margin. Still open.
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

**Keys and metering.** Platform holds the keys; workspaces don't bring their own (design the adapter so a workspace key *can* override later; don't build the UI). Every engine call goes through one server-side **metering layer** stamping `workspace_id`, `project_id`, `shot_id`, `engine`, `model`, `engine_cost`, `billed_credits`, `duration`, `status`. No engine is ever called from a route that bypasses it. Also record **peak concurrency per engine**, sampled per minute and retained — that reading is what justifies a provider limit increase later, and it can't be backfilled.

**Billing.** Prepaid credit balance per workspace, bought in packs by card; invoicing for larger accounts later. Balance in the header beside the workspace switcher and on Usage. Project caps convert to credits; the workspace balance is the hard stop above them. At zero, renders queue with "top up to release", the owner and admins are notified, nothing is silently dropped. Statements per workspace / month / project, itemised by shot and take in credits with one USD line for the pack cost — this is how a workspace bills its own client.

**Onboarding.** Request an invite → platform admin queue → approve → expiring invite code → account → create or join a workspace → workspace seeded with platform Setup defaults, camera bank, rules and a copy of the demo production as a starter project → **a free credit grant** (≈50 cr, enough for three or four real shots) → first render. Time this path against rule 6. Owners and admins invite their team by email with a role; pending invites visible in Team & roles. Workspace switcher in the header lists every workspace the user belongs to.

**Platform admin console** — separate route, platform-role gated: invite queue, workspace list with spend / balance / margin, engine health and error rates, per-workspace suspend, content-policy flags, and a platform-layer editor for default Setup, camera bank, compiler rules and default caps.

**Isolation and lifecycle.** Per-workspace rate limits and a **fair-share queue** — per-workspace concurrency slots inside the global pool, so one customer's batch of forty stills can't starve nine others. This is what breaks first, long before any provider ceiling. Per-workspace storage quota shown on Storage & masters. Self-serve workspace export (all masters plus a CSV of every take, prompt and cost) and deletion with purge. Shared identity with Atomik: one account, one workspace list, one session, same scoping enforced on both sides.

**Policy.** Written content policy shown at signup. Engines refuse some prompts — failure reasons must say so plainly. Report path on review links, platform-side suspend for abuse, terms/privacy/retention visible from Settings → Account.

**Open decisions to bring back with trade-offs:** credit pack sizes; per-engine margin so credit prices land on sensible numbers; whether invoicing ships now or later.

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
1. Schema and the migration from what 1.0 shipped. Be specific about how existing takes get backfilled with provenance, or why they can't. **Done.** Version history is recovered from the takes themselves — the compiler wrote each citation into the prompt, so a take names which upload stood behind which name — and accepted only where the mapping is positionally sound. Seed and rule ids are recorded from that PR forward and never backfilled.
2. The quote/impact engine — what a change costs before it happens. Everything visible depends on it. **Done.**
3. Mobile: `1a` **done** → `1b` **done** → `1c` **done** → `2c` → `2b`.
4. Desktop: `1d` **done** → `2a` **done**. Built ahead of `2c` and `2b` under a desktop-first instruction on 8 September; this document's rule 7 stands and the two remaining mobile surfaces are next.
5. Chat drives the graph; the canvas is a view of what chat did, never the only way to edit.

**Where it lives.** Recipe authoring and the canvas belong in Atomik (planning); running recipes and their outputs belong in particl (rendering). Same graph, same scoping, one database.

**Constraints that don't relax:** rule 6 — a new user must never need to open Rig to make a first render. Rule 7 — five of seven surfaces are 390×844 and must pass the Phase 0 suite. Desktop canvas is min-width 1180px and may be hidden below that; the mobile surfaces may not.

**Geometry — resolved 8 September 2026: neither, because the positions are
computed.** The trade-off assumed the handoff's fixed coordinates and a fixed
1040px graph. `lib/graph.ts` derives positions from the recipe's own shape on
the handoff's grid instead — a stage sits one column right of the furthest
thing feeding it, and a branch drops a row when two want the same column — so
the graph is exactly as wide as the recipe needs and the canvas scrolls. The
inspector keeps its 272px, the columns keep their spacing, and nothing is
pulled in. When the chat panel lands it takes its 288px from the graph's
scrollable area, which costs viewport rather than layout.

One consequence worth naming: the asset layer draws Audio under **Keyframes**
where the handoff draws it under **Motion**, because Audio depends only on the
shot list. The placement follows the dependency rather than the drawing, and it
says something truer — Audio can start as soon as the shot list is done, which
is what the handoff's own copy ("runs alongside Post") means.

---

## 10. Phase 4 — iOS app

Only after Phase 0's safe-area fix and 2.7's push service. Prerequisites: Apple Developer Program enrolment, Xcode, and push working server-side.

Capacitor shell pointing at the live site (`server.url`), since the app is server-rendered and won't export statically. Native plugins that make it an app rather than a wrapper and avoid a Guideline 4.2 rejection: push notifications (the actual reason for the app), camera (identity photos and references), share (review links), filesystem (masters to Files), haptics.

**Sell nothing in the app.** Credits are bought on the web by the workspace owner. No buy button, no price shown — this avoids Apple's 15–30% cut on digital goods entirely and is how every B2B tool works. Out of balance on mobile → "ask your admin to top up", with an offer to notify them.

**Submission needs:** a demo account with a seeded workspace, a demo production with takes and enough credits that Generate works — invite-only apps are rejected under Guideline 2.1 without it, plus a note explaining the invite model. Privacy labels covering face and voice if identity training is reachable on mobile, a public privacy policy URL, screenshots, a 1024px icon. Budget one to two weeks of review round-trips.

Mac is deferred. When it comes, Tauri wrapping the same URL, minimum window 1440×900 for the Rig surfaces — not Mac Catalyst, which gives an iPad-shaped window.

---

## 11. Screen inventory

**particl** — `/welcome`, `/login`, `/` (Video), `/images`, `/audio`, `/projects`, `/projects/:id/canvas` (sequence wall), `/projects/:id/rig` (new), `/all` (Library), `/studio` (Cast & identities), `/studio/shot` (Camera & shot builder), `/usage`, `/settings` (Team & roles · Engines & keys · Storage & masters · Atomik connection · Defaults & caps · Account), plus the platform admin console on its own gated route.

**Atomik** — Ideas, Treatment, Breakdown, Shot list. Plus the workflow map artboard, which is a product map and not a UI.

---

## 12. How to work

1. Confirm or correct every assumption in sections 2 and 5 against the code before changing anything. Specifically: where keys live, whether `workspace_id` is on every table, whether the metering layer exists and **which call paths bypass it**, how Atomik shares auth and data, and what "its own database" means in the schema. Report back.
2. Resolve the two open decisions in section 4 (theme) and section 9 (graph geometry), and bring back the 1.0 pricing decisions with trade-offs.
3. Phase order: finish Phase 0 → 1.0 → 1.1 → the rest of Phase 1 → Phase 2 (2.1 and 2.2 first, they're what a paying team feels) → Phase 3 → Phase 4.
4. For anything schema-touching, summarise what changed as a diff against this document and update it. A scope of work that drifts from the code is worse than none.
5. Each PR states: what it costs a workspace to use, how it's mocked in tests, what changed in the prompt compiler, and where the new code is workspace-scoped.
6. Every mobile change keeps the Phase 0 suite green.
7. Where a decision gets built on by later sections — schemas, ledgers, scoping, inheritance, sync — give two or three structures, argue against your preferred one, and name what breaks. Don't write code until it's agreed.
8. Any task that would spend real money on an engine: stop and ask.
