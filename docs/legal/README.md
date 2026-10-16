# Legal drafts for the owner's lawyer

**Status: DRAFTS, 15 Oct 2026. Not live. Not legal advice.** Nothing here replaces the pages in the product (`/terms`, `/privacy`, `/policy`) until the lawyer has signed off and the owner has approved the text. Owner request: "drafts in docs/legal/ for my lawyer: Terms, Privacy Policy, Refund Policy (7 days if no credits used) and an Acceptable Use Policy, built on my recorded decisions ... Mark every clause my lawyer must check. Plus a font and asset licence register" (docs/redesign-plan.md, "Owner, 15 Oct 2026, 20:45 IST (verbatim)").

| File | What |
|---|---|
| `terms.md` | Terms of Service |
| `privacy-policy.md` | Privacy Policy, with the list of vendors that receive data |
| `refund-policy.md` | Refund Policy |
| `acceptable-use-policy.md` | Acceptable Use Policy |
| `licence-register.md` | Fonts and assets rendered into customer outputs, with licences; UI-only fonts apart. Includes the FFmpeg lgpl build used for DNxHR (L-L10) |
| `unknown-assets.md` | Every font and asset marked UNKNOWN: where it is used (file and line), which outputs it can reach, how to clear or replace it |
| `where-your-data-goes.md` | One page, one table: every provider, what is sent, how long it keeps it, what it does about training, and whether training is switched off on our account. Source for the public page on the site |
| `vendor-requests.md` | Drafts of the emails asking BytePlus, Google, OpenAI, ElevenLabs, Topaz, Bria and Runway for written data terms, plus a BFL "Training Opt Out" and a Sync Labs request (sections 8 and 9), and an owner action for Sarvam. Optional information requests, not a condition of wiring a vendor (owner, 15 Oct 22:15). Nothing is sent |

## How to read the tags

- **⚖ LAWYER L-xx:** a clause the lawyer must check. It names what to check. It is a flag, not a conclusion.
- **[OWNER DECISION OD-xx: ...]:** a point the owner has not decided in the record. The options are listed. Nothing is invented: until the owner decides, the clause stays in brackets.
- **[Dn]:** a recorded decision (below). Each clause that rests on one cites it.
- Indian-law topics the lawyer is asked to cover across the set: DPDP Act 2023 (notice, consent, rights, children, cross-border transfer), IT Act 2000 and the Intermediary Rules 2021 (due diligence, grievance officer, takedown), Consumer Protection (E-Commerce) Rules 2020, GST on credits, the Arbitration and Conciliation Act 1996 (seat and venue Mumbai), and face and voice data.
- Prices are not written into the drafts except where marked. They come from the rate card and the billing page; every price in a draft is a sample.

## Recorded decisions these drafts rest on

Files are on `redesign/integration` (docs/redesign-plan.md reaches `release/1` with the next merge); `CLAUDE.md` and the app pages are on `release/1`.

