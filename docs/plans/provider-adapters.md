# Provider adapters as registry tools: Runway, Sarvam, sync.so, AWS Rekognition (plan, 14 Oct)

The owner asked for this on 14 Oct: plans first, no paid calls. This plan was read from release/1 at 890d559c. The providers' public pages were read on 14 Oct 2026; the links are at the end.

**No provider API was called while writing this,** not even a free one, and no key was used. **Every price below is a sample / proposal.** The owner approves every rate-card row. Screens are not specified here: anything a person will see **waits for Claude Design / v18**.

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
- **Switches:** each provider gets a `<VENDOR>_ENABLED=1` switch, off by default, like `HF_SOUL_CHARACTER_ENABLED` (`lib/vendorRates.ts:16-18`). It stays **off in production**. The owner turns it on in the house workspace for one paid qualification run, after a yes (rule 1).
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

## 1. Runway

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
| Proposed env names | `RUNWAY_API_KEY` (the name SOW §5.1 already uses), `RUNWAY_BASE_URL`, `RUNWAY_ENABLED` |
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
  - That would put customers' faces and footage into a vendor's training set. **The plan recommends no customer workspace uses Runway until the owner has Enterprise terms, or written confirmation, that excludes training.**
- **The terms require "Powered by Runway"** to be shown prominently, with a link, in apps that reach end users. That is a screen element: it **waits for Claude Design / v18**, and the owner decides.
- **Act-Two processes two people's faces:** the character and the performer. Both need a consent record that covers the face.
- **After the output is copied, the plan proposes `DELETE /v1/tasks/{id}`,** so the vendor keeps as little as possible (owner question 7).

### Failure and refunds
- A `FAILED` or `CANCELLED` task with `cost.credits = 0` settles at 0 and reads "Nothing billed". This is new `BASIS` evidence: the task's reported cost.
- A failed task that Runway did charge settles at that cost, and the take says what it cost (rule 14).
- `THROTTLED` means queued at Runway. The take waits and says so; it is not a failure.

### Risks
- The training licence and the "Powered by Runway" clause (above).
- Low tier-1 limits until credit is bought.
- The product moves fast: `gen4_aleph` was replaced within months. Model ids must be checked again before each PR.
- A new US data transfer for customers in India (see §4, DPDP).

---

## 2. Sarvam

### What it adds
- **Indian-language speech (text to speech).** Bulbul v3 and v4-flash read 11 languages, including mixed English and Indian-language text. The voices are built for Indian speech, beside ElevenLabs (in use).
- **Indian-language transcription (speech to text),** in Saaras v4. Particl transcribes with Grok today (`lib/transcription.ts`; owner, 23 Sep: "Grok APIs wherever possible"). Sarvam would be the engine for Indian languages where it does better.
- **Translation** of scripts, captions and dub lines between English and 22 Indian languages (`sarvam-translate:v1`; `mayura:v1` for 11 of them with colloquial modes). Today "a language of a finished cut … translated on-screen text has no path" (`lib/v12/unpriced.ts:73-74`).

### The API
| | |
|---|---|
| Base URL | `https://api.sarvam.ai` |
| Auth | header `api-subscription-key` |
| Proposed env names | `SARVAM_API_KEY`, `SARVAM_BASE_URL`, `SARVAM_ENABLED`, plus the INR-to-dollar rate the owner sets (owner question 4) |
| Endpoints | `POST /text-to-speech` (JSON; returns base64 audio); `POST /speech-to-text` (multipart; for clips under about 30 s); batch transcription: `POST /speech-to-text/job/v1`, `GET /speech-to-text/job/v1/{job_id}/status`, `POST /speech-to-text/job/v1/download-files`; `POST /translate` (JSON) |
| Async | Speech, short transcripts and translation answer at once. Batch transcription is a job: poll, or take a callback (`X-SARVAM-JOB-CALLBACK-TOKEN`; the reply must be 200 within 30 s; status only). |
| Limits | Speech: 2,500 characters a request on v3 and v4-flash. Translation: 2,000 characters on `sarvam-translate:v1`, 1,000 on `mayura:v1`. Batch transcription: files up to 2 hours, 20 a job, diarization up to 20 speakers. Rate limits on the Starter plan: 60 a minute (30 for Bulbul v3); higher on Pro and Business. |
| Billing | In rupees, against prepaid credit (₹100 free on sign-up). |
| Region and law | "We process and store information in India", and may transfer it abroad. Indian law, Bengaluru courts. |
| Retention | Set by the org Owner, from 0 days to 24 months. **Until set, data is kept indefinitely.** Zero retention is available for the model APIs. |
| Training | "Subject to your consent, which you may decline or withdraw." |

