# Claude Code — implementation prompt (paste as the FIRST message of a fresh session, typed at the `>` prompt)

I am the user, typing at the prompt. This message is the brief; everything it references is in the repo.

## Read first, in this order
1. `design/particl-suites/FINAL_SPEC.md` — the order of work and the exact Higgsfield contracts. It wins every disagreement.
2. `design/particl-suites/README.md` — screen-by-screen spec (layout, copy, interactions, state, tokens).
3. `design/particl-suites/CREW_ADDENDUM.md` and `MOBILE_ADDENDUM.md` — only when you reach those steps.
4. Open the prototypes in a browser next to the app while you work: `design/particl-suites/Particl Suites.dc.html` (desktop), `Particl Mobile.dc.html`, `Particl Crew.dc.html`. They are click-through references, not code to copy.
5. `CLAUDE.md` (rate card, repo conventions), `lib/shell/*`, `components/graphite/*`, `app/graphite.css`, `lib/higgsfield-consumer/{video-contract,genjutsu-contract,catalogue}.ts`, `app/api/prompt/enhance/route.ts` — so you know what exists.

## What exists — do not rebuild
The Graphite shell (`components/graphite/*`, `lib/shell/*`, `app/graphite.css` `--gx-*` tokens), the `⌘K` palette, context menu + undo scaffolding, the enhancer route (quote → approve → charge via `lib/paidText`; providers higgsfield | claude | openai; `raw:` bypass), Crew (`app/api/crew/*`, xAI Grok), and the Higgsfield consumer layer (OAuth, catalogue, generation, Genjutsu, prompt-only marketing video, shorts, voice tools). Extend these files; do not fork or duplicate them.

## What you are finishing
Work FINAL_SPEC §1 in order. One branch per step (`feat/suites-01-assets` … `feat/suites-06-flair`). Each step ends with typecheck + lint clean, the acceptance checks for that step passing, and a short PR description listing files changed and how you verified against the prototype. Do not start the next step until the current one is navigable end-to-end with no dead buttons.

**Step 1 — Assets on every page.** Enable Library `+` (sends the asset into the current composer with the right role; toast names the role). Every asset tile `draggable` (`text/plain` = asset id); drop targets = Gen reference well, Business/Viral media wells, Rig nodes. Replace the `WHY … LATER` stubs in `SuitesShell.tsx`: cut / paste / duplicate / move to project / delete (soft, 30 days) / use as reference / open in Inspector / retry, each pushing an inverse onto the undo stack. Inspector shows asset provenance + actions; still preview is a fixed 180px card; Inspector hides via `×`, the page-head toggle (every width) and `⌘J`.

**Step 2 — Business = Higgsfield Marketing Studio.** Give `ads`, `dtc`, `setup` their own pages (retire the shared legacy `marketing` mapping in `lib/shell/ia.ts`). Extend `lib/higgsfield-consumer/video-contract.ts` per FINAL_SPEC §2.1: `product_ids | web_product_ids` (never both), `avatars[{id,type}]`, `hook_id`, `setting_id`, `ad_reference_id`, `medias[{id, role: image|start_image|end_image}]` ≤14, Click-to-Ad `product.url`, duration presets 15/30 s (cap from the live schema), resolution 480p/720p/1080p, `generate_audio`. Enforce both rules client- and server-side: hook/setting only for `ugc, ugc_how_to, ugc_unboxing, product_review, ugc_virtual_try_on`; hook/setting never together with an ad reference (disabled chips at 40 % with a tooltip, never hidden). Relax `consumerVideoOriginalResult` so a job that carries the ids/medias we sent is recognised. Add DTC (§2.2: `format_id` required, brand kit must be `completed`, avatar ≤1, product ≤1, media ≤14, aspect/resolution/quality/batch 1–20, `--cost-only` quote) and Setup (§2.3: products fetch-by-URL and create-from-uploads, avatars preset/custom/from-identity, hooks, settings, ad references from an upload or a job, brand kits fetch-by-URL, ad formats read-only). Every Setup row opens the Inspector with *Use in Ads* / *Use in Image ads*.

