# Moleculr provider capabilities

Verified from official public documentation and unauthenticated discovery on 17 September 2026. No account credentials were read, authorization granted, app registered, or generation requested during this review. Documented support does not prove that a particular account has access.

## Three distinct Higgsfield surfaces

| Surface | Connection | What Moleculr can claim |
| --- | --- | --- |
| Cloud Marketing Studio Image | Existing server-side `HF_CREDENTIALS` / workspace Higgsfield key | Direct campaign images and editing; live, credential-specific image presets; asynchronous image generation with the existing quote, reservation, receipt, and recovery flow. |
| Consumer CLI / MCP | Separate user OAuth and consumer billing workspace | Documented prompt-based Marketing Video and image workflows, plus consumer product/avatar/brand metadata tools. These are not enabled by saving a Cloud API key. |
| Template-first Marketing Studio website | Higgsfield website account | The current full template workflow remains website-only. Moleculr's own creative formats and storyboards are native application features, not access to this proprietary template library. |

The official help article, dated 1 August 2026, explicitly says template-based Marketing Studio is not available through MCP, Supercomputer, or other agentic channels. It describes Product Shots, Ads, Marketplace, Posters, UGC Videos, Motion and reference-to-video tasks. Its 15-second maximum and poster-only post-generation editing apply to that website workflow. Do not transfer those limits to an unrelated API contract. [Official current Marketing Studio help](https://higgsfield.ai/creator-hub/help-center/tools/how-do-i-use-marketing-studio-to-create-video-ads).

## Current Cloud API integration

The authoritative model reference documents `POST https://api.higgsfield.ai/marketing-studio/image` with `Authorization: Key KEY_ID:KEY_SECRET`. Direct generation/editing uses prompt, images and output settings. Enhanced generation additionally requires a visible preset and exactly one product image, optionally followed by one model image. The second image has an assigned role; sending several product views as product-plus-model is incorrect. Without a second image, enhancement remains product-only.

Discover presets through `GET /marketing-studio/image/presets?size=50`, following its returned cursor with the same credentials. Never invent or hardcode preset IDs. Supported resolutions are 1k/2k/4k and aspects are auto, 1:1, 3:2, 2:3, 4:3, 3:4, 16:9, 9:16 and 21:9. Enhancement has an additional charge, so the app uses a live estimate instead of copying promotional list prices. [Model-specific API reference](https://console.higgsfield.ai/models/marketing-studio%2Fimage/api-reference).

The repo implements this in `lib/higgsfieldMarketing.ts` and the existing Higgsfield engine. It uses `POST /estimate/marketing-studio/image`, validates the preset under the credential fingerprint, resolves authorized original images, and retains the accepted provider request for recovery. Its image preset catalogue is not the consumer video/template catalogue.

Higgsfield instructs integrators to prefer model-specific Console documentation over supplementary OpenAPI. Absence from OpenAPI alone does not establish unavailability. This review found no authoritative Cloud API contract for consumer products, avatars, brand kits, DTC Ads Engine, or template-based Marketing Video; no guessed endpoint should be submitted with `HF_CREDENTIALS`. [Official source-priority guidance](https://docs.higgsfield.ai/docs/llms.txt).

## Consumer workflow contracts

The official CLI exposes model and workflow discovery separately. Read the live schema before selecting a consumer job type; a model name is not a Cloud REST path. `marketing_studio_video` accepts a prompt, product/website-product IDs, avatar selections, optional reference media, and video settings. Product IDs and website-product IDs are mutually exclusive, as are an ad reference and hook/setting IDs. Its documented defaults include 15 seconds, 720p and UGC mode. Public documentation disagrees on 1080p availability and duration bounds, so a future connection must use the authenticated live schema rather than a fixed copied enum. [Official CLI model catalogue](https://github.com/higgsfield-ai/cli/blob/main/MODELS.md).

The official marketing workflow supports nine prompt-based modes. Hooks/settings are only valid for the UGC, tutorial, unboxing, review and UGC try-on modes. Curated or custom avatars can be selected; when no specific person is selected, some UGC modes can synthesize a presenter. This differs from Cloud image enhancement, which does not invent a person when the model image is omitted. [Marketing workflow](https://github.com/higgsfield-ai/skills/blob/main/higgsfield-generate/SKILL.md), [mode restrictions](https://github.com/higgsfield-ai/skills/blob/main/higgsfield-generate/references/marketing-modes.md).

| Consumer object | Documented interface and limits |
| --- | --- |
| Product | `marketing-studio products list/create/fetch`; URL import returns an entity whose processing must finish. Manual creation takes title, description and uploaded image IDs. App Store imports use webproducts. [Product contract](https://github.com/higgsfield-ai/skills/blob/main/higgsfield-generate/references/marketing-products.md). |
| Avatar | `marketing-studio avatars list/create`; generation uses `{id,type}` with `preset` or `custom`. Custom creation requires an uploaded image and its returned image URL. [Avatar contract](https://github.com/higgsfield-ai/skills/blob/main/higgsfield-generate/references/marketing-avatars.md). |
| Ad reference | `ad-references create/list/get`; exactly one uploaded video or owned prior video job, optionally one avatar and one product. Wait for `completed`. Arbitrary external video links are not supported inputs. [Ad reference contract](https://github.com/higgsfield-ai/skills/blob/main/higgsfield-generate/references/marketing-ad-references.md). |
| Brand kit | `brand-kits fetch/list/get`; URL-derived brand metadata has queued/in-progress/completed/failed/canceled states. It is a metadata import, distinct from designing an original brand identity. [Brand kit contract](https://github.com/higgsfield-ai/skills/blob/main/higgsfield-generate/references/marketing-brand-kits.md). |
| DTC image ad | `ad-formats list` then `dtc-ads generate`; a selected format ID is mandatory. Optional completed brand kit, one product, one avatar, up to 14 media inputs; batch size 1–20. `--cost-only` is documented. Do not interpret this as the website's full template library. [DTC contract](https://github.com/higgsfield-ai/skills/blob/main/higgsfield-generate/references/marketing-dtc-ads.md). |

## Read-only verified OAuth discovery

`GET https://mcp.higgsfield.ai/.well-known/oauth-protected-resource` advertises resource `https://mcp.higgsfield.ai/mcp`, bearer-header access, and scopes `openid email offline_access`. It points redirect-capable clients to `https://clerk.higgsfield.ai`, and separately advertises a device-flow service. [Live resource discovery](https://mcp.higgsfield.ai/.well-known/oauth-protected-resource).

An unauthenticated TLS-verified GET of `https://clerk.higgsfield.ai/.well-known/oauth-authorization-server` succeeded. The response advertises `/oauth/authorize`, `/oauth/token`, `/oauth/token/revoke`, `/oauth/register`, `/oauth/device_authorization`, S256 PKCE, authorization-code/refresh-token/device-code grants, public-client authentication (`none`), and Client ID Metadata Documents. The alternate device service's standard `/.well-known/oauth-authorization-server` returned 404. No claim is made about its undocumented endpoint layout. No registration or authorization request was sent. [Authorization metadata](https://clerk.higgsfield.ai/.well-known/oauth-authorization-server), [Clerk OAuth guidance](https://clerk.com/docs/guides/configure/auth-strategies/oauth/scoped-access).

A future connector should use a distinct owner-authorized OAuth connection: fixed trusted issuer/resource; app-owned registered redirect URI; one-use, expiring state bound to the current user and workspace; S256 PKCE; encrypted tokens with refresh rotation; and a user-selected, verified Higgsfield billing workspace. Discover allowed tools and parameter schemas after consent. Allowlist read operations separately from imports/uploads/generation; quote and reserve each paid operation, retain provider IDs before collecting, and never replay an ambiguous mutation. Do not reuse Higgsfield's CLI client ID, scrape browser cookies, or store a shared desktop CLI login on the server.

## Implementation direction

Moleculr can provide its own brand brief, reusable product/cast originals, creative formats, editable storyboards, variant tracking, quoted image/video generation and delivery using supported current providers. Keep native format names distinct from provider preset IDs. A generated plan creates editable nodes and tracked variants without calling a media provider. Each render still requires its own generation review and quote. A consumer OAuth connector would be a separate feature and would not remove the documented website-template restriction.