### The tools
| Tool | Kind | Inputs | Output | Who may call | Gate |
|---|---|---|---|---|---|
| `sarvam_speech` | engine (audio task `speech`) | text (split server-side at 2,500 characters), language, a stock voice, model, pace | an audio take | anyone may prepare; a person approves | paid; stock voices only (owner question 5) |
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
- **Voice is personal data.** Stock voices raise no consent question for the speaker. **Voice cloning is not proposed:** it needs a consent record that covers the voice, for a new use (owner question 5).
- **A transcript of a real person's speech is their personal data,** and so is a translation of what they said. Both stay in the workspace's database only.
- **Set Sarvam's retention to 0 days** for the model APIs before any customer use. This is an org-Owner setting in Sarvam's console (owner action).
- **Sarvam's terms §10.5(d) forbid "providing access to the APIs … to third parties"** unless product terms allow it. Particl's customers would be reaching Sarvam through Particl. **Counsel should confirm a platform may offer it,** or the owner should get it in writing.
- **Data stays in India by default,** which suits DPDP better than a US vendor. Sarvam names itself a Data Fiduciary for its own users; for our customers it would act as our processor. That needs a processing agreement.

### Failure and refunds
- Errors (400, 403, 422, 429, 500) are answered at once. Sarvam's docs fetched here say nothing about billing a failed call, so `BASIS` reads `unknown` until Sarvam confirms in writing.
  - **Until then, a failure is settled at 0 and says "Nothing billed".** The platform absorbs any charge, using the meter's existing `unbilled` flag (`lib/meter.ts:54-59`).
- A long text split into several calls that fails partway settles at the parts that succeeded. Nothing is charged for the part that failed.

### Risks
- Rupee billing against dollar rates: the exchange rate moves. Quote with the owner's rate; the margin covers small moves (owner question 4).
- Retention is indefinite until the setting is changed.
- The resale clause.
- Low Starter limits (30 to 60 a minute).

---

## 3. sync.so (lip-sync)

### What it adds
- **Lip-sync:** a clip plus a voice track gives the clip with the mouth matched to the words. Today Particl has no lip-sync engine (`lib/v12/unpriced.ts:17-21`; `lib/v12/make.ts:229`). It is needed for dubbing a cut into another language (with ElevenLabs or Sarvam speech), and for ads with a presenter.

### Two doors to the same model (owner question 3)
- **Through fal** (`fal-ai/sync-lipsync/v2` and `/v2/pro`). This is what SOW 4 Oct §5.1 already lists, on `FAL_KEY`, which is in use. It needs no new vendor, key or contract. It reuses the fal adapter, queue, cancel and recovery (`lib/engines/fal.ts`). Price: $3 a minute (lipsync-2), $5 a minute (pro).
- **Direct** (`https://api.sync.so`, header `x-api-key`). Proposed env: `SYNC_API_KEY`, `SYNC_BASE_URL`, `SYNC_ENABLED`. It adds the newer `sync-3`, segments, active-speaker detection, signed webhooks and per-plan discounts (lipsync-2 is $0.04 to $0.05 a second by plan; pro is $0.067 to $0.083).
  - Endpoints: `POST /v2/generate`, `GET /v2/generate/{id}`, `POST /v2/generations/estimate`, `DELETE /v2/generations/{id}`, `POST /v2/assets/upload`.
  - Statuses: `PENDING`, `PROCESSING`, `COMPLETED`, `FAILED`, `REJECTED`.
  - Webhooks: signed with `Sync-Signature`.
  - Input length: 1 minute on the Hobbyist plan, up to 30 minutes on Scale+.
- **Recommended: fal first.** Go direct only if the owner wants sync-3, or the volume discount.

### The tool
| Tool | Kind | Inputs | Output | Who may call | Gate |
|---|---|---|---|---|---|
| `lip_sync` | engine (a new video task `lipsync`) | a clip (a take or upload from this workspace), a voice track (a take, an upload, or a speech take), model `lipsync-2` or `lipsync-2-pro`, what to do when lengths differ (`cut_off`, `loop`, `bounce`, `silence`, `remap`) | a video take, linked to both sources | anyone may prepare; a person approves | paid; **a live consent record for the face in the clip and, if the voice is a real person's (not a stock voice), for the voice** |

