# Production suite integrations

Verified against official documentation on 17 September 2026. The current interface has three suites: **Particl Studio**, **Atomik Agent**, and **Moleculr Business Suite**. This document retains its original filename for existing links.

## Provider accounts and API access

These are the providers already wired into Particl, as recorded in `lib/providers.ts` and the engine adapters. Account links below lead to the provider's own console; they do not assert that a particular model is enabled or funded for the current workspace.

| Provider / use in Particl | Account or API-key page | Existing server credential / official reference |
| --- | --- | --- |
| Vercel AI Gateway — Atomik's Claude, OpenAI and Gemini thinking models; gateway-routed stills | [AI Gateway API keys](https://vercel.com/d?title=AI+Gateway+API+Keys&to=%2F%5Bteam%5D%2F~%2Fai-gateway%2Fapi-keys) | `AI_GATEWAY_API_KEY`, or Vercel deployment OIDC. [Authentication and BYOK](https://vercel.com/docs/ai-gateway/authentication-and-byok) |
| BytePlus ModelArk — Seedance video | [ModelArk console](https://console.byteplus.com/ark) | `ARK_API_KEY`; the key, model activation and endpoint region must agree. [Regional API configuration](https://docs.byteplus.com/api/docs/modelark/2191806), [video API](https://docs.byteplus.com/en/docs/ModelArk/1520757) |
| Google Gemini — direct Gemini image generation | [Google AI Studio API keys](https://aistudio.google.com/apikey) | `GEMINI_API_KEY` for direct Google routing. [Key setup and current auth-key migration](https://ai.google.dev/gemini-api/docs/api-key) |
| fal — Kling, Topaz image upscale/Astra video upscale, Luma, Bria and configured character models | [fal API keys](https://fal.ai/dashboard/keys) | `FAL_KEY`, created under the intended personal/team account. [API-key guide](https://fal.ai/docs/documentation/setting-up/authentication) |
| ElevenLabs — speech, sound effects and music | [ElevenLabs API keys](https://elevenlabs.io/app/developers/api-keys) | `ELEVENLABS_API_KEY`. [Quickstart](https://elevenlabs.io/docs/eleven-api/quickstart), [authentication](https://elevenlabs.io/docs/api-reference/authentication) |
| Higgsfield — Soul character identity and Moleculr Marketing Studio Image | [Higgsfield API console](https://console.higgsfield.ai) | `HF_CREDENTIALS` as `KEY_ID:KEY_SECRET`. [API authentication](https://docs.higgsfield.ai/docs/authentication); separate consumer OAuth is described below. |

Atomik's current text path uses AI Gateway rather than separate direct Anthropic or OpenAI keys. Its model selector and effort controls remain constrained by the actual gateway catalog and each model's capabilities. The app's Google adapter may also route image calls through AI Gateway; billing then belongs to the gateway account. Configure the credential for the route in use, and keep all provider credentials server-side.

## Higgsfield Marketing Studio Image

Moleculr uses the public production REST model `marketing-studio/image`, represented in Particl as `higgsfield/marketing-studio-image`. It supports direct image generation/editing and preset enhancement. It does not imply access to the complete consumer Marketing Studio.

Official reference: [Marketing Studio Image API](https://console.higgsfield.ai/models/marketing-studio%2Fimage/api-reference).

| Operation        | Public provider contract                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------- |
| Discover presets | `GET https://api.higgsfield.ai/marketing-studio/image/presets?size=50&cursor=…`                   |
| Estimate         | `POST https://api.higgsfield.ai/estimate/marketing-studio/image`, using the generation parameters |
| Generate         | `POST https://api.higgsfield.ai/marketing-studio/image`                                           |
| Track results    | Use the returned `request_id` and documented status URL                                           |

Credentials remain on the server: `Authorization: Key KEY_ID:KEY_SECRET`; the TypeScript SDK calls the combined value `HF_CREDENTIALS`. The API uses a separate prepaid US-dollar balance, independent of the consumer website subscription and its credits. See [authentication](https://docs.higgsfield.ai/docs/authentication), [API versus consumer billing](https://higgsfield.ai/creator-hub/help-center/integrations/what-is-the-higgsfield-api), and [estimates and retention](https://docs.higgsfield.ai/docs/concepts/billing-and-retention).

Particl exposes only scoped preset metadata through `GET /api/higgsfield/marketing/presets?cursor=…`, requiring the captured `X-Workbench-Scope`. Provider IDs are selected from this catalog rather than invented. The response has `configured`, `items`, `total`, `cursor`, and `capabilities`. The live provider returned a numeric pagination cursor on 17 September 2026; the adapter normalizes safe nonnegative integers to opaque strings and also accepts bounded text cursors. Preset visibility can change; stale or inaccessible presets fail before submission. The UI retains the selected preset ID/name with the project and revalidates it against the live catalog.

The verified input schema requires a prompt of 1–5,000 characters. Direct mode supports up to 16 image URLs, quality `low|medium|high`, resolution `1k|2k|4k`, and the documented aspect ratios. Preset enhancement requires high quality, an available preset UUID and one or two images: **product first, optional cast second**. No second image means product-only. The API rejects unknown fields; product URLs, product IDs, avatar IDs, hook IDs, and Soul IDs are not fields in this image request. The schema is embedded in the official model documentation.

Moleculr's product URL is saved context, not a claim that Higgsfield extracted that page. Reference files come from the project's authorized original assets. In enhanced mode the user chooses one product reference and, optionally, one selected cast reference. Quality is fixed to high; aspect and resolution remain reviewable in the existing generation dialog. Direct mode uses the selected product references and optional cast.

The general estimate contract returns decimal-string `credits` and `usd` fields. Particl quotes from the authenticated USD estimate and applies its existing customer accounting. Discovery and estimates do not submit a generation. No estimate or connection failure should fall back to an invented price. The provider documents a 10% surcharge for enhancement; advertised low-quality promotional prices are not a high-quality preset quote. Only a reviewed generation may reach the paid submission path.

Generated provider outputs must be retained in Particl storage; Higgsfield documents a minimum seven-day output availability window, not permanent asset hosting.

## Marketing video, product extraction and consumer tools

The official [Higgsfield CLI model catalog](https://github.com/higgsfield-ai/cli/blob/main/MODELS.md) documents `marketing_studio_video` and `marketing_studio_image` job types. Their consumer schemas are separate from the REST Image schema above. CLI operations include [product extraction](https://github.com/higgsfield-ai/skills/blob/main/higgsfield-generate/references/marketing-products.md), [preset/custom avatars](https://github.com/higgsfield-ai/skills/blob/main/higgsfield-generate/references/marketing-avatars.md), and [video hooks/settings](https://github.com/higgsfield-ai/skills/blob/main/higgsfield-generate/references/marketing-setup-items.md). Full Marketing Studio video and Virality Predictor (`brain_activity`) currently require a separately authorized consumer MCP/CLI connection for the documented integration route; an `HF_CREDENTIALS` REST key does not authorize that route.

The consumer MCP endpoint is `https://mcp.higgsfield.ai/mcp`. It uses OAuth to the user's Higgsfield account and spends consumer plan credits, including for models that have Unlimited access on the website. See [official MCP authentication and credit behavior](https://higgsfield.ai/creator-hub/help-center/integrations/what-is-higgsfield-mcp). No connector or CLI installation is required by this Particl integration.

A current public REST Marketing Studio Video or Virality Predictor contract has **not been verified**. Do not invent REST endpoints from CLI job names, pass consumer tool inputs to REST Image, or describe the unverified feature as enterprise-only. The [template-based Marketing Studio help article](https://higgsfield.ai/creator-hub/help-center/tools/how-do-i-use-marketing-studio-to-create-video-ads) also limits the consumer template product's agentic availability. Published CLI capabilities do not establish that the entire website template library is accessible.

Moleculr therefore preserves campaign video generation through Particl's existing, configured video engines. Those outputs are labeled accordingly and pass through their existing reference validation, generation quote, approval and recovery flow. Virality predictions and live performance scores are not fabricated.

## Agent planning and shared project context

Particl Studio and Moleculr reuse the same saved project assets, nodes, scripts, cast, generation jobs and edit outputs. Atomik Agent planning uses the configured thinking-model provider and the application's existing quote and accounting machinery. A project route ID is a workbench draft ID; backend production operations use its saved `productionProjectId` mapping. API credentials and internal provider IDs are not substitutes for tenant/project authorization.

Brand planning uses the project's existing marketing brief (objective, offer, audience, tone and constraints). Suggested creative actions are reviewed before they are applied. A planning result is not proof that a URL was fetched, a market trend was measured, or a campaign was published.