| ID | Decision (quoted or closely paraphrased) | Where |
|---|---|---|
| D1 | 18+. "an 18+ confirmation at sign-up (a required tick: "I'm 18 or older and agree to the Terms"), stored with the date, on every sign-up path" (Lane B builds it; NEEDS AKSHAY). | docs/redesign-plan.md › "Owner, 15 Oct 2026, 20:45 IST (verbatim)" |
| D2 | "no AI tag". Only the two words are recorded; what they cover is not. See OD-T8. | same |
| D3 | "no sexual content, consent for real faces". The live content policy is narrower than "no sexual content": it bans sexual content of anyone under 18 and of a real person who has not agreed, and says "An identity trained from photos needs the consent of the person in them, and you confirm that when you train one." See OD-A1. The consent half is superseded by D19 (a tick, not a check). | same; app/(app)/policy/page.tsx ("Content policy", 6 Sep 2026) |
| D4 | "customer handles disclosure". Only the phrase is recorded. See OD-T8. | same |
| D5 | "no training on user content". The live pages say it: "does not train on them" (Terms); "Nothing here is used to train a model" (Privacy); "does not train anything on a workspace's work" (Policy). Vendor side: BFL training opt-out done in its dashboard (15 Oct 13:45); sync.so confirmed no training in writing (kept with company records, not the repo; 15 Oct 14:25); Sarvam retention set to 0 days (15 Oct 14:25); Topaz: "confirm Topaz doesn't train on our uploads and how long it keeps files" (asked, not yet recorded as answered). | docs/redesign-plan.md › "Owner, 15 Oct 2026, 13:45 IST", "14:05 IST: Topaz goes direct", "14:20 and 14:25 IST" |
| D6 | "Indian law with arbitration in Mumbai". | docs/redesign-plan.md › "Owner, 15 Oct 2026, 20:45 IST (verbatim)" |
| D7 | Refund Policy: "7 days if no credits used". | same |
| D8 | Credits, plans, packs, expiry, guardrails: 1 credit = US$0.10; included credits expire at cycle end with no rollover; packs last 12 months, which pause while the workspace is on a plan; bonus credits at most 20% of a pack; guardrail 4 (a job over 200 cr needs approval); one-time free grant. | CLAUDE.md › "Pricing" (SOW §7A) |
| D9 | "Terms of use must say the customer is responsible for what they generate, plus a report/takedown process (India IT Rules)", given Gemini's adjustable filters set to BLOCK_NONE. | docs/redesign-plan.md › "Owner decision (Akshay, 14 Oct, 21:00 IST): Gemini safety settings" and "Counsel list" |
| D10 | Counsel list (14 Oct): Particl's DPDP role for a customer's cast; transfers to US vendors; voice data for Sarvam and sync.so. Voice cloning: not now. Counsel before any customer switch. | same, "Counsel list"; "Owner answers (Akshay, 14 Oct evening, recorded 19:15 IST)" item 6 |
| D11 | Privacy text names each AI provider that receives prompts or files, with one line on what it receives; no gateway; no Recraft. | docs/redesign-plan.md › "Owner decisions (Akshay, 11 Oct midday)" item 3; "(11 Oct afternoon: launch day)" item 7 |
| D12 | Nothing is ever erased; undo, not confirmation dialogs. | CLAUDE.md › Ground rules, rule 13; app/(app)/privacy/page.tsx ("How long") |
| D13 | Only a person approves spending, sets spend limits, tops up, approves a post, or records consent for a real person's face or voice. Atomik and outside agents prepare these, never take them. | CLAUDE.md › Ground rules, rules 11 and 14 |
| D14 | Vendors out and in: Vercel out (own tool loop; text direct to providers; 3D on our own workers; Blob kept read-only 30 days after cutover, deletion only with the owner's yes); "keep renders on Vercel until the relay is live and verified"; lip-sync direct through sync.so, then Sarvam, then Runway standby (house only until training-free terms); BFL FLUX.2 on the EU endpoint; Topaz goes direct. | docs/redesign-plan.md › "Owner answers (Akshay, 14 Oct, 20:40 IST)" item 5 and 7; "Owner amendment (14 Oct, 19:29 IST)"; "Owner, 15 Oct 2026, 19:30 IST"; "14:05 IST: Topaz goes direct" |
| D15 | Admin reach into a member's private board is audited; admins cannot make client links on it; API and MCP tokens never get admin reach. | docs/redesign-plan.md › "Owner decisions (Akshay, 14 Oct, 21:55 IST)" |
| D16 | Remotion: Free License confirmed in writing 13 Oct 2026; no licence key, nothing sent to Remotion; at 4 people the Company License must be bought first. | CLAUDE.md:45 (on `release/1`); docs/plans/remotion.md (on `redesign/integration`) |
| D17 | Written content policy at signup; report path on review links; platform-side suspend for abuse; terms, privacy and retention visible from Settings › Account. | docs/particl-sow-v1.md › §7 › "1.0 Tenancy, billing, onboarding" › "Policy" |
| D18 | Data terms (owner, 15 Oct 22:15): "Particl's Terms promise PARTICL does not train on customer content; providers may, under their own policies. No no-training gate on wiring. The Privacy Policy names every provider with a link to its policy. Switch off training/'improve the models' on every account that offers it (ElevenLabs now) and record it. Keep a one-page 'where your data goes' table ... in docs/legal and on the site." | docs/redesign-plan.md › "FINAL ENGINE STACK: owner, 15 Oct 2026, 22:15 IST" |
| D19 | **Likeness and consent, final (owner, 16 Oct 2026, 10:55 IST):** "Rekognition is OUT ... No face matching anywhere, ever"; "Keep only a lightweight consent record on uploaded real faces: a tick ('I have this person's permission') and an optional NOC file, stored with the asset, never checked automatically"; "Particl does not block or screen prompts for resemblance to real people. Providers' own filters apply and their refusals are shown as they come. Storyboards, animatics and pitch decks may name real people as casting references"; "any likeness or real face in generated content is the sole responsibility of the person generating it; likeness references are for pre-production and pitching; publishing a real person's likeness needs that person's rights; sexual content stays prohibited. Record that this was my decision." | docs/redesign-plan.md › "Owner, 16 Oct 2026, 10:55 IST" item 1 |

## Mismatches found while drafting (all flagged in the files)

1. **"No sexual content" (owner's list) is broader than the live content policy** (minors, and real people without consent). OD-A1.
2. **"Nothing is erased" (live Privacy page, rule 13) against the SOW's "deletion with purge"** and the DPDP erasure right. OD-T3, OD-P7, L-P4.
3. **"No training on user content" is a promise by Particl only (D18); the vendors train or retain under their own policies.** The live pages still say "Nothing here is used to train a model" and "does not train on them" without that qualification; they must change to the D18 wording when these drafts go live (L-T8b, L-P6, L-W1). Confirmed in the record: BFL, sync.so, Sarvam. Not recorded: OpenAI, Anthropic, Google, xAI, BytePlus, fal, ElevenLabs, Higgsfield, Luma, Topaz, AWS. L-P6.
4. **The 7-day refund is not in CLAUDE.md § Pricing.** CLAUDE.md says a change to what customers see changes that section too. OD-R1.
5. **Plan tables differ**: CLAUDE.md § Pricing (Invite, Studio $49, Agency $199, Production $999) against prototype v15's placeholders (Explore, Create, Master; Business 100, 250, 500). The drafts follow CLAUDE.md. OD-T4.
6. **The welcome grant (250 cr, one time) has no recorded expiry**; the code gives it none, packs and bonus credits get 12 months off-plan. OD-T6.
7. **"Whether leaving a plan resumes the remaining months or restarts them"** is still open in CLAUDE.md. OD-T5.
8. **Poster text prints in the viewer's own system font** (Georgia, Arial, the system UI stack), whose licence is not Particl's. See `licence-register.md`.
9. **The demo clip shipped as the starter production is CC BY 3.0** and needs attribution when it reaches an output. See `licence-register.md`.
10. **Gemini's adjustable filters are set to BLOCK_NONE** (owner, 14 Oct 21:00), so the AUP and the report process carry the weight. Noted in the AUP.

## General owner decisions

- **[OWNER DECISION OD-G1: the legal entity.]** Name, registered address, contact and grievance email. The record names a company only in the Remotion decision ("SensAI is 3 people in total"); no draft assumes it. Options: put the name here once; or use the trading name Particl with the entity beneath it.
- **[OWNER DECISION OD-G2: the public domain and the contact addresses]** (`particl.app` in CLAUDE.md; `particl.si` in docs/handover-2026-10-05.md).
- **[OWNER DECISION OD-G3: the payment processor and currency.]** Stripe is planned ("Stripe-readiness work", 15 Oct 20:45) and its code paths exist; it is not live. Billing currency and GST invoicing (SOW: "the only open item is whether invoicing ships now or later") are not decided.


## Owner actions: training and "improve the models" settings (D18)

Owner, 15 Oct 22:15: switch off training or "improve the models" on every account that offers it, and record it. These are the owner's, in each provider's own console (not code, and not done by a lane). Record the date and who in `where-your-data-goes.md`, "Record of switches".

- [ ] **ElevenLabs: now.** Switch off training / "improve the models" on the account. Not recorded as done.
- [x] **Black Forest Labs:** training opt-out done in its dashboard (15 Oct 13:45). Its published route is an email to privacy@blackforestlabs.ai, subject "Training Opt Out" (`vendor-requests.md` section 8): optional, to keep a written copy. Recorded in the table.
- [x] **sync.so:** written confirmation of no training (15 Oct 14:25), kept with company records. Its published terms say otherwise and show no opt-out: see OD-W1 and L-W2 in `where-your-data-goes.md`, and the optional email in `vendor-requests.md` section 8.
- [x] **Sarvam, retention:** 0 days is recorded (15 Oct 14:25); re-check it still holds (its published default is 30 days after last access).
- [ ] **Sarvam, training: owner action now.** Its published privacy policy (29 Jul 2026) trains on content unless you opt out in account settings or in writing. Switch training off in Sarvam's account settings, set content retention to the shortest allowed, and record the date and who in `where-your-data-goes.md`.
- [ ] **Runway:** the record says its terms allow training and states no API opt-out. Nothing to switch; customer use stays off until written terms exclude training (house workspace only).
- [ ] **Check, nothing recorded either way** (the repo has no record of whether the account offers such a setting): OpenAI, Anthropic, Google (Gemini API), xAI, BytePlus, fal, Higgsfield, Topaz, Bria, Recraft, Google Cloud Vision (its page says it does not train on content sent; check for a setting anyway). Open each account's data or privacy settings; if one offers a training or "improve the models" switch, turn it off and record the date and who.
- [ ] **Add the provider links:** replace each `[LINK: ...]` in `where-your-data-goes.md` and each `[link to ... privacy policy]` in `privacy-policy.md` with that provider's own policy page.
- [ ] **The optional emails** (`vendor-requests.md`) are information requests: send any you want answers from; nothing waits on them.

## Delivery formats

**DNxHR is back as a delivery format** (owner, 16 Oct 2026, 11:50), once lane D's PR is tested; ProRes mezzanine and H.264 stay. The encoder is the BtbN FFmpeg "lgpl" build (LGPL-2.1-or-later), used only inside the export worker image and not distributed to customers: see `licence-register.md` section A4 and ⚖ L-L10. It is written on our own worker and sends nothing to any provider (`where-your-data-goes.md`).
