> **16 Oct 2026, 10:55 IST (owner): Rekognition is OUT.** No face matching anywhere, ever; no consent-photo table or migration. The `REKOGNITION_*` keys stay set but nothing reads them. Section 3, the K1 to K5 rows, the consent-source decision and every Rekognition mention below are **superseded**; they stay as history. The consent record that remains is a tick ("I have this person's permission") and an optional NOC file stored with the asset, never checked automatically (`docs/legal/`, D19). `GEMINI_IMAGE_MODEL` and `GOOGLE_SAFETY_THRESHOLD` are unused and never set.

# Provider adapters as registry tools: sync.so, Sarvam, AWS Rekognition, Google Cloud Vision, Recraft, Black Forest Labs, Runway, and Topaz (plan, 14 Oct; owner answers added)

> **15 Oct 2026, 22:15 IST:** section 9 (the setting-name table) is updated to the owner's FINAL ENGINE STACK: every provider with its key name, address, switch and extras, what the old table was missing, the site setting for "engines on" and the house-cap finding. The rest of this plan is as of 14 Oct and is not rewritten here.

## Where this stands: the final engine stack, its slices and its PRs (owner, 15 Oct 2026, 22:15 IST; updated 15 Oct late evening)

The owner approved the FINAL ENGINE STACK ("Build it, switch it on, keep it ready. We test it live on particl.si with the Aimighty team") and a standing yes for tonight (22:20): PRs merge into release/1 only, with no migration, env name, money behaviour, sign-in or guard-test change; anything else opens as NEEDS AKSHAY. **No paid generation runs before the team tests with the owner** (no bake-off, no qualification render, no "quick check"); mock tests only. Source: `docs/redesign-plan.md`, "FINAL ENGINE STACK" and "22:20 IST".

**Rules for every engine** (owner): its own PR, titled NEEDS AKSHAY, a yes per PR, live in the next deploy; before merge a price table from the provider's own page, mock tests, an Opus money review, the real provider cost on every ledger line and its own kill switch; **ON for the house workspace (`ws_legacy`) and any workspace listed in the site setting, OFF for customer workspaces until launch**; the normal per-step approval in the UI is the approval, and the team's first real use is the test (**this replaces every "qualification run" row below**); a monthly cap on the house workspace of $500 with a warning at 80%; no migration without the owner's word; guard tests never weakened; secrets never in code or chat. **Data terms** (22:15): Particl promises it does not train on customer content; providers may under their own policies; there is **no no-training gate on wiring** (so Runway's and BFL's training clauses in sections 5 to 7 are information for the privacy table in `docs/legal/where-your-data-goes.md`, not a block); training or "improve the models" is switched off on every account that offers it, and recorded. **Consent:** every real face passes Rekognition against its consent record before Act-Two, cloning or lip-sync runs.

**The order, by slice** (each engine its own PR):

| Slice | What | PRs and where it stands |
|---|---|---|
| **1** | Remotion worker ON (animatic, timeline, titles, subtitles, karaoke captions, narrated assembly, cutdowns, silence cuts, fps conform, H.264 + ProRes mezzanine + DNxHR, stems from our timeline, Download all zip) and **Chromium PDF** (treatment, pitch, PPM decks). First: measure one real 30 s 1080p export (CPU only, our own media; time, cost). | Remotion #697 compositions, #699 worker, #700 app and fair queue (`export_jobs` migration: needs the owner's word), #768 format (H.264, ProRes 422 and HQ; H.265 refused), #769 subtitles, #770 conform, #772 narrated assembly, #773 silence-aware cutdowns; **#767 PDF decks** (stacked on #700, `PDF_EXPORTS`, free); #766 exports on for the house and listed workspaces only (`enginesOnWorkspaces`). Plan: `docs/plans/remotion.md`. **DNxHR is not in #768's list** (H.264 and ProRes only): a follow-up is needed. |
| **2** | sync.so (lipsync-2-pro; sync-3 for hero and 4K); Sarvam (Bulbul, Saaras, dubbing); Black Forest Labs (FLUX 3 and FLUX.2 identity, replacing fal flux-lora); Runway (Act-Two, Aleph 2, Gen-4.5); **Veo 3.1**; AWS Mumbai (**Rekognition** consent match; **MediaConvert Smart Crop**, replacing Luma reframe); Topaz direct (T0 to T3). | **#771 Rekognition consent gate** (NEEDS AKSHAY; the gate fails closed until the reference source is chosen, see below). sync.so, Sarvam, BFL, Runway, Veo, MediaConvert and Topaz have no PR yet; their rows are in the table below. #765 the house workspace's $500 cap with an 80% warning (the finding in section 9) is its own PR. |
| **3** | **Nano Banana 2.1** beside Pro; **Gemini 3.x** for moments, cutdown planning and the vision judge; **Cloud Vision label check with an exact text diff** (never an AI model alone); **Recraft V4.1 and V3** (decks, brand assets, sketch, ink and comic storyboards); **Kling 4.0** on fal the day it is live (3.0 Pro until then). | No PRs yet. |
| **4** | The "later" list, one at a time, on a client need or a bake-off win: HeyGen Avatar IV, Ideogram, FASHN, Hunyuan3D/Tripo, Magnific, AudioShake, Storyblocks, TwelveLabs, Wan 3.0, Gemini Omni Flash. Owner action now: ask Adobe for a Firefly Reframe quote. | Not planned in detail. |
| **5** | The viral trend panel (after Slice 3): YouTube mostPopular (IN), Google Trends via SerpApi, TikTok signals via Zyla (hashtags, sounds, formats; never videos), Instagram hashtag search via Meta once our app is approved; one list with a source badge and a "crossing to India" flag. | `docs/plans/viral-trends.md`; names in section 9, E. |

