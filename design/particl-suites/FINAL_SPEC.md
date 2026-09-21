# Particl Suites — FINAL SPEC for Claude Code (v3, 21 Sep 2026)

**Repo:** `axy-full/aimighty-workspace` · **Reference API:** `higgsfield-ai/cli` (README.md, MODELS.md) + `higgsfield-ai/skills` (higgsfield-generate/SKILL.md + references/).
**Supersedes:** `design/particl-suites/README.md`, `CLAUDE_CODE_PROMPT.md`, `CREW_ADDENDUM.md`, `MOBILE_ADDENDUM.md` where they disagree. Those files stay as detail; this one is the order of work.

This is a **delta**: what the repo already has vs. what is left, then the exact Higgsfield contracts to wire, then the visual layer to apply on top. Every claim below about the repo was read from `main` today.

---

## 0 · Where the repo is (read from `main`)

Already built — keep, do not rebuild:
- Shell: `components/graphite/{SuitesShell,Header,StageStrip,ProjectHead,PageHead,Library,Inspector,Palette,ContextMenu,GenView,WorkspaceView}.tsx`, `components/graphite/crew/*`, state in `lib/shell/{ia,state,palette,context-menu,undo,enhancer,use-enhancer}.ts`, tokens in `app/graphite.css` (`--gx-*`), Crew styles in `app/crew.css`.
- IA in `lib/shell/ia.ts`: Studio (8) · Business (ads · dtc · setup) · Viral (motion · swap · history) · Atomik (agent · runs · approvals · budget · models · skills) · views `gen`, `workspace`, `crew`. Header segment Studio | Gen | Business | Viral | Atomik | Crew.
- Enhancer: `POST /api/prompt/enhance` (quote → approve → charge via `lib/paidText`), providers `higgsfield | claude | openai` (`lib/shell/enhancer.ts`), `raw:` bypass, citation-preserving parse, Workspace › General selector.
- Crew: `app/api/crew/*` (members, sessions, rounds SSE, solutions route, minutes, notes, status/verify), xAI in `lib/crew/xai`.
- Higgsfield consumer layer (`lib/higgsfield-consumer/*`, `app/api/higgsfield/consumer/*`): OAuth connection, catalogue, generation, **Genjutsu** (`hf_mult_motion_control`, `hf_mult_replace_object`; source video index 0 + ≤30 image refs; 480p/720p/1080p; quote → approve → submit → poll), **marketing video** (prompt-only: `marketing_studio_video` with mode/aspect/duration 12–15/resolution/generate_audio; **no products, avatars, hooks, settings, ad references, medias yet** — `consumerVideoOriginalResult` even refuses jobs that carry them), shorts, voice tools, marketing templates, planner, recipes.

Known stubs in the shell (from the source):
- `SuitesShell.tsx` `WHY` map: cut/paste/duplicate/move/delete/use-as-reference → "Arrives with asset actions in the next build step."
- `Library.tsx`: the `+` (use as reference) button is `disabled`.
- `WorkspaceView.tsx`: tabs still link out to legacy pages "until build step 6".
- Business pages `ads · dtc · setup` all map to the legacy `marketing` page (`ia.ts` comment: "narrows as later build steps give Business and Viral their own composers").

---

## 1 · Order of work (ship each as a working increment)

1. **Assets on every page** — finish `Library` `+`, drag/drop targets, context-menu asset commands (cut/paste/duplicate/move/delete + undo), Inspector asset detail. (README › Interactions.)
2. **Business = Marketing Studio, for real** — three composers below, on the existing consumer layer (extend `video-contract.ts`, do not fork).
3. **Viral = Genjutsu** — surface the existing `genjutsu-service` in the shell's Motion Transfer / Object Swap pages; History = the project's Genjutsu results.
4. **Gen** — model sheet from the live Higgsfield catalogue (§3), per-second Length 4–30 for video engines with server-side clamp, references with per-model roles, `enhance_prompt` passthrough (§4).
5. **Atomik › Skills** = the `higgsfield-ai/skills` packs (§5). Workspace tabs rebuilt in Graphite (step 6 in the old plan).
6. **Flair layer** (§6) across desktop; then **mobile** (`Particl Mobile.dc.html`, `MOBILE_ADDENDUM.md`).
7. Crew: nothing new — verify it matches `Particl Crew.dc.html` after the flair layer (§6 lists the Crew-specific bits).

