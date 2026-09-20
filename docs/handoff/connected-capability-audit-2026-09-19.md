# Higgsfield → Particl gap matrix (read-only audit, 19 Sep 2026)

Repo audited: `/Users/axy/Documents/Codex/2026-09-13/vercel-plugin-vercel-openai-curated-remote-4/work/particl-model-picker` (branch `main`, HEAD `4b32dc2` = PR #220). Nothing in the repo was modified. No paid, generating, uploading, publishing or selection-changing call was made.

Public sources (shallow clones in `/private/tmp/hf-audit/`): `cli` (README.md, MODELS.md), `skills` (9 skills + references), `higgsfield-js` (src/v2, src/agents, src/client.ts), `higgsfield-client` (Python), `cursor-plugin`, `fnf-local-pluging-bridge-mcp`, `omagotchi`; plus `docs.higgsfield.ai` (llms.txt, openapi.json saved as `/private/tmp/hf-audit/openapi.json`, webhooks / file-uploads / billing / rate-limits / errors pages) and higgsfield.ai Supercomputer pages. The `higgsfield-ai/higgsfield` repo is an unrelated GPU-orchestration and training framework (last updated 2026-09-14) and is not relevant.

Live MCP (this Claude session's connector, workspace "ZigZag Films", team plan, 1,468.53 credits): 91 tools advertised. The read-only calls made were `get_workflow_instructions`, `apps_search`, `apps_describe` (×2), `balance`, `list_workspaces`, `transactions` (size 3), `shorts_studio_list_presets`, `get_explainer_presets`, `video_analysis_jobs` and `personal_clipper_jobs`. The last returned **"Tool personal_clipper_jobs not found"** even though it is advertised.

---

## 0. Critical finding: the MCP tool surface differs by OAuth client and changes over time

| Tool our code calls | Our OAuth client (docs/moleculr-provider-capabilities.md:64, 98 tools, 18–19 Sep) | This Claude connector (91 tools, today) |
|---|---|---|
| `job_status` (every status poll: mcp.ts:672,677,693) | present | **absent** (has `job_display`, `jobs_wait` instead) |
| `marketing_studio_v2_presets/_costs/_create/_status` (marketing-templates.ts:39-44; mcp.ts:694-701) | present | **absent** (only the widget `show_marketing_studio_v2` and `show_marketing_studio_generations`) |
| `show_marketing_studio(action='fetch')` (named in `generate_video`'s own description) | unknown | **absent** |
| `personal_clipper_jobs` | unknown | advertised, but calling it returns "not found" |

The two surfaces differ, so each build slice has to re-read `tools/list` on **our** client and fail closed. `voice-tool-service` already does this for voice tools. Slice P0 below turns that into a shared guard and a snapshot diff.

---

## 1. The two integration surfaces

### (a) Consumer MCP account: what we use today
- Transport: Streamable HTTP to `mcp.higgsfield.ai` with OAuth and the owner's account. Code: `lib/higgsfield-consumer/oauth.ts`, `mcp.ts` (1,940 lines), and routes `app/api/higgsfield/consumer/{connect,callback,connection,client}`.
- Design: `mcp.ts` has no generic `tools/call`. Every tool name is fixed (mcp.ts:1-9). The fixed operations are at mcp.ts:620-705: `list_workspaces`, `models_explore` list/get, `generate_image|video|audio|3d` with `get_cost` quote and then submit (generation-contract.ts:64-69), `job_status`, `media_import_url`, `marketing_studio_v2_*`, `list_voices`, `voice_change`, `dubbing`, `video_analysis_create/status`. Read-only qualification reads are at mcp.ts:99-162, including `virality_predictor`/`brain_activity` `models_explore get`.
- Billing: credits from the connected account's selected workspace wallet. The wallet is checked through `list_workspaces` immediately before submit (docs/atomik-generation.md:10,32). Cancellation is not possible: no MCP cancel tool exists.

### (b) Developer platform API (official SDKs)
| Aspect | Fact (source) | In our repo? |
|---|---|---|
| Auth | `Authorization: Key KEY_ID:KEY_SECRET` (openapi.json securitySchemes; higgsfield-js/src/v2/client.ts). Environment variables: `HF_CREDENTIALS`/`HF_KEY` or `HF_API_KEY`+`HF_API_SECRET`. Server-only (the v2 client throws in a browser). | **Yes.** `lib/higgsfield.ts:19-45` reads the vendor key `higgsfield` as `KEY_ID:KEY_SECRET`; see `.env.example:40-47`. |
| Base URL | `https://api.higgsfield.ai` (openapi servers; Python `http/client.py:37`) | Yes: `lib/engines/higgsfield.ts:18`, `lib/higgsfieldMarketing.ts:10` |
| Legacy host | `dev-api.higgsfield.com/v1/custom-references` (Soul ID training) with `hf-api-key`/`hf-secret` headers | Yes: `lib/higgsfield.ts:5,49-55`, `lib/higgsfieldVerification.ts:9` |
| Endpoints | Submit to a model path, e.g. `POST /higgsfield-ai/soul/standard`, `/kling-video/v2.5-turbo/...`, `/minimax/hailuo-2.3/...` (openapi.json lists only 7 paths; docs say the model catalogue is at console.higgsfield.ai). v1 SDK: `/v1/text2image/soul`, `/v1/image2video/dop`, `/v1/speak/higgsfield`, `/v1/motions`, `/v1/text2image/soul-styles`, `/v1/custom-references[/list]`. | Partial. We call `higgsfield-ai/soul/character` (engines/higgsfield.ts:19), `marketing-studio/image` and `/presets` (higgsfieldMarketing.ts:9,236), and `higgsfiled/genjutsu/<variant>/v1.0` (genjutsu.ts:9-14). No DoP, Speak, Kling, Minimax, Seedream or other platform models. |
| Async job model | `status_url` = `GET /requests/{id}/status`, `cancel_url` = `POST /requests/{id}/cancel` (queued only, refunded). States: queued / in_progress / completed / failed / nsfw / canceled. | **Yes.** Polling and cancel are in engines/higgsfield.ts:51,160-197. |
| Pricing | `POST /estimate/<model path>` returns `{credits, usd}` (docs concepts/billing-and-retention). failed/nsfw are not charged. Credits expire after 1 year. Outputs are kept ≥7 days. | **Yes.** genjutsu.ts:38-40, higgsfieldMarketing.ts:360-374, higgsfieldVerification.ts:11,122. |
| Webhooks | `?hf_webhook=<https url>` on submit. POST envelope `{request_id,status,error,payload}`. Retries on 5xx for 2 h; duplicates possible. **No signature in the v2 docs.** The v1 SDK sent body `webhook:{url,secret}` with header `X-Webhook-Secret-Key` (higgsfield-js/src/helpers.ts:177). | **No.** We poll only. |
| Upload | `POST /files/generate-upload-url {content_type}` returns `{public_url, upload_url, upload_headers}`. PUT without credentials. Types: jpeg/png/webp/gif, wav, mp4. | **No.** We pass presigned read URLs of our own storage (genjutsu.ts, higgsfieldMarketing.ts:351-356). |
| Rate limits | Concurrency per account, typically 4. A breach returns 400 "Maximum number of concurrent requests"; there are no Retry-After headers. | Implicit (four active jobs per workspace, shared). |
| Balance/transactions | Not exposed by the platform API or SDKs (Console only). | n/a |
| **Agent API** | `POST /v1/agent/sessions {config}`, `POST /v1/agent/sessions/{id}/messages {content}` returns `message_id`, `GET .../messages?after=`, `POST .../interrupt`, `POST /v1/agent/media {extension,type}` then presigned PUT then `POST /v1/agent/media/{id}/confirm` (higgsfield-js/src/agents/resources.ts; higgsfield-client agents/resources.py). Session status: idle/processing/awaiting_input/terminated. Errors: 402 no credits, 403 access disabled, 409 busy. The per-turn `llm_cost_usd` is reported only **after** the turn. Needs "Agent API access enabled" on the account. | **No.** |
| SDK hazard | Both SDKs retry the paid submit POST on 5xx/ECONNRESET/408/429 (higgsfield-js/src/utils/retry.ts:26-32 used by v2 `subscribe`; Python `http/retry.py:4`). This can double-spend. | Our engine sends exactly one POST. **Do not adopt the SDKs for submits.** |

---

## 2. Feature matrix

Legend. Price path: **Q** = exact quote before spend (`get_cost` or `/estimate`); **T** = price table only; **none** = no quote available. Status: **I** = integrated, **P** = partial, **M** = missing. Suite: PS = Particl Production Studio, AT = Atomik, MO = Moleculr, SA = Subatomik.

| # | Capability | Public source | Inputs | Async | Price path | Our status (file) | Home | Risk |
|---|---|---|---|---|---|---|---|---|
| 1 | Image generation (34 catalogue models: gpt_image_2/2.5, nano_banana*, seedream*, flux_2, soul_*, recraft, grok, z_image…) | MCP `generate_image`; CLI `generate create`; skill higgsfield-generate; SDK `subscribe(<path>)` | model, prompt, medias[{role,value}], aspect_ratio, model params | yes | Q (`get_cost`) | **I**: generation-contract.ts:64, generation-service.ts, catalogue.ts, AtomikGenerate.tsx, route `consumer/generation` | AT Generate; PS Boards | the shared account wallet |
| 2 | Batch image/video/audio (1–12 independent requests) + `jobs_wait` + `show_generation_by_ids` | MCP `generate_*_batch`, `jobs_wait` | requests[{index,params}] | yes | **none inside a batch** (`get_cost` is forbidden); quote each item with the single tool first | **M** | AT (parallel runs) | a batch spends N× without a batch quote |
| 3 | Video generation (41 models: seedance_2_5, kling3_0, veo3_1, minimax_h3, wan3_0, cinematic_studio_3_0…) | MCP `generate_video`; CLI; SDK | model, prompt, medias, duration, aspect, preset_id | yes | Q | **I** (same as #1) | AT; PS Takes | |
| 4 | Image-to-video | generate_video with start_image/end_image roles; v1 `/v1/image2video/dop` | image media role | yes | Q | **I** (catalogue roles) | AT; PS | |
| 5 | Image-to-video **presets** (Higgsfield motion presets) | MCP `presets_show` + model `higgsfield_preset` with `preset_id`; v1 `/v1/motions` | preset_id + image | yes | Q | **M**: `preset_id` is a workflow-owned setting and is rejected (catalogue.ts:85-86); no `presets_show` read | AT; SA | |
| 6 | Motion control / transfer | MCP `motion_control` (Kling 3.0: image_id, motion_video_id, resolution, scene_control); `hf_mult_motion_control` via generate_video | image + driving video | yes | `motion_control`: **none**; `hf_mult_*`/`kling3_0` via generate_video: Q | **P**: Genjutsu `hf_mult_motion_control` integrated (genjutsu-service.ts, mcp.ts:1279, ConsumerGenjutsu.tsx, SubatomikWorkspace.tsx); the `motion_control` tool is not used | SA | use the quoted path |
| 7 | Object/character swap in video | `hf_mult_replace_object` (generate_video); `ad_multiplier` model + workflow | video + refs | yes | Q | **I** (Genjutsu); ad_multiplier **P** (catalogue only, the workflow is not wired) | SA; MO | |
| 8 | Lip-sync / talking avatar | catalogue `sync_so`; v1 `/v1/speak/higgsfield`; workflow `narrator`, `ugc-review-video` | video + audio (sync_so) | yes | Q | **P**: Lip-sync tool (tools.ts:51); no Speak/talking-photo; narrator workflow **M** | PS Edit & Sound; MO UGC | likeness/consent (the workflows require consenting adults) |
| 9 | Soul character training (identity, 5–20 photos) | MCP `show_characters action=train`; CLI `soul-id create`; v1 SDK `createSoulId` → `/v1/custom-references` | name, images | yes (~10 min) | MCP: **none**; platform: priced in our code ($2.50) | **I (platform)**: lib/higgsfield.ts:5, docs/higgsfield-soul-integration.md; MCP route **M** | PS Cast & Elements | the MCP train spends without a quote |
| 10 | Soul-conditioned generation | `soul_2`/`soul_cinematic` + `soul_id` (MCP); platform `higgsfield-ai/soul/character` | soul_id | yes | Q | **P**: platform adapter gated off (engines/higgsfield.ts:19-24); MCP `soul_id` is a free-text param with no picker from `show_characters list` | PS | |
| 11 | Reference Elements (characters/environments/props; `<<<element_id>>>` in the prompt) | MCP `show_reference_elements` list/get/create | medias[{id,url,type}], category, name | create is synchronous | none (appears free; unverified) | **M** | PS Cast & Elements; AT | creates remote records |
| 12 | Upscale image | MCP `upscale_image` (bytedance 2k/4k, needs w/h); catalogue `bytedance_image_upscale`, `topaz_image`, `topaz_image_generative` | image, w, h | yes | Q (both) | **I** via catalogue (tools.ts:47) | AT Tools; PS | |
| 13 | Upscale video | MCP `upscale_video` (bytedance/topaz); catalogue `video_upscale`, `topaz_video`, `bytedance_video_upscale` | video, w, h, fps | yes | tool: **none**; catalogue: Q | **I** via catalogue (tools.ts:48) | AT; PS Deliver | the dedicated tool has no quote; keep the catalogue path |
| 14 | Remove background (image/video) | MCP `remove_background`; catalogue `image_/video_background_remover` | media_id, type | yes | tool: none; catalogue: Q | **I** via catalogue (tools.ts:49-50) | AT; MO | |
| 15 | Outpaint / extend canvas | MCP `outpaint_image`; catalogue `outpaint`, `flux_2_pro_outpaint` | image_id, aspect | yes | Q | **I** via catalogue (tools.ts:51) | AT; PS Boards | |
| 16 | Reframe video | MCP `reframe` (≤60 s; video + optional start_image/refs); CLI workflow `reframe` | video, aspect, duration_seconds, resolution | yes | Q (`get_cost` with duration+resolution); CLI `generate cost workflow reframe` | **M**: deferred (docs/atomik-generation.md:54) | PS Deliver; SA | |
| 17 | Draw-to-video (sketch-edit a frame) | CLI workflow `draw_to_video` | video, sketch, timestamp, prompt | yes | Q (CLI cost workflow) | **M**: no MCP tool on either client | PS Takes | CLI-only |
| 18 | Relight / inpaint / video edit | `gpt_image_2` `is_inpaint`+`mask` (CLI MODELS.md:50-66); catalogue `kling_video_edit`, `flux_3_video_edit`, `sam_3_video` (segmentation), `video_deflicker` | mask/refs | yes | Q | **P**: generic catalogue form (no mask painter); deflicker **I** (tools.ts); no dedicated relight model exists | PS Takes | |
| 19 | 3D generation (17 models: image_to_3d, multi_image_to_3d, sam_3_3d, tripo, meshy*, hunyuan3d, 3d_rigging) | MCP `generate_3d`; CLI | images, texture, rigging, `animation_action_id` | yes | Q | **I**: catalogue 3D + GLB validation (docs/atomik-generation.md:11) | AT; PS Astra blender | |
| 20 | 3D animation-action catalogue (678 rig clips) | MCP `animation_actions`; CLI `preset list animation-action` | query/group | sync read | free | **M**: `animation_action_id` is typed by hand | PS Astra | |
| 21 | 3D Jutsu scene builder (remote Blender 5.2: projects, Python edit/query, catalogue GLB import, GLB/.blend/artifact export) | MCP `scene_builder_3d_*` (12 tools) | projectId, code, guards | yes (operations) | **none** | **M**. Local alternative: `fnf-blender-mcp` (bridge repo `blender/`) | PS Astra blender | arbitrary Python in a remote scene; unknown cost |
| 22 | TTS (seed_audio, text2speech_v2 variants elevenlabs/minimax/seed_speech/vibe_voice/cozy_voice, qwen_audio_tts) | MCP `generate_audio`; CLI | prompt, voice_type, voice_id | yes | Q | **P**: generic Sound workflow; `voice_id` is not wired to the cached `list_voices` picker (voices-cache.ts is used only by voice tools) | PS Edit & Sound; AT | |
| 23 | Voice listing | MCP `list_voices`; CLI `voices list/get` | cursor | read | free | **I**: voices-cache.ts; mcp.ts:703 | PS; AT | |
| 24 | Voice clone | MCP `create_voice_from_confirmed_audio` (+ `create_voice` widget) | audio_media_id, name | yes (processing) | **none** ("charges the voice-clone credit cost") | **M** | PS Edit & Sound | spends without a quote; consent to clone a voice |
| 25 | Voice change | MCP `voice_change`; CLI workflow `voice-change` | video_id, voice_id, voice_type | yes | **none** (CLI: "do not support cost estimation") | **P**: implemented, refused with `price_unknown` (voice-tools.ts:1-15, 51) | PS; AT | |
| 26 | Dubbing (18 languages, lip-synced) | MCP `dubbing`; CLI workflow `dubbing` | video_id, target_language | yes | **none** | **P** (same as #25; voice-tools.ts:52) | PS Deliver; MO localisation | |
| 27 | Music / SFX | catalogue `sonilo_music`, `mirelo_text_to_audio`, `inworld_text_to_speech` | prompt, duration | yes | Q | **P and at risk**: exposed in our Sound catalogue with no filter; the provider description says these are "ONLY for the game-generation pipeline and must not be used for standalone audio" | (hide) | policy breach; we have ElevenLabs music/SFX instead |
| 28 | Video analysis (scene by scene) | MCP `video_analysis_create/status/jobs` (upload or YouTube URL) | video_input_id or youtube_url | yes (3–5 min) | **none** | **P**: code present, gated off (`capabilities.analysis`; voice-tools.ts:53) | SA; AT | |
| 29 | Virality predictor (hook, attention, retention dashboard) | MCP `virality_predictor` create/preview; CLI model `brain_activity` | medias[{role:video,id}] | yes | **none** observed; check whether `brain_activity` via `generate_video get_cost` quotes | **P**: read-only qualification only (mcp.ts:155-162, route `analysis-qualification`) | SA | |
| 30 | Shorts Studio (restyle one 4–120 s video into shorts with a style preset; user presets) | MCP `shorts_studio_create`/`_create_preset`/`_list_presets`/`_list_sessions`/`_status` | preset_id, source_video_id, aspect | yes (session → job_ids) | **Q** (`get_cost` + duration_seconds) | **M** | SA | `create_preset` stores public URLs of the references |
| 31 | Personal Clipper / Clipify (YouTube → up to 20 subtitled clips) | MCP `personal_clipper_create/status/jobs`; catalogue `clipify` | YouTube urls, clips_num, aspect, font | yes (≤30+ min) | tool: **none**; clipify via generate_video: possibly Q | **M**: deferred (docs/atomik-generation.md:55: multi-output) | SA | third-party YouTube content rights |
| 32 | Explainer / faceless video | MCP `get_explainer_presets`, `resolve_explainer_preset`; models `video_explainer` (monolithic, 20–600 s) and `explainer_video` (assembler); workflow `faceless-video`; skill higgsfield-video-explainer | preset, voice, blocks | yes | Q per model; `resolve_explainer_preset` imports media (free) | **M** | AT recipe; SA | |
| 33 | Marketing Studio video (UGC, product showcase, TV spot…) | `marketing_studio_video` via generate_video; skill modes (9) | product, avatar, hooks, settings | yes | Q | **I** (typed): video-contract.ts, video-service.ts, ConsumerMarketingVideo.tsx, route `consumer/video` | MO | |
| 34 | Marketing Studio v2 templates (986 presets) | our client: `marketing_studio_v2_presets/_costs/_create/_status`; Claude client: widget `show_marketing_studio_v2` only | template id + product image | yes | T (cost table) or Q when advertised | **I in code, not live-qualified**: marketing-templates*.ts, MarketingTemplates.tsx, CreativeTemplateBrowser.tsx | MO | tool drift (§0) |
| 35 | Marketing Studio image + presets (platform) | platform `marketing-studio/image`, `/presets`, `/estimate/...` | preset, refs | yes | Q | **I**: higgsfieldMarketing.ts, MarketingPresets.tsx, `app/api/higgsfield/marketing/presets` | MO | |
| 36 | Marketing Studio entities: avatars, products (fetch by URL), hooks, settings, ad-references, ad-formats, brand-kits, DTC Ads Engine | CLI `marketing-studio …` (skills/higgsfield-generate references marketing-*.md); `show_marketing_studio(action='fetch')` named in the MCP description | URLs, images | mixed | DTC: `--cost-only` Q | **M** remotely. Local equivalents: BrandKitEditor.tsx, ProductProfileEditor.tsx, ReferenceAd.tsx | MO | CLI-only today; not on our MCP client (moleculr doc:64) |
| 37 | Product photoshoot (10 modes) / marketplace cards / YouTube thumbnail / brand kit | CLI `product-photoshoot create`, `marketplace-cards create`; workflows `product-photoshoot`, `thumbnail-generation`, `brand-asset-creation`, `character-sheet` | brief + product | yes | Q per underlying generate call | **M** as recipes (only the raw models exist) | MO; AT recipes | |
| 38 | UGC video workflows (review, product, try-on, tutorial, unboxing, website) | MCP `get_workflow_instructions` + `get_workflow_bundle_file` | brief | multi-step | per step Q; the sandbox steps have none | **M** | MO; AT | the workflow text is provider instructions (prompt-injection surface) |
| 39 | Subtitles burn / video editing (Higgsedit) | workflows `subtitles`, `video-editing` (run in `sandbox_exec`) | video | yes | **none** (sandbox) | **M** (PS Edit has its own timeline) | PS Edit | |
| 40 | Media library read/upload/import | MCP `show_medias`, `media_upload`, `media_confirm`, `media_import_url`, `media_upload_widget`; platform `/files/generate-upload-url` | files/URLs | sync | free | **P**: `media_import_url` only (mcp.ts:673), once per quote | all | |
| 41 | Generation history | MCP `show_generations`, `show_generation_by_ids`, `job_display`, `show_marketing_studio_generations` | cursor | read | free | **M** (we keep our own records) | AT Runs | |
| 42 | Job status | our client: `job_status`; Claude client: `jobs_wait` | job ids | read | free | **I** on `job_status`; **at risk** per §0 | all | |
| 43 | Sandbox exec (ffmpeg, ImageMagick, sox, whisper, Playwright; `$HF_WORKFLOWS` scripts) | MCP `sandbox_exec` | command (≤16k), background | yes | **none** | **M** | AT | arbitrary remote code with the account's media access |
| 44 | Marketplace apps (1 today: Match Cut + Tracelab, 28 actions, manifest v3) | MCP `apps_search`, `apps_describe`, `apps_invoke` (+ poll action `get_render`) | app_id, action, args, manifest_revision | async | **none** (annotations carry only `poll_action`/`poll_arg`) | **M** | AT Tools; SA | spend unknown; third-party app code |
| 45 | Websites / apps / games (create, repo access, deploy, rename, publish to feed, DB read, secrets, status, categories) | MCP `create_website`, `website_repo_access`, `deploy_website`, `rename_website`, `publish_website`, `website_db`, `website_secrets`, `website_status`, `list_websites`, `list_website_categories`; CLI `website …`, `game deploy/publish`; skill higgsfield-websites | type, category, template, subdomain | deploy is async | **none** | **M** | AT (optional); MO landing pages | **deploys public sites**, publishes to the community feed, stores secrets on a third party |
| 46 | App contest entry | MCP `participate_in_contest`; CLI `website contest` | website_id, social URLs | sync | none | **M**, do not build | none | auto-publishes |
| 47 | TikTok connect / trending music / tune / prepare / publish / status | MCP `tiktok_*` (8) | connector_id, Higgsfield-hosted media URL, privacy, disclosures | yes | no credits (quota 5/min, 13/day) | **M** | MO Deliver; SA | **posts to a third-party public account**; needs explicit per-post consent |
| 48 | Balance / plans / transactions / trial | MCP `balance`, `transactions`, `show_plans_and_credits` (checkout links), `cancel_trial_auto_renewal` | none | read | free | **P**: wallet via `list_workspaces` only; `transactions` is not used for reconciliation | AT Budget | never surface checkout links or cancel the trial without the owner |
| 49 | Workspaces | MCP `list_workspaces`, `select_workspace`; CLI `workspace` | workspace_id | sync | free | **P**: list only; select is deliberately excluded because it is a global mutation (mcp.ts:95-97) | Settings | select changes billing for all the owner's clients |
| 50 | Model discovery / recommend | MCP `models_explore` list/search/get/**recommend** | goal, input | read | free | **P**: list/get only (mcp.ts:681-687) | AT planner | |
| 51 | Game asset pipeline (autosprite, rigged characters, music/SFX) | catalogue `autosprite`; skill game-generation | | yes | Q | **P**: catalogue only | none | |
| 52 | Agent sessions (programmatic multi-step agent) | SDK `client.agents.sessions.create/send/messages/interrupt/run`, `agents.media.upload` | message text, media URLs | yes (turn ≤30 min) | **none before the turn** (`llm_cost_usd` after; 402) | **M** | AT (see §5) | autonomous spend inside a turn |
| 53 | Platform webhooks | `?hf_webhook=` | url | push | n/a | **M** (polling only) | infra | unsigned; always re-verify via status |
| 54 | Local creative-app bridges (After Effects 12 tools; Blender 17 tools) | `fnf-local-pluging-bridge-mcp` (stdio, local only) | n/a | n/a | free | **M**. A web app cannot launch a local stdio process (README) | PS Astra (desktop only) | local code execution |
| 55 | Cursor plugin | `cursor-plugin/mcp.json` → `https://mcp.higgsfield.ai/mcp`; command `/higgs` routing notes | none | none | none | n/a (IDE packaging) | none | none |
| 56 | omagotchi | uses the CLI only: `generate create nano_banana_2` + a video model, `generate wait/get` (scripts/generate-sprite.py:774-807) | none | none | none | n/a | none | none |

---

## 3. Can each missing or partial capability follow our contract?

Contract: exact credit quote → owner approval → single durable claim → poll → collect the original → file it into the project.

| Capability | Quote path | Contract fit |
|---|---|---|
| Reframe (#16) | `reframe get_cost` (duration+resolution) | **Fits.** Needs a typed status envelope; verify whether `job_status` covers reframe jobs |
| Image-to-video presets (#5) | `generate_video get_cost` with `model:higgsfield_preset, preset_id` | **Fits** once `preset_id` is allowed for that model only, with the value taken from `presets_show` |
| Shorts Studio (#30) | `shorts_studio_create get_cost` + duration | **Fits for the quote**; collection is multi-output (session → job_ids → per-clip status). Needs a multi-original collector |
| Batch generation (#2) | per-item single-tool `get_cost` | **Fits** with a summed approval, one claim per index, per-index receipts. Batch submit has no quote of its own |
| Soul picker / animation picker / voice picker (#10, #20, #22) | free reads | **Fits** (read-only feeders into existing quoted flows) |
| Reference Elements create (#11) | unknown | **Contract ambiguity**: probably free. Verify with `transactions` before and after one owner-approved create |
| Clipify (#31) | try `generate_video get_cost` with `model:clipify` | **Unverified**; `personal_clipper_create` has **no quote** |
| Explainer (#32) | `video_explainer`/`explainer_video` via generate_video `get_cost` (probe) | **Likely fits**; `resolve_explainer_preset` has no cost field |
| Voice change / dubbing (#25–26) | **none** | **Flag: no quote.** Only an owner-stated ceiling + one qualification run + `transactions` delta could create a price table (T, not Q) |
| Voice clone (#24) | **none** | **Flag** (as above) |
| Video analysis (#28) | **none** | **Flag** (may be free; prove via `transactions`) |
| Virality predictor (#29) | **none** observed | **Flag**; probe whether `brain_activity` quotes through generate_video |
| motion_control / upscale_video / remove_background dedicated tools | **none** | **Flag.** Keep the quoted catalogue equivalents (already integrated) |
| Personal clipper (#31) | **none** | **Flag** |
| Soul training via MCP (#9) | **none** | **Flag.** Keep the priced platform path |
| sandbox_exec (#43) | **none** | **Flag.** Prefer our own server-side ffmpeg |
| apps_invoke (#44) | **none** | **Flag** |
| scene_builder_3d_* (#21) | **none** | **Flag** |
| Websites / deploy / publish / contest (#45–46) | **none** | **Flag**, plus a public-deploy risk |
| TikTok publish (#47) | no credits | Contract N/A; needs a **publish-consent** contract instead (preview, privacy and disclosure choices, per-post approval) |
| Agent API sessions (#52) | **none** (post-hoc `llm_cost_usd`) | **Does not fit.** The agent spends inside the turn. Only acceptable with an owner-set turn ceiling enforced by us (not possible provider-side) or as a sandboxed, owner-only "delegate" mode |
| Platform webhooks (#53) | n/a | Fits as a *wake-up* only; the status endpoint stays the authority (unsigned) |

---

## 4. Build order (PR-sized, one concern each)

P0 is a prerequisite for everything. The Atomik parity track (§5) is the owner's top priority and is interleaved first.

| Order | Slice | Depends on | Value |
|---|---|---|---|
| **P0** | **Tool-surface snapshot + drift guard**: owner-triggered `tools/list` capture into a fixture; every typed operation checks that its tool name and schema are advertised before quote and submit (generalise the voice-tool pattern); a `jobs_wait` fallback when `job_status` is absent | none | protects every paid flow (§0) |
| **A1** | **Atomik read tools (free, auto-run)**: `models_explore recommend/search`, `list_voices`, `presets_show`, `get_explainer_presets`, `animation_actions`, `show_characters list`, `show_reference_elements list/get`, `show_generations`, `show_medias`, `balance`, `transactions` exposed to the planner as read-only tools | P0 | the planner can see what Supercomputer sees |
| **A2** | **Atomik proposes connected-account steps**: extend `engines()` (lib/atomik.ts:344-366) with connected catalogue models; a proposal card runs the existing generation-service quote → approve → claim → poll → file | A1 | the core of Supercomputer parity |
| **A3** | **Tool presets as agent steps**: upscale, background, outpaint, deflicker, lip-sync (tools.ts) and Genjutsu become proposable step kinds | A2 | |
| **A4** | **Batch/parallel steps**: per-item quotes, summed approval, `generate_*_batch` submit, `jobs_wait` polling, per-index receipts | A2, P0 | Supercomputer "parallel jobs" |
| **A5** | **Workflow recipes**: read the `get_workflow_instructions` catalogue (16 workflows) and bundle files as *read-only guidance*; Atomik recipes (lib/pipeline) gain templates for faceless-video, ugc-*, product-photoshoot, thumbnail, character-sheet, narrator; every paid step stays a quoted card; sandbox steps are replaced by our own ffmpeg or marked unavailable | A2 | Supercomputer "skills" |
| **A6** | **Slash commands / saved skills**: `/recipe` invocation in the Atomik chat, workspace-shared, versioned (pipeline store) | A5 | |
| **A7** | **Atomik memory**: a per-workspace/project memory store (brand kit from Moleculr, style refs, approved Elements/Souls, prior successful params); planner context injection; delete-by-chat; memory view | A2 | Supercomputer memory |
| **A8** | **Schedules**: owner-created recurring or one-time recipe runs on the existing pipeline executor and `/api/cron/sync` (vercel.json); each schedule carries a standing credit ceiling and a per-run cap and auto-pauses on price drift | A5, A7 | Supercomputer CronJobs; unattended spend is bounded by the ceiling |
| **A9** | **Identity pickers**: Soul (`show_characters list`, `soul_id` picker for soul_2/soul_cinematic), Reference Elements list/create with `<<<id>>>` prompt insertion | A1 | Cast & Elements + Atomik |
| **A10** | **AI Employees**: packaged persona and recipe bundles (Cartoon Animator, Motion Designer, Podcast Producer, Product Photographer) over A5/A6 | A6 | |
| **A11** | **Marketplace apps (read + gated invoke)**: `apps_search/describe`; invoke only behind owner approval with an explicit "no price available" disclosure and a per-call ceiling from a `transactions` delta; poll via the declared poll action | A1, P0 | |
| **A12** | **Delegate to Higgsfield agent (optional, gated)**: platform Agent API sessions (needs Agent API access) with transcript mirroring, interrupt, and result import; owner-only; a hard wallet ceiling enforced by our pre/post `transactions` check; **off by default** | P0 | literal Supercomputer engine; high risk |
| **A13** | **Websites (owner-only, off by default)**: list/status/db-read first; create/deploy/publish behind explicit per-action confirmation | A1 | low film-studio value |
| **A14** | **External connectors** (Slack/Drive/Notion/Gmail/Figma/Telegram): our own OAuth integrations, not Higgsfield | none | Supercomputer connectors; separate project |
| F1 | Reframe typed tool (#16) | P0 | PS Deliver, SA |
| F2 | Image-to-video presets (#5) | P0 | SA / AT |
| F3 | Voice picker for TTS + hide game-only audio models (#22, #27) | P0 | PS Edit & Sound; removes the policy risk |
| F4 | Shorts Studio + multi-original collector (#30) | P0 | SA (high viral value) |
| F5 | Explainer/faceless (#32) | F4 collector, A5 | AT / SA |
| F6 | Clipify / personal clipper (#31) | F4 collector | SA |
| F7 | Price qualification harness: owner-approved single runs with a `transactions` delta for voice change, dubbing, clone, analysis, virality, apps; records a T-price table; unlocks #24–29 | P0 | unblocks the flagged tools |
| F8 | Virality predictor + video analysis live (#28–29) | F7 | SA |
| F9 | Voice clone (#24) | F7 | PS Edit & Sound |
| F10 | Marketing entities parity (#36): blocked until an MCP tool appears on our client; otherwise keep local brand/product editors | P0 | MO |
| F11 | TikTok publish with a publish-consent contract (#47) | P0 | MO / SA delivery |
| F12 | Platform webhooks as wake-up (#53) | none | infra latency |
| F13 | 3D animation picker (#20) and scene-builder read-only viewer (#21) | A1 | PS Astra |

---

## 5. Supercomputer → Atomik parity

**What Supercomputer is (first-party sources).** Higgsfield's agentic workspace: "describe what you want in natural language, and the agent plans the task, generates across image, video, and audio models, and connects to external apps" ([help centre](https://higgsfield.ai/creator-hub/help-center/tools/how-do-i-use-supercomputer)). The [intro page](https://higgsfield.ai/supercomputer-intro) and the [guide](https://higgsfield.ai/blog/higgsfield-supercomputer-guide) describe the parts listed in the table below. The public repos also refer to it: "Supercomputer Design mode" is an inspector for built sites (skills/higgsfield-websites/references/runtime-and-infra.md:34-48); the app contest lives at `higgsfield.ai/supercomputer/apps` (contest.md:10); and the Supercomputer can reach external MCP servers through a `custom_mcp` wrapper (fnf bridge archive `ae-mcp-realities/SKILL.md:8-16`). Third-party articles (bitsminds, explainx) claim a "Hermes agent" and "40+ built-in tools"; these are unverified.

**Programmatic access.** The SDK "Agent API" (`/v1/agent/sessions…`) "runs multi-step creative tasks in persistent sessions" (higgsfield-client README). It is almost certainly the same engine, but no public source names it Supercomputer; this is inference. The MCP server exposes Supercomputer's *tools* and *workflows*, not its chat, memory or schedules.

| # | Supercomputer capability | Exposed publicly by | Atomik today | Missing | Price path | Risk |
|---|---|---|---|---|---|---|
| S1 | Agent chat that plans, breaks work into steps and picks models | Agent API sessions; MCP tools as its toolset | **P**: planner turn with a JSON protocol and proposal cards (lib/atomik.ts:1-20, 380-620), but it proposes **only Particl engines + ElevenLabs** (lib/atomik.ts:331-366) | the planner cannot call any connected-account tool | per-step Q (via A2) | none new |
| S2 | LLM selector with auto routing (Claude Opus 4.6/4.7, Sonnet 4.6, GPT-5.5 Pro, Gemini 3.1 Pro; help lists xAI, DeepSeek, Kimi…) | none (Supercomputer UI) | **I**: lib/atomikModelPolicy.ts:5 (5 verified + auto list), PR147 | optional extra families once verified on the Gateway (docs/atomik-model-policy.md:5) | our text billing (`runPaidText` maxCredits) | none |
| S3 | Upfront cost shown; approval before spend; pause or cancel and pay only for completed steps | MCP `get_cost`; platform `/estimate`, `/requests/{id}/cancel` | **I**: approval cards, Budget page, platform cancel (engines/higgsfield.ts:187-197) | MCP-side cancel does not exist; batch totals (A4) | Q | none |
| S4 | 40+ built-in tools (generation, edit, audio, 3D, analysis, publish) | MCP (91–98 tools) | **P**: 4 workflows + 7 tool presets + 3 voice tools on the Generate page, **manual only** | agent-invocable tools (A1–A4); everything in §2 marked M | per tool (§3) | tool drift (P0) |
| S5 | Skills / slash commands (`/montage`, `/cinematic`), marketplace, official skills (Product UGC, Faceless Video, Shorts Maker, YouTube Covers, Personal Clipper, TV commercials, animated infographics, localization), versioned and shareable | MCP `get_workflow_instructions` (16) + `get_workflow_bundle_file`; skills repo (9) | **P**: Recipes = durable pipelines (lib/pipeline/*, `recipes` page in atomik-suite-data.ts:6-13) on own engines only | Higgsfield workflows as recipes (A5), slash invocation (A6), sharing and versioning UI | per step | workflow text is untrusted data |
| S6 | AI Employees (Cartoon Animator, Motion Designer, Podcast Producer, Product Photographer) | none | **M** | persona bundles (A10) | per step | none |
| S7 | Memory: context between chats, brand guidelines, references, graph view, delete via chat, import from Claude/ChatGPT/Codex | none | **P**: per-project chat context; Moleculr brand kits (lib/workbench/moleculr*.ts) are not fed to Atomik | memory store + injection + UI (A7) | none | privacy of stored brand data |
| S8 | Scheduling: daily, weekly or one-time jobs (≤10 active on Ultra) | none | **P**: pipeline executor `scheduleWake` (lib/pipeline/store.ts:1004, executor.ts:91-101) + cron every 10 min (vercel.json) — infrastructure only | user schedules with standing ceilings (A8) | Q per run within a ceiling | unattended spend (hence the ceiling) |
| S9 | Parallel chats and jobs (10 concurrent on Ultra) | MCP batch + `jobs_wait` | **P**: 4 active connected jobs per workspace (docs/atomik-generation.md:30) | batch steps (A4); concurrency is bound by the provider (4 per the platform docs) | Q per item | none |
| S10 | Connectors: Slack, Drive, Notion, Gmail, Figma, Telegram, TikTok (+25) | only TikTok via MCP | **M** (internal team chat only: app/api/chat) | TikTok (F11); others are our own integrations (A14) | none | third-party posting |
| S11 | Access from Telegram or browser | none | browser only | Telegram bot (optional) | none | none |
| S12 | Cloud sandbox (ffmpeg, whisper, Playwright, workflow scripts) | MCP `sandbox_exec` | **M** | our server-side media tooling, or a gated sandbox | none | remote code |
| S13 | Build and deploy sites/apps/games + Design-mode inspector + feed/contest | MCP website tools; CLI `website`, `game` | **M** | A13 (owner-only) | none | public deploys |
| S14 | Marketplace apps | MCP `apps_*` | **M** | A11 | none | spend unknown |
| S15 | Files and storage allowance | MCP media tools; storage in the plan | **I** (our project library, R2/Blob) + `media_import_url` | `show_medias` import-back (optional) | none | none |
| S16 | Access to all generation models | `models_explore` | **I** for the Generate page (98 models) | planner access (A2); `recommend` (A1) | Q | none |
| S17 | Credits/budget; top-up mid-production | `balance`, `transactions`, `show_plans_and_credits` | **P**: wallet check; Budget page is Particl-side | `transactions` reconciliation; link out to top-up (never purchase) | none | purchase flows are prohibited for the agent |
| S18 | Publishing (TikTok, community feed) | MCP `tiktok_*`, `publish_website` | **M** | F11 | none | public posting |
| S19 | Identities (Soul, Elements) used across runs | MCP `show_characters`, `show_reference_elements` | **P**: platform Soul train (PS) | A9 | train: none (MCP) / priced (platform) | none |
| S20 | Long faceless videos (up to 15 min) with script, voice, music and subtitles | workflow `faceless-video`, `video_explainer` (≤600 s) | **M** | F5 | Q per step | none |
| S21 | Commercial-use rights on outputs | policy | n/a | n/a | none | none |
| S22 | Remote programmatic agent | SDK Agent API | **M** | A12 (gated) | **none** | autonomous spend |
| S23 | Our Atomik exposed to other agents (Supercomputer skills "work outside Supercomputer, through MCP in Claude") | none | **P**: our own MCP server `app/api/mcp` + lib/mcp.ts (render_shot, list_renders, usage_summary…) | expose Atomik recipes and connected tools through our MCP (after A5) | Q | auth scope |

**Parity verdict.** Atomik already has the planner, model selector, quote/approve discipline, durable recipes, budget and the Generate page. The largest gap is that **the planner cannot use the connected-account tools** (S1/S4). Closing A1–A5 gives Atomik most of what Supercomputer does. Memory (A7), schedules (A8) and personas (A10) have no public Higgsfield API and must be built on our side. Connectors other than TikTok are not exposed by Higgsfield at all.