**Left out, by decision:** MiniMax/Hailuo, Suno, Udio, Sora, PlayHT, any face swap built on InsightFace, Wav2Lip, self-hosted MMAudio, Luma reframe (replaced by MediaConvert). **H.265 stays off** until the owner's lawyer answers.
**Pro pick menu:** Seedance 2.5, Veo 3.1, Kling 4.0, Runway Gen-4.5. Names live in config, never in the design.
**SUPERSEDED 16 Oct 10:55 (owner): Rekognition is out; no face check and no reference-source decision. What follows is history.** (Was: Owner decision pending: the face reference source (#771).) A consent record holds no face image today (the recorder is audio only), so the check refuses every face with "This person's consent has no face reference yet" until the owner picks one: (1) a face photo taken at consent time (a new table or column; ties the face to the person who consented; the heaviest for counsel; the coordinator recommends it), (2) the cast member's identity master (no schema change; proves "same as the cast member", not "the person who consented"), or (3) a frame from a video recording. **Until then lip-sync, Act-Two and cloning cannot run on real faces.** The check runs for the house workspace only.
**Bake-offs the team runs live** (results decide defaults; no paid run before the team tests with the owner): (a) an 8-panel storyboard, two characters, three styles, on Recraft, GPT Image 2.5, Nano Banana Pro and 2.1; (b) 10 real briefs on the top 3 video engines; (c) one Hindi lip-sync clip on sync.so.


The owner asked for this on 14 Oct: plans first, no paid calls. This plan was read from release/1 at 890d559c. The providers' public pages were read on 14 Oct 2026; the links are at the end.

**No provider API was called while writing this,** not even a free one, and no key was used. **Every price below is a sample / proposal.** The owner approves every rate-card row. Screens are not specified here: anything a person will see **waits for Claude Design / v18**.

## Owner decisions (14 Oct, final)
In the owner's words: "order accepted with one change — lip-sync goes DIRECT through sync.so (I'm buying the account; not via fal), including lipsync-2-pro and sync-3. Then Sarvam direct (I'm buying the account), then Rekognition, then Runway standby (house only until training-free terms). Voice cloning: not now. Counsel before any customer switch. Delete the vendor's copy once we've stored the output (sync.so DELETE, Sarvam retention 0). ADD to the plan: Recraft (raster, vector, vectorize, remove background), Black Forest Labs FLUX.2 (create + multi-reference edit), Google Cloud Vision text detection (GOOGLE_VISION_API_KEY is set), and a Topaz direct vs fal price comparison. Give me the exact Coolify setting NAMES per provider (names only; AWS names distinct from anything R2/S3 reads)."

- **DECIDED, the order:**
  1. lip-sync **direct on sync.so** (§1), with lipsync-2, lipsync-2-pro and sync-3;
  2. **Sarvam direct** (§2);
  3. **Rekognition** (§3);
  4. **Runway on standby**, in the house workspace only until training-free terms (§7).
  
  The additions (§4 Google Cloud Vision, §5 Recraft, §6 Black Forest Labs FLUX.2) are slotted in §10. Owner question A confirms where.
- **DECIDED: no voice cloning for now.** Stock voices only.
- **DECIDED: counsel before any switch is turned on for a customer workspace.** Building behind switches that are off may go ahead. Turning a switch on for a customer waits for counsel.
- **DECIDED: delete the vendor's copy once ours is stored.** sync.so `DELETE /v2/generations/{id}`, Sarvam retention 0 days, Runway `DELETE /v1/tasks/{id}`. It is the vendor's copy, so Particl's never-delete rule is untouched.
- **Added:**
  - Recraft (§5);
  - FLUX.2 on Black Forest Labs' own API (§6);
  - Google Cloud Vision text detection (§4);
  - a Topaz direct-versus-fal comparison (§8);
  - every Coolify setting name, in one table (§9).
- **Still open from the first draft:** the rupee rate (D), the face-check threshold and its pricing (E), and Sarvam versus Grok for transcripts (F). See §12.

## 0. How a provider becomes a tool in Particl today

- **An engine is one adapter file** (`lib/engines/types.ts:6-12`; the list is `lib/engines/index.ts:13-14`).
- **A provider is one data entry** (`lib/providers.ts:15-17`). It names the key's env var, the request limits, and whether the provider bills failures (`billsFailures`, `:49`).
- **What a vendor charges** lives only on the server (`lib/vendorRates.ts`). `tests/unit/bundle.spec.ts` guards that this never reaches a browser.
- **What we sell at** comes from `billCredits()`, via the margin table (`lib/creditTerms.ts:49-86`). It is whole credits, rounded up, at least 1.
- **The tool registry (A1) is not built on release/1.** `lib/v12/skills.ts:33` says so, and no branch has one. The shape a tool must have is set by SOW 4 Oct §4.3:
  - an id, a kind, inputs and limits, a provider, the key it needs, a price function, a mock;
  - who may call it: anyone, people only, or admins only.
  
  Engine tools are generated from `lib/models.ts` and the task tables, never from a second hand-kept list. App actions are declared beside their handlers.
  - **So each tool below is written in that shape.** If A1 has landed when a PR starts, the tool registers there. If not, the PR adds model rows (for engines) or a typed declaration beside the handler (for app actions), and A1 picks them up. No PR adds a parallel list of engines.
- **One paid path** for every tool:
  1. a quote from the server's price path;
  2. a person's approval (Ask), or a plan's approval;
  3. a durable claim (`generation_requests`, `lib/generationRequests.ts:52`);
  4. a reservation on the meter (`lib/meter.ts:158`);
  5. poll and collect;
  6. settle.
  
  Atomik, MCP and API tokens prepare. They never approve (`lib/security/people-only.ts:1-5`, `:18`). A job above 200 cr always asks (guardrail 4).
- **Switches:** each provider gets a `<VENDOR>_ENABLED=1` switch, off by default, like `HF_SOUL_CHARACTER_ENABLED` (`lib/vendorRates.ts:16-18`). It stays **off in production**. The owner turns it on in the house workspace for one paid qualification run, after a yes (rule 1). Every setting name is in the table in §9.
- **Mocks:** `ENGINE_MOCK=1` makes every adapter answer from a fixture (`lib/mock.ts:9-19`). Every test below runs under it.
- **Tenant isolation:**
  - Inputs come from the workspace's own storage. Either a presigned read of at most 15 minutes that refuses another workspace's key (`presignedReadUrl` and `assertWorkspaceKey`, `lib/storage.ts:682-686`), or bytes read on the server.
  - Outputs are copied into the workspace's own prefix `ws/<id>/` (`lib/storage.ts:32-45`; `storeVideo` `:157`, `storeAudioBytes` `:451`).
  - Signed links are issued only through the workspace's own routes.
- **Failures:** every provider needs its evidence lines in `BASIS` (`lib/providerOutcome.ts:34`). That is where it says, in the provider's own words, when a failed job is billed. A failure that cost nothing reads "Nothing billed" and offers Retry under the same approval (rule 14).
- **Consent records already exist** (`lib/security/consent.ts:8-21`): face and/or voice, the uses, an expiry date and a recording. Only a person records or withdraws one. Records are never deleted; a withdrawal is marked. Today's uses are `production`, `identity`, `ads` and `social` (`lib/security/consent-words.ts:12`). Identity training already requires a consent record (`lib/identities.ts:379`).

**How the sample prices below were worked out.** Each figure is the vendor's public price passed through `billCredits()` with the code's default margin entry (`lib/creditTerms.ts:49-51`). The live margin table is private (`CREDIT_MARGINS`) and may differ. **Every figure is a sample / proposal; the owner approves.** No vendor cost is ever shown to a customer.

**The mocked tests every tool gets (rule 11):**
1. The tool has a price.
2. Atomik, or an MCP token, can prepare it, and a person's approval runs it.
3. An unapproved run spends nothing.
4. Without its key, the tool names that key and cannot run.
5. A failure at no cost reads "Nothing billed".
6. An input from another workspace is refused.
7. The output lands under the workspace's own prefix.
8. Where a real person's face or voice is involved: no live consent record means a refusal, and Atomik or a token cannot record consent.

---

## 1. sync.so lip-sync, direct (DECIDED: first; the owner is buying the account)

### What it adds
- **Lip-sync:** a clip plus a voice track gives the clip with the mouth matched to the words. Today Particl has no lip-sync engine (`lib/v12/unpriced.ts:17-21`; `lib/v12/make.ts:229`). It is needed for dubbing a cut into another language (with ElevenLabs or Sarvam speech), and for ads with a presenter.
- **Three models (DECIDED):**
  - **lipsync-2:** "the best lipsync for the majority of videos"; 512×512 faces.
  - **lipsync-2-pro:** the same, with "diffusion-based super resolution", for beards, teeth and fine detail.
  - **sync-3:** processes the whole shot at once, handles profile and over-the-shoulder angles and obstructions, keeps the speaker's emotion, and outputs 4K.
- **Not via fal** (DECIDED). This replaces the SOW 4 Oct §5.1 row "Sync Lipsync 2.0 (fal)".

### The API
| | |
|---|---|
| Base URL | `https://api.sync.so` |
| Auth | header `x-api-key` |
| Settings | see §9: `SYNC_API_KEY`, `SYNC_BASE_URL`, `SYNC_ENABLED`, and `SYNC_WEBHOOK_SECRET` only if webhooks are turned on |
| Endpoints | `POST /v2/assets/upload` (a presigned upload for our bytes); `POST /v2/assets`; `POST /v2/generate` (a JSON body: `model`, `input` = a video and an audio, each by `assetId` or `url`, `options` with `sync_mode`, optional `webhookUrl`); `GET /v2/generate/{id}` (may wait up to 10 s); `GET /v2/generations/{id}/download`; `POST /v2/generations/estimate`; `DELETE /v2/generations/{id}` |
| Models (`model`) | `lipsync-2`, `lipsync-2-pro`, `sync-3` (also listed: `lipsync-1.9.0-beta`, `react-1`, not proposed) |
| When the lengths differ | `sync_mode`: `bounce` (default), `loop`, `cut_off`, `silence`, `remap` |
| Async | A job. Statuses: `PENDING`, `PROCESSING`, `COMPLETED`, `FAILED`, `REJECTED`. **Poll first**, through the existing poll path and cron rescue. Webhooks exist: a POST on a terminal state, signed with a `Sync-Signature` header, verified with the organisation's webhook secret. They are a later PR (Y4). |
| Limits by plan | Hobbyist ($5/mo): 1 job at once, 1 minute of video. Creator ($19): 3, 5 min. Growth ($49): 6, 10 min. Scale ($249): 15, 30 min. Longer videos are processed in 30 to 40 s chunks on lipsync-2 and -pro. |
| Billing | "Usage is billed on output frames": frames in the output × the per-frame price, quoted per second at 25 fps. Invoiced when usage reaches the plan's threshold ($6, $20, $50 or $250). |
| Deleting | `DELETE /v2/generations/{id}` works only on a finished job ("409 while processing"). So a running job cannot be cancelled (docs/redesign/app-map.md:409). |
| Region and data | Handled in the United States. The privacy policy (effective 27 May 2024) says personal information may be used for "developing, training, and fine-tuning" its models, and states no opt-out. |

- **Inputs go up as assets, from bytes read on the server** (`POST /v2/assets/upload`), not as our storage links. Our presigned links stay inside Particl.
- **DECIDED: the vendor's copy is deleted.** Once the output is stored under the workspace's prefix, the collector calls `DELETE /v2/generations/{id}` (and deletes the uploaded assets, if the asset API allows it; to be checked in Y1). A failed delete is retried by the cron and never blocks the take.

### The tool
| Tool | Kind | Inputs | Output | Who may call | Gate |
|---|---|---|---|---|---|
| `lip_sync` | engine (a new video task `lipsync`, `lib/tasks.ts:25`) | a clip (a take or upload from this workspace), a voice track (a take, an upload, or a speech take), model `lipsync-2`, `lipsync-2-pro` or `sync-3`, `sync_mode` | a video take, linked to both sources | anyone may prepare; a person approves | paid; **a live consent record for the face in the clip, and for the voice if it is a real person's** (not a stock voice) |

- **sync-3's still-image input** (a talking person from a photo) is not offered in v1 (owner question I). It overlaps "talking person from a photo" (OmniHuman, SOW §5.1).

### Prices (sample / proposal; through `billCredits()`, on output seconds)
| Row | Vendor's public price, Hobbyist and Creator | Sells at (sample) | At the Scale plan's rate | Sells at (sample) |
|---|---|---|---|---|
| lipsync-2, 5 s | $0.05/s | 4 cr | $0.04/s | 3 cr |
| lipsync-2, 30 s | | 23 cr | | 18 cr |
| lipsync-2, 60 s | | 45 cr | | 36 cr |
| lipsync-2-pro, 5 s | $0.083/s | 7 cr | $0.067/s | 6 cr |
| lipsync-2-pro, 30 s | | 38 cr | | 31 cr |
| lipsync-2-pro, 60 s | | 75 cr | | 61 cr |
| sync-3, 5 s | $0.133/s | 10 cr | $0.107/s | 9 cr |
| sync-3, 30 s | | 60 cr | | 49 cr |
| sync-3, 60 s | | 120 cr | | 97 cr |

- **Quote:** the output seconds (the audio's length for `cut_off`, the longer track otherwise) times the rate for the plan the owner buys (`lib/vendorRates.ts`, `secondRates`). Reserve at the quote.
- **Settle:** at the delivered `outputDuration` times the rate, never above the hold.

### Privacy and law (counsel before any customer switch)
- **Lip-sync changes what a real person appears to say.** That is the clearest deep-fake risk in this plan. It needs a consent record covering the face, for the use it is made for (`production`, `ads` or `social`, `lib/security/consent-words.ts:12`). A voice that is not a stock voice needs a record covering the voice too.
- **The vendor's training clause** (above): counsel reads it before any customer switch. The owner asks sync.so for written terms that exclude training (owner action).

### Failure and refunds
- sync.so's billing page does not say whether `FAILED` or `REJECTED` jobs are billed. So `BASIS` (`lib/providerOutcome.ts:34`) reads `unknown`, and the job settles at 0, absorbed by the platform (the meter's `unbilled`, `lib/meter.ts:54-59`). The take reads "Nothing billed", with Retry under the same approval.
- Settling at 0 stops once sync.so confirms its rule in writing, or the first invoice shows it.

### Risks
- Misuse for putting words in a real person's mouth (the consent gate above).
- Quality falls with several faces in the frame (sync.so's own advice).
- The training clause.
- A low plan has 1 to 3 jobs at once, so jobs queue (THROTTLED-style waiting, shown as waiting).

## 2. Sarvam, direct (DECIDED: second; the owner is buying the account)

### What it adds
- **Indian-language speech (text to speech).** Bulbul v3 and v4-flash read 11 languages, including mixed English and Indian-language text. The voices are built for Indian speech, beside ElevenLabs (in use).
- **Indian-language transcription (speech to text),** in Saaras v4. Particl transcribes with Grok today (`lib/transcription.ts`; owner, 23 Sep: "Grok APIs wherever possible"). Sarvam would be the engine for Indian languages where it does better.
- **Translation** of scripts, captions and dub lines between English and 22 Indian languages (`sarvam-translate:v1`; `mayura:v1` for 11 of them with colloquial modes). Today "a language of a finished cut … translated on-screen text has no path" (`lib/v12/unpriced.ts:73-74`).

### The API
| | |
|---|---|
| Base URL | `https://api.sarvam.ai` |
| Auth | header `api-subscription-key` |
| Settings | see §9: `SARVAM_API_KEY`, `SARVAM_BASE_URL`, `SARVAM_ENABLED`, `SARVAM_USD_PER_INR` |
| Endpoints | `POST /text-to-speech` (JSON; returns base64 audio); `POST /speech-to-text` (multipart; for clips under about 30 s); batch transcription: `POST /speech-to-text/job/v1`, `GET /speech-to-text/job/v1/{job_id}/status`, `POST /speech-to-text/job/v1/download-files`; `POST /translate` (JSON) |
| Async | Speech, short transcripts and translation answer at once. Batch transcription is a job: poll, or take a callback (`X-SARVAM-JOB-CALLBACK-TOKEN`; the reply must be 200 within 30 s; status only). |
| Limits | Speech: 2,500 characters a request on v3 and v4-flash. Translation: 2,000 characters on `sarvam-translate:v1`, 1,000 on `mayura:v1`. Batch transcription: files up to 2 hours, 20 a job, diarization up to 20 speakers. Rate limits on the Starter plan: 60 a minute (30 for Bulbul v3); higher on Pro and Business. |
| Billing | In rupees, against prepaid credit (₹100 free on sign-up). |
| Region and law | "We process and store information in India", and may transfer it abroad. Indian law, Bengaluru courts. |
| Retention | Set by the org Owner, from 0 days to 24 months. **Until set, data is kept indefinitely.** Zero retention is available for the model APIs. **DECIDED: 0 days**, set by the owner in Sarvam's console before `SARVAM_ENABLED` is turned on anywhere. |
| Training | "Subject to your consent, which you may decline or withdraw." |

### The tools
| Tool | Kind | Inputs | Output | Who may call | Gate |
|---|---|---|---|---|---|
| `sarvam_speech` | engine (audio task `speech`) | text (split server-side at 2,500 characters), language, a stock voice, model, pace | an audio take | anyone may prepare; a person approves | paid; **stock voices only (DECIDED: no voice cloning for now)** |
| `sarvam_transcribe` | engine (transcript) | a stored audio or video original, language or auto-detect, diarization | a transcript in the same shape as Grok's (timed words, SRT) | as above | paid; quoted from the measured length, as Grok's is (`lib/transcription.ts` header) |
| `sarvam_translate` | engine (text) | text (up to 2,000 characters a call; longer text is split), source and target language, mode | text, written back where it was asked for (a script, a caption, a dub line) | as above | paid |

### Prices (sample / proposal; rupees converted at a sample ₹85 = US$1, which is illustrative only)
| Row | Vendor's public price (pay as you go) | Sells at (sample) |
|---|---|---|
| Speech, Bulbul v3, 500 characters | ₹30 per 10,000 characters | 1 cr |
| Speech, Bulbul v3, 10,000 characters | | 6 cr |
| Speech, Bulbul v4-flash, 10,000 characters | ₹20 per 10,000 characters | 4 cr |
| Transcript, 10 minutes | ₹29.40 an hour | 1 cr |
| Transcript, 60 minutes | | 6 cr |
| Transcript with speakers, 60 minutes | ₹35.40 an hour | 7 cr |
| Translation, 2,000 characters | ₹20 per 10,000 characters | 1 cr |
| Translation, 10,000 characters | | 4 cr |

- Like an ElevenLabs line, speech and translation are priced by length, so they are "up to N cr" estimates on the button, not single card rows (CLAUDE.md § Pricing, the VO note).

### Privacy and law (for counsel)
- **Voice is personal data.** Stock voices raise no consent question for the speaker. **DECIDED: no voice cloning for now.**
- **A transcript of a real person's speech is their personal data,** and so is a translation of what they said. Both stay in the workspace's database only.
- **DECIDED: Sarvam's retention is 0 days** for the model APIs, an org-Owner setting in Sarvam's console (owner action), so Sarvam keeps no copy once it has answered.
- **Sarvam's terms §10.5(d) forbid "providing access to the APIs … to third parties"** unless product terms allow it. Particl's customers would be reaching Sarvam through Particl. **Counsel should confirm a platform may offer it,** or the owner should get it in writing.
- **Data stays in India by default,** which suits DPDP better than a US vendor. Sarvam names itself a Data Fiduciary for its own users; for our customers it would act as our processor. That needs a processing agreement.

### Failure and refunds
- Errors (400, 403, 422, 429, 500) are answered at once. Sarvam's docs fetched here say nothing about billing a failed call, so `BASIS` reads `unknown` until Sarvam confirms in writing.
  - **Until then, a failure is settled at 0 and says "Nothing billed".** The platform absorbs any charge, using the meter's existing `unbilled` flag (`lib/meter.ts:54-59`).
- A long text split into several calls that fails partway settles at the parts that succeeded. Nothing is charged for the part that failed.

### Risks
- Rupee billing against dollar rates: the exchange rate moves. Quote with the owner's rate (`SARVAM_USD_PER_INR`, reviewed monthly; owner question D).
- Retention is indefinite until the setting is changed.
- The resale clause.
- Low Starter limits (30 to 60 a minute).

---

## 3. AWS Rekognition (DECIDED 14 Oct: third; face checks for identity and consent) — SUPERSEDED 16 Oct: not used, see the note at the top

### What it adds
- **"Same face":** a score for whether the person in a take is the cast member they should be. It becomes one more score inside the identity check that Verify already makes (`lib/workbench/verify.ts:25`, checks identity, wardrobe, environment, props, artifacts), as the handover planned (docs/handover-2026-10-05.md:1213).
- **A face check on references before training.** Is there exactly one usable face in each photo? This catches bad uploads before a training run is paid for.
- **What it is not:** it does not identify who someone is, it keeps no face collection, and it never searches a database of faces.

### The API
| | |
|---|---|
| Region | Asia Pacific (Mumbai), `ap-south-1`; endpoint `rekognition.ap-south-1.amazonaws.com` |
| Auth | AWS Signature Version 4, with an IAM user allowed only `rekognition:CompareFaces` and `rekognition:DetectFaces` |
| Settings | see §9: `REKOGNITION_ACCESS_KEY_ID`, `REKOGNITION_SECRET_ACCESS_KEY`, `REKOGNITION_REGION`, `REKOGNITION_ENABLED`. None starts with `AWS_`, so nothing the AWS SDK reads by itself and nothing the storage code reads can collide with them (the proof is in §9). |
| Endpoints | `CompareFaces` (the largest face in the source against up to 100 faces in the target); `DetectFaces` |
| Async | None. Both answer at once. |
| Inputs | PNG or JPEG bytes, at most 5 MB (15 MB from S3, which we do not use). At least 80 px a side. A face must be at least 40×40 px in a 1920×1080 image. |
| Limits | 25 calls a second for each of `CompareFaces` and `DetectFaces` in Mumbai (default). |
| Storage at AWS | "This is a stateless API operation. That is, data returned by this operation doesn't persist." No face collection is created. The Rekognition FAQ says inputs "may" be stored and used to improve the service **unless the account opts out** through an AWS Organizations AI-services opt-out policy. |

- **Library choice (recommended): sign the request with the SigV4 header signing already in `lib/storage/r2.ts:115-116` (`signRequest`), with no AWS SDK.** Then no AWS SDK default (any `AWS_*` setting, shared config file or instance role) can ever be consulted. If the SDK is used instead (`@aws-sdk/client-rekognition`), the client must be given its region, credentials and endpoint explicitly, as the R2 client is (`lib/storage/r2.ts:190-194`).

### The tools
| Tool | Kind | Inputs | Output | Who may call | Gate |
|---|---|---|---|---|---|
| `face_check` | app action, priced inside Verify | a take (its three review frames for a clip, `lib/workbench/verify.ts:39`; one frame for a still) and up to 5 cast masters that are real people | for each master: the best similarity (0 to 100), faces found, pass or fail against the workspace's threshold | anyone, as part of a Verify step the person approved | **a live consent record covering the face, for each master**; without one, that master is skipped and says "Needs consent" |
| `face_detect` | app action | a reference photo from this workspace | the number of faces, each face's size, sharpness and brightness | anyone | the same consent rule, when the photo is of a real person |
| `record_face_consent` | app action (exists: `recordConsent`, `lib/security/consent.ts:159`) | the person, face and/or voice, the uses, an expiry date, a recording | a consent record | **people only.** Atomik and outside agents may prepare it; they never record it (rule 11). | — |

- **Threshold (proposal; still open, owner question E):** a workspace setting that only an admin changes, with a platform-layer default (rule 3). AWS's default is 80; the plan proposes 90 for "same face".
- **AWS's own advice:** before acting on a result that affects a person, a human should review it. So a low score marks the take for a person to look at. It never blocks or deletes anything by itself.
- **Stored:** the scores, in the take's existing `take_verifications` row (`lib/workbench/verify-server.ts:23`). No frames, face crops or face vectors are kept beyond what the take already is.

### Prices (sample / proposal)
| Row | Vendor's public price (Mumbai, first million images a month; AWS price list published 11 Sep 2026) | Sells at (sample) |
|---|---|---|
| Face check, a still against 1 master | $0.00125 an image (one image per call; to be confirmed on the first bill) | 1 cr on its own |
| Face check, a clip (3 frames) against 1 master | 3 calls | 1 cr on its own |
| Face check, a clip against 5 masters | 15 calls | 1 cr on its own |
| Face detect, one photo | $0.00125 an image | 1 cr on its own |

- **Recommended (owner question E):** add the face check's dollars to the Verify step's own quote **before rounding**, as "batches multiply before rounding" says (CLAUDE.md § Credits). The check then usually adds 0 or 1 cr to Verify, instead of being a separate 1 cr line. A low score marks the take for a person and never blocks it.

### Privacy and law: biometric data (for counsel; not decided here)
- **Consent first.** No face is sent to AWS without a live consent record covering that person's face. Recording consent is a person-only action (rule 11; `lib/security/consent.ts:15-16`).
  - Today's consent uses do not name biometric comparison. **Counsel decides** whether `production` already covers it, or whether a new use is needed, for example "face checks". Adding a use is a word in `CONSENT_USES` (`lib/security/consent-words.ts:12`); it needs no migration.
- **No face collections.** Only the stateless calls are used. No `IndexFaces`, `CreateCollection` or search.
- **Opt out of AWS service improvement** with an AWS Organizations AI-services opt-out policy, before any customer use (owner action). AWS's FAQ asks customers who collect consent to collect it on behalf of AWS too.
- **Region:** Mumbai, so faces do not leave India for this step.
- **Deletion and Particl's never-delete rule.** Particl erases nothing (owner, 24 Sep), and consent records are never deleted (`lib/security/consent.ts:16-17`). India's DPDP Act gives a person the right to have their data erased once consent is withdrawn.
  - What we would keep are similarity scores, not face templates. **Counsel must say** whether a score is personal data that must be erased on withdrawal, and how that fits the never-delete rule.
  - Until then: a withdrawal stops all new checks at once (`consentLive`, `lib/security/consent-words.ts:118`).
- **India's DPDP Act 2023, at a high level** (counsel to confirm; nothing here is legal advice):
  - Faces and voices are personal data. The Act asks for consent that is free, specific, informed and unambiguous, given after a clear notice.
  - Particl would be a Data Fiduciary for its own users. For a customer's cast, it is probably the customer's processor. **Counsel to decide.**
  - Transfers abroad are allowed unless the government restricts a country. This matters for Runway and sync.so (US). Rekognition in Mumbai and Sarvam in India stay in the country.
  - Commencement is phased. The Rules were notified in November 2025. Consent-manager rules follow in November 2026. Most duties (notice, consent standards, security, breach notice, erasure and the data principal's rights) apply from **13 May 2027**.

### Failure and refunds
- A call that fails is answered at once. AWS bills images processed, and a refused image (no face, too large, bad format) is answered with an error before analysis. `BASIS` cites AWS's pricing page. Until confirmed: settle at 0, "Nothing billed".
- When a face check fails, the Verify step still finishes on its other scores, and says the face score is missing.

### Risks
- **Biometric law is the biggest risk in this plan:** consent wording, erasure and notice. Counsel, before any customer use.
- False negatives on side angles and low light. AWS itself recommends a human review, so a score is advice, never a block.
- AWS bills the account, not a workspace. Spend must go through our meter like every other engine.

---

## 4. Google Cloud Vision, text detection (added by the owner)

### What Particl would use it for (proposal; owner question G)
Reading the text inside a picture: OCR.
1. **A "no stray lettering" check inside Verify.** The platform rule `no-lettering` asks stills to carry no lettering, captions or logos (`lib/platformLayer.ts:78`). Generated frames often carry stray, garbled text, which is a known artifact.
   - Vision reads the take's three review frames (`lib/workbench/verify.ts:39`). Any text found becomes part of Verify's `artifacts` check (`lib/workbench/verify.ts:25`), with the words and where they sit.
   - Where text is *wanted* (a title card, a packshot with its label), the check reports it rather than failing it.
2. **On-screen text for translating a cut.** Today "translated on-screen text has no path" (`lib/v12/unpriced.ts:73-74`). Vision reads the text in a frame, and Sarvam (§2) translates it.
3. **Later: the brand mandatories check** (legal line, VO tagline). It waits until mandatories are stored at all ("Brand mandatories aren't stored in Particl yet", `lib/v12/deliver.ts:104-105`).

### The API
| | |
|---|---|
| Endpoint | `POST https://vision.googleapis.com/v1/images:annotate`, feature `TEXT_DETECTION` (`DOCUMENT_TEXT_DETECTION` for dense text) |
| Auth | a Google Cloud API key, restricted to the Vision API (and to the server's address). Google's OCR page shows OAuth in its examples; the key route is Google's standard API-key auth (to confirm in V1). |
| Settings | see §9: `GOOGLE_VISION_API_KEY` (**already set in Coolify**, but **no code reads it yet**: it is nowhere in the repo), `GOOGLE_VISION_BASE_URL`, `GOOGLE_VISION_ENABLED` |
| Async | None for this use: one request answers at once, up to 16 images a request |
| Inputs | Base64 image bytes in the JSON body, read on the server from the workspace's storage (no links leave Particl). 20 MB an image; 10 MB a request. |
| Limits | 1,800 requests a minute (default) |
| Output | `textAnnotations` (the full text, then each word with its box) and `fullTextAnnotation` |
| Data | For answers given at once, "the image data is processed in memory and not persisted to disk". "Google does not use the content you send to train and improve our Cloud Vision features." Some request metadata is logged for a short time. |
| Region | Global by default, with "no guarantee that data stays in one location". EU and US endpoints exist for OCR. **There is no India endpoint.** |

### The tools
| Tool | Kind | Inputs | Output | Who may call | Gate |
|---|---|---|---|---|---|
| `text_check` | app action, priced inside Verify | the take's review frames | the text found, its boxes, and pass, or "text found" against the take's rules | anyone, as part of a Verify step a person approved | none beyond Verify's own |
| `read_text` | app action | a frame or still from this workspace | the text and its boxes, stored with the take or the cut | anyone may prepare; a person approves when it is charged | paid (1 cr on its own) |

### Prices (sample / proposal)
| Row | Vendor's public price (Text Detection) | Sells at (sample) |
|---|---|---|
| Text check, 3 review frames | $1.50 per 1,000 images after the first 1,000 a month (free) | inside Verify's quote, usually +0 cr |
| Read text, one frame | $0.0015 an image | 1 cr on its own |

### Tenant isolation, privacy and failure
- **Isolation:** bytes are read from the workspace's own storage. The words found are stored in that workspace's `take_verifications` row or on its cut.
- **Privacy:** frames can show people and private text (a name tag, a screen). Google keeps no image and trains on nothing (above). It is processed abroad (global), which counsel notes with the other transfers.
- **Failure:** an error answers at once. Google bills images processed; a refused request settles at 0, "Nothing billed". If the text check fails, Verify finishes on its other scores and says the text check is missing.

### Risks
- OCR reads garbled generated text unevenly. It is advice, never a block.
- No India region.
- The key is already set but unused. It should be restricted to the Vision API before V1 lands (owner action).

## 5. Recraft (added by the owner): raster, vector, vectorize, remove background

### What it adds
- **Vector images (SVG)** and design-style raster images, which none of today's engines make. SOW 4 Oct §5.1 lists "Vector and type: Recraft V4 (Recraft API), `RECRAFT_API_KEY` (new), E2". The handover asks for "the SVG kept as the original" (docs/handover-2026-10-05.md:1263).
- **Vectorize:** a PNG or JPG logo from a product page (`lib/v12/campaign.ts:21-31`, the Product stage's logo candidates) turned into a clean SVG, for end cards and the Remotion templates.
- **Remove background:** a second engine beside Bria cut-out on fal (`lib/stillTools.ts:15`; $0.018 a call, `lib/vendorRates.ts:161-166`). Recraft costs $0.01 a call. Both sell at 1 cr, so Auto can choose on quality, not price.

### The API
| | |
|---|---|
| Base URL | `https://external.api.recraft.ai/v1` |
| Auth | `Authorization: Bearer <token>` |
| Settings | see §9: `RECRAFT_API_KEY` (the name SOW §5.1 and the handover already use; Recraft's own docs call it `RECRAFT_API_TOKEN`, but we keep one name), `RECRAFT_BASE_URL`, `RECRAFT_ENABLED` |
| Endpoints | `POST /v1/images/generations` (models `recraftv4_1`, `recraftv4_1_vector`, V4, V4 Styles; `size`, `style`, `n` 1 to 6, `response_format`, `image_format`); `POST /v1/images/vectorize`; `POST /v1/images/removeBackground`; later `imageToImage`, `replaceBackground`, `crispUpscale` |
| Async | None documented: the reply carries the image. |
| Inputs | JSON with the image as a data URL, or multipart with the file. Under 20 MB, up to 16 MP and 4,096 px on the longest side, at least 256 px on the shortest. |
| Outputs | `response_format` is `url` (a link "valid for about 24 hours"), `b64_json` or `multipart`. **We use `b64_json` or `multipart`,** so no vendor link is ever kept. Raster comes back as WebP by default (PNG on request); vector models give SVG. |
| Limits | 100 images a minute and 5 requests a second, per account |
| Billing | API units: $1 = 1,000 units; bought in advance; they never expire. The reply states the `credits` it used. |
| Data | Recraft's data-use page says API inputs and outputs "are never used for model training", and API data "is not stored or used to improve models". The Developer Terms (11 Aug 2026) govern. |

### The tools
| Tool | Kind | Inputs | Output | Who may call | Gate |
|---|---|---|---|---|---|
| `recraft_image` | engine (still; raster or vector) | words, model, size or aspect, style, count 1 to 6, optional style references (1 to 10) | an image take; a vector take keeps its SVG as the original | anyone may prepare; a person approves | paid |
| `recraft_vectorize` | engine (still tool) | a PNG, JPG or WebP from this workspace | an SVG take, linked to its source | as above | paid |
| `recraft_remove_background` | engine (still tool, beside Bria's `cutout`) | a still from this workspace | a transparent PNG take | as above | paid |

- **SVG is a new kind of original.** Storage knows video, image, audio and model originals (`lib/storage.ts:39-41`), so C2 adds an `svg` path.
- **An SVG can carry script.** So it is served only as a download, or with a strict content-security policy (`Content-Type: image/svg+xml` plus `Content-Security-Policy: default-src 'none'`). It is never inlined into a page. This is a security point for the review.

### Prices (sample / proposal)
| Row | Vendor's public price | Sells at (sample) |
|---|---|---|
| Raster image, V4.1 | $0.035 | 1 cr |
| Raster image, V4.1 Pro (2K) | $0.21 | 4 cr |
| Vector image, V4.1 | $0.08 | 2 cr |
| Vector image, V4.1 Pro | $0.30 | 5 cr |
| Vectorize | $0.01 | 1 cr |
| Remove background | $0.01 | 1 cr |
| Style references, added to a request | $0.005 | added before rounding |

- **Settle** at the units the reply states (`credits`), never above the quote.

### Tenant isolation, privacy and failure
- **Isolation:** inputs are sent as bytes or data URLs read from this workspace. Outputs are stored under its prefix.
- **Privacy:** no training and no storage on Recraft's side for API data (above). A logo or a product photo is usually not personal data. A photo of a person sent for background removal is, but it is not processed as biometric.
- **Failure:** the reply comes at once. Recraft's pages do not say whether a failed call uses units. Until confirmed: settle at 0, "Nothing billed", absorbed by the platform.
- **Risks:**
  - the SVG security point above;
  - units are bought in advance and are "non-refundable", so the owner tops them up;
  - the region is not stated on the pages read.

## 6. Black Forest Labs FLUX.2, direct (added by the owner): create, and edit from several references

### What it adds
- **Create:** FLUX.2 [pro] (and [flex] and [max]) stills from words, up to 4 MP.
- **Edit from several references:** up to **8 reference images through the API** (10 in BFL's own playground). For example: put this product in this setting, in this look, on this person. This is the "style transfer, in-context edits" row of SOW 4 Oct §5.1, and the fix step for a failed region that P6b plans.
- **On BFL's own API** (as the owner named it), not fal. The SOW row says "(fal)"; this plan follows the owner. Owner question B confirms it.

### The API
| | |
|---|---|
| Base URL | `https://api.bfl.ai` (global). Regional: `api.eu.bfl.ai` ("EU multi-cluster", GDPR) and `api.us.bfl.ai`. |
| Auth | header `x-key` |
| Settings | see §9: `BFL_API_KEY` (BFL's own docs use this name), `BFL_BASE_URL`, `BFL_ENABLED` |
| Endpoints | `POST /v1/flux-2-pro` (a fixed snapshot; recommended, so results don't drift) or `/v1/flux-2-pro-preview` (the latest). Also [flex] and [max]. Body: `prompt`, `input_image`, `input_image_2` … up to 8, then size, seed and output format per the API reference. |
| Async | Submit returns `id` and `polling_url`. "You must use the `polling_url` returned." Statuses: `Ready` (the image is in `result.sample`), `Error`, `Failed`, plus pending and moderated states. |
| Outputs | "Signed URLs are only valid for 10 minutes." **The collector must copy the image within 10 minutes of `Ready`.** So BFL jobs are polled by the worker in a tight loop, not left to the next page load or the cron. This is the main build risk. |
| Billing | Credits at $0.01. FLUX.2 is priced by megapixel. The docs give from-prices ([pro] from $0.03 to create and from $0.045 to edit; [flex] from $0.05; [max] from $0.07) and point to BFL's calculator for exact figures. Secondary sources describe [pro] as $0.03 for the first output megapixel, $0.015 for each further one, and $0.015 per megapixel of reference. **To confirm on the first bill.** |
| Data | BFL's privacy policy (revised 1 Aug 2026) says inputs and outputs "may be used to train and improve our AI models". It allows an objection by email ("Training Opt Out") and excludes enterprise customers, whose agreements govern instead. Retention: "as long as is reasonably necessary". |

### The tools
| Tool | Kind | Inputs | Output | Who may call | Gate |
|---|---|---|---|---|---|
| `flux2_image` | engine (still) | words, size (up to 4 MP), model [pro], [flex] or [max], seed | an image take | anyone may prepare; a person approves | paid |
| `flux2_edit` | engine (still; edit) | words, 1 to 8 reference stills from this workspace, size | an image take, linked to every reference | as above | paid; **a live consent record (face) for every real person among the references** |

### Prices (sample / proposal; [pro] unless named)
| Row | Vendor's public price | Sells at (sample) |
|---|---|---|
| Create, 1 MP | from $0.03 | 1 cr |
| Create, 4 MP | about $0.075 (reported per-MP rule) | 2 cr |
| Edit, 1 reference, 1 MP | from $0.045 | 1 cr |
| Edit, 4 references, 1 MP | about $0.09 (reported) | 2 cr |
| Edit, 8 references, 1 MP | about $0.15 (reported) | 3 cr |
| Create, [max], 1 MP | from $0.07 | 2 cr |

- **Quote** from the per-megapixel rule, with the references counted.
- **Settle** at the job's cost if BFL's reply states one; otherwise at the quote. Which one applies is to be checked in B1.

### Tenant isolation, privacy and failure
- **Isolation:** references are read from this workspace. BFL takes image URLs or data; we send data, or a presigned link of at most 15 minutes (`lib/storage.ts:682-686`). The output is copied under the workspace's prefix within the 10 minutes.
- **Privacy:**
  - **The training clause:** before any customer switch, the owner sends BFL the training opt-out, or signs enterprise terms (owner action; counsel reads them).
  - A reference showing a real person needs a face consent record (above).
  - Data leaves India. The EU endpoint gives GDPR terms (decided: B1 defaults to it).
- **Failure:** BFL's pricing page says nothing about failed or moderated jobs. Until confirmed: settle at 0, "Nothing billed", absorbed by the platform. A job whose image could not be copied within the 10 minutes is a failure to collect. It is retried only if BFL still answers, and it is settled as "Nothing billed" if the image is lost (the platform absorbs it).
- **Risks:**
  - the 10-minute link;
  - the training clause;
  - pricing that is only "from" figures until the first bill.

## 7. Runway (DECIDED: standby; the house workspace only until training-free terms)

### What it adds
- **Act-Two, "character performance":** a performance video (a person acting) drives a character image or video. Particl already has motion transfer on the Higgsfield API key (task `motion`, `lib/tasks.ts:25`). Runway is the fallback that SOW 4 Oct §5.1 names, "if Higgsfield's API changes".
- **Aleph 2, video to video:** edit an existing shot from words. For example: change the weather, the time of day, the wardrobe or an object, or restyle it. This fits the existing task `edit`.
  - Runway's current API has **`aleph2`**. The older `gen4_aleph` is no longer a model value in Runway's own SDK. The handover's "Aleph" (docs/handover-2026-10-05.md:558) means `aleph2` today.
- **Gen-4.5 and Gen-4 Turbo, image to video:** two more video engines for the `generate` task.
- **Also on Runway, but not proposed:** Runway resells models Particl already reaches directly (Kling, Seedance, Veo, ElevenLabs), plus upscalers. Going through Runway would add a second door to the same engines, at a different price.

### The API
| | |
|---|---|
| Base URL | `https://api.dev.runwayml.com/v1` |
| Auth | `Authorization: Bearer <key>` and `X-Runway-Version: 2024-11-06` |
| Settings | see §9: `RUNWAY_API_KEY` (the name SOW §5.1 already uses), `RUNWAY_BASE_URL`, `RUNWAY_ENABLED` |
| Endpoints | `POST /v1/character_performance` (model `act_two`); `POST /v1/video_to_video` (model `aleph2`); `POST /v1/image_to_video` (models `gen4.5`, `gen4_turbo`); `POST /v1/uploads` (ephemeral `runway://` inputs); `GET /v1/tasks/{id}`; `DELETE /v1/tasks/{id}` |
| Async | Create, then poll `GET /v1/tasks/{id}`. Statuses: `PENDING`, `THROTTLED`, `RUNNING`, `SUCCEEDED`, `FAILED`, `CANCELLED`. **No webhooks are documented,** so we poll through the existing poll path and the cron rescue. |
| What it reports | A running task has `estimatedCost.credits`. A finished one has `cost.credits`, and "fully refunded tasks report 0". A failure has `failure` and `failureCode`. |
| Inputs | An HTTPS URL (16 MB image, 32 MB video), a data URI (5 MB, 16 MB), or an upload (200 MB, gone after 24 h). A URL must answer `HEAD` with a real `Content-Type` and `Content-Length`, and no redirect is followed. |
| Limits | Act-Two's performance video is 3 to 30 s. Aleph 2's input is 2 to 30 s at 30 fps or lower. Gen-4.5 is 2 to 10 s. Usage tier 1: 1 to 2 tasks at once, 50 to 200 a day, $100 a month; higher tiers unlock as more credit is bought. |
| Outputs | The URLs "expire within 24-48 hours", so we copy them at once (as we do for Seedance). |
| Region and law | "Controlled and offered … from its facilities in the United States". Governed by New York law. |
| Retention | Not stated for API outputs. `DELETE /v1/tasks/{id}` removes a finished task, "under the retention policy". |

- **Our presigned links may not answer `HEAD`.** A link signed for `GET` can fail a `HEAD` check; this was not tested. The plan therefore sends inputs through `POST /v1/uploads` from bytes read on the server. That also keeps our storage links away from the vendor.

### The tools
| Tool | Kind | Inputs | Output | Who may call | Gate |
|---|---|---|---|---|---|
| `runway_performance` | engine (task `motion`) | a character (a still or a clip from this workspace), a performance clip (3 to 30 s), ratio, body control on or off, expression strength 1 to 5 | a video take | anyone may prepare; a person approves | paid; **a live consent record (face) for every real person in the character or the performance** |
| `runway_edit` | engine (task `edit`, model `aleph2`) | a source clip (2 to 30 s), words, optional keyframes and aspect | a video take | as above | paid; consent when a real person's face is edited |
| `runway_video` | engine rows `gen4.5` and `gen4_turbo` (task `generate`) | a start still, words, 2 to 10 s, ratio | a video take | as above | paid |

### Prices (sample / proposal; Runway sells credits at $0.01 each)
| Row | Vendor's public price | Sells at (sample) |
|---|---|---|
| Act-Two, 5 s | 5 credits/s | 4 cr |
| Act-Two, 10 s | | 8 cr |
| Act-Two, 30 s | | 23 cr |
| Aleph 2, 2 s (its 56-credit minimum) | 28 credits/s, 56-credit minimum | 9 cr |
| Aleph 2, 5 s | | 21 cr |
| Aleph 2, 10 s | | 42 cr |
| Aleph 2, 30 s | | 126 cr |
| Gen-4.5, 5 s | 12 credits/s | 9 cr |
| Gen-4.5, 10 s | | 18 cr |
| Gen-4 Turbo, 5 s | 5 credits/s | 4 cr |

- **Quote:** our rate times the requested seconds, from `lib/vendorRates.ts` (`secondRates`).
- **Settle:** at the task's own `cost.credits`, never above the hold. The overrun rule is the existing one (`lib/meter.ts:26-36`).

### Privacy and law (for counsel; not decided here)
- **Runway's standard terms (updated 15 Sep 2026) let Runway "train and improve its AI models" on Inputs and Outputs,** under a "perpetual, worldwide" licence. The page states no API opt-out. A separate Enterprise agreement exists, which the page does not reproduce.
  - That would put customers' faces and footage into a vendor's training set. **DECIDED: no customer workspace uses Runway until the owner has Enterprise terms, or written confirmation, that excludes training.** Until then `RUNWAY_ENABLED` is on in the house workspace only.
- **The terms require "Powered by Runway"** to be shown prominently, with a link, in apps that reach end users. That is a screen element: it **waits for Claude Design / v18**, and the owner decides.
- **Act-Two processes two people's faces:** the character and the performer. Both need a consent record that covers the face.
- **DECIDED: after the output is copied, `DELETE /v1/tasks/{id}`,** so the vendor keeps as little as possible.

### Failure and refunds
- A `FAILED` or `CANCELLED` task with `cost.credits = 0` settles at 0 and reads "Nothing billed". This is new `BASIS` evidence: the task's reported cost.
- A failed task that Runway did charge settles at that cost, and the take says what it cost (rule 14).
- `THROTTLED` means queued at Runway. The take waits and says so; it is not a failure.

### Risks
- The training licence and the "Powered by Runway" clause (above).
- Low tier-1 limits until credit is bought.
- The product moves fast: `gen4_aleph` was replaced within months. Model ids must be checked again before each PR.
- A new US data transfer for customers in India (see §3, DPDP).

---

## 8. Topaz: direct versus fal (added by the owner)

**Today the code uses Topaz through fal:**
- Astra 2 creative video upscale at $0.30/s up to 1080p and $0.50/s at 4K, doubled at 60 fps (`lib/vendorRates.ts:132-142`; model row `lib/models.ts:302-330`; docs/astra-video-upscale.md);
- image upscale at $0.08 for 24 MP and $0.16 for 48 MP (`lib/vendorRates.ts:152-153`).

The rate card's Topaz rows (CLAUDE.md § Pricing: 23 cr for 5 s 1080p, 38 cr for 5 s 4K) come from these.

**Topaz's own API** sells credits on a plan:
- Developer: $0.10 a credit, $50 a month for 500;
- Scale: $0.08 a credit, $240 a month for 3,000;
- Starter: $0.12 ("coming soon");
- Enterprise: on request.

Astra is billed by output frame: about 7.7 frames a credit at 1080p, and 4.3 at 4K. Gigapixel image upscale is 24 output megapixels a credit (the API page also says 48 MP costs 3 credits; the two figures disagree).

| Job (30 fps) | fal, in the code today | Topaz direct, Developer ($0.10/credit) | Topaz direct, Scale ($0.08/credit, $240/mo) |
|---|---|---|---|
| Astra, 5 s at 1080p (150 frames) | $1.50 → **23 cr** | ≈19.5 credits ≈ $1.95 → 30 cr | ≈ $1.56 → 24 cr |
| Astra, 5 s at 4K | $2.50 → **38 cr** | ≈34.9 credits ≈ $3.49 → 53 cr | ≈ $2.79 → 42 cr |
| Image upscale to 24 MP | $0.08 → 2 cr | 1 credit, $0.10 → 2 cr | $0.08 → 2 cr |
| Image upscale to 48 MP | $0.16 → 3 cr | 2 or 3 credits, $0.20 to $0.30 → 3 to 5 cr | $0.16 to $0.24 → 3 to 4 cr |
| (not in the code) Proteus precision video, 5 s at 1080p | $0.02/s on fal → $0.10 | 4 credits per 10 s → ≈ $0.20 | ≈ $0.16 |

Both sides double at 60 fps: fal by its rule, Topaz because it bills by frame. The "sells at" figures are samples through `billCredits()`.

**Owner decision, 15 Oct 2026, 14:05 IST (verbatim in docs/redesign-plan.md on redesign/integration): Topaz goes DIRECT. It replaces item H, "Topaz stays on fal", which this plan first recommended.**
- **New adapter for Topaz Labs' own API**, image and video upscale, using `TOPAZ_API_KEY` (set in Coolify: production only, locked, not in previews). The same presets and controls as today (`lib/topaz.ts`). Mocks only until the owner approves the house run. Opus money review, NEEDS AKSHAY.
- **Before building (T0, docs only):**
  - a price table from Topaz's published API rates against our current fal rates (`lib/vendorRates.ts`): per image and per second at 720p, 1080p and 4K, for each model we offer, the Starlight-equivalent included. The comparison in this section is its start; the table is its finished form.
  - If direct is dearer, the new customer prices are shown; nothing is priced below cost.
  - Data terms: Topaz does not train on our uploads; how long it keeps files; the vendor's copy is deleted after we store the output (the same rule as Runway and sync.so).
- **T1:** the adapter behind its switch, off in production, on mocks.
- **T2:** the owner approves the small paid run on the house workspace, then it is qualified.
- **T3:** the switch, and the fal Topaz endpoints are removed. fal then keeps only Kling, Bria and Luma reframe.
- **Queued after B1 (BFL).** Not part of deploy #4. Customer prices still come only from the rate card and the server's price path; a change to what customers see changes CLAUDE.md § Pricing too and needs the owner's yes.

## 9. Coolify setting names, per provider (names only)

**Corrected 16 Oct 2026 against tonight's PRs: see "The names each PR reads" below, which replaces any name in A to E that differs (Vision and Topaz switches, no Vision or Topaz base-address setting, the `REMOTION_EXPORT_*` tuning names, `BFL_IDENTITY_ENABLED`).** **Updated 15 Oct 2026, 22:15 IST for the owner's FINAL ENGINE STACK** (`docs/redesign-plan.md` on `redesign/integration`). Names only: no value, key or secret is written here. The owner sets each in Coolify (production, runtime only, locked); lanes never touch env. Names marked **set** were reported as set by the owner (19:30 name check; 22:15 for Recraft); names marked **new (proposed)** are proposals for the owner to confirm before any PR uses them.

**How the names were chosen:**
- Names already in the code or the scope are reused. They were read from `release/1` at 663fb243 (`lib/providers.ts`, `lib/gemini.ts`, `lib/textRoute.ts`, `lib/engines/*`): `ARK_*`, `GEMINI_*`, `OPENAI_*`, `ANTHROPIC_*`, `XAI_*`, `HF_*`, `FAL_*`, `ELEVENLABS_*`. Names the scope or the owner already used: `RUNWAY_API_KEY`, `RECRAFT_API_KEY`, `BFL_API_KEY`, `TOPAZ_API_KEY`, `SYNC_API_KEY`, `SARVAM_API_KEY`, `SARVAM_USD_PER_INR`, the three `REKOGNITION_*` and `GOOGLE_VISION_API_KEY`.
- New ones follow the code's pattern: `<VENDOR>_API_KEY` for the key, and `<VENDOR>_BASE_URL` for the address, as in `FAL_BASE_URL` and `ELEVENLABS_BASE_URL` (`lib/providers.ts:116`, `:140`). The base URL is optional; it exists so a local echo server can stand in during tests, and a default is in code.
- Every new engine gets its own kill switch, `<VENDOR>_ENABLED=1` (owner's rule 15 Oct: "its own kill switch"). Unset means off. Which workspaces see an engine that is switched on is a site setting, not an env name (see "The site setting" below).
- I found no `TOPAZ_*` or `BFL_*` setting in the code on `release/1`; no adapter for sync.so, Sarvam, BFL, Runway, Recraft, Vision, Rekognition, MediaConvert, Veo, the Remotion worker or trends is merged yet, so every name for them is read from this plan and the owner's notes, not from code.

### A. In use today (names in the code on `release/1`)

| Provider | Key (secret) | Address (optional) | Switch | Other |
|---|---|---|---|---|
| BytePlus (Seedance 2.5 / 2.0, ModelArk text) | `ARK_API_KEY` | `ARK_BASE_URL` | none today (the engine is live) | `ARK_TEXT_MODEL` |
| Google Gemini API (Nano Banana Pro and 2, Gemini text) | `GEMINI_API_KEY` | `GEMINI_BASE_URL` | none today | `GEMINI_IMAGE_MODEL`, `GOOGLE_SAFETY_THRESHOLD`: **remove / unused (never set)**. Named only in `tests/unit/geminiSafety.spec.ts`; no file under `lib/` reads either on `release/1` at 663fb243; neither was ever set in Coolify (15 Oct name check); nothing to set (owner, 16 Oct) |
| OpenAI (GPT Image) | `OPENAI_API_KEY` | `OPENAI_BASE_URL` | none today | |
| Anthropic (Claude text) | `ANTHROPIC_API_KEY` | none (fixed origin, `lib/textRoute.ts`) | `TEXT_DIRECT` (a list of vendors that go direct; Google always does) | `ANTHROPIC_PROMPT_MODEL`, `ANTHROPIC_PROMPT_EFFORT` |
| xAI (Grok text, Grok Imagine, voice) | `XAI_API_KEY` | `XAI_BASE_URL` | `TEXT_DIRECT` for text | `XAI_MODEL`, `XAI_RATE_USD_PER_MTOK` |
| ElevenLabs | `ELEVENLABS_API_KEY` | `ELEVENLABS_BASE_URL` | none today | `ELEVENLABS_RATES`, `ELEVENLABS_SOURCE_LIMIT_BYTES`, `ELEVENLABS_OUTPUT_LIMIT_BYTES`, `ELEVEN_SFX_CREDITS`, `ELEVEN_MUSIC_CREDITS_PER_MINUTE` |
| Higgsfield (API key only, rule 10/16) | `HF_API_KEY_ID` and `HF_API_KEY_SECRET`, or `HF_CREDENTIALS` | `HF_BASE_URL` (default `https://api.higgsfield.ai`) | none for the API key (the `HF_*_ENABLED` names in the code belong to the sign-in features, which are off) | |
| fal (Kling 3.0 now, Kling 4.0 on fal when live; identity training; Topaz and Bria until each goes direct) | `FAL_KEY` | `FAL_BASE_URL` | none today; **Kling 4.0:** `KLING4_ENABLED` (new, proposed; 3.0 Pro until then) | `FAL_TRAINER`, `FAL_TRAIN_STEPS`, `FAL_TRAIN_USD_PER_STEP`, `FAL_RENDER_USD_PER_MP` |
| Stripe (planned) | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | | `PAYMENT_PROVIDER` | |
| Resend, Liveblocks, R2, Turso | `RESEND_API_KEY`; `LIVEBLOCKS_SECRET_KEY`; `R2_ACCESS_KEY_ID` + `R2_SECRET_ACCESS_KEY` (+ `R2_ACCOUNT_ID`, `R2_BUCKET`); `TURSO_AUTH_TOKEN` | `RESEND_BASE_URL`; `TURSO_DATABASE_URL` | | unchanged by the new stack |

### B. Keys the owner has already set; the adapter is wired now

| Provider | Key (secret) | Address (optional) | Switch | Other |
|---|---|---|---|---|
| sync.so (lipsync-2-pro; sync-3 for hero and 4K) | `SYNC_API_KEY` (**set**) | `SYNC_BASE_URL` (default `https://api.sync.so`) | `SYNC_ENABLED` | `SYNC_WEBHOOK_SECRET` (only when webhooks are turned on, Y4) |
| Sarvam (Bulbul, Saaras, dubbing) | `SARVAM_API_KEY` (**set**) | `SARVAM_BASE_URL` (default `https://api.sarvam.ai`) | `SARVAM_ENABLED` | `SARVAM_USD_PER_INR` (**set**; the rupee rate the owner sets, reviewed monthly) |
| Black Forest Labs (FLUX 3, FLUX.2 identity; replaces fal flux-lora) | `BFL_API_KEY` (**set**) | `BFL_BASE_URL` (unset: B1 defaults to `https://api.eu.bfl.ai`; if set, an `https://` `*.bfl.ai` host) | `BFL_ENABLED` | |
| Runway (Act-Two, Aleph 2, Gen-4.5) | `RUNWAY_API_KEY` (named in SOW 4 Oct §5.1; owner 22:15: keys set, name to confirm in the name-only check) | `RUNWAY_BASE_URL` (default `https://api.dev.runwayml.com/v1`) | `RUNWAY_ENABLED` (house workspace only until training-free terms) | |
| Topaz, direct (T0 to T3) | `TOPAZ_API_KEY` (**set**: production only, locked, not in previews) | none: #781 fixes `api.topazlabs.com`, so `TOPAZ_BASE_URL` is **not read** (16 Oct) | `TOPAZ_DIRECT_ENABLED` (**corrected 16 Oct**; not `TOPAZ_ENABLED`) | `FAL_KEY` stays for Kling and, until each goes direct, Bria |
| AWS Rekognition (Mumbai) | `REKOGNITION_ACCESS_KEY_ID`, `REKOGNITION_SECRET_ACCESS_KEY`, `REKOGNITION_REGION`, `REKOGNITION_ENABLED`: **not used (owner, 16 Oct 2026): the keys stay set, read by nothing** | none | none | Rekognition is out: no face matching anywhere. The IAM user stays limited to `CompareFaces` and `DetectFaces` and unused |
| Google Cloud Vision | `GOOGLE_VISION_API_KEY` (**set**; read by #783) | none: #783 fixes the address, so `GOOGLE_VISION_BASE_URL` is **not read** (16 Oct) | `VISION_LABEL_CHECK_ENABLED` (**corrected 16 Oct**; not `GOOGLE_VISION_ENABLED`) | |
| Recraft (V4.1 and V3) | `RECRAFT_API_KEY` (**set** 15 Oct 22:15) | `RECRAFT_BASE_URL` (default `https://external.api.recraft.ai/v1`) | `RECRAFT_ENABLED` | |

### C. New engines: names proposed (owner confirms; keys not yet needed unless marked)

| Provider | Key (secret) | Address (optional) | Switch | Other |
|---|---|---|---|---|
| Bria, direct (replaces Bria on fal) | `BRIA_API_KEY` (**new, proposed**; the owner holds no Bria direct key yet, so one is needed) | `BRIA_BASE_URL` | `BRIA_ENABLED` | |
| Google Veo 3.1 | **No new key.** Veo is served by the Gemini API, the host `lib/gemini.ts:36` already reads, so the adapter is expected to use the existing `GEMINI_API_KEY` and `GEMINI_BASE_URL`. This is not yet in code (there is no Veo row in `lib/models.ts` or `lib/vendorRates.ts`) and is **to be confirmed against Google's own page in the Veo PR** | existing `GEMINI_BASE_URL` | `VEO_ENABLED` (new, proposed) | |
| Google Nano Banana 2.1 and Gemini 3.x (moments, cutdown planning, vision judge) | existing `GEMINI_API_KEY` | existing `GEMINI_BASE_URL` | `NANOBANANA21_ENABLED` and `GEMINI3_ENABLED` (new, proposed; one per engine PR) | model names live in config and the model rows, never in the design |
| AWS Elemental MediaConvert, Smart Crop reframe (replaces Luma reframe) | see "AWS MediaConvert" below | `MEDIACONVERT_ENDPOINT` | `MEDIACONVERT_ENABLED` | `MEDIACONVERT_REGION`, `MEDIACONVERT_ROLE_ARN`, `MEDIACONVERT_BUCKET` |
| Pro pick menu (Seedance 2.5, Veo 3.1, Kling 4.0, Runway Gen-4.5) | none | none | none | names live in config, never in the design |

#### AWS MediaConvert: what it needs that Rekognition does not
Rekognition is one stateless call with a key pair. MediaConvert is a job service that reads and writes S3. It needs, in AWS Mumbai (`ap-south-1`):
- **An IAM role that MediaConvert assumes** to read the input and write the output. Its ARN is `MEDIACONVERT_ROLE_ARN` (not a secret, but treated as one).
- **An S3 bucket in `ap-south-1`** for the job's input and output: `MEDIACONVERT_BUCKET`. Private, no public access, an expiry rule on its objects (owner action) so AWS keeps nothing longer than needed. Our code copies the finished clip into it, then copies the cropped result back under the workspace's own R2 prefix, so every Blob path stays prefixed by the workspace (ground rule 2).
- **The account's MediaConvert endpoint:** a per-account address (found with `DescribeEndpoints`). Either the adapter discovers it once, or the owner sets it as `MEDIACONVERT_ENDPOINT`. `MEDIACONVERT_REGION` is `ap-south-1`.
- **A queue ARN, only if the default queue is not used:** `MEDIACONVERT_QUEUE_ARN` (optional).
- **Keys.** The Rekognition key pair is limited to `CompareFaces` and `DetectFaces`, so it cannot create a job. Either grant that IAM user MediaConvert (`CreateJob`, `GetJob`, `DescribeEndpoints`), `iam:PassRole` on the role above, and S3 `PutObject`/`GetObject` on the bucket, or, **recommended (least privilege), use a separate key pair**: `MEDIACONVERT_ACCESS_KEY_ID` and `MEDIACONVERT_SECRET_ACCESS_KEY`. The recommendation is the separate pair, so a Rekognition key can never write to S3.
- None of these names starts with `AWS_` (see the collision note below).

### D. Our own server

| What | Key or secret | Address | Switch | Other |
|---|---|---|---|---|
| Remotion + ffmpeg worker (`docs/plans/remotion.md` on `redesign/integration`) | `REMOTION_WORKER_SECRETS` on the app, and `REMOTION_WORKER_SECRET` on the worker's own stack (the same value; one secret per worker) | `REMOTION_WORKER_URLS` (the worker's internal address) | `REMOTION_EXPORTS` | limits are in `compose.yaml` (3 CPU, 8 GB), not env |
| Chromium PDF (treatment, pitch, PPM decks) | none if it runs on the same Remotion worker (it already has Chromium); if it gets its own worker, `PDF_WORKER_URLS` and `PDF_WORKER_SECRETS` (new, proposed, mirroring Remotion) | | `PDF_EXPORTS` (new, proposed) | |
| Blender relay (#757, already merged) | existing `ASTRA_*` names (`ASTRA_WORKER_URLS` and the rest; see `ops/render-worker/README.md`) | | | unchanged |

### E. Slice 5: viral trend panel (`docs/plans/viral-trends.md`)

One provider per platform, each optional, behind one `TRENDS_ENABLED` switch (the plan's own names, section 4):

| Source | Key (secret) | Other |
|---|---|---|
| YouTube Data API (mostPopular, region IN) | `YOUTUBE_API_KEY` | |
| Google Trends via SerpApi | `SERPAPI_API_KEY` | |
| TikTok signals via Zyla (hashtags, sounds, formats; never videos) | `TRENDS_TIKTOK_API_KEY` | `TRENDS_TIKTOK_PROVIDER=zyla` |
| Instagram hashtag search via Meta (after app review) | `META_IG_ACCESS_TOKEN` (new, proposed) | `META_IG_BUSINESS_ACCOUNT_ID` (new, proposed) |
| The feature | | `TRENDS_ENABLED`; optional `TRENDS_DAILY_CALL_BUDGET` (default 50), `TRENDS_CACHE_TTL_HOURS` (default 6), `TRENDS_REGIONS` (default `IN,US,GB,global`) |

The plan's single `TRENDS_PROVIDER` and `TRENDS_API_KEY` are replaced by the per-platform names above (its 15 Oct note); `ZYLA_API_KEY` would read more plainly than `TRENDS_TIKTOK_API_KEY`, which is the owner's call. None of these is needed until Slice 3 is done.

### The site setting (a platform setting, not an env name)

"On for the house workspace (ws_legacy) and any workspace I list in the site setting; OFF for customer workspaces until launch" (owner, 15 Oct 22:15). The site settings are one row in the platform database (`platform_layer`, key `site`; `lib/site/settings.ts`), changed only by the platform owner from /admin, with no migration and no env. **Proposed name: `enginesOnWorkspaces`**, a list of workspace ids (well-formed, distinct, at most 50), empty by default, the same shape as `newInterfaceWorkspaces`. An engine is offered to a workspace only when **its `<VENDOR>_ENABLED` switch is on** (the global kill switch) **and** the workspace is the house workspace or is listed in `enginesOnWorkspaces`. Adding the field is a small change to `SiteSettings`, `cleanSite` and `sitePatch` and a control in /admin; the row already exists. **Status (15 Oct late evening):** #766 (exports) and #771 (the face check) already read a field of this name through a shared engine gate (`lib/engineGate.ts`: the engine's own switch exactly `1` and the house workspace or a listed one, failing closed); nothing writes the list yet. #767 (PDF decks) still reads `newInterfaceWorkspaces`, so the two lists should be made one in the PR that adds the field. One list covers every engine in the stack; a per-engine list is not proposed. At launch the owner opens engines to all by a platform-layer default, not by listing everyone.

### The house cap (no env name; a code finding)

The owner's cap is $500 a month on the house workspace, warning at 80%. **Neither needs a migration.** The per-workspace cap already exists as the column `workspaces.allowance_usd`, set from /admin (`lib/allowanceDesk.ts`), and `PLATFORM_ALLOWANCE_USD` is only the default for customer workspaces. **But `allowanceUsd()` returns no cap at all for the house workspace** (`lib/allowance.ts`: "The house workspace has none (`lib/houseWorkspace.ts`)"), so setting the column on the house row would change nothing today. The cap therefore needs a small code change (the house workspace reads its own `allowance_usd` when one is stored, and none otherwise), plus the 80% warning, which is not in the code on `release/1`. No new env name and no migration. A new env name such as `HOUSE_ALLOWANCE_USD` is not recommended: the column is already the one place the desk reads and writes. **Status:** this is now **#765** (NEEDS AKSHAY: the house workspace's $500 monthly cap with a warning at 80%).

### What was missing from the old table

The table in this section before 15 Oct 22:15 had eight rows (sync.so, Sarvam, Rekognition, Vision, Recraft, BFL, Runway, Topaz). Each of the following is new:
1. **Providers in use that had no row**, with names read from the code: BytePlus (`ARK_API_KEY`, `ARK_BASE_URL`, `ARK_TEXT_MODEL`), Google Gemini API (`GEMINI_API_KEY`, `GEMINI_BASE_URL`; the two option names are not read by the code), OpenAI (`OPENAI_API_KEY`, `OPENAI_BASE_URL`), Anthropic (`ANTHROPIC_API_KEY`, `TEXT_DIRECT`), xAI (`XAI_API_KEY`, `XAI_BASE_URL`), ElevenLabs (`ELEVENLABS_API_KEY`, `ELEVENLABS_BASE_URL`), Higgsfield (`HF_API_KEY_ID` + `HF_API_KEY_SECRET` or `HF_CREDENTIALS`, `HF_BASE_URL`), fal (`FAL_KEY`, `FAL_BASE_URL`).
2. **Bria, direct:** `BRIA_API_KEY`, `BRIA_BASE_URL`, `BRIA_ENABLED`. Needs a new key; Bria runs on fal today.
3. **Google Veo 3.1:** no new key (the Gemini key and host), `VEO_ENABLED`, to be confirmed.
4. **Google Nano Banana 2.1 and Gemini 3.x:** the Gemini key, `NANOBANANA21_ENABLED`, `GEMINI3_ENABLED`.
5. **Kling 4.0 on fal:** `FAL_KEY` (existing), `KLING4_ENABLED`.
6. **AWS MediaConvert:** `MEDIACONVERT_ROLE_ARN`, `MEDIACONVERT_BUCKET`, `MEDIACONVERT_REGION`, `MEDIACONVERT_ENDPOINT`, `MEDIACONVERT_QUEUE_ARN`, `MEDIACONVERT_ENABLED`, and a key pair (recommended separate: `MEDIACONVERT_ACCESS_KEY_ID`, `MEDIACONVERT_SECRET_ACCESS_KEY`), because the Rekognition user is limited to two calls and the job needs an IAM role, an S3 bucket in Mumbai and the account's endpoint.
7. **The Remotion worker:** `REMOTION_EXPORTS`, `REMOTION_WORKER_URLS`, `REMOTION_WORKER_SECRETS`, and the worker stack's `REMOTION_WORKER_SECRET`.
8. **Chromium PDF decks:** `PDF_EXPORTS` (and `PDF_WORKER_URLS`, `PDF_WORKER_SECRETS` only if it gets its own worker).
9. **Slice 5 trend sources:** `YOUTUBE_API_KEY`, `SERPAPI_API_KEY`, `TRENDS_TIKTOK_API_KEY` + `TRENDS_TIKTOK_PROVIDER`, `META_IG_ACCESS_TOKEN`, `META_IG_BUSINESS_ACCOUNT_ID`, `TRENDS_ENABLED`, and the three optional tuning names.
10. **The site setting `enginesOnWorkspaces`** (not an env name).
11. **The house cap:** no env name, but a code gap (the house workspace has no cap today).
12. **Names that were marked "set" or confirmed since the old table:** `SYNC_API_KEY`, `SARVAM_API_KEY`, `SARVAM_USD_PER_INR`, `BFL_API_KEY`, `TOPAZ_API_KEY`, the three `REKOGNITION_*` and `GOOGLE_VISION_API_KEY` (owner, 15 Oct 19:30), and `RECRAFT_API_KEY` (22:15). The old table's `BFL_ENABLED`, `REKOGNITION_ENABLED`, `PROMPT_MODELS` and `GATEWAY_PROMPT_MODELS` were reported missing from the production container on 15 Oct 19:30; the two `*_PROMPT_MODELS` names are not in this table (gateway text is being retired; see `TEXT_DIRECT`).

**Why the AWS names cannot collide.** None of the Rekognition or MediaConvert names starts with `AWS_`, `R2_`, `S3_`, `STORAGE_` or `BLOB_`.
- **What the storage code reads:**
  - `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_ENDPOINT`, `STORAGE_BACKEND` and `BLOB_READ_WRITE_TOKEN` (`lib/storage/*.ts`);
  - the same R2 names in the backup and copy scripts (`scripts/ops/blob-to-r2.mjs:51-56`, `scripts/ops/backup-lib.mjs:392`).
  
  The R2 client is given its region, endpoint and credentials in code (`lib/storage/r2.ts:190-194`).
- **What the AWS SDKs read by themselves:** every environment setting in AWS's settings reference starts with `AWS_`:
  - credentials: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`;
  - region and profile files: `AWS_REGION`, `AWS_PROFILE`, `AWS_CONFIG_FILE`, `AWS_SHARED_CREDENTIALS_FILE`;
  - endpoints: `AWS_ENDPOINT_URL`, `AWS_ENDPOINT_URL_<SERVICE>`, `AWS_IGNORE_CONFIGURED_ENDPOINT_URLS`, `AWS_USE_FIPS_ENDPOINT`, `AWS_USE_DUALSTACK_ENDPOINT`;
  - roles and containers: `AWS_ROLE_ARN`, `AWS_ROLE_SESSION_NAME`, `AWS_WEB_IDENTITY_TOKEN_FILE`, `AWS_CONTAINER_CREDENTIALS_FULL_URI`, `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI`, `AWS_CONTAINER_AUTHORIZATION_TOKEN`, `AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE`;
  - instance metadata: `AWS_EC2_METADATA_DISABLED`, `AWS_EC2_METADATA_SERVICE_ENDPOINT`, `AWS_EC2_METADATA_SERVICE_ENDPOINT_MODE`, `AWS_EC2_METADATA_V1_DISABLED`, `AWS_METADATA_SERVICE_NUM_ATTEMPTS`, `AWS_METADATA_SERVICE_TIMEOUT`;
  - retries and defaults: `AWS_MAX_ATTEMPTS`, `AWS_RETRY_MODE`, `AWS_DEFAULTS_MODE`;
  - checksums and compression: `AWS_REQUEST_CHECKSUM_CALCULATION`, `AWS_RESPONSE_CHECKSUM_VALIDATION`, `AWS_DISABLE_REQUEST_COMPRESSION`, `AWS_REQUEST_MIN_COMPRESSION_SIZE_BYTES`;
  - S3: `AWS_S3_USE_ARN_REGION`, `AWS_S3_DISABLE_MULTIREGION_ACCESS_POINTS`, `AWS_S3_DISABLE_EXPRESS_SESSION_AUTH`;
  - the rest: `AWS_ACCOUNT_ID`, `AWS_ACCOUNT_ID_ENDPOINT_MODE`, `AWS_AUTH_SCHEME_PREFERENCE`, `AWS_SIGV4A_SIGNING_REGION_SET`, `AWS_CA_BUNDLE`, `AWS_DISABLE_HOST_PREFIX_INJECTION`, `AWS_ENABLE_ENDPOINT_DISCOVERY`, `AWS_SDK_UA_APP_ID`, `AWS_STS_REGIONAL_ENDPOINTS`.
- **No `AWS_*` setting should be added to Coolify for this work.** The Rekognition and MediaConvert adapters sign with `signRequest` (`lib/storage/r2.ts:115-116`) and read only the `REKOGNITION_*` and `MEDIACONVERT_*` names. So neither the storage client nor any AWS SDK default can pick those keys up, and the AWS adapters can never pick up the R2 keys.

### The names each PR reads (checked 16 Oct 2026 against the PR branches)

"Set?" is only what this plan or the owner's notes record: **set** = the owner reported it set in Coolify (19:30 name check on 15 Oct; Recraft at 22:15); **not recorded** = no note says it is set. No value was seen and no env was read. "Reads" means the name appears in the PR's code. Every switch is exactly `1` for on, goes through the shared engine gate (`lib/engineGate.ts`: the switch on **and** the house workspace or a workspace in the site setting `enginesOnWorkspaces`, from #766 and #771), and is off for customer workspaces until launch.

| Provider | Names the PR reads | Set? | PR | Kill switch |
|---|---|---|---|---|
| Remotion worker (its own stack) | `REMOTION_WORKER_SECRET` (one per worker); `REMOTION_WORKER_CONTAINER`, `REMOTION_WORKER_TEST_ROOT` (ignored inside the container), `REMOTION_RUNTIME_DIR`, `REMOTION_BUNDLE_DIR`, `REMOTION_BROWSER_EXECUTABLE`, `REMOTION_FONTS_DIR` (#767), `REMOTION_CONCURRENCY` (Dockerfile default 2), `REMOTION_MAX_SECONDS` (Dockerfile default 120) | none set: the worker is not deployed. Only `REMOTION_WORKER_SECRET` is the owner's; the rest are image or compose constants, tuned in `compose.yaml` from the measurement, never by hand | #699 (and #767 for the fonts) | none on the worker; the app's `REMOTION_EXPORTS` |
| Remotion exports (app) | `REMOTION_EXPORTS`; `REMOTION_WORKER_URLS`; `REMOTION_WORKER_SECRETS`; optional tuning `REMOTION_EXPORT_MAX_RUNNING` (default 1), `REMOTION_EXPORT_MAX_PER_HOUR` (6), `REMOTION_EXPORT_RUN_TIMEOUT_MS` (200000), each bounded in code; also `REMOTION_EXPORT_QUEUE_EXPIRY_MS` (default 30 minutes, found in the code 16 Oct), which **becomes a constant** (owner, 16 Oct 10:55) and is not a name to set | not recorded | #700 (the `export_jobs` migration needs the owner's word); #766 for the gate | `REMOTION_EXPORTS` |
| Chromium PDF decks | `PDF_EXPORTS`; and, to reach a worker, `REMOTION_WORKER_URLS` and `REMOTION_WORKER_SECRETS` | not recorded | #767 | `PDF_EXPORTS` |
| AWS Rekognition (consent face match) | `REKOGNITION_ACCESS_KEY_ID`, `REKOGNITION_SECRET_ACCESS_KEY`, `REKOGNITION_REGION`, `REKOGNITION_ENABLED`: **not used (owner, 16 Oct 2026): keys stay set, read by nothing**. Three keys were set (15 Oct 19:30); `REKOGNITION_ENABLED` never was | none read | #771 (removing the face check, owner 16 Oct) | none: no longer an engine |
| sync.so | `SYNC_API_KEY`, `SYNC_BASE_URL` (optional), `SYNC_ENABLED` | key **set** (19:30); switch not recorded | #776 | `SYNC_ENABLED` |
| Sarvam | `SARVAM_API_KEY`, `SARVAM_USD_PER_INR` (no rate means no price, so the engine is unavailable), `SARVAM_BASE_URL` (optional), `SARVAM_ENABLED` | key and `SARVAM_USD_PER_INR` **set** (19:30; the value was not seen); switch not recorded | #777 | `SARVAM_ENABLED` |
| Black Forest Labs | `BFL_API_KEY`, `BFL_BASE_URL` (optional; default the EU endpoint; if set an `https://` `*.bfl.ai` host), `BFL_ENABLED`; FLUX 3 and FLUX.2 identity add `BFL_IDENTITY_ENABLED` (needs `BFL_ENABLED` too) | key **set** (13:45, 15 Oct); `BFL_ENABLED` reported **missing** at 19:30 | #778; #785 for the identity switch | `BFL_ENABLED`; `BFL_IDENTITY_ENABLED` |
| Runway | `RUNWAY_API_KEY`, `RUNWAY_BASE_URL` (optional; an `https://` `*.runwayml.com` host ending `/v1`), `RUNWAY_ENABLED` | owner (22:15): keys set; the name was not in the 19:30 check | #780 | `RUNWAY_ENABLED` |
| Veo 3.1 | `VEO_ENABLED`; **the existing** `GEMINI_API_KEY` and `GEMINI_BASE_URL` (confirmed: no new key) | Gemini key live; `VEO_ENABLED` not recorded | #779 | `VEO_ENABLED` |
| Topaz, direct | `TOPAZ_API_KEY`, `TOPAZ_DIRECT_ENABLED`. No base-address setting (the address is fixed) | key **set** (production only, locked); switch not recorded | #781 | `TOPAZ_DIRECT_ENABLED` |
| AWS MediaConvert | `MEDIACONVERT_ACCESS_KEY_ID`, `MEDIACONVERT_SECRET_ACCESS_KEY` (its own pair), `MEDIACONVERT_ROLE_ARN`, `MEDIACONVERT_BUCKET`, `MEDIACONVERT_REGION` (unset or exactly `ap-south-1`), `MEDIACONVERT_ENDPOINT` (optional; discovered once if unset), `MEDIACONVERT_QUEUE_ARN` (optional), `MEDIACONVERT_ENABLED` (eight names) | not recorded (the role, the bucket and the key pair are owner actions) | #782 | `MEDIACONVERT_ENABLED` |
| Cloud Vision label check | `GOOGLE_VISION_API_KEY`, `VISION_LABEL_CHECK_ENABLED`. No base-address setting | key **set** (plan, 14 Oct); switch not recorded | #783 | `VISION_LABEL_CHECK_ENABLED` |
| Nano Banana 2.1 | `NANOBANANA21_ENABLED`; the existing `GEMINI_API_KEY` and `GEMINI_BASE_URL`. (`NANO_BANANA_21_ID` is a code constant, not a setting) | Gemini key live; switch not recorded | #784 | `NANOBANANA21_ENABLED` |
| Recraft | `RECRAFT_API_KEY`, `RECRAFT_BASE_URL` (optional), `RECRAFT_ENABLED` | key **set** (owner, 15 Oct 22:15) | #786 | `RECRAFT_ENABLED` |
| Where engines are ON | the site setting `enginesOnWorkspaces` (not env), read by the shared gate | nothing writes it yet; empty means the house workspace only | #766, #771 | n/a |

### What is still missing, 16 Oct 2026
- **Names this plan proposed that no PR reads:** `GOOGLE_VISION_BASE_URL` and `GOOGLE_VISION_ENABLED` (replaced by `VISION_LABEL_CHECK_ENABLED`, no address setting); `TOPAZ_BASE_URL` and `TOPAZ_ENABLED` (replaced by `TOPAZ_DIRECT_ENABLED`); `SYNC_WEBHOOK_SECRET` (named in #776's body; no code reads it; webhooks are the later Y4); `PDF_WORKER_URLS` and `PDF_WORKER_SECRETS` (not needed: #767 uses the Remotion worker's two names).
- **Names a PR reads that this plan's table did not have:** `REMOTION_EXPORT_MAX_RUNNING`, `REMOTION_EXPORT_MAX_PER_HOUR`, `REMOTION_EXPORT_RUN_TIMEOUT_MS`, `REMOTION_FONTS_DIR`, `REMOTION_CONCURRENCY`, `REMOTION_MAX_SECONDS`, `REMOTION_BUNDLE_DIR`, `REMOTION_BROWSER_EXECUTABLE`, `REMOTION_RUNTIME_DIR`, `REMOTION_WORKER_CONTAINER`, `REMOTION_WORKER_TEST_ROOT`, `BFL_IDENTITY_ENABLED`, `TOPAZ_DIRECT_ENABLED`, `VISION_LABEL_CHECK_ENABLED`. (Constants named in PR bodies, such as `REKOGNITION_USD_PER_IMAGE`, are in code, not settings.)
- **Engines in the stack with no PR yet and so no names read:** Gemini 3.x (moments, cutdown planning, the vision judge: `GEMINI3_ENABLED` is only a proposal), Kling 4.0 (`KLING4_ENABLED`, on `FAL_KEY`), Bria direct (`BRIA_API_KEY`, `BRIA_BASE_URL`, `BRIA_ENABLED`), the Pro pick config, DNxHR.
- **Slice 5 trends (`docs/plans/viral-trends.md`):** no PR. `YOUTUBE_API_KEY`, `SERPAPI_API_KEY`, `TRENDS_TIKTOK_API_KEY`, `TRENDS_TIKTOK_PROVIDER`, `META_IG_ACCESS_TOKEN`, `META_IG_BUSINESS_ACCOUNT_ID`, `TRENDS_ENABLED`, `TRENDS_DAILY_CALL_BUDGET`, `TRENDS_CACHE_TTL_HOURS`, `TRENDS_REGIONS` are proposals; none is read anywhere.
- **No `AWS_*`, `R2_*`, `S3_*`, `STORAGE_*` or `BLOB_*` name** appears among the new names (the collision rule below holds).
- **To check, owner:** that `BFL_ENABLED` and the other switches are unset until the owner turns each on; that no unused name (`TOPAZ_ENABLED`, `GOOGLE_VISION_ENABLED`, `SYNC_WEBHOOK_SECRET`) is added to Coolify by mistake.

## 10. Order and PRs

**Updated 15 Oct 2026, 22:15 IST to the final engine stack.** The order is the slices in "Where this stands" above, not the 14 Oct order. What follows is the PR list. A **Slice** column places each row; rows for engines the stack adds since 14 Oct (Veo, MediaConvert, Nano Banana 2.1, Gemini 3.x, Kling 4.0, the label check) are new and have no PR yet. **Every "qualification run" row is superseded** (owner, 15 Oct 22:15 and 22:20): there is no separate paid run; the person's normal per-step approval is the approval, and the team's first real use, with the owner, is the test. The spend figures stay as expectations of what a first use costs.

**14 Oct order, kept for the record (DECIDED then; slotted into the slices now):** sync.so, Sarvam, Rekognition with Vision's text check, Recraft then BFL, Runway, Topaz direct (T0 price table and data terms, T1 adapter on mocks, T2 the house run, T3 the switch and the removal of fal's Topaz endpoints).

Every adapter lands **behind its own kill switch** (`<VENDOR>_ENABLED`, off unless set), is on for the house workspace and listed workspaces only (`enginesOnWorkspaces`, the shared engine gate `lib/engineGate.ts` from #771, which the exports in #766 and later engines use), and off for customers until launch. None needs board UI. Every screen **waits for Claude Design / v18**. **Counsel before any switch is turned on for a customer** is unchanged (14 Oct).

| # | Slice | PR | Size | Review | After |
|---|---|---|---|---|---|
| Y1 | 2 | sync.so adapter: asset upload from bytes, `POST /v2/generate`, poll, `DELETE` after storing, `BASIS`, a new task `lipsync`, `SYNC_ENABLED` off, mocks | M, 8h | **Opus (money)** | — |
| Y2 | 2 | `lip_sync` tool: lipsync-2, lipsync-2-pro, sync-3; consent gate (face, and voice if not stock); source links; MCP | M, 6h | **Opus (privacy)** | Y1 |
| Y3 | 2 | Lip-sync rate rows for the plan bought | S, 2h | **NEEDS OWNER (prices)** | Y1 |
| Y4 | 2 | Signed webhooks (`Sync-Signature`) as a faster path beside polling | S, 3h | Opus (security) | Y2 |
| Y5 | 2 | ~~Qualification run~~ superseded: the team's first real use is the test (about $1.33 for one 5 s job on each model); includes the Hindi clip, bake-off (c) | — | none | Y2, Y3 |
| S1 | 2 | Sarvam adapter: speech, short transcripts and translation (answered at once), batch transcription (polled), `SARVAM_ENABLED` off, rupee rates and `SARVAM_USD_PER_INR`, mocks | M, 8h | **Opus (money)** | — |
| S2 | 2 | `sarvam_speech` (stock voices only) | S, 4h | — | S1 |
| S3 | 2 | `sarvam_translate` | S, 3h | — | S1 |
| S4 | 2 | `sarvam_transcribe` (Auto by language, per owner question F) | M, 6h | Opus (privacy) | S1 |
| S5 | 2 | Sarvam rate rows (the qualification run is superseded; first use about ₹4) | S, 2h | **NEEDS OWNER** | S2-S4 |
| V1 | 3 | Vision adapter: `images:annotate` `TEXT_DETECTION`, bytes in, `GOOGLE_VISION_ENABLED` off, mocks | S, 3h | — | — |
| V2 | 3 | `text_check` inside Verify (the `artifacts` check; priced into Verify's quote) | M, 5h | **Opus (money)** | V1 |
| V3 | 3 | `read_text` for on-screen text (feeds S3) | S, 3h | — | V1, S3 |
| V4 | 3 | ~~Qualification run~~ superseded (inside Google's 1,000 free images a month) | — | none | V2 |
| K1 | 2 | **In #771 (NEEDS AKSHAY, mocked).** Rekognition adapter: `signRequest` SigV4, Mumbai, `REKOGNITION_*` names, `REKOGNITION_ENABLED` off, mocks | S, 4h | — | AWS account set up |
| K2 | 2 | **#771 builds the gate** (`requireConsentMatch`, the `consent.check` tool; it fails closed until the owner picks the reference source). Left for K2 proper: any new use word after counsel; `record_face_consent` as a people-only tool, and the reference source once chosen | S, 4h | **Opus (privacy)**, NEEDS OWNER | counsel |
| K3 | 2 | `face_check` inside Verify: priced into its quote, threshold setting (owner question E), scores in `take_verifications` | M, 6h | **Opus (privacy, money)** | K1, K2 |
| K4 | 2 | `face_detect` on references before training | S, 3h | Opus (privacy) | K2 |
| K5 | 2 | ~~Qualification run~~ superseded (about 10 calls, $0.0125, or inside AWS's free tier) | — | none | K3 |
| C1 | 3 | Recraft adapter: generate, vectorize, remove background; `b64_json`; settle at the reply's units; `RECRAFT_ENABLED` off; mocks | M, 6h | **Opus (money)** | — |
| C2 | 3 | `svg` originals in storage, served safely (download only or a strict CSP) | S, 3h | **Opus (security)** | C1 |
| C3 | 3 | `recraft_image`, `recraft_vectorize`, `recraft_remove_background` tools; MCP | S, 4h | — | C1, C2 |
| C4 | 3 | Recraft V4.1 and V3 rate rows (the qualification run is superseded; first use about $0.14); V3 and the sketch, ink and comic storyboard styles added to C3 | S, 2h | **NEEDS OWNER** | C3 |
| B1 | 2 | BFL adapter: submit, worker poll of `polling_url`, copy within 10 minutes, `BFL_ENABLED` off, mocks; EU endpoint default pinned by a test (never `api.bfl.ai`), `*.bfl.ai` hosts only | M, 6h | **Opus (money)** | — |
| B2 | 2 | `flux2_image` and `flux2_edit` (up to 8 references; consent gate for real people) | S, 5h | **Opus (privacy)** | B1 |
| B3 | 2 | BFL rate rows (the qualification run is superseded; first use about $0.15) | S, 2h | **NEEDS OWNER** | B2 |
| R1-R5 | 2 | Runway, now in the stack (Act-Two, Aleph 2, Gen-4.5; Gen-4.5 is also a Pro pick): adapter (M, 8h, Opus money), rows (NEEDS OWNER), `runway_performance` (Opus privacy; passes the consent gate first), `runway_edit`; first use about $1.41, no separate run | about 21h | as listed | the consent reference source (#771); house workspace only until launch |
| T0-T3 | 2 | Topaz direct, from section 8: T0 price table and data terms (docs), T1 adapter on mocks (`TOPAZ_ENABLED`), T2 the switch for the house, T3 the removal of fal's Topaz endpoints | M, about 8h | **Opus (money)**, NEEDS AKSHAY | B1 |
| G1 | 2 | **Veo 3.1** (new): adapter on the Gemini key and host (to confirm), model row and rate row from Google's own page, `VEO_ENABLED`; a Pro pick | M, about 8h | **Opus (money)** | — |
| M1 | 2 | **AWS MediaConvert Smart Crop** (new, replaces Luma reframe): adapter (SigV4 through `signRequest`; the role, bucket, endpoint and key pair in section 9), job poll, copy back under the workspace's prefix, `MEDIACONVERT_ENABLED`; Luma reframe removed after | M, about 10h | **Opus (money, privacy)** | the owner's AWS role and bucket |
| N1 | 3 | **Nano Banana 2.1** beside Pro (model row, rate row, `NANOBANANA21_ENABLED`) | S, about 4h | **Opus (money)** | — |
| N2 | 3 | **Gemini 3.x** for moments, cutdown planning and the vision judge: tools in the registry, no new paid path except the model's own price | M, about 8h | **Opus (money)** | N1 |
| V5 | 3 | **Cloud Vision label check with an exact text diff:** read the text, then diff it exactly against the brief's mandatory text; **never an AI model alone**; a mismatch marks the take for a person | M, about 6h | Opus (money) | V2 |
| L1 | 3 | **Kling 4.0 on fal** the day it is live (`KLING4_ENABLED`; Kling 3.0 Pro until then); a Pro pick | S, about 4h | **Opus (money)** | fal listing it |
| P1 | 3 | **Pro pick menu in config:** Seedance 2.5, Veo 3.1, Kling 4.0, Runway Gen-4.5; names in config, never in the design | S, about 3h | — | G1, L1, R1 |
| D1 | 1 | **DNxHR mezzanine** (a follow-up: #768's title lists H.264 and ProRes 422 and HQ only) | S, about 4h | Opus (money) | #768 |

**About 120 hours for the 14 Oct rows,** Runway's 21 included; the rows above are estimates only. The Remotion and PDF PRs are in Slice 1 and their own plan.

- **No migration.** The one possible schema change is K2's, and only if counsel asks for a new kind of consent record rather than a new use word. If so, it ships after the owner's backup.
- **The `svg` original in C2** is a storage path and a content type, not a table change.

**Guard tests: added to, never weakened.**
- `tests/unit/bundle.spec.ts`: new vendor rates stay off the browser.
- `tests/unit/noVendorCostToCustomers.spec.ts`: no rupee, dollar or units figure from a vendor reaches a customer.
- `tests/unit/engines.spec.ts:6`: each new adapter estimates what the catalogue says.
- The people-only tests: `record_face_consent` refuses Atomik and tokens.
- `tests/unit/signinRetiredGuard.spec.ts` and `signinOffRelease1.spec.ts`: untouched. Nothing here uses a sign-in.
- **New:** a test that no `REKOGNITION_*` value can reach the R2 client, and no `R2_*` value the Rekognition adapter.

## 11. What needs the owner
- **Accounts and keys.** The owner puts them into Coolify (names in §9), never an agent, never the repo.
  - **sync.so:** the plan (owner question C); `SYNC_API_KEY`; written terms that exclude training.
  - **Sarvam:** the account and plan tier; **retention set to 0 days**; `SARVAM_API_KEY`; `SARVAM_USD_PER_INR`.
  - **AWS:** an account under AWS Organizations with the AI-services opt-out policy; an IAM user allowed only `rekognition:CompareFaces` and `rekognition:DetectFaces` in `ap-south-1`; the `REKOGNITION_*` settings.
  - **Google Cloud Vision:** `GOOGLE_VISION_API_KEY` is set. Restrict it to the Vision API and the server's address, and make sure the project has billing on.
  - **Recraft:** API units bought in advance; `RECRAFT_API_KEY`.
  - **Black Forest Labs:** an account and credits; `BFL_API_KEY`; the training opt-out email, or enterprise terms.
  - **Runway:** standby. Only for a house-only qualification run.
- **Prices:** every rate row (sync.so, Sarvam, Rekognition and Vision inside Verify, Recraft, BFL, Runway). Every figure here is a sample.
- **Contracts, for counsel to read before any customer switch:**
  - sync.so and BFL on training;
  - Sarvam's processing terms and its §10.5(d) (offering access to third parties);
  - Runway's Enterprise terms;
  - AWS's and Google's standard data terms (they come with the accounts);
  - Recraft's Developer Terms.
- **Counsel (DECIDED: before any customer switch):** biometric consent wording; whether similarity scores must be erased when consent is withdrawn (versus never-delete); Particl's DPDP role for a customer's cast; transfers outside India (sync.so, BFL, Runway and Vision process abroad; Sarvam and Rekognition in India).
- **Screens** (wait for Claude Design / v18): the consent prompts for lip-sync, face checks and references; the lip-sync model choice; showing the face and text scores; language and voice pickers; "Powered by Runway" if Runway is ever used for customers.
- **Each qualification run's spend** (house workspace only):

  | Provider | About |
  |---|---|
  | sync.so | $1.33 |
  | Sarvam | ₹4 |
  | Vision | free tier |
  | Rekognition | $0.01 |
  | Recraft | $0.14 |
  | BFL | $0.15 |
  | Runway | $1.41 |

  These are what a first real use costs, **not** a separate run: the owner's 15 Oct decision is that the per-step approval is the approval and the team's first use is the test. No paid run happens before the team tests with the owner.

## 12. Owner questions

**Answered (14 Oct):**
- The order: sync.so direct, then Sarvam direct, then Rekognition, then Runway on standby.
- No voice cloning.
- Counsel before any customer switch.
- Delete the vendor's copy.
- Recraft, BFL FLUX.2, Vision and the Topaz comparison added.
- The Coolify names (§9).

**Still open from the first draft:**
- **D. The rupee rate for Sarvam.** A fixed `SARVAM_USD_PER_INR`, reviewed monthly by the owner? **Recommended: yes.**
- **E. Face checks.** A threshold of 90, priced inside Verify (usually +0 or +1 cr), and a low score marks the take for a person and never blocks it? **Recommended: yes.**
- **F. Transcripts.** Sarvam for Indian languages and Grok for the rest, chosen by Auto from the language? **Recommended: yes.**

**New:**
- **A. Where the additions go.** **Recommended:**
  - Vision's text check in the Verify lane with Rekognition, but free to land first (no consent question);
  - Recraft, then BFL, as an image lane beside Sarvam and Rekognition;
  - Topaz direct, after B1 (decided 15 Oct 14:05, §8).
- **B. BFL.** DECIDED: direct, on the EU endpoint (GDPR terms). The owner set `BFL_API_KEY` on 15 Oct 13:45 (production only, locked; the training opt-out is done in BFL's dashboard). **B1's defaults:** `BFL_BASE_URL` is unset, so B1 uses `https://api.eu.bfl.ai` in code, never the global `api.bfl.ai`, with a test pinning the default; a `BFL_BASE_URL` that is set must be an `https://` `*.bfl.ai` host; a polling or result URL BFL returns is followed only when its host is a `bfl.ai` subdomain (no SSRF); a test says which region served the call; `BFL_ENABLED` stays unset until the owner turns it on; no paid call without the owner's yes.
- **C. Which sync.so plan to buy.** **Recommended: Creator** ($19 a month: 3 jobs at once, 5-minute videos). Move to Scale (20% off usage, 15 at once) when volume justifies $249 a month.
- **G. Vision's uses.** The Verify text check and reading on-screen text for translation now; the mandatories check once mandatories are stored? **Recommended: yes.**
- **H. Topaz.** DECIDED (owner, 15 Oct 14:05): direct, on Topaz's own API with `TOPAZ_API_KEY`; the first recommendation here (stay on fal) is replaced. See §8.
- **I. sync-3's photo input** (a talking person from a still). Leave it out of v1? **Recommended: yes**, video only, until the consent design for it exists.

## Verified prices, 16 Oct 2026

Prices were checked against each provider's own page on the night of 15 to 16 Oct 2026 by the build lanes and recorded in `docs/redesign-progress.md`. **Dollars and rupees are the vendor's, not ours:** customer credits come through the margin path, which is private to the owner, and vendor costs never reach customers. Every figure is as published that night; check again before relying. Each PR says "TO CONFIRM on the first invoice" where the unit or field is not certain; the first house use settles those.

| Provider (PR) | Source | Figures recorded |
|---|---|---|
| sync.so (#776) | https://sync.so/docs/models | Per output second at 25 fps: lipsync-2 $0.04 to $0.05; lipsync-2-pro $0.067 to $0.083; sync-3 $0.107 to $0.133. The PR uses the top (standard) rate of each, with exact 5 s and 60 s rates |
| Sarvam (#777) | https://docs.sarvam.ai (pricing) and https://www.sarvam.ai/api-pricing | Bulbul v3 ₹30 per 10,000 characters; Bulbul v4 Flash ₹20; translate ₹20 per 10,000 characters; speech to text ₹30 an hour in the docs table but ₹0.49 a minute (₹29.4 an hour) on the pricing page, and the PR uses the lower reading. In rupees, converted at `SARVAM_USD_PER_INR`. Neither page states retention or training use |
| Black Forest Labs (#778, #785) | BFL's published pricing data (the source behind https://docs.bfl.ai/quick_start/pricing); 1 BFL credit = $0.01 | FLUX.2 pro 3 / 1.5 / 1.5 credits (first megapixel / further megapixel / input megapixel); flex 5 / 5 / 5; max 7 / 3 / 3. FLUX 3 per image: 768 px 4.1 credits, 1k 4.8, 1.5k 7, 2k 10, 4k 60.7; Klein 0.8 to 3.6. Up to 4 MP and 8 references; result URLs valid 10 minutes. The megapixel definition (1,000,000 or 1,048,576 pixels) is to be confirmed by the first call |
| Runway (#780) | https://docs.dev.runwayml.com (pricing) | $0.01 a credit. act_two 5 credits a second; aleph2 28 credits a second with a 56-credit minimum; gen4.5 12 credits a second; gen4_turbo 5. All matched |
| Veo 3.1 (#779) and Nano Banana 2.1 (#784) | https://ai.google.dev/gemini-api/docs/pricing (updated 15 Oct); for Nano Banana 2.1 also https://ai.google.dev/gemini-api/docs/models (updated 13 Oct) | Veo 3.1 per second with audio: Standard $0.40 at 720p and 1080p, $0.60 at 4k; Fast $0.10 at 720p, $0.12 at 1080p, $0.30 at 4k. Nano Banana 2.1 per image: $0.0336 at 1K, $0.0504 at 2K, $0.1134 at 4K |
| AWS MediaConvert (#782) | AWS price list API, ap-south-1 (Mumbai) | Basic tier, AVC single pass, per output minute: HD up to 30 fps $0.015, up to 60 fps $0.0188; 4K $0.03 / $0.0375; SD $0.0075 / $0.0094. Billed per second, 10 s minimum per output |
| ~~AWS Rekognition (#771)~~ **history only: not used (owner, 16 Oct)** | AWS Price List API, Mumbai: https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonRekognition/current/ap-south-1/index.json (fetched 16 Oct 2026) | "Images Processed: Non Free Tier: 0 - 1000000 images processed per month": $0.00125 an image; then $0.0010 up to 5 million, $0.00075 up to 35 million, lower after. Matches #771's `REKOGNITION_USD_PER_IMAGE` = 0.00125 with `IMAGES_PER_CALL` = 1: the first tier only, never the cheaper ones. Still to confirm on the first bill |
| Topaz direct (#781) | https://www.topazlabs.com/api and the developer docs; table in `docs/plans/topaz-direct-prices.md` | $0.10 a credit on Developer, $0.08 on Scale. Image up to 24 MP 1 credit, 48 MP 3 credits on the API page (the docs say linear). Astra 2: 3 credits a second at 1080p30 and 5 at 4K30, scaling with frame rate. Pages contradict each other; the PR prices the dearer reading at $0.10 until the owner confirms the plan |
| Cloud Vision (#783) | https://cloud.google.com/vision/pricing | $1.50 per 1,000 images after the first 1,000 a month free; the PR ignores the free tier |
| Recraft (#786) | https://www.recraft.ai (pricing and Developer Terms) | V4.1 $0.035 raster and $0.08 vector; V4.1 Pro $0.21 raster and $0.30 vector; V3 $0.04 and $0.08; vectorize and remove background $0.01; style $0.005 a request. Developer Terms section 6.3: no training on API outputs |

Notes: the older sample prices in sections 1 to 8 of this plan were set on 14 Oct and are samples; where they differ from the table above, this table is later. Text prices (Gemini 3.x) come from `lib/modelCatalog.json`, which has no dated steps, so a scheduled change such as 3.8 Flash's price change on 1 Jan 2027 cannot be encoded yet (owner question in the progress log).

## Sources (all read 14 Oct 2026)
- Runway:
  - API reference: https://docs.dev.runwayml.com/api/
  - Using the API: https://docs.dev.runwayml.com/guides/using-the-api
  - Pricing: https://docs.dev.runwayml.com/guides/pricing
  - Inputs: https://docs.dev.runwayml.com/assets/inputs
  - Outputs: https://docs.dev.runwayml.com/assets/outputs
  - Usage tiers: https://docs.dev.runwayml.com/usage/tiers
  - Runway's SDK types (request fields and task statuses): https://github.com/runwayml/sdk-node/tree/main/src/resources
  - Terms of use (updated 15 Sep 2026): https://runway.com/terms-of-use
- Sarvam:
  - Text to speech: https://docs.sarvam.ai/api-reference-docs/text-to-speech/convert
  - Speech to text: https://docs.sarvam.ai/api-reference-docs/speech-to-text/transcribe
  - Batch speech to text: https://docs.sarvam.ai/api-reference-docs/api-guides-tutorials/speech-to-text/batch-api
  - Translate: https://docs.sarvam.ai/api-reference-docs/text/translate-text
  - Rate limits: https://docs.sarvam.ai/api/ratelimits
  - Data retention: https://docs.sarvam.ai/api/platform/data-retention.md
  - Pricing: https://www.sarvam.ai/api-pricing
  - Terms (effective 29 Jul 2026): https://www.sarvam.ai/terms-of-service
- sync.so:
  - OpenAPI: https://sync.so/docs/openapi.json
  - Billing: https://sync.so/docs/product/billing.md
  - Models: https://sync.so/docs/models/lipsync
  - Privacy: https://sync.so/privacy
- fal:
  - Lip-sync: https://fal.ai/models/fal-ai/sync-lipsync/v2
  - Lip-sync Pro: https://fal.ai/models/fal-ai/sync-lipsync/v2/pro
- AWS:
  - CompareFaces: https://docs.aws.amazon.com/rekognition/latest/APIReference/API_CompareFaces.html
  - Limits: https://docs.aws.amazon.com/rekognition/latest/dg/limits.html
  - Endpoints and quotas: https://docs.aws.amazon.com/general/latest/gr/rekognition.html
  - FAQ: https://aws.amazon.com/rekognition/faqs/
  - Pricing: https://aws.amazon.com/rekognition/pricing/
  - Mumbai price list: https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonRekognition/current/ap-south-1/index.json
- sync.so (direct):
  - Pricing: https://sync.so/pricing
  - Models: https://sync.so/docs/models
- Google Cloud Vision:
  - OCR: https://docs.cloud.google.com/vision/docs/ocr
  - Pricing: https://cloud.google.com/vision/pricing
  - Data usage: https://docs.cloud.google.com/vision/docs/data-usage
  - Quotas: https://docs.cloud.google.com/vision/quotas
- Recraft:
  - Docs: https://www.recraft.ai/docs
  - Pricing: https://www.recraft.ai/docs/api-reference/pricing
  - Endpoints: https://www.recraft.ai/docs/api-reference/endpoints
  - Limits: https://www.recraft.ai/docs/api-reference/appendix
  - Data use: https://www.recraft.ai/docs/trust-and-security/data-use-and-model-training.md
- Black Forest Labs:
  - Generating images: https://docs.bfl.ai/quick_start/generating_images
  - Pricing: https://docs.bfl.ai/quick_start/pricing
  - FLUX.2 overview: https://docs.bfl.ai/flux_2/flux2_overview
  - Image editing: https://docs.bfl.ai/flux_2/flux2_image_editing
  - Privacy policy (revised 1 Aug 2026): https://bfl.ai/legal/privacy-policy
- Topaz:
  - Pricing: https://developer.topazlabs.com/getting-started/pricing
  - Astra: https://developer.topazlabs.com/video-models/astra.md
  - Enhance API prices: https://www.topazlabs.com/enhance-api
  - fal Astra: https://fal.ai/models/topaz/upscale/video/creative
  - fal video upscale: https://fal.ai/models/fal-ai/topaz/upscale/video
- AWS SDK settings reference (the `AWS_*` names): https://docs.aws.amazon.com/sdkref/latest/guide/settings-reference.html
- DPDP: the Act (2023) and the DPDP Rules 2025, phased dates from secondary summaries. Counsel to confirm against the Gazette.