---

## 2 · Business — Higgsfield Marketing Studio (exact contracts)

Source of truth: `cli/MODELS.md › marketing_studio_video`, `marketing_studio_image`; `skills/higgsfield-generate/SKILL.md › Marketing Studio`; `references/marketing-modes.md`, `marketing-dtc-ads.md`.

### 2.1 Ads (`business/ads`) → `marketing_studio_video`
Params (all echoed by the account; validate against the live schema with `models_explore(get marketing_studio_video)` like Genjutsu does):
- `prompt` (required) · `mode` default `ugc` — slugs `ugc, ugc_how_to, ugc_unboxing, product_showcase, product_review, tv_spot, wild_card, ugc_virtual_try_on, virtual_try_on`
- `aspect_ratio` `auto | 21:9 | 16:9 | 4:3 | 1:1 | 3:4 | 9:16` (default 16:9; the UI defaults to 9:16 for UGC)
- `duration` integer ≥ 4 (repo currently clamps 12–15; keep the two presets **15 s · 30 s** and let the schema decide the cap) · `resolution` `480p | 720p | 1080p` · `generate_audio` boolean
- `product_ids: string[]` **or** `web_product_ids` (never both) · `avatars: [{id, type: "preset"|"custom"}]`
- `hook_id`, `setting_id` — **only** for `ugc, ugc_how_to, ugc_unboxing, product_review, ugc_virtual_try_on`; **never with `ad_reference_id`** (server rule: "Ad_reference_id cannot be combined with hook_id or setting_id")
- `ad_reference_id` · `medias[{id, role: image | start_image | end_image}]` ≤ 14 · Click-to-Ad: `product: { url }` / `--url` (backend fetches + dedupes by URL)
- `specific_mode` `default | web_product | from_storyboard`, `storyboard_id`, `web_product_type` — expose only when a web product / storyboard is selected.

UI (matches `Particl Suites.dc.html › Business › Ads`): chip rows Mode · Product (+ *From URL…* reveals the Click-to-Ad field) · Avatar (None · auto = backend synthesises a Soul Character for UGC modes · presets · custom) · Hook · Setting · Ad reference · Aspect · Duration · Resolution · Audio; Prompt + Enhance; reference-stills well (roles cycle image → start_image → end_image). Hook/Setting chips disabled (40 % opacity + tooltip) outside the UGC family or when an ad reference is chosen; choosing an ad reference clears hook/setting and vice-versa. Primary `Generate ad · n cr` from the live `get_cost` quote; blocked with the reason inline.

Repo work: widen `consumerVideoInputSchema` (products, avatars, hook/setting, adReference, medias, productUrl), send them in `consumerVideoParams`, and **relax `consumerVideoOriginalResult`** so a job carrying the sent ids/medias is recognised (today it returns null if any of these arrays is non-empty).

### 2.2 Image ads (`business/dtc`) → DTC Ads Engine (`marketing-studio dtc-ads generate`)
- `prompt` (req) · `format_id` **(req, no default — always a user pick from `ad-formats list`)** · `brand_kit_id` (kit must be `status: completed`) · `avatar` ≤1 (`id[:preset|custom]`) · `product` ≤1 · `media` ≤14 (`id[:role]`, default role `image`) · `aspect_ratio` `1:1 3:2 2:3 4:3 3:4 16:9 9:16 21:9 27:16 16:27 9:8 8:9 4:9 9:4 auto` · `resolution` `1k 2k 4k` · `quality` `low medium high` · `batch_size` 1–20 · `--cost-only` for the quote.
- Also expose `marketing_studio_image` (≤14 refs; `aspect auto` needs a ref; prompt **or** ≥1 ref required) as the *Image ads › plain* variant.

