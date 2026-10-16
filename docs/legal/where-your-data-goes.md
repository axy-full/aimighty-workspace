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
| sync.so / Sync Labs (lipsync-2-pro; sync-3 for hero and 4K; PR #776) | Planned | A clip and audio: **faces and voices** | Published (as published 16 Oct 2026, check before relying): "as long as is necessary"; no zero-retention option on its pages; data provided to it in the United States. We delete our generation and uploaded assets after we store the output (`DELETE /v2/generations/{id}`, finished jobs only, and `DELETE /v2/assets/{id}`); whether that removes stored media permanently is not stated (see the published statements below) | Published: uses data for "developing, training, and fine-tuning the AI models"; its terms grant a "perpetual, and irrevocable license"; no training opt-out on its pages. **The owner holds a written confirmation of no training on our data (15 Oct 14:25), kept with company records, not in the repo; it conflicts with the published text (L-W2)** | **Yes, by written confirmation only** (not an account setting; no opt-out is published) |
| Sarvam AI (Bulbul, Saaras, dubbing; PR #777) | Planned | Text to speak or translate; audio to transcribe: voices | Published (as published 16 Oct 2026, check before relying): inputs and outputs "User-configurable (default: 30 days after last access)"; usage logs 1 year. **Ours is set to 0 days** by the owner (15 Oct 14:25). Sensitive personal data of Indian users stored in India "where feasible"; transfers to the US (AWS, GCP, Azure) and the EU (some model providers) | Published: trains on content unless you opt out in account settings or in writing. Its terms: "Subject to your consent, which you may decline or withdraw" (plan section 2) | **Retention: yes (0 days). Training: no / unknown. To switch off: owner action in Sarvam's account settings** (not recorded as done) |
| Black Forest Labs (FLUX 3, FLUX.2; PR #778) | Planned | Prompts and up to 8 reference images, to the EU endpoint `api.eu.bfl.ai`. Result links last 10 minutes, so we copy the output at once | Published (as published 16 Oct 2026, check before relying): "as long as is reasonably necessary"; transfers outside the collection country under standard contractual clauses; controller BFL GmbH (Germany) for the EEA, UK and Switzerland | Published: "the Company may use Inputs and Outputs to train and improve its artificial intelligence models"; opt out by email | **Yes.** Training opt-out done in BFL's dashboard (owner, 15 Oct 13:45); the published route is an email, so keep the written copy (L-W3) |
| Recraft (V4.1, V3) | Planned | Prompts; an image for vectorize or background removal | API data "is not stored" (its data-use page, in the plan section 5) | API inputs and outputs "are never used for model training" (same record) | n/a: no setting recorded |
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

Not used, by decision: **AWS Rekognition (receives nothing; no face matching, owner, 16 Oct 2026)**; an AI gateway; MiniMax/Hailuo, Suno, Udio, Sora, PlayHT, face-swap engines built on InsightFace, Wav2Lip, self-hosted MMAudio (owner, 15 Oct 22:15).

## Published statements, 16 Oct 2026: Black Forest Labs, Sarvam AI, sync.so

These are what each provider's **own pages said when fetched on 16 Oct 2026**, quoted as published. **Check each page again before relying on it**; pages change. They are the provider's words, not a promise to us, and not legal advice. The record of what the owner has set or confirmed is in the table above and the record of switches below.

| Provider | Source | What it says (quoted) |
|---|---|---|
| Black Forest Labs (FLUX.2 images, EU endpoint `api.eu.bfl.ai`, PR #778) | API terms, https://bfl.ai/legal/flux-api-service-terms (rev. 4 Aug 2026) | "the Company may use Inputs and Outputs to train and improve its artificial intelligence models". Opt-out by email to privacy@blackforestlabs.ai with the subject "Training Opt Out" |
| | Privacy policy, https://bfl.ai/legal/privacy-policy | Retention "as long as is reasonably necessary"; transfers outside the collection country under standard contractual clauses; controller BFL GmbH (Germany) for the EEA, UK and Switzerland |
| | API behaviour | Result URLs are valid for 10 minutes |
| Sarvam AI (speech, transcription, translation, PR #777) | Privacy policy, https://www.sarvam.ai/privacy-policy (29 Jul 2026) | Inputs and outputs retention "User-configurable (default: 30 days after last access)"; usage logs 1 year; trains on content unless you opt out in account settings or in writing; transfers to the US (AWS, GCP, Azure) and the EU (some model providers); "Sensitive personal data of Indian users is stored in India where feasible." |
| sync.so / Sync Labs (lip-sync, PR #776) | Privacy, https://sync.so/privacy (effective 27 May 2024) | Retention "as long as is necessary"; uses data for "developing, training, and fine-tuning the AI models"; data provided to it in the United States |
| | Terms, https://sync.so/terms | A "perpetual, and irrevocable license"; no training opt-out and no zero-retention option on its pages; its terms on face and voice tools contain bracketed, draft-like text |
| | API | `DELETE /v2/generations/{id}` works on a finished job only; `DELETE /v2/assets/{id}`. Our adapter deletes the vendor's copy after we store the output |

**Items that follow (face and voice data):**
- [OWNER DECISION OD-W1: sync.so receives faces and voices, and its published terms give it a perpetual, irrevocable licence and training use with no published opt-out, against the owner's written confirmation of no training. Options: (a) keep sync.so for the house workspace only until the confirmation is checked against the terms; (b) rely on the written confirmation and say so; (c) ask Sync Labs for an API opt-out and zero retention (`vendor-requests.md`, section 8) and wait for the answer before any customer use.]
- [OWNER DECISION OD-W2: Sarvam's published default is training on content unless opted out, and 30 days' retention. Options: switch training off in Sarvam's account settings now (owner action, README) and re-check the 0-day retention setting; or accept the default and say so in the privacy table.]
- ⚖ LAWYER L-W2: the conflict between sync.so's published terms (perpetual, irrevocable licence; training) and the written confirmation we hold: which governs, whether the confirmation is a binding amendment, and what we may tell customers whose faces and voices pass through sync.so. Also the **bracketed, draft-like text in sync.so's terms on face and voice tools**: what it means for us and for a person whose face or voice is sent. See L-T9, L-P3, L-V1.
- ⚖ LAWYER L-W3: that an email opt-out to BFL (and the dashboard setting) is enough, who may rely on it, whether the written copy is kept, and the transfer terms (standard contractual clauses, BFL GmbH as controller) for the notice.
- ⚖ LAWYER L-W4: Sarvam's published transfers to the US and the EU against "stays in India" wording; whether Indian users' sensitive data "where feasible" is enough for our notice; and the processing agreement (L-P3b).

**Delivery formats (16 Oct 2026, owner 11:50):** **DNxHR is back as a delivery format** (HQ and HQX mezzanine, alongside ProRes and H.264), once lane D's PR is tested. It is written on our own export worker; no provider receives anything for it, so it adds no row to the tables above. Its encoder's licence is in `licence-register.md` (section A4, L-L10).

## Record of switches (fill in; date and who)

When someone switches off training, "improve the models" or a retention setting in a provider's console, add the line here the same day. Who = the role or initials, never a secret.

| Provider | Setting | Date | Who | Source |
|---|---|---|---|---|
| Black Forest Labs | Training opt-out (dashboard) | 15 Oct 2026, 13:45 IST | Owner | `docs/redesign-plan.md`, "Owner, 15 Oct 2026, 13:45 IST" |
| sync.so | No training, written confirmation (not a setting) | 15 Oct 2026, 14:25 IST | Owner | `docs/redesign-plan.md`, "14:20 and 14:25 IST"; the letter is kept with company records |
| Sarvam | Retention 0 days | 15 Oct 2026, 14:25 IST | Owner | same |
| ElevenLabs | Training / "improve the models" off | [DATE] | [WHO] | owner action, not yet recorded |
| Sarvam | Training off in account settings; content retention at the shortest allowed | [DATE] | [WHO] | owner action: retention 0 days is recorded (15 Oct 14:25); training off is not |
| Every other provider that offers such a setting | Check the account; see `README.md`, "Owner actions" | [DATE] | [WHO] | |
