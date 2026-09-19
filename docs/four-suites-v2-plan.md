# Four suites v2 — the restructure plan

Owner brief, 19 September 2026. Home opens on a project selector, then four suites: **Particl Production Studio · Atomik Super Agent · Moleculr Business Suite · Subatomik Viral Studio**. Top-right controls unchanged. Provider names never appear in the product.

| Suite | Target |
| --- | --- |
| Particl Production Studio | Brief & Script (one agentic stage) → Boards → Cast & Elements (identity features only, our naming) → Astra blender → Rig (bugs fixed) → Takes (whole project library: uploads + generations) → Edit & Sound (ElevenLabs wired in) → Deliver |
| Atomik Super Agent | every feature and workflow of the Higgsfield agent surface, under our own names |
| Moleculr Business Suite | Marketing Studio only, feature-for-feature with Higgsfield Marketing Studio |
| Subatomik Viral Studio | every Genjutsu feature as on the Higgsfield site; Higgsfield credit billing folded in silently |

This plan is written from a read-only inventory of the current code (19 September) and the provider capability docs (`docs/moleculr-provider-capabilities.md`, `docs/subatomik-genjutsu.md`, `docs/higgsfield-soul-integration.md`, `docs/four-suite-apis.md`). Rules carried over from the handover: a feature ships only when its provider contract is verified through the authenticated API; paid qualification runs only under a stated ceiling; nothing is presented as parity without evidence.

## What is buildable now, what is gated, what is blocked

**Buildable now (our code only)**
- The whole information architecture: labels, order, merging Brief+Script and Cast+Elements, folding Look into Boards, project selector first, Moleculr as one Marketing Studio page, one label vocabulary instead of three. → **PR A** (in progress).
- Takes as the project library: `resolveProjectLibrary` already scopes uploads and generations to a project; the stage links out to `/library` instead of embedding them. → **PR B**.
- Edit & Sound: the Edit inspector has no ElevenLabs control; speech, sound effects and music generation exist behind `/api/audio` (`text-to-speech`, `sound-generation`, `music`). Add a Sound tab that generates directly into the dialogue/music/sfx lanes. → **PR C**. Dubbing and speech-to-speech are ElevenLabs endpoints the app does not call; they are added only after a priced, verified call each. → **PR C2**.
- Brief & Script "agentic": the development flow (`docs/agentic-development.md`) already serves both stages from one saved workflow; the merged stage makes the run dialog and development the primary actions. → **PR A/PR D**.
- Subatomik billing: the explicit "Particl billing / Connected credits" toggle becomes a default to connected credits with the wallet caveat kept in the approval step (never removed: the wallet is shared account-wide). → **PR H**.
- Rig bug pass: a full run of the Rig browser specs at five viewports plus an issue sweep. → **PR E**.

**Gated on provider verification (needs a paid or read-only qualification first)**
- Cast & Elements on identity only: Soul ID training is implemented and priced ($2.50 per training); Soul Character generation is implemented but gated off because the provider's model page returned 404 on 17 September and there is no verified generation price. Until a verified contract exists, Cast & Elements can train identities but generates through the existing image engines. The older fal LoRA identity path leaves the navigation but its data stays. → **PR F**, then a paid qualification.
- Marketing Studio parity: Cloud image generation with presets is live; `marketing_studio_v2_create`/`_status` (website templates) are advertised by the connected account but unwired; consumer brand/product/avatar entities are not advertised at all; the marketing-video creative mode is unqualified. → **PR G** wires v2 create/status behind the quote/claim/receipt pattern, then one approved run.
- Genjutsu: the authenticated API exposes exactly two features, Motion Transfer and Object Swap (Cloud: 480p/720p, ≤8 images; connected account: 1080p, ≤30 images). The website's community motion gallery and presets are not in the API. "Every Genjutsu feature as on the website" therefore means those two, at the connected account's limits, plus the surrounding workflow already built. Anything else would be invented.

**Blocked (no verified contract)**
- Virality scoring (`brain_activity` / `virality_predictor` return "Model not found" and have no non-submitting price call).
- The Higgsfield agent tools not reachable through the connected account's advertised surface: 3D, audio, standalone motion control, reframe, upscale, background removal, outpaint, voice, dubbing, video analysis, shorts, clipper, scene builder, publishing. Equivalents that already exist run on other engines (Topaz upscale, Luma reframe, Bria cutout/expand, ElevenLabs audio) and stay.
- Per-request wallet binding on the connected account (workspace selection is global); unattended multi-tenant spending stays unqualified.

## Atomik Super Agent — what "every feature" becomes

Atomik today orchestrates Particl's own engines (runs, recipes, approvals, budget, models). The connected-account tool surface reachable from the app is: `list_workspaces`, `models_explore`, `marketing_studio_v2_presets/_costs`, `get_workflow_instructions`, `generate_video` (marketing video and the two Genjutsu models), `job_status`, `media_import_url`. Plan: expose these as Atomik workflows under our names — Campaign video, Motion transfer, Object swap, Template catalogue — each behind the existing quote → approve → claim → receipt pattern, owner-scoped as today, and add further tools one per PR only after `models_explore` returns a priced contract for that tool. → **PR I** (first four workflows).

## Order

1. **PR A** IA restructure (labels, order, merges, aliases, home, Moleculr page, tests) — in progress.
2. **PR B** Takes = project library in-stage.
3. **PR C** Edit & Sound generation controls; **C2** dubbing/speech-to-speech after verification.
4. **PR E** Rig bug pass.
5. **PR H** Subatomik default to connected credits.
6. **PR F** Cast & Elements identity-first (training now; generation when verified).
7. **PR G** Marketing Studio v2 templates (create/status), approved run.
8. **PR I** Atomik workflows over the verified tool surface.
9. Provider qualifications (each with a stated ceiling): Soul Character, Marketing v2, Genjutsu connected 1080p, marketing video in product_showcase mode.

Each PR ships desktop and the mobile theme together, with the browser suites at 360×640, 390×844, 844×390, 1440×900 and 1920×1080, and updates this document.
