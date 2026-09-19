# Atomik Generate — catalogue-driven workflows on the connected account

PR I, slice I1 (19 September 2026). Atomik Super Agent gains a **Generate** page with four workflows — Image, Video, Sound and 3D — that run on the workspace owner's connected account. The page never names the provider: it speaks of the connected account, its wallet and its credits.

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

## Not covered by I1

- Virality scoring (no non-submitting price for `brain_activity`).
- Per-request wallet binding.
- Cancellation (the connected account advertises no job cancel tool; `cancel:false` in capabilities).
- The media tools (upscale, reframe, background removal, outpaint) and voice/dubbing/analysis workflows — I2 and I3.
- Live qualification: every browser and unit check here uses fixtures; no paid call was made while building this slice.

## Files

`lib/higgsfield-consumer/catalogue.ts`, `catalogue-cache.ts`, `generation-contract.ts`, `generation-sources.ts`, `generation-service.ts`; `mcp.ts` (`catalogueList`, `catalogueGet`, `generationQuote`, `generationSubmit`, `generationStatus`); `jobs.ts` (`generation` workflow); `video-original.ts` (kind-generic collection); `app/api/higgsfield/consumer/generation/route.ts`; `components/suites/AtomikGenerate.tsx`; specs `tests/unit/connectedCatalogue.spec.ts`, `generationConsumerTransport.spec.ts`, `generationConsumerService.spec.ts`, `generationConsumerRoute.spec.ts`, `tests/atomik-generate-workbench.spec.ts`.