### Prices (sample / proposal; billed on output length)
| Row | Vendor's public price (fal) | Sells at (sample) |
|---|---|---|
| Lip-sync, 5 s | $3 a minute | 4 cr |
| Lip-sync, 30 s | | 23 cr |
| Lip-sync, 60 s | | 45 cr |
| Lip-sync Pro, 5 s | $5 a minute | 7 cr |
| Lip-sync Pro, 30 s | | 38 cr |
| Lip-sync Pro, 60 s | | 75 cr |

### Privacy and law (for counsel)
- **Lip-sync changes what a real person appears to say.** That is the clearest deep-fake risk in this plan. It needs a consent record covering the face, for the use it is made for (`production`, `ads` or `social`). A voice that is not a stock voice needs a record covering the voice as well.
- **sync.so's own privacy policy (effective 27 May 2024) says personal information may be used for "developing, training, and fine-tuning" its models.** It states no opt-out. Data is handled in the United States. Going through fal puts fal's terms in between; **counsel should read both** before customer use.
- **After the output is copied:** on the direct route, `DELETE /v2/generations/{id}` (allowed only once a job has finished). On fal, the existing behaviour applies.

### Failure and refunds
- fal: "server errors (HTTP 500+) are never charged" (`lib/providerOutcome.ts` `fal-5xx`). Other failures read `unknown` and settle at 0, absorbed by the platform, until fal or sync says otherwise.
- Direct: sync.so's billing page does not say whether failed or `REJECTED` jobs are billed. Same rule: settle at 0, absorb, "Nothing billed".
- A cancel is only possible once the job has finished, so a running lip-sync cannot be stopped (docs/redesign/app-map.md:409).

### Risks
- Misuse for putting words in a real person's mouth (the consent gate above).
- Quality falls with several faces in the frame.
- The vendor's training clause.

---

## 4. AWS Rekognition (face checks for identity and consent)

### What it adds
- **"Same face":** a score for whether the person in a take is the cast member they should be. It becomes one more score inside the identity check that Verify already makes (`lib/workbench/verify.ts:25`, checks identity, wardrobe, environment, props, artifacts), as the handover planned (docs/handover-2026-10-05.md:1213).
- **A face check on references before training.** Is there exactly one usable face in each photo? This catches bad uploads before a training run is paid for.
- **What it is not:** it does not identify who someone is, it keeps no face collection, and it never searches a database of faces.

### The API
| | |
|---|---|
| Region | Asia Pacific (Mumbai), `ap-south-1`; endpoint `rekognition.ap-south-1.amazonaws.com` |
| Auth | AWS Signature Version 4, with an IAM user allowed only `rekognition:CompareFaces` and `rekognition:DetectFaces` |
| Proposed env names | `AWS_REKOGNITION_REGION`, `AWS_REKOGNITION_ACCESS_KEY_ID`, `AWS_REKOGNITION_SECRET_ACCESS_KEY`, `FACE_CHECK_ENABLED`. They are deliberately not the generic `AWS_*` names, so the SDK can never pick up the storage keys (`R2_*`, `lib/storage/r2.ts`) or any other AWS credentials by accident. |
| Endpoints | `CompareFaces` (the largest face in the source against up to 100 faces in the target); `DetectFaces` |
| Async | None. Both answer at once. |
| Inputs | PNG or JPEG bytes, at most 5 MB (15 MB from S3, which we do not use). At least 80 px a side. A face must be at least 40×40 px in a 1920×1080 image. |
| Limits | 25 calls a second for each of `CompareFaces` and `DetectFaces` in Mumbai (default). |
| Storage at AWS | "This is a stateless API operation. That is, data returned by this operation doesn't persist." No face collection is created. The Rekognition FAQ says inputs "may" be stored and used to improve the service **unless the account opts out** through an AWS Organizations AI-services opt-out policy. |

- **Library choice:** either add `@aws-sdk/client-rekognition`, from the same family as the `@aws-sdk/client-s3` already used, or sign the request with the SigV4 header signing already in `lib/storage/r2.ts:115-116` (`signRequest`). The PR chooses; fewer new dependencies is better.

### The tools
| Tool | Kind | Inputs | Output | Who may call | Gate |
|---|---|---|---|---|---|
| `face_check` | app action, priced inside Verify | a take (its three review frames for a clip, `lib/workbench/verify.ts:39`; one frame for a still) and up to 5 cast masters that are real people | for each master: the best similarity (0 to 100), faces found, pass or fail against the workspace's threshold | anyone, as part of a Verify step the person approved | **a live consent record covering the face, for each master**; without one, that master is skipped and says "Needs consent" |
| `face_detect` | app action | a reference photo from this workspace | the number of faces, each face's size, sharpness and brightness | anyone | the same consent rule, when the photo is of a real person |
| `record_face_consent` | app action (exists: `recordConsent`, `lib/security/consent.ts:159`) | the person, face and/or voice, the uses, an expiry date, a recording | a consent record | **people only.** Atomik and outside agents may prepare it; they never record it (rule 11). | — |

