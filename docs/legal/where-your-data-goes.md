# Where your data goes: DRAFT

Draft 0.1, 15 Oct 2026. Not live. One page for the owner's lawyer, and the source for a public page on the site (a later product PR; nothing in the app changes with this file). Owner, 15 Oct 2026, 22:15 IST: "Keep a one-page 'where your data goes' table (provider → what is sent → retention → training) in docs/legal and on the site." Tags are explained in `README.md`.

## The promise this table supports

**Particl does not train on customer content. Providers may, under their own policies.** There is no no-training gate on wiring a provider (owner, 15 Oct 22:15). So the Training column below says what the repo's record says about each provider, and nothing more. "Per the provider's policy" means no source is recorded here: read the provider's policy at the link before relying on it. A `[LINK: ...]` is a placeholder for that provider's own policy page; the owner or the lawyer fills it (no link is invented here).

⚖ LAWYER L-W1: whether this table, with the Terms sentence above, is accurate enough to publish; whether each "per the provider's policy" needs a stronger statement; and whether the table belongs in the Privacy Policy or on a linked page. See L-P6.

## How to read the columns

- **Status:** Live = in production use on `release/1` or named on the live Privacy page. Planned = decided in the record and not merged or not switched on; the 15 Oct 22:15 stack is being wired and everything it adds is Planned until its PR is merged and deployed. Leaving = in use now, being replaced.
- **What is sent:** from the code and the plan, in plain words. Each vendor gets only what its job needs. Every call goes straight to the vendor; there is no AI gateway.
- **Retention:** what the record says. Where it says nothing: "not recorded".
- **Training:** what the record says about the provider's own terms or our written confirmation.
- **Switched off on our account?** yes / no / unknown / n/a, from the record. "To switch off: owner action" means the setting is Particl's account owner's to change in the provider's console and is not recorded as done (see the record of switches at the end).

## AI providers