### 2.3 Setup (`business/setup`) — one list, typed rows
`products` (fetch --url → background import, dedupe by URL; create from ≤5 uploads) · `avatars` (preset list; custom from photos; **or** a Production identity) · `hooks` · `settings` · `ad-references` (create from `--video-input <upload>` or `--job <job>`; bound to avatar/product) · `brand-kits` (fetch --url --wait; status completed) · `ad-formats` (read-only). Every row opens the Inspector; *Use in Ads* / *Use in Image ads* pre-select it in the composer.

---

## 3 · Gen — Higgsfield catalogue (live, not hard-coded)

Model sheet groups: **Studio engines** (ModelArk Seedance, fal Kling/Topaz/Flux, ElevenLabs — the repo's own rate card) and **Higgsfield catalogue** (from `catalogue.ts`, filtered by type). Per model read `aspect_ratios`, `durations` (closed list **or** min/max range), `parameters`, `medias` roles — the CLI's `model get` shape — and render chips from that. Never invent an option.

Per-second Length: for engines whose `durations` is a range (Seedance 2.5: 4–30 s, `mode t2v | omni_reference | video_edit | video_extension`), the Length `<select>` lists every second in range; for closed lists (Veo 3.1: 4/6/8; Hailuo: 6/10; Kling: 5/10/15) list exactly those. Clamp server-side and show the clamped value (`adjustments` come back from the account — surface them, never auto-accept: see `parseConsumerCreditsForParams › unapproved_adjustment`).

Reference roles per family (from `references/media-inputs.md`): Seedance 2.5 `start_image, end_image, image_references, video_references, audio_references` (mode `omni_reference`; `t2v` takes none) · Seedance 2.0 `image, start_image, end_image, video, audio` (≤9 images incl. start/end, ≤3 video, ≤3 audio, ≤12 total) · Gemini Omni ≤7 images or 1 video (+≤5 images) · Kling 3.0 `start_image, end_image` · Veo 3.1 / Kling Turbo / Grok 1.5 single `start_image` (Grok requires it) · image models `image_references` (Nano Banana Pro ≤14, GPT Image 2.5 ≤16, Flux Kontext ≤4, Soul V2 / Soul Cinematic single + `soul_id`) · prompt-only: `z_image, recraft_v4_1, soul_cast, soul_location, sonilo_music, mirelo_text_to_audio` (hide the well) · `brain_activity` exactly one `video`, no prompt · `multi_image_to_3d` 1–4 images, `should_texture`.

Defaults (SKILL.md): image → GPT Image 2.5; video → Seedance 2.5; character/reference stills → Nano Banana 2 / Lite / Pro; ads → Marketing Studio; audio → Seed Audio 1.0; 3D → Multi-Image to 3D; analysis → Virality Predictor (`brain_activity`, text report + Open-report link, never surface `.glb/.bin`).

Workflows (separate from models; `workflow list / get`): `draw_to_video` (video + sketch + timestamp + prompt), `reframe` (video + aspect + resolution, mode std|pro), `voice-change`, `dubbing` (ISO-639-3). Studio › Deliver › *Social cuts* = `reframe`; Studio › Astra › *Draw to edit* = `draw_to_video`; Edit › Dialogue = `text2speech_v2` (variant + voice_type + voice_id from `voices list`). Cost via `generate cost workflow …` (voice-change/dubbing have none — say so).

Soul ID (Cast › *Build identity*): `soul-id create --name --soul-2|--soul-cinematic --image ×5–20` → wait → reuse via `soul_id` on `text2image_soul_v2` / `soul_cinematic`. Paid plan required — show the plan gate before submitting.

---

## 4 · Prompt enhancer — final wiring

Keep `lib/shell/enhancer.ts` as is (it already encodes Higgsfield's published rules). Add the passthrough: for catalogue jobs whose schema declares `enhance_prompt` (Cinematic Studio 3.0 / 3.5, `marketing_studio_video` echoes `enhanced_prompt`), send `enhance_prompt: true` when *Auto* is on and show the account's `enhanced_prompt` in the result card, labelled "Enhanced on Higgsfield". `raw:` prompts send `enhance_prompt: false` and are never rewritten locally. One cr for a local enhancement; the passthrough is free (it is part of the render).

---

## 5 · Atomik › Skills = higgsfield-ai/skills

Rows (name · one line · *Install* opens the pack): `higgsfield-generate` (images/video/3D/audio/Marketing Studio/Virality) · `higgsfield-soul-id` · `higgsfield-brandkit` · `higgsfield-product-photoshoot` · `higgsfield-youtube-thumbnail` · `higgsfield-video-explainer` (Seed Audio narration + Gemini Omni clips → `explainer_video` assembler) · `higgsfield-websites` (`website create --type app --template app-detail|preset|studio`) · `higgsfield-marketplace-cards`. The agent's tool reach is these packs; Atomik › Models keeps thinking-model choice separate from engines.

---

## 6 · Visual — the flair layer (additive to `app/graphite.css`)

Base tokens stay exactly as in `app/graphite.css`. Add these on top (values from `Particl Suites.dc.html`, applied 21 Sep):

- **Header 60px**, `position:relative; overflow:hidden`. Two blurred radial blobs (`filter: blur(36px|40px)`, opacity .75/.6, drift 12 s / 14 s `om-drift`, `om-drift2`). Blob A tint per view: Studio `rgba(10,132,255,.55)` · Business `rgba(255,159,10,.45)` · Viral `rgba(255,69,58,.4)` · Atomik `rgba(48,209,88,.4)` · Gen `rgba(191,90,242,.5)` · Workspace `rgba(100,210,255,.4)` · Crew `rgba(191,90,242,.5)`. Blob B violet `rgba(191,90,242,.38)` (blue in Gen). Over them: 14px dot grid `rgba(255,255,255,.06)` masked to fade downward; 1px baseline `linear-gradient(90deg, transparent, rgba(10,132,255,.7) 25%, rgba(191,90,242,.6) 55%, transparent 85%)`. Mark fill gradient `#F5F5F7 → #6EB4FF` with a breathing glow (`om-breathe` 3.2 s); suite badge = mono pill `#6EB4FF` on `rgba(10,132,255,.14)` / border `.35`; avatar ring `0 0 0 2px #000, 0 0 0 3px rgba(10,132,255,.45)`.
- **Suite picker**: track `rgba(255,255,255,.06)`, border `.10`, `inset 0 1px 2px rgba(0,0,0,.6)`, radius 9, gap 2. Each tab = glyph + label + 5px signature dot; suite colours Studio `#0A84FF` (clapper) · Business `#FF9F0A` (tag) · Viral `#FF453A` (bolt) · Atomik `#30D158` (atom) · Crew `#BF5AF2` (three agents around a chair). Active thumb `linear-gradient(180deg, rgba(255,255,255,.13), rgba(255,255,255,.06))`, shadow `0 2px 10px rgba(0,0,0,.55), inset 0 1px 0 rgba(255,255,255,.16), inset 0 -1px 0 <colour>55`; icon glows `drop-shadow(0 0 5px <colour>99)`. Below **1180px** labels drop, icons stay.
- **Primary buttons**: `linear-gradient(160deg,#4C9DFF,#0A84FF 55%,#0064D6)`, `0 6px 18px rgba(10,132,255,.32), inset 0 1px 0 rgba(255,255,255,.28)`, hover `filter: brightness(1.08)`; Gen Generate 44px r10; page primary 34px r8.
- **Cards**: `linear-gradient(180deg,#1B1B20,#141417)` + `inset 0 1px 0 rgba(255,255,255,.05), 0 8px 20px rgba(0,0,0,.3)`.
- **Segment tracks** as the suite picker; selected thumb `linear-gradient(180deg,#45454C,#2E2E34)` + `0 2px 8px rgba(0,0,0,.5), inset 0 1px 0 rgba(255,255,255,.12)`.
- **Display titles** 26–28/700/−0.035em with `background-clip:text` `#FFFFFF → rgba(235,235,245,.72)`.
- **Grounds**: stage strip `linear-gradient(180deg, rgba(255,255,255,.025), transparent)`; main `radial-gradient(90% 50% at 50% -10%, rgba(10,132,255,.10), transparent 60%)` over `#0D0D10`; Library/Inspector `linear-gradient(180deg,#111114,#0D0D10 120px)`.
- **Library › Tools**: each department a framed card (`linear-gradient(180deg,#15151A,#101013)`, border `.10`, r10, `flex:none`) with a header row (6px glowing colour dot · eyebrow title · count badge `rgba(255,255,255,.08)`), rows divided by `rgba(255,255,255,.06)`, 36px tag tile tinted in the department colour (`<c>55 → <c>1F`, border `<c>66`), trailing chevron. Department colours cycle `#0A84FF, #BF5AF2, #FF9F0A, #30D158, #64D2FF, #FF453A`. Tabs get icons (wrench · stack) + count badges (blue pill when active); search field has a leading magnifier; filter chips carry kind dots — image `#0A84FF`, video `#30D158`, audio `#BF5AF2`, uploads `#FF9F0A`, All = 3-stop gradient.
- **Project poster**: head tile 72×46 r8 (switcher rows 56×36): project gradient + blurred colour signature top-right + mono initials + a 2px film-strip baseline. Sample palette Dune Studies `#7A5A34→#1A120B` / amber; Northline `#2E4A6A→#0B1420` / blue; Untitled `#3A3A40→#141416`.
- **Inspector**: still preview is a fixed **180px** card (not aspect-ratio — it collapsed in the flex column); hideable via `×` in its header, the *Inspector* toggle in the page head (lit when open, every width), and `⌘J`.
- **Running pill**: `0 0 16px rgba(10,132,255,.25)` + glowing dot.
- **Crew**: header badge `CREW` violet pill; active tab carries the crew glyph + violet dot; everything else inherits.
- Motion: `om-in` 400ms, `om-pop` 150–300ms, `om-breathe` 3.2s, `om-drift` 12s, `om-drift2` 14s, easing `cubic-bezier(.2,.7,.2,1)`.

Mobile mirrors the same layer (`Particl Mobile.dc.html`): glass tab bar with glowing active tab, glowing stage dots, glass sheets, gradient balance, suite tabs with glyphs, kind-dot chips, poster thumbnails; all tap targets ≥ 44px.

---

## 7 · Acceptance (diff against the prototypes)

Open `design/particl-suites/Particl Suites.dc.html` beside the app at 1440 and 1180 and check: header aurora changes tint per suite; suite tabs show glyph + dot; Library › Tools framed groups with tinted tiles; `+` on any asset lands it in the current composer as a reference with the right role; Business › Ads refuses hook/setting outside the UGC family and with an ad reference (disabled chips, tooltip); DTC blocks without a format; Viral requires one 4–30 s video + ≥1 image and a **live** estimate; Gen › Length lists every second for Seedance 2.5 and only the closed list for Veo; a `raw:` prompt is never enhanced; every right-click command works or says exactly why not; Inspector hides three ways; Crew tab shows its glyph.

---

## Files in this folder
`Particl Suites.dc.html` (desktop, flair applied) · `Particl Mobile.dc.html` · `Particl Crew.dc.html` · `support.js`, `image-slot.js`, `ios-frame.jsx` · `README.md` (full screen-by-screen spec) · `CLAUDE_CODE_PROMPT.md` (original brief) · `CREW_ADDENDUM.md` · `MOBILE_ADDENDUM.md` · `screenshots/` · `reference/`.