- **Threshold:** a workspace setting that only an admin changes, with a platform-layer default (rule 3). AWS's default is 80. The plan proposes 90 for "same face" (owner question 8).
- **AWS's own advice:** before acting on a result that affects a person, a human should review it. So a low score marks the take for a person to look at. It never blocks or deletes anything by itself.
- **Stored:** the scores, in the take's existing `take_verifications` row (`lib/workbench/verify-server.ts:23`). No frames, face crops or face vectors are kept beyond what the take already is.

### Prices (sample / proposal)
| Row | Vendor's public price (Mumbai, first million images a month; AWS price list published 11 Sep 2026) | Sells at (sample) |
|---|---|---|
| Face check, a still against 1 master | $0.00125 an image (one image per call; to be confirmed on the first bill) | 1 cr on its own |
| Face check, a clip (3 frames) against 1 master | 3 calls | 1 cr on its own |
| Face check, a clip against 5 masters | 15 calls | 1 cr on its own |
| Face detect, one photo | $0.00125 an image | 1 cr on its own |

- **Recommended:** add the face check's dollars to the Verify step's own quote **before rounding**, as "batches multiply before rounding" says (CLAUDE.md § Credits). The check then usually adds 0 or 1 cr to Verify, instead of being a separate 1 cr line (owner question 8).

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

## 5. PRs and order

**Recommended order:**
1. **sync via fal.** This fills a known gap (lip-sync has no engine) with no new vendor, and it is the fastest.
2. **Sarvam.** A new market strength, with data kept in India. It waits for counsel on the resale clause.
3. **Rekognition.** Small to build, but it waits for counsel on biometric consent and erasure.
4. **Runway.** Kept on standby, as SOW §5.1 says. It waits for training-free terms and the owner's word on "Powered by Runway".

Each provider's adapter ships **behind its switch, off in production.** None needs board UI to land. Every screen **waits for Claude Design / v18**.