| Provider | Status | What is sent | Retention | Training | Switched off on our account? |
|---|---|---|---|---|---|
| BytePlus (Seedance 2.5 / 2.0; ModelArk text for prompt enhancement) | Live | Prompts, reference images, clips and audio for video; a customer's prompt, to be rewritten | A draft's task can make its final for 7 days from when the vendor took it (code, `docs/seedance-draft-final.md`). Otherwise not recorded; per the provider's policy [LINK: BytePlus privacy policy] | Not recorded; per the provider's policy [LINK: BytePlus privacy policy]. Written terms requested (optional): `vendor-requests.md` section 1 | Unknown |
| Google, Gemini API (Nano Banana Pro and 2, Gemini text) | Live | Prompts and reference images (inline) for stills; Atomik's words for text | Not recorded; per the provider's policy [LINK: Google Gemini API terms and privacy] | Not recorded; per the provider's policy [LINK: Google Gemini API terms and privacy] | Unknown |
| Google, Nano Banana 2.1 and Gemini 3.x (moments, cutdown planning, vision judge) | Planned | Same as above; frames for the vision judge | Not recorded; per the provider's policy [LINK: Google Gemini API terms and privacy] | Not recorded; per the provider's policy | Unknown |
| Google, Veo 3.1 | Planned | A prompt, reference images or a frame | Not recorded; per the provider's policy [LINK: Google Gemini API terms and privacy] | Not recorded; per the provider's policy | Unknown |
| Google, Cloud Vision (text in images) | Planned | Images or review frames, to read the text in them | For answers given at once, the image "is processed in memory and not persisted to disk"; some request metadata is logged for a short time (`docs/plans/provider-adapters.md` section 4, from Google's data-usage page read 14 Oct). No India endpoint: processed abroad | "Google does not use the content you send to train and improve our Cloud Vision features" (same record) | n/a: no setting recorded |
| OpenAI (GPT Image 2.5) | Live | Prompts and reference images; some of Atomik's writing | Not recorded; per the provider's policy [LINK: OpenAI privacy policy] | Not recorded; per the provider's policy [LINK: OpenAI privacy policy]. Written terms requested (optional): `vendor-requests.md` section 3 | Unknown |
| Anthropic (Claude, for Atomik) | Live | Your words to Atomik and files attached | Not recorded; per the provider's policy [LINK: Anthropic privacy policy] | Not recorded; per the provider's policy [LINK: Anthropic privacy policy] | Unknown |
| xAI (Grok text, Grok Imagine, voice) | Live | Prompts and reference images; Atomik's writing; audio for voice | Not recorded; per the provider's policy [LINK: xAI privacy policy] | Not recorded; per the provider's policy [LINK: xAI privacy policy] | Unknown |
| ElevenLabs (speech, sound effects, music, dubbing; speech to text planned) | Live (speech to text: Planned) | Scripts and audio | Not recorded; per the provider's policy [LINK: ElevenLabs privacy policy] | Not recorded; per the provider's policy [LINK: ElevenLabs privacy policy]. The account offers a setting to improve the models (owner, 15 Oct 22:15) | **No. To switch off: owner action** (not recorded as done) |
| Higgsfield (API key only) | Live | Prompts and photos, for identities and stills | Not recorded; per the provider's policy [LINK: Higgsfield privacy policy] | Not recorded; per the provider's policy [LINK: Higgsfield privacy policy] | Unknown |
| fal (Kling 3.0 now, Kling 4.0 when live; identity training; today also Topaz and Bria until each goes direct) | Live | Prompts, reference images, clips; identity photos for training | Not recorded; per the provider's policy [LINK: fal privacy policy] | Not recorded; per the provider's policy [LINK: fal privacy policy] | Unknown |
| Topaz Labs (direct) | Planned (live today through fal) | Images and clips to upscale | Not recorded. Asked: how long it keeps files; to delete its copy after we store the output (`docs/plans/provider-adapters.md` section 8); no answer recorded | Not recorded: "confirm Topaz doesn't train on our uploads" was asked, no answer recorded. Optional request: `vendor-requests.md` section 5 | Unknown |
| Bria (direct) | Planned (live today through fal) | A still to extend or cut out | Not recorded; per the provider's policy [LINK: Bria privacy policy] | Not recorded; per the provider's policy [LINK: Bria privacy policy]. Optional request: `vendor-requests.md` section 6 | Unknown |
| Runway (Act-Two, Aleph 2, Gen-4.5) | Planned (house workspace only) | A face video and a driving video, a video to transform, or a prompt and image | Not stated for API outputs; we delete a finished task after we store the output (`docs/plans/provider-adapters.md` section 7) | Its terms (updated 15 Sep 2026) let it "train and improve its AI models" on inputs and outputs; no API opt-out is stated (same record) | **No** (none stated). Customer use only under written terms that exclude training |
| sync.so (lipsync-2-pro; sync-3 for hero and 4K) | Planned | A clip and audio | We delete our generation and uploaded assets after we store the output (planned, section 1 of the plan). Otherwise not recorded | Its privacy policy allows training; the owner has written confirmation of no training on our data (15 Oct 14:25), kept with company records, not in the repo | **Yes, by written confirmation** (not an account setting) |
| Sarvam (Bulbul, Saaras, dubbing) | Planned | Text to speak or translate; audio to transcribe | **0 days**, set by the owner in Sarvam's console (15 Oct 14:25). Processed and stored in India | "Subject to your consent, which you may decline or withdraw" (its terms, `docs/plans/provider-adapters.md` section 2). No decision recorded | Unknown for training; retention switch: yes |
| Black Forest Labs (FLUX 3, FLUX.2) | Planned | Prompts and up to 8 reference images, to the EU endpoint | "As long as is reasonably necessary" (its privacy policy, revised 1 Aug 2026, in the plan section 6). EU endpoint | Its policy says inputs and outputs "may be used to train and improve" its models, with an opt-out by request | **Yes.** Training opt-out done in BFL's dashboard (owner, 15 Oct 13:45) |
| Recraft (V4.1, V3) | Planned | Prompts; an image for vectorize or background removal | API data "is not stored" (its data-use page, in the plan section 5) | API inputs and outputs "are never used for model training" (same record) | n/a: no setting recorded |
| AWS Rekognition (Mumbai) | Planned | Face images: review frames and cast masters, stateless calls, no face collections | Stateless: "data returned by this operation doesn't persist". Mumbai | AWS's FAQ says inputs "may" be stored and used to improve the service unless the account opts out through an AWS Organizations AI-services opt-out policy (plan section 3) | **Unknown. To switch off: owner action** (not recorded as done); before any customer use |
| AWS Elemental MediaConvert (Smart Crop reframe) | Planned | The finished clip, copied to an S3 bucket in Mumbai, and the cropped clip back | Our bucket: ours to set. AWS side: not recorded; per the provider's policy [LINK: AWS privacy notice] | Not recorded; per the provider's policy [LINK: AWS service terms and privacy notice] | Unknown: check whether an AWS opt-out applies |

## Our infrastructure and other providers

None of these is an AI model provider; nothing in the record says any of them trains on content.

| Provider | Status | What is sent | Retention | Training | Switched off on our account? |
|---|---|---|---|---|---|
| Turso (Mumbai) | Live | All workspace records except files; account and billing records | Ours: nothing is erased (live Privacy page) | n/a | n/a |
| Cloudflare R2 | Live | Your files (masters, uploads, identity photos) under your workspace's own prefix | Ours: files are kept | n/a | n/a |
| Cloudflare (DNS) | Live | Domain lookups | Per the provider's policy [LINK: Cloudflare privacy policy] | n/a | n/a |
| DigitalOcean (Bangalore) | Live | Everything the app handles, in transit and at rest | Ours | n/a | n/a |
| Resend | Live | Your email address, for sign-in and invites | Per the provider's policy [LINK: Resend privacy policy] | n/a | n/a |
| Liveblocks | Live | Board content shared in a live session | Per the provider's policy [LINK: Liveblocks privacy policy] | n/a | n/a |
| Inngest | Live | Identifiers of work to run, not prompts | Per the provider's policy [LINK: Inngest privacy policy] | n/a | n/a |
| Google sign-in | Live (Google's Testing mode until published) | Your Google account identifier and email | Per the provider's policy [LINK: Google privacy policy] | n/a | n/a |
| Stripe | Planned (not live) | Billing details; card data goes to Stripe | Per the provider's policy [LINK: Stripe privacy policy] | n/a | n/a |
| Vercel (Blob, 3D Sandbox) | Leaving | Older stored files; the scene and assets of a 3D render | Blob read-only for 30 days after cutover, then deleted only with the owner's yes | n/a | n/a |
| Luma, through fal (reframe) | Leaving (replaced by AWS MediaConvert Smart Crop) | A finished clip | Not recorded; per the provider's policy [LINK: Luma privacy policy] | Not recorded | Unknown |

Not used, by decision: an AI gateway; MiniMax/Hailuo, Suno, Udio, Sora, PlayHT, face-swap engines built on InsightFace, Wav2Lip, self-hosted MMAudio (owner, 15 Oct 22:15).

## Record of switches (fill in; date and who)

When someone switches off training, "improve the models" or a retention setting in a provider's console, add the line here the same day. Who = the role or initials, never a secret.

| Provider | Setting | Date | Who | Source |
|---|---|---|---|---|
| Black Forest Labs | Training opt-out (dashboard) | 15 Oct 2026, 13:45 IST | Owner | `docs/redesign-plan.md`, "Owner, 15 Oct 2026, 13:45 IST" |
| sync.so | No training, written confirmation (not a setting) | 15 Oct 2026, 14:25 IST | Owner | `docs/redesign-plan.md`, "14:20 and 14:25 IST"; the letter is kept with company records |
| Sarvam | Retention 0 days | 15 Oct 2026, 14:25 IST | Owner | same |
| ElevenLabs | Training / "improve the models" off | [DATE] | [WHO] | owner action, not yet recorded |
| AWS (Rekognition) | AI-services opt-out policy (AWS Organizations) | [DATE] | [WHO] | owner action, not yet recorded |
| Every other provider that offers such a setting | Check the account; see `README.md`, "Owner actions" | [DATE] | [WHO] | |
