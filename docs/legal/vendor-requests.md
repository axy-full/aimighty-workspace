# Requests to engine vendors for written data terms: DRAFTS, nothing sent

**Nothing here has been sent.** These are drafts for the owner to send from his own address; nobody else sends them. Draft 0.1, 15 Oct 2026. Owner request (15 Oct 22:00): request written no-training and no-retention terms from BytePlus, Google, OpenAI, ElevenLabs, Topaz, Bria and Runway.

Placeholders to fill: `[Your name]`, `[Company legal name]`, `[Account/organisation id]`, `[link to their current policy]`, `[address]`. No real id, key or address is in this file. Each email stands alone. Under each is a note outside the quote with what the record says and the code references (endpoints and models are from `release/1` at 663fb243, current on 15 Oct). The answers feed `privacy-policy.md` (sections 5 to 7), `licence-register.md` (A6) and `unknown-assets.md` (item 9).

Not drafted here: fal (Kling, Luma, Flux), BFL, xAI, Anthropic, Higgsfield, sync.so and Sarvam. The record already has: sync.so confirmed no training in writing (with company records); Sarvam retention set to 0 days; BFL training opt-out done (docs/redesign-plan.md, 15 Oct 13:45 and 14:25).

⚖ LAWYER L-V1: whether the requests should come from the company's legal contact, and where the replies are filed (DPDP Act processor terms, cross-border transfer notice, `privacy-policy.md` section 6).

## 1. BytePlus (Seedance / ModelArk)

**Send to:** BytePlus ModelArk sales or support [address].

**What the record already says:** BytePlus is on the live Privacy page as receiving prompts, reference images and clips for video. Nothing is recorded about training or retention. One retention fact is in the code: a Seedance 2.5 draft's task id can make its final for 7 days from when the vendor took it.

**Code and repo references (not for the email):** `lib/ark.ts` (host default `ark.ap-southeast.bytepluses.com`, tasks URL), `lib/models.ts:206, 230`, `lib/enhance.ts:59-66, 571-574` (prompt enhancement), `lib/draftFinal.ts:28`, docs/seedance-draft-final.md. Links already in the repo: the draft workflow https://docs.byteplus.com/en/docs/ModelArk/2607688 and the task API https://docs.byteplus.com/en/docs/ModelArk/1520757 (API docs, not a privacy policy).

**Draft email**

> Subject: Written data terms for our use of BytePlus ModelArk ([Account/organisation id])
>
> Hello,
>
> I am the owner of [Company legal name], which runs Particl, a production tool for film teams. Our account or organisation id is [Account/organisation id]. Our customers' prompts, images and media pass through your service, so we need your data terms in writing before we offer it more widely.
>
> **What we use:** Seedance 2.5 (`dreamina-seedance-2-5-260628`) and Seedance 2.0 (`dreamina-seedance-2-0-260128`) video generation, including draft mode, through the ModelArk API on the ap-southeast endpoint: `POST /api/v3/contents/generations/tasks` and `GET /api/v3/contents/generations/tasks/{id}`. Our inputs are prompts, reference images, reference clips and audio; outputs are video files. We also use ModelArk text for prompt enhancement: `POST /api/v3/chat/completions` with `dola-seed-2-1-turbo-260628` and `seed-2-0-pro-260328`, where the input is a customer's prompt and the output is a rewritten prompt.
>
> Please confirm in writing, for this account and these endpoints:
> 
> 1. **No training.** Our inputs and the outputs we get back are not used to train or improve your models, and are not shared for that purpose.
> 2. **Retention.** How long you keep inputs, outputs and logs, and whether a zero-retention option exists for our account.
> 3. **Location.** Where the data is processed and stored, and whether an India or EU region exists.
> 4. **Sub-processors.** The list of sub-processors that may see our data, and how we are told of changes.
> 5. **Deletion.** That you delete our data on request, and how long that takes.
> 6. **A data processing agreement** that we can sign.
>
> The policy pages we are reading are [link to their current policy]. If a different agreement applies to us, please send it.
>
> Please also tell us the retention window for a generation task and its input and output files (we rely on 7 days for a draft to make its final), whether the draft watermark is absent from the final, and whether an India or EU region exists.
>
> Please also confirm, for the same account, that our customers may use what is generated commercially, who owns the output, and any plan or agreement that depends on.
>
> A short written reply, or a link to the signed terms that apply to us, is enough. We will keep it with our records.
>
> Thank you,
> [Your name]
> [Company legal name]
> [Account/organisation id]