| # | PR | Size | Review | After |
|---|---|---|---|---|
| Y1 | Lip-sync through fal: model rows `fal-ai/sync-lipsync/v2` and `/v2/pro`, a new task `lipsync`, `BASIS` lines, mocks | S, 4h | Opus (money) | — |
| Y2 | `lip_sync` tool: consent gate (face, and voice if not a stock voice), source links, MCP | M, 6h | **Opus (privacy)** | Y1 |
| Y3 | Lip-sync rate rows | S, 2h | **NEEDS AKSHAY (prices)** | Y1 |
| Y4 | One paid qualification run in the house workspace (about $0.70: one 5 s run of each model) | — | **NEEDS AKSHAY (spend)** | Y2, Y3 |
| S1 | Sarvam adapter: speech, short transcripts and translation (answered at once), batch transcription (polled), `SARVAM_ENABLED` off, rupee rates and the exchange-rate setting, mocks | M, 8h | **Opus (money)** | counsel on §10.5(d) |
| S2 | `sarvam_speech` (stock voices) | S, 4h | — | S1 |
| S3 | `sarvam_translate` | S, 3h | — | S1 |
| S4 | `sarvam_transcribe`, with Auto choosing it by language | M, 6h | Opus (privacy) | S1 |
| S5 | Sarvam rate rows; qualification run (about ₹4, inside the free ₹100) | S, 2h | **NEEDS AKSHAY** | S2-S4 |
| K1 | Rekognition adapter: SigV4, Mumbai, `FACE_CHECK_ENABLED` off, mocks | S, 4h | — | AWS account set up |
| K2 | Consent gate for face checks (any new use word, after counsel); `record_face_consent` as a people-only tool | S, 4h | **Opus (privacy)**, NEEDS AKSHAY | counsel |
| K3 | `face_check` inside Verify: priced into its quote, threshold setting, scores in `take_verifications` | M, 6h | **Opus (privacy, money)** | K1, K2 |
| K4 | `face_detect` on references before training | S, 3h | Opus (privacy) | K2 |
| K5 | Qualification run (about 10 calls, $0.0125, or inside AWS's free tier) | — | **NEEDS AKSHAY** | K3 |
| R1 | Runway adapter: uploads, poll, settle at the reported cost, `THROTTLED`, `BASIS`, `RUNWAY_ENABLED` off, mocks | M, 8h | **Opus (money)** | training-free terms |
| R2 | Model and rate rows `act_two`, `aleph2`, `gen4.5`, `gen4_turbo` | S, 3h | **NEEDS AKSHAY (prices)** | R1 |
| R3 | `runway_performance` (task `motion`), consent for both faces | M, 6h | **Opus (privacy)** | R2 |
| R4 | `runway_edit` (`aleph2`, task `edit`) | S, 4h | — | R2 |
| R5 | Qualification run (about $1.41: Act-Two 5 s, Aleph 2 at 2 s, Gen-4.5 5 s) | — | **NEEDS AKSHAY (spend)** | R3, R4 |

**About 100 hours in total.** No PR here changes a migration-guarded table. The one schema change is in K2, and only if counsel asks for a new kind of consent record rather than a new use word. If so, it ships after the owner's backup.

**Guard tests: added to, never weakened.**
- `tests/unit/bundle.spec.ts`: new vendor rates stay off the browser.
- `tests/unit/noVendorCostToCustomers.spec.ts`: no rupee or dollar vendor figure reaches a customer.
- `tests/unit/signinRetiredGuard.spec.ts` and `signinOffRelease1.spec.ts`: untouched. Nothing here uses any sign-in.
- The people-only tests: `record_face_consent` refuses Atomik and tokens.
- `tests/unit/engines.spec.ts:6`: "every provider has an adapter, and the adapters estimate what the catalogue says". Each new adapter must pass it.

## 6. What needs the owner
- **Accounts and keys** (put into the server's settings by the owner; never by an agent, and never in the repo):
  - **Runway:** a developer organisation and credit (tier 1 caps spend at $100 a month); `RUNWAY_API_KEY`.
  - **Sarvam:** an account, retention set to 0 days, and the plan tier; `SARVAM_API_KEY`.
  - **sync.so:** nothing if we go through fal. If direct: an account and `SYNC_API_KEY`.
  - **AWS:** an account under AWS Organizations with the AI-services opt-out policy, and an IAM user limited to the two calls in `ap-south-1`; the `AWS_REKOGNITION_*` settings.
- **Prices:** every rate row above, and the rupee-to-dollar rate for Sarvam.
- **Contracts:** Runway Enterprise terms (no training on inputs); a processing agreement with Sarvam and written permission to offer it through a platform; sync.so's terms (and fal's) on training; AWS's standard data processing terms, which come with the account.
- **Counsel:** biometric consent wording, erasure versus never-delete, and DPDP roles and timing.
- **Screens** (waits for Claude Design / v18): "Powered by Runway"; the consent prompt for face checks and lip-sync; showing the face score; picking a language and voice.
- **Each qualification run:** a yes, at the stated cost, in the house workspace only.

## 7. Owner questions (with recommendations)
1. **Order.** **Recommended:** sync via fal, then Sarvam, then Rekognition, then Runway (standby).
2. **Runway and training.** Use Runway for customers only under terms that exclude training on their inputs? **Recommended: yes.** Until then, Runway runs in the house workspace only.
3. **Lip-sync through fal or sync.so directly?** **Recommended: fal**, with no new vendor. Go direct later for sync-3 or volume.
4. **The rupee rate for Sarvam:** a fixed rate the owner updates, or a weekly published rate? **Recommended:** a fixed rate in the server's settings, reviewed monthly by the owner.
5. **Voice cloning (Sarvam or ElevenLabs):** not now? **Recommended: not now.** Stock voices only, until counsel approves the voice-consent wording.
6. **Transcripts:** Sarvam for Indian languages, and Grok for the rest? **Recommended: yes,** chosen by Auto from the language (rule 13).
7. **Vendor copies:** delete the vendor's copy of each job once we have stored it (Runway `DELETE /v1/tasks/{id}`, sync.so `DELETE /v2/generations/{id}`, Sarvam retention 0)? **Recommended: yes.** It is the vendor's copy, not ours, so the never-delete rule is untouched.
8. **Face checks:** a 90 threshold, priced inside Verify (usually +0 or +1 cr)? **Recommended: yes**, and a low score marks the take for a person; it never blocks.
9. **Counsel** for: biometric consent wording; whether similarity scores must be erased when consent is withdrawn; Particl's DPDP role for a customer's cast; and transfers to US vendors. **Recommended: before any switch is turned on for a customer workspace.**

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
- DPDP: the Act (2023) and the DPDP Rules 2025, phased dates from secondary summaries. Counsel to confirm against the Gazette.
