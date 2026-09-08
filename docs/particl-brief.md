# particl studio — brief for Claude

You are working on **particl studio** (particlstudio.com), an invite-only, multi-tenant production tool for anyone who makes film with generative engines — ad agencies, production houses, independent directors, brand teams. It is not a consumer toy and not a Higgsfield clone. Its job is to make shots, keep them consistent across a production, and know what every shot cost before and after it was rendered — for any workspace that has an invite, not for one studio.

That last point governs everything below. The product started inside one production house and some of its code and copy still assume one team, one set of keys and one owner's judgement. Every change you make must move it toward a product a stranger with an invite can pick up and use, without losing the opinions that make it good.

Read this whole brief before touching code. Then explore the repo, write a short plan back to me, and wait for a go before the first change.

---

## 1. What you're working with

Confirmed from the live site and settings — verify each against the codebase before relying on it:

- Next.js app deployed on Vercel. PWA manifest and apple-touch-icon exist. `viewport-fit=cover` is set.
- Engine map (this is the source of truth — the site's own copy is out of date, see Phase 0):
  - **ByteDance → Seedance 2.5** (video)
  - **Google → Nano Banana Pro** (stills), called directly on Google's APIs
  - **Vercel API → every LLM call.** Claude and GPT models are supplied through the Vercel API and nothing else — Atomik's prompt enhancement, idea builder and shot builder, and anything in particl that needs an LLM. fal is never used for LLMs; it is media models only. Vercel AI Gateway is not in the image path.
  - **ElevenLabs → audio** (the Audio tab's engine)
  - **fal → Soul ID and character training (Flux), Topaz (upscale), Kling 3.0 (video) and Kling 3.0 Motion (motion control)** — `FAL_KEY` is not set, so none of these work yet. fal is one provider adapter with several media models behind it, not four adapters. No LLMs through fal.
- **Tenancy as stated in Settings:** every workspace has its own database, its own keys and its own team; nothing in one can be seen from another. But the Engines & keys copy says keys "live in Vercel, set by an admin" — that is one deployment's keys, not per-workspace. This contradiction is the first thing Phase 1.0 resolves.
- Masters stored byte-for-byte in private Blob storage. File naming is `{project}_{shot}_{version}_{w}x{h}.{ext}`, driven by filing a render against a shot.
- **Atomik** is the shot-list companion app sharing the same database (idea → shot list happens there; renders happen here).
- Existing data model: Project → Shot → Take, with take states **Draft / Picked / Approved**. Library states: finished / rendering / queued / failed.
- **Setup** (shot size, angle, move, lens, lighting, time of day, look, mood, technique, motion, sound, titles) is set in Studio and carried into every shot.
- **Cast** (character / location / prop / look) is defined once and cited as `@Name` in any prompt.
- **Defaults & caps** already exist per workspace: default model, cost approval rule, duration/resolution/ratio defaults, warn the producer at 80% of a project cap, producer unlocks at cap.
- Cost is currently shown in USD on the render button before pressing, with the token count. This changes to **credits** in 1.0 — 1 credit = US$0.10, everywhere.
- Roles: owner / admin / member. Invitation only, requested through an "Ask for an invitation" form. There's a "Connect apps & tokens" section for Claude · ChatGPT · CLI.

---

## 2. Rules for this work

1. **Other people's money.** Every render bills a customer workspace in credits that they paid real money for. Never trigger a generation, training run or upscale against any customer workspace. Development uses mocked engine responses and fixtures; if a test genuinely needs a real engine call, it runs in a dedicated internal test workspace, and you tell me the cost and wait for a yes.
2. **Tenant isolation is not a feature, it's the floor.** Every table carries a `workspace_id`; every query filters on it; every Blob path is prefixed by it; every signed URL is scoped to it. Identities, cast, masters, prompts, costs and rules never cross a workspace boundary. If you can't point to where a query is scoped, it's a bug.
3. **Nothing tied to one studio in the code.** The rules, defaults and camera bank the product has today were learned by one team. They become the **platform layer** — defaults every workspace inherits and can override — not hard-coded behaviour. No workspace name, client name or person appears in source, seed data or copy.
4. **Do not redesign what already works.** The shot/take model, Draft/Picked/Approved, cost-on-the-button, Setup-carried-into-every-shot, `@cast`, file naming and caps are the product. Extend them; don't replace them.
5. **One vocabulary.** Every surface must use the same names. Decide with me, then enforce in code: one word for the render feed (currently "The wall" / "Library" / "All" / "Browse every render"), one word for the make screen (currently "MAKE" in the dock, "Video/Images/Audio" in the segmented control, "Generate" on the login page), and drop "Canvas" and "Production" from the login page unless they map to real screens.
6. **The first five minutes.** A stranger with an invite must get from email to first render inside five minutes without reading a paragraph. Every screen is judged against that person, not against someone who already knows the product.
7. **Mobile is a first-class surface.** Producers approve takes from a phone. Every change ships with Playwright checks at 360×640, 390×844 and 844×390. No horizontal overflow on any route, all primary actions reachable without panning, dock and composer bar clear of the home indicator.
8. **Ship in small PRs**, one concern each, in the order of the phases below. Don't start Phase 2 until Phase 0 and Phase 1 are merged.
9. **Prose in the product is a cost.** The copy voice is good; there's too much of it. Where a paragraph explains what the UI should make obvious, fix the UI and cut the paragraph.

---

## 3. Phase 0 — Mobile bugs (fix first, all of them)

Reproduced on the live site at 390×844 (iPhone) and 360×640 (small Android) in Chromium mobile emulation.

### Blockers
- **Every route except /login has horizontal overflow** — document is 446px wide on a 390px viewport (447 on 360). Cause: `.hdr-right` ("Contact management" + "Sign in") doesn't collapse. Effects: Sign in clipped (fully off-screen at 360), the page pans sideways, Android Chrome zooms the whole UI out ~12%, the dock and composer bar only span 390px leaving a bare strip on the right. Fix: collapse the header actions on small screens (icon or overflow menu), add `overflow-x: clip` on the root as a guard, and add a Playwright assertion `scrollWidth === clientWidth` on every route.
- **Composer bottom sheet (`.ws-rail.is-sheet`) inherits the overflowed width** — renders 430px wide at x=8, so Close, "Edit in Studio" and the right Setup column (Angle / Lens / Time of day / Mood) are clipped; at 360 the Close button doesn't exist on screen.
- **Composer sheet has `overflow: hidden` and no internal scroller** — its own Render button (`$2.86 · 244.8k TOK`) and the Cast row sit below the fold and can't be reached. Only escape is tapping the scrim. It gets worse once Setup and Cast populate. Fix: sheet height = `100dvh` minus header, scrollable body, Render pinned to the sheet's bottom edge.
- **No safe-area padding** — `viewport-fit=cover` is set but `.tabbar` has `padding-bottom: 0` and the composer bar above it has none either. On any Face ID iPhone the dock labels sit under the home indicator. Use `env(safe-area-inset-bottom)` on the dock, composer bar and every bottom sheet.

### Layout
- **Desktop two-pane layout switches on too early** — at 844×390 (phone landscape / small tablet) the page is 1091px wide; "The wall" wraps to two lines, "0 TAKES · 0 SHOTS" to three, filter chips clip at "Approved". Move the two-pane breakpoint to ≥1024px and gate it on height too.
- **"Ask for an invitation" modal is centered on the 446px layout**, not the viewport — pushed right and clipped. Will resolve with the overflow fix; verify.
- **Settings section tabs** (Workspace / Team & roles / Engines & keys / Storage & masters / Atomik / Defaults & caps / Account) run off the right edge with no scroll affordance — "Storage" is cut mid-word. Make the strip horizontally scrollable with a fade edge, or collapse to a select.
- **Empty wall leaves ~600px of dead space** between the empty state and the composer bar. When the wall has zero takes, pull the composer up or fill the space with the demo production (see 1.7).

### Type, touch and iOS behaviour
- **All text inputs are under 16px** — search 12px, prompt textarea 14px, login fields 15px. iOS Safari auto-zooms on focus and the zoom sticks after the keyboard dismisses. Set every input and textarea to ≥16px on touch devices.
- **Text too small for a phone:** dock labels 8.5px, composer eyebrow 9.5px, nav and counters 11px, the cost `$2.86` at 10px in light grey on a grey disabled button. Floor at 11px for eyebrows, 12px for anything you expect someone to read, and give the cost on the button real contrast.
- **Tap targets under 44pt:** "Contact management" 11px tall, "LIBRARY →" 11px tall, Video/Images/Audio tabs 27px, filter chips 30px.
- **Invitation modal auto-focuses the email field** — keyboard pops the instant it opens. Don't auto-focus on touch devices.

### Copy and naming
- "The composer **on the right** is the real one" (wall empty state) and "The prompt **on the right** assembles itself" (camera tab) — on mobile it's below, or in a sheet. Make this copy responsive or drop the positional reference.
- "**Contact management**" opens "Ask for an invitation" — label and action don't match. Call it "Request an invite".
- "**1080P**" label next to a "1920×1088" value, and 1080P reused as a stills resolution. Say 1088 or say "1080p-class"; use pixel dimensions for stills.
- **Engine copy is wrong**: Settings → Engines & keys and the login page say Nano Banana runs "through Vercel AI Gateway". The real map is ByteDance/Seedance, Google/Nano Banana Pro (direct), ElevenLabs/audio, fal (Soul ID, Flux character, Topaz, Kling 3.0, Kling 3.0 Motion), and Vercel API only for Atomik's Claude prompt engine. Correct both surfaces, and make the engines list in Settings read from the adapter registry (Phase 1.1) so this can't drift again.
- **"An admin sets FAL_KEY in Vercel"** is visible to the public. Platform plumbing never appears in customer-facing UI.
- Vocabulary drift (see rule 5).

### Performance
- **The model dropdown in the composer lags on mobile** (reported in use, not measured in emulation). Profile it on a real phone before guessing, but the usual suspects are: the whole composer re-rendering on open/close, the price estimate recomputing synchronously on every change, or a custom dropdown animating layout properties. Fix at the cause, then replace the dropdown with a **bottom-sheet picker on touch** — one row per model with its one-line "what it's for" and its credit price for the current settings — and debounce the estimate. Add a Playwright trace assertion that opening the picker commits no long task over 50ms.

### Unfinished or inconsistent
- **Audio tab shows nothing** — no composer, just "This is private". Video and Images show the real composer signed out. ElevenLabs is the engine for this tab: if it's wired, show the composer (voice, script, duration, cost on the button); if not, hide the tab until it is.
- **Usage page signed-out is blank** while the copy elsewhere promises "everything else here is yours to look at". Show the shape of the page with placeholder numbers.
- **Server-rendered `/images` HTML carries the video composer** (Seedance 2.5 · 5s · Audio · $2.86 · 244.8k tok); the client then swaps to Nano Banana Pro / Generate still. Likely a hydration mismatch — flash of wrong controls and wrong price on slow connections. Confirm and fix at the source.
- **Camera & shot builder:** the CTA bar is correctly sticky, but the assembled prompt and the "N OF 12 ROWS SET" counter live at the top and scroll away, so tapping a chip 2,000px down gives no visible feedback. Put a one-line prompt preview and the counter in the sticky bar.
- Chips use a class `is-on` only — add `aria-pressed` so VoiceOver reads selection state.
- Static `theme-color: #1D1F24` while Appearance defaults to Auto — in light mode the iOS status bar / Safari chrome is dark against a light page. Emit a theme-color per scheme.
- "New identity" button floats alone right-aligned with dead space on the identities card. Cosmetic.

**Acceptance for Phase 0:** a Playwright suite that visits every route at the three viewports signed-out, asserts no horizontal overflow, opens the composer sheet and asserts Close and Render are inside the viewport, asserts the dock's bottom padding ≥ safe-area inset, and asserts no input under 16px.

---

## 4. Phase 1 — Multi-tenant foundations, then close the Higgsfield gap

1.0 is not optional and comes before any new engine. Everything after it is Higgsfield's real advantage over particl, in the order it matters to a working team.

### 1.0 Tenancy, billing and onboarding

**Keys and metering**
- The platform holds the engine keys. Workspaces do not bring their own by default (BYOK can be a later enterprise option — design the adapter so a workspace-level key can override the platform key, but don't build the UI now).
- Every engine call goes through one server-side **metering layer** that stamps `workspace_id`, `project_id`, `shot_id`, `engine`, `model`, `engine_cost`, `billed_cost`, `duration`, `status`. No engine is ever called from a route that bypasses it. This is the ledger everything else reads.
- **Credits are the unit. 1 credit = US$0.10, fixed.** Every price in the product — the render button, post tools, training, caps, statements — is in whole credits. The button reads "29 credits", never "$2.86" and never raw engine cost. The ledger keeps exact `engine_cost` in USD and `billed_credits`; platform margin is the gap between them, set platform-side per engine, and is never shown to a workspace.
- Rounding: estimate rounds **up** to the next whole credit per job; batches multiply before rounding. Actual metering may be fractional internally, but a workspace only ever sees and is charged whole credits.
- Show the USD equivalent once, on the top-up screen ("500 credits · $50"), and nowhere else. The product speaks credits.

**Billing per workspace**
- A **prepaid credit balance** per workspace, bought in packs by card (propose pack sizes to me), with monthly invoicing for larger accounts later. Balance shows in the header next to the workspace switcher and on Usage, as a number of credits.
- Project caps already exist; convert them to credits, and add the **workspace balance as the hard stop** above them. At zero: renders queue with "top up to release", the owner/admin gets notified, and nothing is silently dropped.
- **Statements**: per workspace, per month, per project — downloadable, itemised by shot and take in credits, with one USD line at the bottom for what the pack cost. This is how a workspace bills its own client.

**Invite and onboarding flow**
- Request an invite (existing form) → lands in a **platform admin queue** → approve → invite email with a code → create account → **create a workspace or join one** → the workspace opens on a **starter production** (three shots pre-named, Setup defaulted from the platform layer, one demo cast member) → first render. Time this path; rule 6 says five minutes.
- Owners and admins invite their own team by email with a role. Invite links expire. Pending invites are visible in Team & roles.
- Workspace switcher in the header (the `partıcl ⌃` control) lists every workspace the user belongs to.

**Platform admin console** (separate from workspace Settings, separate route, platform-role gated)
- Invite queue, workspace list with spend / balance / margin, engine health and error rates, per-workspace suspend, content-policy flags.
- Platform layer editor: default Setup, camera bank, compiler rules, default caps — what every new workspace inherits.

**Isolation, limits and lifecycle**
- Per-workspace **rate limits and concurrency**, so one workspace's batch can't starve another's queue.
- Per-workspace **storage quota** with usage shown on Storage & masters.
- **Workspace export** (all masters + a CSV of every take, prompt and cost) and **workspace deletion** with a purge, both self-serve for the owner.
- **Shared identity with Atomik**: one account, one workspace list, one session across both apps. Both apps must enforce the same `workspace_id` scoping on the shared database.

**Policy**
- A written content policy, shown at signup. Engines will refuse some prompts; the failed-job reasons in 1.5 must say so plainly. A report path for review links and a platform-side suspend for abuse.
- Terms, privacy and data-retention for masters (how long, where) visible from Settings → Account.

### 1.1 Model breadth per shot
Higgsfield lets you pick the engine per job — Seedance for standard video, Kling for water and physics-heavy motion, a trained likeness model for faces, Nano Banana for stills. Particl is Seedance-only for video.

Build:
- An **engine abstraction** with one interface (`estimate(cost)`, `render`, `poll`, `fetchMaster`) and one adapter per provider: ByteDance/Seedance 2.5 and Google/Nano Banana Pro (existing), ElevenLabs (audio), **fal** carrying Kling 3.0, Kling 3.0 Motion, Topaz and Soul ID / Flux character as media models behind one adapter, and **Vercel** as the single LLM adapter (Claude, GPT) with the same `estimate` / `run` / meter shape so text calls are credits like everything else. Every adapter calls through the metering layer from 1.0. Wiring `FAL_KEY` and the fal adapter properly unlocks 1.1, 1.2 and 1.3 at once — do it first and do it once. Make adding another provider a one-file change.
- A **model row in the composer**, defaulted from the workspace's Defaults & caps (which inherit the platform default), overridable per shot. Next to each model, one line on what it's for ("Kling: water, cloth, physics").
- A **per-engine prompt compiler**. The Setup rows are engine-neutral; the compiler turns them into each engine's dialect. Seedance's rules are already partly encoded (one move per shot, term + what-happens for niche techniques, only subtitles/audio take a NO). Add Kling's and Nano Banana's. Rules live in the platform layer with workspace overrides (see 2.5). The Claude prompt engine under Atomik (via Vercel API) reads the same rule set — one source of truth for both apps, not two copies that drift.
- Cost estimate must work per engine and show the credit price on the button before pressing, as now with dollars.

Don't copy: Higgsfield's model marketplace. Five well-wired engines beat thirty.

### 1.2 Post tools on an Approved take
Higgsfield has upscale, reframe, outpaint, background removal, motion control. Particl renders and stops. An Approved take with no reframe or upscale is half-delivered — every team needs 9:16 and 1:1 cutdowns of every 16:9 approval.

Build, in this order:
- **Reframe** (aspect change with content-aware fill) — creates a new take under the same shot, versioned, named by convention.
- **Upscale** to delivery resolution via **Topaz on fal**.
- **Motion control** via **Kling 3.0 Motion on fal**: a cast still or approved frame plus a reference video, animated with that motion and camera. This is the one that saves re-rolling a performance.
- **Extend / last-frame continuation** for shots that need to run longer than one generation.
- Outpaint and background removal for stills.
Every post tool shows its credit price before pressing and files its output against the same shot. Post outputs are takes, not a separate bucket.

### 1.3 Identities that actually work
Higgsfield's trained characters (Soul) work today. Particl's equivalent — **Soul ID and Flux character training on fal** — is scaffolded but `FAL_KEY` isn't set. Until then `@Name` only carries a still, which is weaker than a trained likeness.

Build:
- Wire fal end to end: photo intake → Soul ID / Flux character training → status → identity available as a cast member. Credit price of training shown before pressing. Training is asynchronous; show it in the queue (1.5).
- Make `@Name` resolve to the trained model for stills and to the identity's hero still for video, automatically.
- Trained identities are **workspace-scoped and never shared, listed or reused across workspaces**. Consent: the person uploading photos confirms they have the right to train on that face; store that confirmation with the identity.

### 1.4 Visual camera bank
Higgsfield's presets are thumbnails — you pick by looking at the result. Particl's Studio is ~120 text chips with no search, no defaults, no recency. It already tracks "no take yet" per move, so it has the data to do better.

Build:
- A **short looping preview per camera move and technique**, generated **once, at platform level**, from a fixed neutral scene (one batch, in the internal test workspace, with my sign-off on cost), stored as platform assets and served to every workspace. Never regenerated per workspace.
- **Sort by "used in this production" then "used in this workspace" then alphabetical.** A move the workspace has used shows its own last take as the thumbnail instead of the neutral preview.
- **Search across all rows** ("dolly" finds Dolly zoom and Push in).
- **Sensible defaults** from the platform layer for a new production so "0 of 12 rows set" isn't the starting state.

### 1.5 Queue and job state
Higgsfield's concurrency cap is annoying but visible. Particl shows no job state on the make screen.

Build:
- A **queue strip** on the make screen: rendering / queued / failed, with per-job credits and shot, tappable. Reuse the library's existing states.
- **Failed jobs say why** (engine refused the prompt, engine error, project cap hit, balance at zero) and offer the right action (retry, edit prompt, ask an admin to unlock, top up).
- Show the workspace's concurrency limit and where it currently stands against it.

### 1.6 Batch variations
Higgsfield generates N variations of one prompt in one go. Particl is one render per press.

Build:
- A **count control** on the composer (1–4 for video, 1–8 for stills). The button shows the multiplied credits. All variations file under the same shot as sibling takes.
- The wall groups sibling takes so picking between them is one screen.

### 1.7 Proof it works, signed out — and on day one
Higgsfield's explore feed sells itself by showing output. Particl's signed-out state is a museum of empty states, and a new workspace's first screen is the same.

Build:
- One **platform demo production** visible signed out and from every empty state: three shots, a few takes each, one Approved, real credit numbers, a cast of two, Setup filled. Read-only. Made with generic, rights-clear content — no client work, no real people.
- The same production, copied into every new workspace as its **starter production** (see 1.0), editable, deletable.
- Keep the "sign in to render" gate exactly where it is.

### 1.8 Atomik — idea builder, shot builder and prompt enhancement (LLMs via Vercel API)
Atomik owns everything before the render: idea → treatment → scenes → shot list → prompts. Every LLM call it makes — Claude or GPT — goes through the **Vercel API** and the Vercel adapter from 1.1, metered and priced in credits through the same layer as rendering, so a workspace's credits pay for thinking and rendering out of one balance. fal is not in this path.

Build, in Atomik:
- **Prompt enhancement** as a first-class engine in the adapter registry: `enhance(prompt, targetEngine, setup, cast, rules)` → an engine-dialect prompt. It reads the rule library from 2.5 (platform + workspace) and the target engine's dialect, so a shot written once in Atomik comes out ready for Seedance, Kling or Nano Banana. Priced in credits, shown before pressing like any render; small, but never free and never hidden.
- **Idea builder**: from a logline or brief to a treatment and a scene list, in the workspace's voice. Each pass is a versioned document, not a chat transcript. The user can edit any line and re-run only from there.
- **Shot builder**: from a scene to a shot list with every Setup row pre-filled (shot size, angle, move, lens, lighting, time of day, look, mood), cast tagged with `@Name`, the recommended engine per shot, and an estimated credit cost per shot and per scene **before anything is rendered**. This is the planned budget that 2.6 hands to particl.
- Model choice: propose which Claude or GPT model per job (enhancement, idea, shot) through the Vercel API, with per-call credit cost. Enhancement is high-volume and should run on a fast, cheap model; idea and shot building can afford a stronger one. Use structured output for the shot builder so Setup rows land as fields, not prose to parse. Use prompt caching for the rule library and the workspace's Setup, which are the same on every call.
- Every generated line shows which model wrote it and can be regenerated alone. Nothing auto-overwrites a human edit.
- The same `workspace_id` scoping and the same content policy as particl.

Round-trip (from 2.6, now with real numbers): a shot approved in particl marks itself in Atomik's list; a shot added or re-budgeted in Atomik appears on particl's wall empty with its credit budget; the burn-down in 2.2 compares planned credits from Atomik against spent credits in particl per shot.

---

## 5. Phase 2 — Double down on what particl does that Higgsfield can't

These exist because particl has a shot model and a cost model and Higgsfield has neither. Push them until they're the reason a team picks particl.

### 2.1 Takes as selects
- **Compare view**: two to four sibling takes side by side, synced playback, one-tap Pick / Approve. This is the producer's phone screen.
- **Approval flow**: who picked, who approved, when. A shot with an Approved take is "locked"; rendering another take against it asks for a reason.
- **Notes on a take** (one line, `@person` mentions) so "the 3rd one but with the pan slower" is written on the take, not in WhatsApp.

### 2.2 Cost that lives with the shot, not just the button
- On the wall, every shot shows **takes so far · spent so far** ("6 takes · 172 credits").
- On the project, a **cap burn-down**: spent / cap, projected finish based on takes-per-shot so far, and which shots are burning it. The Usage page already promises "which shot is taking the most takes" — make that the headline chart, and make it per project.
- On the workspace, **balance and burn rate** — days of runway at the current pace.
- **Cost approval rule** (already in Defaults & caps): make it visible in the composer when it applies ("Over 50 credits needs an admin").
- Statements from 1.0 are the export; make sure they cut by project and by client-facing shot names so a workspace can bill its client from them directly.

### 2.3 Setup you can see and override
- The composer shows a **live diff**: which Setup rows are active, which the current prompt overrides, in one line ("Setup: 35mm · Golden hour · Handheld — this shot overrides: Locked off").
- **Per-shot override** without touching the workspace setup, and one-tap **clear for this shot**.
- **Three layers**: platform default → workspace Setup → project Setup → shot. Each inherits and overrides the one above; the UI shows where each active value came from.

### 2.3b / 2.3c — superseded
The graph work has moved to **Phase 3 — Rig** at the end of this brief, and now has a design handoff. Read that instead.

### 2.4 Cast that carries across everything
- A cast member's page shows **every take and still made with it**, across the workspace's projects (already promised in Studio — make it real and fast).
- **Consistency check**: when a take is rendered with `@Name`, thumbnail the cast still next to the take so a likeness drift is visible at a glance.
- Cast works identically in stills and video composers. Cast never crosses a workspace boundary.

### 2.5 A rule library, not a hard-coded compiler
Higgsfield forwards your text to the model. Particl should know what working teams have learned — and let each workspace add what it learns. Structure it as **platform rules** (everyone inherits) + **workspace rules** (their own, editable in Studio) + per-engine scope. Seed the platform layer with these:
- One camera move per shot; a travelling technique overrides the move row.
- Niche terms go out as term + what actually happens.
- Only subtitles and audio reliably accept a NO; everything else is described positively.
- Time of day and lighting are separate rows and never both say golden hour.
- **All-caps section headers in an image prompt leak into the render as burned-in captions** — the compiler writes camera and subject direction as plain sentences and always appends a no-lettering line.
- **Relative edits on Nano Banana plateau** ("make him smaller", "fade the colours a notch") — after two failed edit passes on a still, the UI offers "regenerate fresh with the full final look specified" instead of a third edit.
- Kling for water, cloth and physics; Seedance for everything else — surface this as the default model suggestion when the prompt contains those words.
Workspace rules are plain sentences the team writes ("our brand never shows logos in the first frame"); the compiler appends them to every prompt in scope. Rules show their source (platform / workspace) so a team can see and switch off a platform rule it disagrees with.

### 2.6 Atomik → particl → out
Atomik does idea → shot list. Particl does shot → takes. Close the loop on the way out:
- **Client review link**: a read-only page of a project's Approved takes, in shot order, with notes. No login; tokenised, expiring, revocable from the project; carries the workspace's name and logo, never particl's branding in front of their client. A comment box that writes back to the take's notes.
- **Export selects**: zip of Approved masters named by the convention, plus a CSV shotlist (shot, take, version, engine, credits, prompt) and an EDL/XML with the takes in order so an editor drops them straight into Resolve or Premiere.
- **Round-trip to Atomik**: when a shot is Approved here, Atomik's shot list shows it; when Atomik adds a shot, the wall shows it empty with its planned budget. Same workspace scoping on both sides.

### 2.7 Team on a phone
- The four things an admin or producer does on a phone: see what rendered, compare and approve, see the burn-down, unlock a cap or top up. Make each of those one tap from the make screen and test them at 360×640.
- Push notifications for "take finished", "cap at 80%", "approval needed", "balance low" — the Settings page already has the notifications section. Per-user, per-workspace preferences.

---

## 6. How to work

1. Explore the repo and confirm or correct every assumption in section 1. In particular: where keys live today, whether `workspace_id` is on every table, how Atomik shares auth and data, and what "its own database" actually means in the schema. Report back before changing anything.
2. Propose the vocabulary decisions from rule 5 as a table: current names → proposed single name → files affected. Wait for my answer.
3. Credits are decided (1 credit = US$0.10). Bring me the remaining 1.0 decisions as options with trade-offs: credit pack sizes, per-engine margin so that credit prices land on sensible numbers, and whether monthly invoicing ships now or later. For 1.8, bring me a shortlist of Claude / GPT models via the Vercel API for enhancement, idea building and shot building with per-call credit cost. Wait for my answer.
4. Phase 0 as one or two PRs with the Playwright suite. Screenshots at all three viewports in the PR description.
5. Phase 1 in the numbered order, one PR each, 1.0 first. Each PR includes: what it costs a workspace to use (per render / per training), how it's mocked in tests, what changed in the prompt compiler if anything, and where the new code is workspace-scoped.
6. Phase 2 after Phase 1 is merged, starting with 2.1 and 2.2 — those are the two a paying team will feel first.
7. Any time a task would spend real money on an engine, stop and ask.

---

## 7. Phase 3 — Rig

The node layer. It has a full design handoff in the repo at `docs/handoff/nodegraph/` — README.md (the seven surfaces), DESKTOP-README.md (shared design system, state model, Atomik sync contract), design-tokens.json, and design-references/. Read all of it before planning.

**Name.** The surface is called **Rig**. "Canvas" is already taken by the sequence wall at `/projects/:id/canvas`, and Rig is the right word twice over: on a set it's the wiring and mounting that holds a setup together, and in animation "rigging" is exactly what 2b does — binding a character's attributes to controls that everything downstream reads. Nav entry `RIG`, route `/projects/:id/rig`, mono label `RIG`. Recipes, runs, elements, ports, bindings and provenance are the nouns inside it.

**Seven surfaces**, from the handoff:
- `2a` Rig · asset layer (1440×900) — how characters, elements and backgrounds connect to shots
- `2b` Character attributes (390×844) — a character is four versioned attributes, not one asset
- `2c` Shot bindings (390×844) — what one shot points at, and what changing it costs
- `1a` Run view (390×844) — watching a recipe run, fixing a failed stage in place
- `1b` Impact panel (390×844) — editing a shared element with takes downstream
- `1c` Provenance card (390×844) — exactly what produced a finished take
- `1d` Rig · stage layer (1440×900) — the recipe as an editable stage graph, chat alongside

The two desktop surfaces are two layers of one screen behind an `Assets | Stages | Runs` switcher, not two screens.

**The seven rules the surfaces enforce** (from the handoff — these are the acceptance criteria):
1. The price is on the action, quoted before the button enables.
2. State vocabulary: `queued → running → done`, plus `needs you` for failure and `locked` for pinned.
3. Take states stay `draft → picked → approved`; only approved reaches assembly.
4. A failure never restarts a run — it offers priced fixes in place.
5. Nothing re-renders silently; any edit to a shared element opens the impact panel first.
6. A wire lands on a slot, not a node. Ports are the unit of connection.
7. Versions are additive. A new version never alters an existing take; the *swap* is what costs.

**Port identity is `elementId:attributeId:versionId`.** That triple is what a wire carries and what provenance records. It is the single most important line in the handoff — everything else in Rig is bookkeeping on top of it.

**Elements can be created from takes** (the handoff's example: a prop promoted from an approved take, then bound into six other shots). The dashed creation wire in 2a is that loop. Design the schema for it from the start.

**Build order** — data model first, mobile before desktop, canvas last:
1. Schema: `recipe`, `stage`, `run`, `failure`, `element`, `attribute`, `version`, `binding`, `provenance`, `impact`, `quote` (shapes are in the handoff). Workspace-scoped like everything else. Migration from what 1.0 shipped.
2. The quote/impact engine — what a change costs, before it happens. Everything visible depends on it.
3. Mobile surfaces in this order: `1a` run view, `1b` impact panel, `1c` provenance, `2c` shot bindings, `2b` character attributes.
4. Desktop `1d` stage layer, then `2a` asset layer.
5. Chat panel drives the graph; the canvas is a view of what chat did, never the only way to edit.

**Where it lives.** Recipe authoring belongs in Atomik (planning); running recipes and their outputs belong in particl (rendering). Same graph, same workspace scoping, one database. The Atomik ⇄ particl sync contract in DESKTOP-README governs the handoff both ways.

**Constraints that do not relax for this phase:** rule 6 (five minutes to first render — a new user must never need to open Rig) and rule 7 (mobile first-class — five of the seven surfaces are 390×844 and must pass the Phase 0 Playwright suite). The desktop canvas is min-width 1180px and may be hidden below that; the mobile surfaces may not.

**Do not port `support.js`** — it is a preview runtime for opening the HTML standalone. Recreate every surface in the existing Next/React components, routing and styling patterns. The striped grey rectangles are image placeholders; in production they are real keyframes, take thumbnails, reference photos, location plates and turntable views. Do not ship a surface with text where a thumbnail belongs.