**Step 3 — Viral = Genjutsu.** Surface the existing `genjutsu-service` in Motion Transfer and Object Swap: exactly one source video 4–30 s (index 0, `video_references`) + up to 30 ordered images (`image_references`), 480p/720p/1080p, optional prompt, **live estimate required** — a stale or missing estimate blocks submit with the reason inline. History = this project's Genjutsu results with Recreate / Compare / Send to Edit.

**Step 4 — Gen from the live catalogue.** Model sheet in two groups (Studio engines from the rate card; Higgsfield catalogue from `catalogue.ts`). Render aspect / resolution / duration / roles from each model's schema — never a hard-coded list. Length: every second across the range for range models (Seedance 2.5 = 4–30 s), exactly the closed list otherwise (Veo 3.1 = 4/6/8; Hailuo = 6/10; Kling = 5/10/15). Clamp server-side and show the clamped value; surface account `adjustments` for approval, never auto-accept them (`unapproved_adjustment`). Reference roles per family as FINAL_SPEC §3; hide the well for prompt-only models; `brain_activity` takes one video and no prompt. Workflows (`reframe`, `draw_to_video`, `dubbing`, `voice-change`) wired to Deliver › Social cuts, Astra › Draw to edit, Edit › Dialogue/Dubbing. Soul ID from Cast › Build identity with the paid-plan gate. Enhancer passthrough (§4): `enhance_prompt: true` when Auto is on for models whose schema declares it; show the account's `enhanced_prompt` labelled "Enhanced on Higgsfield"; `raw:` sends `false` and is never rewritten.

**Step 5 — Atomik › Skills + Workspace.** Skills rows = the eight `higgsfield-ai/skills` packs (§5) with *Install*. Rebuild the six Workspace tabs in Graphite (General incl. the enhancer selector, People, Plans & credits, Usage, Engines incl. the xAI row, Security) — no more links out to legacy pages.

**Step 6 — Flair layer, then mobile.** Apply FINAL_SPEC §6 as additive CSS on top of `--gx-*`: suite-tinted header aurora + dot grid + gradient baseline, glyph suite tabs with signature dots (icons only below 1180px), gradient primaries with glow, layered cards, glass segment tracks, gradient display titles, panel grounds, framed Library › Tools groups with department-tinted tag tiles, kind-dot filter chips, project poster tiles, glowing running pill, Crew glyph. Then the mobile web app below 768px per `MOBILE_ADDENDUM.md` and `Particl Mobile.dc.html` — tap targets ≥ 44px, sticky Generate CTA, sheets.

## Non-negotiables
- One composer (every tool is a preset that opens Gen or the page's own composer). One credit balance shown in `cr`. Assets on every page. Every card, tool row and list row routes somewhere real.
- Nothing paid runs without a live quote the user saw; failed renders are never billed; a changed price refuses instead of charging more.
- Blocked buttons show the reason inline; no silent disabled states; no dead toasts.
- Match the prototypes' copy verbatim. Base tokens stay `--gx-*`; the flair layer is additive.
- Keep existing endpoints, roles and prices. New routes only as FINAL_SPEC lists them.
- Ask me only when FINAL_SPEC and a prototype genuinely disagree. Otherwise decide and note it in the PR.

## Acceptance (run before you call a step done)
Diff the app against `Particl Suites.dc.html` at 1440 and 1180: header tint changes per suite; suite tabs show glyph + dot; Library › Tools shows framed groups; `+` and drag/drop land a reference with the right role; Ads refuses hook/setting outside the UGC family and with an ad reference; DTC blocks without a format; Viral needs one 4–30 s video + ≥1 image + a live estimate; Gen › Length is per-second for Seedance 2.5 and the closed list for Veo; `raw:` is never enhanced; every right-click command works or states exactly why not; Inspector hides three ways; Crew tab has its glyph.

Start now: read the files above, then reply with the list of files you will create or change for Step 1 — nothing else — and wait for my go.
