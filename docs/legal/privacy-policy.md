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
- **Faces and voices:** photos for an identity, voice recordings, the consent record, and where used the results of face matching (see section 4).
- **Payments:** when online billing is live, the payment processor holds card details; we keep the invoice record. Planned.
[OWNER DECISION OD-P2: how long technical logs are kept. The live page says "a short while".]

## 3. Why

To run the service you asked for; to bill; to keep it safe; to answer reports; to follow the law. We do not sell data. We do not use your work to train a model [D5].
⚖ LAWYER L-P2: the lawful purposes and the notice and consent text the DPDP Act needs for each; "legitimate uses" we may rely on; a consent manager; withdrawal.

## 4. Faces, voices and other special data

Training an identity uses photos of a real person; the person in them must have agreed, and you confirm that when you train one [D3]. Voice work sends audio to the engines named below. Voice cloning is not offered now [D10]. Face matching with AWS Rekognition is planned and off today; the owner wants counsel before any customer switch [D10].
[OWNER DECISION OD-P3: whether Rekognition's similarity scores are erased when a person withdraws consent. D10 lists this as a question "against never-delete". Options: (a) erase scores on withdrawal; (b) keep and say so.]
⚖ LAWYER L-P3: face and voice as biometric or sensitive data under Indian law (the DPDP Act has no separate sensitive class; check the IT Act's SPDI rules still in force), consent wording, withdrawal, retention, and transfer to US vendors [D10].

## 5. Who receives data (vendors)

Each vendor gets only what it needs to do its job, and goes straight to that vendor (no AI gateway or relay in between) [D11; live Privacy page]. "Live" means named on the live Privacy page or in production use in the record; "Planned" means decided in the record and not yet in use.

| Vendor | What it does for us | What it receives | Status | Where recorded |
|---|---|---|---|---|
| Turso | Databases: one per workspace and one platform database | All workspace records except files; account and billing records | Live | live Privacy page; docs/handover-2026-10-05.md (Mumbai, aws-ap-south-1) |
| Cloudflare R2 | Private file storage (masters, uploads, identity photos) under each workspace's own prefix, reached by short-lived signed links | Your files | Live | live Privacy page |
| Cloudflare | DNS | Domain lookups | Live | live Privacy page |
| DigitalOcean | The server we run Particl on (droplet in Bangalore, BLR1) | Everything the app handles, in transit and at rest | Live | docs/scale-out-runbook.md |
| Vercel | Older files still in Vercel Blob (to be moved; read-only for 30 days after the cutover, then deleted only with the owner's yes); 3D (Astra) renders run on Vercel Sandbox until our own workers are live | Older stored files; the scene and assets of a 3D render | Live, leaving | live Privacy page; docs/redesign-plan.md › "Owner, 15 Oct 2026, 19:30 IST" |
| Resend | Email | Your email address, for sign-in and invites | Live | live Privacy page |
| Inngest | Background jobs | Identifiers of work to run, not prompts | Live | live Privacy page |
| Liveblocks | Live team editing on a shared board | Board content shared in a live session | Live | live Privacy page |
| Google (sign-in) | Sign in with Google | Your Google account identifier and email | Live, but still in Google's Testing mode until the owner publishes it | docs/redesign-plan.md › "Owner decision (Akshay, 12 Oct evening)" |
| Anthropic | Atomik's writing and planning | Your words to Atomik and files attached | Live | live Privacy page |
| OpenAI | Stills; some of Atomik's writing | Prompts and reference images | Live | live Privacy page |
| Google (Gemini) | Stills; some of Atomik's writing | Prompts and reference images | Live | live Privacy page |
| xAI | Stills, video, voice; some of Atomik's writing | Prompts and reference images | Live | live Privacy page |
| BytePlus | Video | Prompts, reference images and clips | Live | live Privacy page |
| fal | Video, identity training and renders, upscales (Topaz until direct), reframe through Luma | Prompts, reference images, clips, identity photos | Live | live Privacy page |
| Luma, through fal | Re-cutting a finished clip to another shape | A finished clip | Live | live Privacy page |
| Higgsfield (API key only) | Identities and stills | Prompts and photos | Live | live Privacy page; CLAUDE.md rule 10 |
| ElevenLabs | Speech, sound effects, music, dubbing; speech to text | Scripts and audio | Live | live Privacy page; docs/redesign-plan.md › "Owner answers (14 Oct, 20:40 IST)" item 7F |
| sync.so | Lip-sync, direct | A clip and audio | Planned (account bought; keys set) | docs/redesign-plan.md › "Owner amendment (14 Oct, 19:29 IST)" and "20:40 IST" |
| Sarvam | Transcripts in Indian languages | Audio | Planned (account bought; key set; retention 0 days) | same; "15 Oct, 14:20 and 14:25 IST" |
| Black Forest Labs (FLUX.2) | Stills, EU endpoint | Prompts and reference images | Planned (off; training opt-out done) | docs/redesign-plan.md › "Owner, 15 Oct 2026, 13:45 IST" |
| Topaz Labs (direct) | Upscaling | Images and clips | Planned (replaces the fal route) | docs/redesign-plan.md › "14:05 IST: Topaz goes direct" |
| AWS Rekognition | Face matching to check a take against a cast member | Face images | Planned (off) | docs/redesign-plan.md › "20:40 IST" item 7E; "Counsel list" |
| Google Cloud Vision | Reading text in images | Images | Planned (key set) | docs/redesign-plan.md › "14 Oct evening, recorded 19:15 IST" item 6 |
| Stripe | Card payments | Billing details; card data goes to Stripe | Planned (not live) | docs/redesign-plan.md › "Owner, 15 Oct 2026, 20:45 IST" |
| Runway | Standby engine | Not in use; house workspace only until training-free terms | Not in use | docs/redesign-plan.md › "14 Oct evening, recorded 19:15 IST" item 6 |

Not used, by decision: an AI gateway [D11]; Recraft [D11].
[OWNER DECISION OD-P4a: the final vendor list at launch. The table is drawn from the record on 15 Oct; the owner confirms which "Planned" vendors are live on the day and removes the rest.]
⚖ LAWYER L-P3b: whether each vendor needs a data processing agreement, and whether the list must be in the notice or can sit in a linked page.

## 6. Training and retention at vendors

Our promise: we do not train on your work [D5]. The engines receive prompts and references to render under their own terms. What the record confirms:

| Vendor | Recorded |
|---|---|
| Black Forest Labs | Training opt-out set in its dashboard (15 Oct 13:45) |
| sync.so | No training on our data, confirmed in writing; the letter is with company records, not in the repo (15 Oct 14:25) |
| Sarvam | Retention set to 0 days (15 Oct 14:25) |
| Topaz | Asked: no training on our uploads, how long it keeps files, delete its copy after we store the output. Not recorded as answered |
| Runway | Standby; house only "until training-free terms" |
| OpenAI, Anthropic, Google, xAI, BytePlus, fal, Luma, ElevenLabs, Higgsfield, AWS, Google Vision | Nothing recorded about training or retention. [OWNER DECISION OD-P5: confirm each (settings or written terms) before the sentence "we do not train on your work" is shown without a qualifier. Options: confirm all; qualify the sentence to name the vendors confirmed; remove a vendor.] |

⚖ LAWYER L-P6: how to word the promise so it is true when vendors retain or train under their own terms; whether to publish the table.

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
