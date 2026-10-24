# Privacy Policy: DRAFT for the owner's lawyer

Draft 0.1, 15 Oct 2026. Not live. The live page is `app/(app)/privacy/page.tsx` ("Privacy & retention", 11 Oct 2026); this draft starts from it. Tags and decision ids are explained in `README.md`.

## 1. Who is responsible

[COMPANY] (see OD-G1) decides why and how your account data is used. For the work a workspace puts in (prompts, references, photos, cast, voices), the workspace's owner decides what goes in, and we run the service for them.
[OWNER DECISION OD-P1: our role for a customer's cast and other people's data in a workspace. Options: (a) we are the fiduciary for everything; (b) we are the fiduciary for account data and a processor for workspace content; (c) the lawyer advises.]
⚖ LAWYER L-P1: Particl's DPDP Act role (Data Fiduciary or Processor) for a customer's cast and uploads [D10 counsel list], notice and consent for each, and whether a Significant Data Fiduciary duty could ever apply.

## 2. What we keep

- **Account:** name, email, password hash; the 18+ confirmation with its date [D1]; Google sign-in details if you use it.
- **Work:** prompts, references, takes and their masters, cast and identities, shots and projects.
- **Records:** what was billed, in credits, and the engine's cost behind it, for our own books.
- **Reports:** what a person sends at /report: a link or take id, what is wrong, and an email if they give one; a salted hash of the sender's IP address (used to limit repeat reports); and, if they are signed in, their account and workspace ids.
- **Technical logs**, for a short while, to find faults. The product also records timings and ids (for example the time to a first render and where people stop), never prompt text [CLAUDE.md, rule 17].
- **Faces and voices:** photos for an identity, voice recordings, and the permission record (a tick and an optional permission file, stored with the asset and never checked automatically; see section 4).
- **Payments:** when online billing is live, the payment processor holds card details; we keep the invoice record. Planned.
[OWNER DECISION OD-P2: how long technical logs are kept. The live page says "a short while".]

## 3. Why

To run the service you asked for; to bill; to keep it safe; to answer reports; to follow the law. We do not sell data. Particl does not train on your content; the providers that receive it may, under their own policies (sections 5 and 6) [D5].
⚖ LAWYER L-P2: the lawful purposes and the notice and consent text the DPDP Act needs for each; "legitimate uses" we may rely on; a consent manager; withdrawal.

## 4. Faces, voices and other special data

