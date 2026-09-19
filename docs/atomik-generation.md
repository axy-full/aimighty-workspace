# Atomik Generate — catalogue-driven workflows on the connected account

PR I, slice I1 (19 September 2026). Atomik Super Agent gains a **Generate** page with four workflows — Image, Video, Sound and 3D — that run on the workspace owner's connected account. The page never names the provider: it speaks of the connected account, its wallet and its credits. Slice I2 (same day) adds a second group, **Tools**, on the same page; see "Tools" below. Slice I3 (same day) adds a third group, **Voice** — Change voice, Dub and (gated off) Analyse video; see "Voice tools" below.

## What it does

1. **Catalogue.** `models_explore list` (limit 100, following the provider's page token for at most five pages) is read once per connection and cached for one hour per connection fingerprint (tenant, owner, authorization generation) in memory and in `higgsfield_consumer_catalogue`. The captured catalogue of 19 September (`tests/fixtures/connected-models.json`, 98 models: 34 image, 41 video, 6 audio, 17 3D) is the contract for the parser; its shape is `{items:[{id,name,provider_name,description,output_type,parameters,medias,aspect_ratios,durations,duration_range,tags,supports_unlim}],has_more,unlim}`. Display names and descriptions drop the provider's name; `provider_name` is not exposed.
2. **Constraints.** Each model's declared `parameters` (string/number/bool/string_array, options, min/max, required), `medias` (roles, per-slot caps, required), `aspect_ratios`, `durations` and `duration_range` become the only settings a request may carry. Aspect ratio and duration are validated as settings beside the declared parameters. Unknown settings, workflow-owned settings (`model`, `prompt`, `medias`, `count`, `get_cost`, `use_unlim`, presets), out-of-range values, unknown media roles, mismatched media kinds and missing required inputs are rejected before any provider call. `lib/higgsfield-consumer/catalogue.ts` is pure and shared by the browser form and the server.
3. **References.** Project originals (uploads or completed generations, ≤50 MB each, kind derived from the role: `*video*` → video, `*audio*` → audio, otherwise image) are imported through `media_import_url` once per quote under a durable claim, exactly as Genjutsu sources are. The page discloses that originals are copied to the connected account before a quote is requested.
4. **Quote → approve → submit.** `generate_image` / `generate_video` / `generate_audio` / `generate_3d` with `get_cost:true` returns the exact credit price for the validated params (`count:1`, `use_unlim:false`); provider adjustments the owner did not approve reject the quote. The owner approves the exact wallet and credit amount; submission re-checks the wallet, price and balance, takes one durable dispatch claim, then sends exactly one paid call. Ambiguous acknowledgements stay `uncertain` with their receipt and are never retried.
5. **Status → original.** `job_status` (`raw_data:false`) is polled under the shared lease. Only the normalized envelope for the exact job, model, output type and prompt qualifies `results.rawUrl`; the original is fetched with the DNS-pinned HTTPS fence, identified by its bytes (PNG/JPEG/WebP; MP4; MP3/WAV/OGG/FLAC/M4A; GLB or zip), stored immutably in private storage under the same 100 MiB cap as Marketing Video, and filed as a `generations` row of kind image/video/audio/model on the project, retained by the same receipt guards, deletion protection and purge rules. GLB outputs must pass `validateAstraGlb` (self-contained GLB 2.0, ≤32 MB). "Save to project" adds the collected original to the project library; downloads go through `/api/media/<id>?download=1`, which serves the provider's actual type.

## Quote and receipt contract

| Step | Tool | Guard |
| --- | --- | --- |
| Catalogue | `models_explore` list/get (read-only) | bounded pages, 400 models, parsed with hard limits |
| Import | `media_import_url {url,type}` | one claim per (quote, index); uncertain imports never repeat |
| Quote | `generate_* {params:{…,get_cost:true}}` | `credits === credits_exact`, adjustments must echo the request |
| Approval | — | exact `workspaceId` + `credits`, five-minute quote lifetime |
| Submit | `generate_* {params:{…,get_cost:false}}` | fresh wallet/price/balance checks, one dispatch claim, one call |
| Status | `job_status {jobId,sync:false,raw_data:false}` | leased polls, `generation.{id,model,type,params}` must match |
| Original | HTTPS `results.rawUrl` | bytes sniffed, hashed, quota-reserved, immutable store |

Outputs are the connected account's and are billed in **its credits**; Particl records the approved quote separately from Particl credits and USD and claims no invoice, live balance or refund.

## Limits

- Prompt ≤ 5,000 characters; ≤ 30 reference files; ≤ 50 MB per reference; ≤ 100 MiB per original; 32 MB for a GLB that must preview in Astra blender.
- Four active connected-account jobs per workspace (shared with Marketing Video and Genjutsu).
- Rate limits per owner: 12 catalogue reads, 6 quotes, 6 submits, 30 status reads per minute.
- The connected account's selected wallet is global across its clients; Particl checks it immediately before submission but cannot bind a request to a wallet. This surface is owner-operated, not qualified for unattended multi-tenant spending.

## Tools (slice I2)

The Generate page shows a second group, **Tools**, beside the workflow buttons. A tool is a thin preset over the same generation request: it fixes the output workflow, the candidate catalogue models, and the one project file it works on (plus one audio track for lip-sync). Everything else — the declared settings, media roles, `get_cost` quote, exact-credit approval, single durable dispatch claim, leased `job_status` polling, original collection and filing — is the I1 pipeline unchanged. Tools take no prompt. The request carries `tool: {name, model}` (recorded on the job, never sent to the provider); `lib/higgsfield-consumer/tools.ts` is pure and shared by the form and the server.

| Tool | Catalogue models (in offer order) | Source role(s) | Settings shown |
| --- | --- | --- | --- |
| Upscale image | `bytedance_image_upscale`, `topaz_image` | one image (`image_references`) | `resolution`, `remove_bg` / `output_width`, `output_height` (required), `variant`, `face_enhancement*`, `sharpen`, `denoise`, `folder_id` |
| Upscale video | `video_upscale`, `topaz_video`, `bytedance_video_upscale` | one video (`input_video` / `video_references`) | `duration`, `folder_id` / `resolution`, `enhancement`, `frame_interpolation`, `aspect_ratio` / `fps`, `resolution`, `preset`, `model_version` |
| Remove background (image) | `image_background_remover` | one image (`image_references`) | none |
| Remove background (video) | `video_background_remover` | one video (`video_references`) | none |
| Extend canvas | `outpaint`, `flux_2_pro_outpaint` | one image (`image_references`) | `aspect_ratio`, `folder_id` / `expand_top|bottom|left|right` (−8192…2048), `folder_id` |
| Deflicker | `video_deflicker` | one video (`input_video`) | `duration`, `folder_id` |
| Lip-sync | `sync_so` | one video (`input_video`) **and** one audio file (`input_audio`) | `sync_mode`, `folder_id` |

Rules, enforced before any provider call (`validateToolRequest`): the model must be one of the tool's candidates with the tool's output type and a declared role for every file the tool needs (`tool_model` / `tool_source`); exactly one source of the right kind and exactly one file per extra kind, nothing else (`tool_source`); then the generic catalogue validation. A tool whose candidate is absent from the live catalogue simply offers the remaining candidates (none → the tool cannot quote). In the page, picking a file for a role replaces the previous one; the library offers "Use as reference" on audio cards only while an audio role is active.

Results are filed into the project library as `<source name without extension> · <suffix>` (`upscaled`, `background removed`, `extended`, `deflickered`, `lip-synced`) under the category **Tools**; the job snapshot records the source names read from the uploads/generations rows at quote time (`sources`), and the view exposes `tool` and `sources`. Same limits as the workflows (≤50 MB per source, ≤100 MiB per original, four active jobs, the same rate limits).

**Excluded from I2, and why**

- **Reframe.** The catalogue has no `reframe` model, so `models_explore get` gives no constraints. The connected account's MCP does advertise a `reframe` tool with its own form (`params:{medias:[{role:"video"}…], aspect_ratio, duration_seconds, resolution, get_cost}`), but `mcp.ts` has no typed operation for it — the catalogue pipeline quotes only through `generate_image/video/audio/3d` by model id — and its status envelope is unverified. It needs its own typed quote/submit/status contract; deferred.
- **Clipify.** `clipify` is declared, but its only input is a required `urls` list of YouTube links (no project source) and it yields up to 20 clips, while the collector stores exactly one `results.rawUrl` original. It is not a transform of a project file and does not fit the single-original pipeline; deferred.
- Also unchanged: 3D tools were already covered by I1's 3D workflow (`image_to_3d`, rigging, remesh, retexture models with their declared roles) and are not duplicated as presets.

## Voice tools (slice I3)

The Generate page shows a third group, **Voice**, beside Workflows and Tools: **Change voice**, **Dub** and — only while `capabilities.analysis` is on — **Analyse video**. Unlike the Tools presets these are not catalogue models: each is a typed request to one of the connector's own tools, over exactly one project video (upload or completed generation, ≤50 MB), with arguments taken verbatim from the tool's advertised input schema. The route is `app/api/higgsfield/consumer/audio-tools` (actions `voices`, `quote`, `submit`, `status`; GET returns capabilities and saved jobs); the workflow is recorded as `voice-tool` in `higgsfield_consumer_jobs` with the tool name on the job (`tool.name`), and the pure contract lives in `lib/higgsfield-consumer/voice-tools.ts`, shared by the form and the server.

**Argument facts** (advertised by the connected account's `tools/list` on 19 September 2026; captured verbatim in `tests/fixtures/connected-voice-tools.json`, a read-only capture — no tool was invoked):

| Tool (our label) | MCP create tool | Arguments we send | Declared but not sent | Status tool |
| --- | --- | --- | --- | --- |
| Change voice | `voice_change` | `params.video_id` (uuid: a confirmed media id or completed video job id), `params.voice_id`, `params.voice_type` (`preset` \| `element`) | — (`additionalProperties:false`) | `job_status {jobId, sync:false, raw_data:false}` |
| Dub | `dubbing` | `params.video_id`, `params.target_language` (enum of 18 ISO-639-3 codes: eng, cmn, fra, hin, ita, jpn, kor, por, rus, tur, spa, deu, ara, pol, ind, fil, swe, fin) | — (`additionalProperties:false`) | `job_status` |
| Analyse video | `video_analysis_create` | `video_input_id` (top level, uuid of an uploaded video) | `youtube_url` (never sent: not a project file) | `video_analysis_status {video_analyze_id}` |
| — | `list_voices` | `size:100`, `cursor` (from `next_cursor`) | — | read-only listing, cached one hour per connection fingerprint (memory + `higgsfield_consumer_voices`); only `{voice_id, voice_type, name, language, gender}` are kept, `preview_url` is dropped and never played |

Pipeline, per tool: validate (`consumerVoiceToolInputSchema`: the tool, one source, a voice **or** a language, nothing else) → read the create tool's advertised schema from this session's `tools/list` and check that it declares exactly the argument names we send at the level it declares them, no required argument we do not send, and that any declared enum contains our value (`voiceToolArgumentShape`; otherwise `contract_unverified`, nothing sent) → **price**: if the advertised schema declares `get_cost`, the tool is called with `get_cost:true` and `credits === credits_exact` is the quote (`priceSource:"get_cost"`), else the request is refused as `price_unknown` **before the source is imported** (an unpriced tool makes no remote mutation at all) → import the project video once per quote through `media_import_url {url,type:"video"}` under the same durable claim table as Generate references → approve the exact wallet and credit amount (five-minute quote lifetime, shared-wallet caveat kept) → submit: fresh wallet, schema-shape, price and balance checks, one durable dispatch claim, exactly one call without `get_cost`; only a single structured job UUID (`id`/`job_id`/`jobId`/`video_analyze_id`, one-element `results`/`jobs`, `generation`) is acceptance, anything else stays `uncertain` with its receipt and is never retried → leased status polls → collect/file.

- **Change voice / Dub** results are videos: only the normalized `job_status` envelope for exactly the acknowledged job qualifies `results.rawUrl` (`generation.id` must match; `generation.type`, when present, must be `video`; the provider's model name for these tools is unverified, so it is recorded but not matched). The MP4 is collected by the kind-generic collector into private storage (same 100 MiB cap, receipt guards, deletion protection and purge rules) and filed as a `generations` row (`task:"connected-generation"`, `workflow:"voice-tool"`, model = the tool name). "Save to project" adds it to the library as `<source name without extension> · voice changed` or `<source> · dubbed (<language name>)` under the category **Voice**.
- **Analyse video** results are reports, not media: a completed `video_analysis_status` envelope for exactly the acknowledged job is reduced to a bounded report (numeric estimates under recognisable keys — hook, attention, retention, virality, engagement, overall, score — plus up to 200 scenes and a summary, links stripped; the redacted raw envelope is kept only while it fits 64 KB) and stored on the job's result manifest. The card shows the figures plainly under the label "the connected account's estimate for this video, not a measurement"; "Save report to project" files a **document** asset (`analysis_<job>`, category Voice) whose text lives in its description. A `failed` status with `fail_reason` settles the job as `provider_failed`.

**What is not covered, and why**

- **No verified price for any of the three tools.** None of `voice_change`, `dubbing` or `video_analysis_create` advertised a `get_cost` argument on 19 September, each declares `additionalProperties:false`, and no `models_explore` catalogue entry or cost table prices them. Sending `get_cost` to a schema that does not declare it would violate the "never send undeclared arguments" rule, so on the account observed that day every Change voice / Dub quote is refused with `price_unknown` before any import — the workflow is complete and fails closed exactly as Marketing Studio templates without a cost-table price do. The quote path checks the live schema each time, so a provider that starts advertising `get_cost` is priced without a code change. Enabling these tools for real needs a verified non-submitting price (or an owner-approved ceiling for a first live run).
- **Analyse video stays off** (`capabilities.analysis:false`; `HF_CONSUMER_VIDEO_ANALYSIS_ENABLED=1` turns it on): no price contract (above) **and** an unverified report schema — the tool description only promises `status`, `scenes` and `fail_reason`; the figures the card shows are extracted from key names, not a documented contract. The route refuses analysis quotes with `analysis_disabled` (403) and the page hides the button while the flag is off. The saved report note's `url` is an inert identifier (`/api/workbench/media/analysis-…` resolves to nothing); serving the report as a text file is part of enabling the feature.
- **Change voice takes a video only.** The advertised `voice_change` schema has one source argument, `video_id`; there is no audio-only form, so a project audio file cannot be revoiced here.
- **Dub takes a target language only.** `dubbing` declares no source-language argument; the spoken language is detected by the connected account.
- **Voices from `create_voice`** are not created here: that tool opens the provider's own widget and takes no confirmed audio id. Existing custom voices (`voice_type:"element"`) do appear in the listing and can be chosen.
- **Virality (`virality_predictor`)** stays out: no price contract and `models_explore get` returned "Model not found" on 18 September.
- **Live qualification:** every browser and unit check uses fixtures; no paid call was made while building this slice.

Same limits as the workflows (≤50 MB per source, ≤100 MiB per original, four active connected-account jobs) and the same rate limits per owner (12 voice-list reads, 6 quotes, 6 submits, 30 status reads per minute).

## Connected toolset guard (P0)

The connected account's tool surface differs by OAuth client and changes over time. On 19 September our own client advertised 98 tools (with `job_status` and `marketing_studio_v2_*`); another client of the same account advertised 91 (neither of those; `job_display` and `jobs_wait` instead). `lib/higgsfield-consumer/toolset.ts` makes every flow check OUR connection's live `tools/list` first:

- **Cache.** The bounded list (names + input schemas, descriptions dropped) is cached in memory per connection (hash of the access token) for 60 seconds. A miss against a cached list re-reads it once; a failed status read drops the cached list.
- **Before spend.** Every quote (before any `media_import_url`), every submit (before the durable claim) checks that `list_workspaces`, `media_import_url` and the `generate_*` tool are advertised and that their schemas accept exactly the arguments we send (types, required keys, `additionalProperties:false`, forbidden `{"not":{}}` properties, enums/consts, numeric and array bounds, `anyOf`/`oneOf`; provider `pattern`s are never run). Otherwise the request is refused before any call with `tool_unavailable` or `tool_contract_changed` (409) — "Nothing was sent and no credits were spent." Marketing Video, Genjutsu and Generate are covered; Marketing templates and the voice tools already verified their create/status schemas and now also check the import tool.
- **Status polls.** `job_status` when advertised; otherwise `job_display {id}`, then `jobs_wait {jobs:[{index:0,job_id}],timeout_seconds:0}` (an immediate snapshot, never a long poll). Their replies are rewritten into the normalized `{generation:{…}}` envelope only when the entry names exactly the acknowledged job id; a model or type the entry states must match (the collectors re-check); when the entry omits them the job is bound by its id alone. One HTTPS result URL is kept; anything else stays an inert diagnostic. With no status tool the poll is refused with `status_unavailable` (503) and the job stays saved. Marketing Video polls need `job_status`'s `raw_data` envelope, so on a surface without it they fail closed.
- **Fixtures.** `tests/fixtures/connected-tools-91.json` (names verbatim; schemas verbatim for every tool Particl calls) and `connected-tools-98.json` (reconstructed: the 91 plus the tools our client is known to serve; two unidentified placeholders keep the count). Spec: `tests/unit/connectedToolset.spec.ts`.

## Not covered by I1/I2

- Virality scoring (no non-submitting price for `brain_activity`).
- Per-request wallet binding.
- Cancellation (the connected account advertises no job cancel tool; `cancel:false` in capabilities).
- Reframe and Clipify (above). The voice/dubbing/analysis workflows are I3 (above).
- Live qualification: every browser and unit check here uses fixtures; no paid call was made while building these slices.

## Files

`lib/higgsfield-consumer/catalogue.ts`, `catalogue-cache.ts`, `tools.ts`, `generation-contract.ts`, `generation-sources.ts`, `generation-service.ts`; `mcp.ts` (`catalogueList`, `catalogueGet`, `generationQuote`, `generationSubmit`, `generationStatus`); `jobs.ts` (`generation` workflow); `video-original.ts` (kind-generic collection); `app/api/higgsfield/consumer/generation/route.ts`; `components/suites/AtomikGenerate.tsx`; specs `tests/unit/connectedCatalogue.spec.ts`, `generationConsumerTransport.spec.ts`, `generationConsumerService.spec.ts`, `generationConsumerRoute.spec.ts`, `tests/atomik-generate-workbench.spec.ts`; I2: `tests/unit/connectedTools.spec.ts`, `tests/atomik-tools-workbench.spec.ts`; I3: `lib/higgsfield-consumer/voice-tools.ts`, `voice-tool-sources.ts`, `voices-cache.ts`, `voice-tool-service.ts`, `mcp.ts` (`readConnectedVoices`, `getConsumerVoiceToolQuote`, `submitConsumerVoiceTool`, `readConsumerVoiceToolJob`), `jobs.ts` / `video-original.ts` / `original-identity.ts` (`voice-tool` workflow), `app/api/higgsfield/consumer/audio-tools/route.ts`, `components/suites/AtomikVoiceTools.tsx`, `tests/fixtures/connected-voice-tools.json`, specs `tests/unit/connectedVoiceTools.spec.ts`, `voiceToolsConsumerTransport.spec.ts`, `voiceToolsConsumerService.spec.ts`, `voiceToolsConsumerRoute.spec.ts`, `tests/atomik-voice-workbench.spec.ts`.