## 2. Google (Gemini API; Vertex AI if different)

**Send to:** Google Cloud sales or the Gemini API team [address].

**What the record already says:** Google is on the live Privacy page for prompts and reference images (stills, some of Atomik's writing). Gemini's four adjustable safety filters are set to BLOCK_NONE (owner, 14 Oct 21:00); Google's fixed filters stay. Image outputs always carry SynthID. Nothing is recorded about training or retention. Cloud Vision (text in images) is planned, key set, not live.

**Code and repo references (not for the email):** `lib/gemini.ts:36` (host `generativelanguage.googleapis.com`), `lib/models.ts:201-202, 424`, `lib/atomikModelPolicy.ts`, `lib/geminiSafety.ts`. The repo cites only Google's pricing page (ai.google.dev/gemini-api/docs/pricing, `lib/models.ts:422`). No Vertex AI use in the code.

**Draft email**

> Subject: Written data terms for our use of the Gemini API ([Account/organisation id])
>
> Hello,
>
> I am the owner of [Company legal name], which runs Particl, a production tool for film teams. Our account or organisation id is [Account/organisation id]. Our customers' prompts, images and media pass through your service, so we need your data terms in writing before we offer it more widely.
>
> **What we use:** The Gemini API (`generativelanguage.googleapis.com`): image models `gemini-3-pro-image` and `gemini-3.1-flash-image`, and text models such as `gemini-3.1-pro-preview` for writing and planning. Planned: Cloud Vision text detection. We do not use Vertex AI today; please say whether Vertex gives different data terms (training, region, retention) and what moving would take.
>
> Please confirm in writing, for this account and these endpoints:
> 
> 1. **No training.** Our inputs and the outputs we get back are not used to train or improve your models, and are not shared for that purpose.
> 2. **Retention.** How long you keep inputs, outputs and logs, and whether a zero-retention option exists for our account.
> 3. **Location.** Where the data is processed and stored, and whether an India or EU region exists.
> 4. **Sub-processors.** The list of sub-processors that may see our data, and how we are told of changes.
> 5. **Deletion.** That you delete our data on request, and how long that takes.
> 6. **A data processing agreement** that we can sign.
>
> The policy pages we are reading are [link to their current policy]. If a different agreement applies to us, please send it.
>
> Please also tell us whether our paid API usage is excluded from training and human review, what abuse-monitoring logging keeps and for how long, and whether SynthID is always applied to image outputs.
>
> Please also confirm, for the same account, that our customers may use what is generated commercially, who owns the output, and any plan or agreement that depends on.
>
> A short written reply, or a link to the signed terms that apply to us, is enough. We will keep it with our records.
>
> Thank you,
> [Your name]
> [Company legal name]
> [Account/organisation id]

## 3. OpenAI

**Send to:** OpenAI sales or support [address].

**What the record already says:** OpenAI is on the live Privacy page for prompts and reference images (stills, some of Atomik's writing). Nothing is recorded about training or retention.

**Code and repo references (not for the email):** `lib/openai-direct.ts:46, 54`, docs/openai-direct.md, `lib/vendorImages.ts:28-31`. The repo cites only OpenAI's image guide (`lib/providers.ts:193`).

**Draft email**

> Subject: Written data terms for our use of the OpenAI API ([Account/organisation id])
>
> Hello,
>
> I am the owner of [Company legal name], which runs Particl, a production tool for film teams. Our account or organisation id is [Account/organisation id]. Our customers' prompts, images and media pass through your service, so we need your data terms in writing before we offer it more widely.
>
> **What we use:** The OpenAI API (`api.openai.com`): `/v1/responses` and `/v1/chat/completions` for text, and `/v1/images/generations` and `/v1/images/edits` for the image models `gpt-image-2`, `gpt-image-2.5-flare`, `gpt-image-2.5-sunburst` and `gpt-image-1.5`. Our inputs are prompts, reference images and attached files; outputs are text and images.
>
> Please confirm in writing, for this account and these endpoints:
> 
> 1. **No training.** Our inputs and the outputs we get back are not used to train or improve your models, and are not shared for that purpose.
> 2. **Retention.** How long you keep inputs, outputs and logs, and whether a zero-retention option exists for our account.
> 3. **Location.** Where the data is processed and stored, and whether an India or EU region exists.
> 4. **Sub-processors.** The list of sub-processors that may see our data, and how we are told of changes.
> 5. **Deletion.** That you delete our data on request, and how long that takes.
> 6. **A data processing agreement** that we can sign.
>
> The policy pages we are reading are [link to their current policy]. If a different agreement applies to us, please send it.
>
> Please also tell us the standard retention for API requests and abuse-monitoring logs, whether zero data retention is available to our account and for which endpoints (images and responses), and the data-residency options.
>
> Please also confirm, for the same account, that our customers may use what is generated commercially, who owns the output, and any plan or agreement that depends on.
>
> A short written reply, or a link to the signed terms that apply to us, is enough. We will keep it with our records.
>
> Thank you,
> [Your name]
> [Company legal name]
> [Account/organisation id]

## 4. ElevenLabs

**Send to:** ElevenLabs sales or support [address].

**What the record already says:** ElevenLabs is on the live Privacy page for scripts and audio (speech, sound effects, music, dubbing). Its speech to text is the choice for transcripts outside Indian languages (owner, 14 Oct 20:40, item 7F). Voice cloning is not offered now (owner, 14 Oct evening). Nothing is recorded about training or retention.

**Code and repo references (not for the email):** `lib/elevenlabs.ts` (endpoints at lines 315-669), `lib/dubbing.ts:39`. The repo cites only the API reference (`lib/providers.ts:118`).

**Draft email**

> Subject: Written data terms for our use of the ElevenLabs API ([Account/organisation id])
>
> Hello,
>
> I am the owner of [Company legal name], which runs Particl, a production tool for film teams. Our account or organisation id is [Account/organisation id]. Our customers' prompts, images and media pass through your service, so we need your data terms in writing before we offer it more widely.
>
> **What we use:** The ElevenLabs API (`api.elevenlabs.io`): `/v1/text-to-speech`, `/v1/text-to-dialogue`, `/v1/sound-generation`, `/v1/music`, `/v1/speech-to-speech`, `/v1/dubbing` and `/v1/voices`, with the models `eleven_v3`, `eleven_music`, `eleven_sfx`, `eleven_multilingual_v2`, `eleven_flash_v2_5`, `eleven_turbo_v2_5`, `eleven_text_to_sound_v2` and `eleven_multilingual_sts_v2`. Our inputs are scripts and our customers' audio and video; outputs are audio.
>
> Please confirm in writing, for this account and these endpoints:
> 
> 1. **No training.** Our inputs and the outputs we get back are not used to train or improve your models, and are not shared for that purpose.
> 2. **Retention.** How long you keep inputs, outputs and logs, and whether a zero-retention option exists for our account.
> 3. **Location.** Where the data is processed and stored, and whether an India or EU region exists.
> 4. **Sub-processors.** The list of sub-processors that may see our data, and how we are told of changes.
> 5. **Deletion.** That you delete our data on request, and how long that takes.
> 6. **A data processing agreement** that we can sign.
>
> The policy pages we are reading are [link to their current policy]. If a different agreement applies to us, please send it.
>
> Please also tell us which plan or agreement we need for commercial use of generated audio in our customers' work, whether zero-retention mode is available on the API and on which endpoints (dubbing in particular). [OWNER: drop the next sentence? Voice cloning is "not now"; it is only a hypothetical.] If we ever add voice cloning with consent records, how would voice data be treated?
>
> Please also confirm, for the same account, that our customers may use what is generated commercially, who owns the output, and any plan or agreement that depends on.
>
> A short written reply, or a link to the signed terms that apply to us, is enough. We will keep it with our records.
>
> Thank you,
> [Your name]
> [Company legal name]
> [Account/organisation id]

## 5. Topaz Labs

**Send to:** Topaz Labs API team [address].

**What the record already says:** Asked, not yet answered. Owner, 15 Oct 14:05: "confirm Topaz doesn't train on our uploads and how long it keeps files; delete the vendor's copy after we store the output". Topaz goes direct (TOPAZ_API_KEY set; adapter not built); until then it runs through fal.

**Code and repo references (not for the email):** `lib/topaz.ts:2`, `lib/astra.ts:1`, `lib/vendorRates.ts:132, 152-153`, docs/topaz-image-upscale.md, docs/astra-video-upscale.md. The repo cites fal's Topaz model page (fal.ai/models/fal-ai/topaz/upscale/image, `lib/vendorRates.ts:152`), not a Topaz policy.

**Draft email**

> Subject: Written data terms for our use of the Topaz Labs API ([Account/organisation id])
>
> Hello,
>
> I am the owner of [Company legal name], which runs Particl, a production tool for film teams. Our account or organisation id is [Account/organisation id]. Our customers' prompts, images and media pass through your service, so we need your data terms in writing before we offer it more widely.
>
> **What we use:** Image upscaling (presets Standard V2, High Fidelity V2, Low Resolution V2, CGI and Text Refine) and creative video upscaling, today through fal's hosted endpoints `fal-ai/topaz/upscale/image` and `topaz/upscale/video/creative`. We are evaluating calling your own API directly for both.
>
> Please confirm in writing, for this account and these endpoints:
> 
> 1. **No training.** Our inputs and the outputs we get back are not used to train or improve your models, and are not shared for that purpose.
> 2. **Retention.** How long you keep inputs, outputs and logs, and whether a zero-retention option exists for our account.
> 3. **Location.** Where the data is processed and stored, and whether an India or EU region exists.
> 4. **Sub-processors.** The list of sub-processors that may see our data, and how we are told of changes.
> 5. **Deletion.** That you delete our data on request, and how long that takes.
> 6. **A data processing agreement** that we can sign.
>
> The policy pages we are reading are [link to their current policy]. If a different agreement applies to us, please send it.
>
> Please also tell us whether the answers are the same when the work is routed through fal as when we call your API directly, and whether you delete your copy of our inputs and outputs once the output has been delivered and stored on our side (our rule for every vendor).
>
> Please also confirm, for the same account, that our customers may use what is generated commercially, who owns the output, and any plan or agreement that depends on.
>
> A short written reply, or a link to the signed terms that apply to us, is enough. We will keep it with our records.
>
> Thank you,
> [Your name]
> [Company legal name]
> [Account/organisation id]

## 6. Bria

**Send to:** Bria sales or support [address].

**What the record already says:** Nothing is recorded about Bria's data or output terms. It runs through fal (cut-out and outpaint, in use per docs/particl-sow-2026-10-04.md); "fal then keeps only Kling, Bria and Luma reframe" once Topaz leaves (owner, 15 Oct 14:05).

**Code and repo references (not for the email):** `lib/stillTools.ts:14-32`, `lib/vendorRates.ts:154, 161`, `lib/falImage.ts:14`. The repo cites fal's model pages only.

**Draft email**

> Subject: Written data and output terms for your models used through fal
>
> Hello,
>
> I am the owner of [Company legal name], which runs Particl, a production tool for film teams. We use two of your models through fal, which hosts them; we have no account with you directly. Our customers' still images go through those models, so we need your data and output terms in writing before we offer them more widely.
>
> **What we use:** Background removal `fal-ai/bria/background/remove` (our "Cut out") and expand `fal-ai/bria/expand` (our "Outpaint"), called through fal. Our inputs are our customers' still images; outputs are images (a transparent PNG; an extended canvas).
>
> Please confirm in writing, for our use of these models through fal and for a direct account if we opened one:
> 
> 1. **No training.** Our inputs and the outputs we get back are not used to train or improve your models, and are not shared for that purpose.
> 2. **Retention.** How long you keep inputs, outputs and logs, and whether a zero-retention option exists for our account.
> 3. **Location.** Where the data is processed and stored, and whether an India or EU region exists.
> 4. **Sub-processors.** The list of sub-processors that may see our data, and how we are told of changes.
> 5. **Deletion.** That you delete our data on request, and how long that takes.
> 6. **A data processing agreement** that we can sign.
>
> The policy pages we are reading are [link to their current policy]. If a different agreement applies to us, please send it.
>
> Please also tell us whether the terms differ when the models are called through fal or directly, whether we need a licence from you for output our customers use commercially, and whether a direct API is available.
>
> Please also confirm, for the same account, that our customers may use what is generated commercially, who owns the output, and any plan or agreement that depends on.
>
> A short written reply, or a link to the signed terms that apply to us, is enough. We will keep it with our records.
>
> Thank you,
> [Your name]
> [Company legal name]

## 7. Runway

**Send to:** Runway sales or enterprise team [address].

**What the record already says:** Standby engine, "house only until training-free terms" (owner, 14 Oct evening, item 6; 19:29 IST amendment). Not in the code on `release/1` and not offered to customers. Same data rule as sync.so and Topaz: delete the vendor's copy after we store the output (owner, 15 Oct 14:05).

**Code and repo references (not for the email):** No code and no policy page in the repo. Fill the model or endpoint names before sending.

**Draft email**

> Subject: Written data terms before we evaluate Runway's API
>
> Hello,
>
> I am the owner of [Company legal name], which runs Particl, a production tool for film teams. We are evaluating your API as a possible video engine. We have not integrated it and have sent you no data. Before we do, we need your data terms in writing.
>
> **What we use:** Your API for video generation, as a standby engine; we have not integrated it. [Name the model or endpoint we would use, for example the current generation model and any video-to-video or lip-sync endpoint.] Our inputs would be prompts, reference images and clips; outputs would be video.
>
> Please confirm in writing, for an API account like the one we would open:
> 
> 1. **No training.** Our inputs and the outputs we get back are not used to train or improve your models, and are not shared for that purpose.
> 2. **Retention.** How long you keep inputs, outputs and logs, and whether a zero-retention option exists for our account.
> 3. **Location.** Where the data is processed and stored, and whether an India or EU region exists.
> 4. **Sub-processors.** The list of sub-processors that may see our data, and how we are told of changes.
> 5. **Deletion.** That you delete our data on request, and how long that takes.
> 6. **A data processing agreement** that we can sign.
>
> The policy pages we are reading are [link to their current policy]. If a different agreement applies to us, please send it.
>
> Please also tell us the plan or agreement under which you commit in writing to not training on API inputs or outputs; we will not offer the engine to our customers without it.
>
> Please also confirm, for the same account, that our customers may use what is generated commercially, who owns the output, and any plan or agreement that depends on.
>
> A short written reply, or a link to the signed terms that apply to us, is enough. We will keep it with our records.
>
> Thank you,
> [Your name]
> [Company legal name]