Training an identity uses photos of a real person; you tick that you have the person's permission when you upload them [D3, D19]. Voice work sends audio to the engines named below. Voice cloning is not offered now [D10]. **No face matching or biometric check is used** (owner's decision, 16 Oct 2026: no face matching anywhere), so no similarity score or face template is made or kept. On an upload of a real person you tick "I have this person's permission" and may attach a permission file (NOC); both are stored with the asset and never checked automatically. Any likeness in generated content is the responsibility of the person generating it (Terms section 6).
[OWNER DECISION OD-P3: what happens to a stored permission tick and file when the person withdraws permission. Options: (a) hide the asset and keep the record; (b) erase on request; (c) keep and say so.]
⚖ LAWYER L-P3: face and voice data held as photos and recordings (whether any is sensitive or special data under Indian law (the DPDP Act has no separate sensitive class; check the IT Act's SPDI rules still in force), consent wording, withdrawal, retention, and transfer to US vendors) [D10, D19].

## 5. Who receives data (vendors)

Each vendor gets only what it needs to do its job, and goes straight to that vendor (no AI gateway or relay in between) [D11; live Privacy page]. Every provider below is named with a link to its own privacy policy; the links are placeholders for the owner to fill from each provider's own page. "Live" means named on the live Privacy page or in production use in the record; "Planned" means decided in the record (owner, 15 Oct 22:15, the final engine stack) and not yet merged or switched on. A one-page table of what each receives, how long it keeps it and what it does about training is in `where-your-data-goes.md`.

| Vendor | What it does for us | What it receives | Status | Its privacy policy |
|---|---|---|---|---|
| Turso | Databases: one per workspace and one platform database | All workspace records except files; account and billing records | Live | [link to Turso privacy policy] |
| Cloudflare R2 | Private file storage (masters, uploads, identity photos) under each workspace's own prefix, reached by short-lived signed links | Your files | Live | [link to Cloudflare privacy policy] |
| Cloudflare | DNS | Domain lookups | Live | [link to Cloudflare privacy policy] |
| DigitalOcean | The server we run Particl on (droplet in Bangalore, BLR1) | Everything the app handles, in transit and at rest | Live | [link to DigitalOcean privacy policy] |
| Vercel | Older files still in Vercel Blob (to be moved; read-only for 30 days after the cutover, then deleted only with the owner's yes); 3D (Astra) renders run on Vercel Sandbox until our own workers are live | Older stored files; the scene and assets of a 3D render | Live, leaving | [link to Vercel privacy policy] |
| Resend | Email | Your email address, for sign-in and invites | Live | [link to Resend privacy policy] |
| Inngest | Background jobs | Identifiers of work to run, not prompts | Live | [link to Inngest privacy policy] |
| Liveblocks | Live team editing on a shared board | Board content shared in a live session | Live | [link to Liveblocks privacy policy] |
| Google (sign-in) | Sign in with Google | Your Google account identifier and email | Live, but still in Google's Testing mode until the owner publishes it | [link to Google privacy policy] |
| Stripe | Card payments | Billing details; card data goes to Stripe | Planned (not live) | [link to Stripe privacy policy] |
| Anthropic | Atomik's writing and planning | Your words to Atomik and files attached | Live | [link to Anthropic privacy policy] |
| OpenAI | Stills (GPT Image); some of Atomik's writing | Prompts and reference images | Live | [link to OpenAI privacy policy] |
| Google (Gemini API) | Stills (Nano Banana Pro, and 2.1 when live); some of Atomik's writing; Gemini for moments, cutdown planning and the vision judge | Prompts and reference images; frames for the vision judge | Live (2.1 and the judge: Planned) | [link to Google Gemini API privacy policy] |
| Google (Veo) | Video | Prompts, reference images and frames | Planned | [link to Google Gemini API privacy policy] |
| Google (Cloud Vision) | Reading text in images, with an exact text check | Images and review frames | Planned (key set) | [link to Google Cloud privacy policy] |
| xAI | Stills, video, voice; some of Atomik's writing | Prompts, reference images, audio | Live | [link to xAI privacy policy] |
| BytePlus | Video (Seedance) and prompt enhancement | Prompts, reference images and clips | Live | [link to BytePlus privacy policy] |
| fal | Video (Kling), identity training and renders; upscales and stills tools until each goes direct | Prompts, reference images, clips, identity photos | Live | [link to fal privacy policy] |
| Luma, through fal | Re-cutting a finished clip to another shape (replaced by AWS MediaConvert) | A finished clip | Live, leaving | [link to Luma privacy policy] |
| Higgsfield (API key only) | Identities and stills | Prompts and photos | Live | [link to Higgsfield privacy policy] |
| ElevenLabs | Speech, sound effects, music, dubbing, and transcripts outside Indian languages | Scripts and audio | Live (speech to text: Planned) | [link to ElevenLabs privacy policy] |
| Topaz Labs (direct) | Upscaling | Images and clips | Planned (live today through fal) | [link to Topaz Labs privacy policy] |
| Bria (direct) | Extending and cutting out stills | A still | Planned (live today through fal) | [link to Bria privacy policy] |
| Runway | Face and video performance, video edits, video | A face video and a driving video, a video, or a prompt and image | Planned (house workspace only until written terms exclude training) | [link to Runway privacy policy] |
| sync.so | Lip-sync, direct | A clip and audio | Planned | [link to sync.so privacy policy] |
| Sarvam | Speech, transcripts and translation in Indian languages | Text and audio | Planned | [link to Sarvam privacy policy] |
| Black Forest Labs | Stills (FLUX 3, FLUX.2), EU endpoint | Prompts and reference images | Planned | [link to Black Forest Labs privacy policy] |
| Recraft | Decks, brand assets, vector and storyboard styles | Prompts; an image for vectorize or background removal | Planned | [link to Recraft privacy policy] |
| AWS MediaConvert (Mumbai) | Smart Crop reframe of a finished clip | The clip, held in a storage bucket in Mumbai | Planned | [link to AWS privacy notice] |

AWS Rekognition is not used and receives nothing (owner, 16 Oct 2026).

Not used, by decision: an AI gateway [D11]; MiniMax/Hailuo, Suno, Udio, Sora, PlayHT, face-swap engines built on InsightFace, Wav2Lip and self-hosted MMAudio (owner, 15 Oct 22:15). Recraft was "not used" in the 11 Oct record and is now in the stack (owner, 15 Oct 22:15).
[OWNER DECISION OD-P4a: the final vendor list at launch. The table is drawn from the record on 15 Oct (22:15 stack); the owner confirms which "Planned" vendors are live on the day and removes the rest.]
⚖ LAWYER L-P3b: whether each vendor needs a data processing agreement, and whether the list must be in the notice or can sit in a linked page.
⚖ LAWYER L-P3c: that the notice names every vendor above with its policy link, that the links are kept current, and how a vendor added later is announced.

## 6. Training and retention at vendors

**Our promise: Particl does not train on customer content. Providers may, under their own policies** (owner, 15 Oct 22:15) [D5]. Particl does not require a provider to promise no training before we use it, so we do not promise it on their behalf. Each provider's own policy, linked in section 5, governs what it does with what it receives. Where we have an account setting that turns training or "improve the models" off, we switch it off and record the date and who (`where-your-data-goes.md`, "Record of switches").

What the record says, from our own account settings and written confirmations (nothing else is claimed):

| Vendor | Recorded |
|---|---|
| Black Forest Labs | Training opt-out set in its dashboard (15 Oct 13:45). Published (16 Oct, check before relying): its API terms let it train on inputs and outputs, with an email opt-out; retention "as long as is reasonably necessary"; controller BFL GmbH (`where-your-data-goes.md`) |
| sync.so | No training on our data, confirmed in writing; the letter is with company records, not in the repo (15 Oct 14:25). Published (16 Oct, check before relying): training use and a perpetual, irrevocable licence, with no published opt-out. It receives faces and voices: OD-W1, L-W2 |
| Sarvam | Retention set to 0 days (15 Oct 14:25). Published (16 Oct, check before relying): trains on content unless you opt out in account settings; default retention 30 days. Training off is an owner action, not yet recorded as done: OD-W2 |
| ElevenLabs | Account has a training setting; to be switched off (owner action; not yet recorded as done) |
| Runway | Its terms allow training on inputs and outputs; house workspace only until written terms say otherwise |
| Topaz | Asked, optional: no training on our uploads, how long it keeps files. Not recorded as answered |
| Every other vendor | Nothing recorded about training or retention; the vendor's own policy applies. [OWNER DECISION OD-P5: how the page states this. Options: the "providers may, under their own policies" sentence alone; also the table in `where-your-data-goes.md` on the site.] |

The written requests to vendors (`vendor-requests.md`) are optional information requests, not a condition of using a vendor.
⚖ LAWYER L-P6: how to word the promise so it is true when providers retain or train under their own terms; whether to publish the table; whether "we do not train" needs to say we do not train any model of our own on customer content and do not sell it for training.

## 7. Where your data is

Databases are in Mumbai (Turso, aws-ap-south-1). The app runs on our own server in Bangalore. Files are in Cloudflare R2; the storage region setting is not recorded. Many engines are outside India (for example in the US; BFL's endpoint is in the EU), so prompts and files can leave India [D10, D14].
⚖ LAWYER L-P4b: cross-border transfer under the DPDP Act (any restricted country list, the notice), and the transfer terms with each vendor.
[OWNER DECISION OD-P6: R2's storage jurisdiction. Options: leave as is; set an Indian or EU jurisdiction.]

## 8. How long we keep it

Nothing is erased. Files are kept in storage. A take, upload or project you delete is hidden and kept, so it can be restored. Deleting a workspace ends access at once and retires its key; its files and database are kept. Account and billing records remain. Older files in Vercel Blob stay read-only for 30 days after the cutover and are deleted only with the owner's yes [D12, D14; live Privacy page].
⚖ LAWYER L-P4: this against the DPDP Act's right to erasure and its limit on keeping data longer than needed, and against the SOW's "deletion with purge". See OD-T3.
[OWNER DECISION OD-P7: the erasure process for a person who asks (a person in a cast photo, a former member). Options: erase their data on request within a stated time; hide and restrict, keeping the file; erase only what the law requires.]

## 9. Who sees it inside Particl

A board is private to its maker until they share it with the team. Members see shared boards and work as the roles allow; admins run the team and the ledger; the owner alone deletes or exports the workspace. The platform's desk sees each workspace's spend, balance, engine health and reports about it, and can suspend a workspace; it does not browse a workspace's takes. If the platform owner is a member of a workspace, they can read what is shared with the team as any member can. An admin's read of a member's private board is logged and audited, and API and MCP tokens never get admin reach [D15; live Privacy page].
⚖ LAWYER L-P7: whether the audited admin reach and the platform desk's access need to be stated as access by us, and the lawful basis.

## 10. Your rights and how to use them

You can ask what we hold about you, ask us to correct it, ask us to erase it (see section 8), withdraw consent, nominate someone, and complain to us and then to the Data Protection Board.
[OWNER DECISION OD-P8: the privacy contact, the time we take to reply, and the grievance officer for data. See OD-T9.]
⚖ LAWYER L-P5: the list of rights and the response times the Act sets; the nominee right; how a customer's team member exercises rights against a workspace owner.

## 11. Children

Particl is for people 18 and over [D1]. We do not knowingly keep an under-18's account and we close one when we learn of it.
⚖ LAWYER L-P8: children's data duties (verifiable parental consent, no tracking) and whether our tick-only approach is enough. See L-T2.

## 12. Keeping it safe

Each workspace has its own database; files are under a prefix that is the workspace's alone and reached by short-lived signed links; a vendor key a workspace adds is sealed on the server and shown back masked; owners can require authenticator sign-in for members [live Privacy page; docs/particl-sow-v1.md, 14 September workspace sign-in policy]. We do not claim more than this.
⚖ LAWYER L-P9: the breach notice we owe the Board and the people affected; the text that describes our safeguards without over-promising.

## 13. Cookies and analytics

[OWNER DECISION OD-P9: cookies and analytics. The record does not describe them. The code at 15 Oct has no third-party analytics package; the session cookie and the service worker are ours. Confirm, then state it.]

## 14. Changes and contact

The page carries its date; a change that matters is announced in the product first. Contact: [OWNER DECISION OD-P10: the privacy email and postal address. See OD-G1, OD-G2.]
