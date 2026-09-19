# Subatomik viral studio

Subatomik adds Higgsfield Genjutsu to the shared project workflow. The fourth top-bar suite keeps the selected workbench draft; `/subatomic` redirects to `/subatomik` for older bookmarks. Production, Atomik and Moleculr retain their existing workflows.

## Website and API audit

The signed-in [Genjutsu website](https://higgsfield.ai/ai/video?model=genjutsu), the Cloud model catalogue and the connected account's advertised MCP tools were inspected in September 2026. The website offers Motion Transfer and Objects Swap, an optional prompt, up to 30 reference images, source videos of 4–30 seconds, 480p/720p/1080p, history, recreation and a motion library. Source preview includes playback, frame extraction, download and edit/upscale handoffs.

Subatomik implements the two modes, ordered shared-library references and uploads, optional creative direction, reviewed generation, original result history, recreation, enlarged reference previews, start/end-frame PNG extraction, synchronized split/wipe comparison with seek/speed/volume/fullscreen, original download and Edit/upscale handoffs. Frame extraction preserves native dimensions and files the explicit upload back into the selected project. Atomik planning remains a separate reviewed action.

The website's Higgsfield/Community motion gallery is not exposed by the connected account's advertised Genjutsu API. The public JavaScript SDK, Python SDK, CLI and skills repositories also contain no Genjutsu-specific preset catalogue. The generic `presets_show` tool describes the older `higgsfield_preset` model; its IDs must not be sent to Genjutsu. Subatomik links to the official gallery and can recreate its own saved takes. Particl's creative directions are editable prompt starting points, not purported provider presets or a live community feed.

## Cloud developer connection

The official model catalogue exposes two operations:

| Operation | Developer endpoint |
| --- | --- |
| Motion Transfer | `higgsfiled/genjutsu/motion-transfer/v1.0` |
| Object Swap | `higgsfiled/genjutsu/object-swap/v1.0` |

The provider spells these identifiers `higgsfiled`. Requests contain one `video_url`, up to eight ordered `image_urls`, an optional `prompt`, and `resolution` of `480p` or `720p`. The catalogue specifies an input duration of 1–30 seconds. Particl's creative text limit is 5,000 characters; this is a local bound, not a claimed Higgsfield limit.

Use the existing private `HF_CREDENTIALS` connection. Each quote uses the authenticated `/estimate/<model path>` endpoint; a missing or invalid live estimate blocks submission. No public-list discount is assumed. Server validation resolves tenant-owned originals, inspects source duration and preserves reference order. Browser-supplied URLs and claimed duration cannot substitute for retained media.

Submission uses the standard generation credit reservation and idempotency boundary. Accepted provider request handles are durably retained for collection and recovery. Completed output follows the documented `video.url` status response and is copied into Particl's private original storage; provider retention alone is insufficient for a production library. Result history, original download and edit handoff retain the selected project's mapping.

Queued Cloud jobs can request cancellation. An HTTP 202 only means requested; Subatomik continues polling the existing job until cancellation is confirmed. It does not promise a refund or dispatch a replacement while the result is uncertain.

## Billing default and override

The connected account is the silent default. When the workspace owner has a connected account, `/subatomik` generates with connected credits and shows no billing toggle; the page reads the owner's connection status from `/api/higgsfield/consumer/connection` on open. Members always use Particl workspace (Cloud) billing, as only the owner can spend the connected account's credits. Without a connection the page keeps the Cloud path and shows the connection prompt (Workspace settings → Engines); it does not offer a choice in the main flow.

`?account=particl` is the explicit, unadvertised override to Particl workspace billing. It is linked from the small **Advanced** disclosure at the bottom of the page and is carried across the Motion Transfer / Object Swap pages by the dock. `?account=higgsfield` remains valid for older links and recreation URLs, but is not required for the default. Every approval-step disclosure is unchanged: originals are copied to the connected account at quote time (approved before the quote), the exact connected-credit price and wallet are approved before submission, and the account-wide shared-wallet caveat is shown on the quote. User-facing copy says "connected account" / "connected credits"; the provider is not named.

## Connected account

The authenticated `models_explore` catalogue advertises `hf_mult_motion_control` and `hf_mult_replace_object` with 480p/720p/1080p. The `generate_video` tool explicitly requires exactly one source media UUID with role `video` and ordered references with role `image`. URLs are not valid generation references. The website's 4–30-second source and 30-image limits apply to this path; remote URL imports are bounded to 50 MB per original.

Reviewing a quote first imports the chosen tenant-owned originals through `media_import_url`. This transfer is disclosed before the action. Import receipts pin the connected owner, authorization generation, selected Higgsfield workspace, local original identity and returned media UUID. An uncertain import does not silently repeat. No private bearer token or signed media URL is included in saved generation parameters or public exports.

The account route calls `generate_video` with `get_cost: true` for a quote and `use_unlim: false`. Approval binds the exact immutable input, wallet, credit amount and expiry. Submission has one durable dispatch claim; uncertain replies retain their recovery record and cannot create a second paid job. This uses **connected credits** (Higgsfield credits in the ledger), recorded separately from Particl's Cloud generation credits and USD costs. Switching connections is explicit and cannot change a pending job's billing identity.

Successful account outputs are copied byte-for-byte into authenticated Particl storage. The retained model, source, reference order, resolution, project and provider credit receipt remain attached. Collection, deletion protection, export, recovery and tenant purge use the same original-retention boundaries as Marketing Studio. Provider results that do not match the verified job identity fail closed for reconciliation.

Atomik can develop a Subatomik creative plan through the existing Claude/OpenAI model and effort controls. Planning has its own reviewed quote; applying a proposal does not authorize a render. Rendering requires a separate generation quote.

## Official references

- [Genjutsu model catalogue](https://console.higgsfield.ai/models/workflows/genjutsu/playground)
- [Genjutsu website](https://higgsfield.ai/genjutsu)
- [Genjutsu creation and motion library](https://higgsfield.ai/ai/video?model=genjutsu)
- [Motion Transfer](https://console.higgsfield.ai/models/higgsfiled/genjutsu/motion-transfer/v1.0/playground)
- [Object Swap](https://console.higgsfield.ai/models/higgsfiled/genjutsu/object-swap/v1.0/playground)
- [Request lifecycle and output](https://docs.higgsfield.ai/docs/concepts/requests)
- [Authenticated estimates, refunds and retention](https://docs.higgsfield.ai/docs/concepts/billing-and-retention)
- [Official JavaScript SDK](https://github.com/higgsfield-ai/higgsfield-js)
- [Official Python SDK](https://github.com/higgsfield-ai/higgsfield-client)
- [Official CLI catalogue](https://github.com/higgsfield-ai/cli/blob/main/MODELS.md)
- [Official skills](https://github.com/higgsfield-ai/skills)

Live read-only account discovery verified both models and 1080p. Mocked provider responses and browser fixtures verify application behavior; they do not certify successful paid Genjutsu output or an unobserved final-result envelope. Any live rehearsal requires its own reviewed estimate and explicit spending ceiling. Full first-party gallery/community parity remains dependent on Higgsfield exposing those capabilities.
