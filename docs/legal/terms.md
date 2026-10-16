# Terms of Service: DRAFT for the owner's lawyer

Draft 0.1, 15 Oct 2026. Not live. The live page is `app/(app)/terms/page.tsx` (25 Sep 2026). Tags and decision ids are explained in `README.md`.

## 1. Who we are

These terms are between [COMPANY] ("we") and the person or company that creates a workspace or uses Particl ("you").
[OWNER DECISION OD-T1: legal entity name, registered address, contact email. See OD-G1.]

⚖ LAWYER L-T1: how a person accepts. The sign-up tick reads "I'm 18 or older and agree to the Terms" and is stored with the date on every sign-up path [D1]. Check that this is enough to form the contract, what must be stored (version of the Terms, time, account), and how a change is accepted again.

## 2. Who may use Particl

You must be 18 or older [D1]. [OWNER DECISION OD-T14: whether a person who signs up for a company confirms they may bind it. Not recorded. Options: say so here; leave it to the workspace owner's acceptance.] We do not allow anyone under 18 to hold an account.

⚖ LAWYER L-T2: capacity to contract and the DPDP Act's rules on children's data. We rely on the tick and make no other age check.
[OWNER DECISION OD-T2: is the tick enough, or is there a further check? Options: (a) tick only; (b) tick plus a stronger check for suspected minors; (c) none beyond the tick, but suspend on report.]

## 3. Your account and workspace

Registration needs a verified email address. Each production house has its own workspace, team and settings. Owners, admins and members have different rights. The owner can export the workspace from Settings › Account. Deleting a workspace ends access at once; its files, database and billing records are kept, not erased, and we can restore it [D12; live Terms and Privacy pages].
You keep your sign-in details safe and you are responsible for what happens under your account.

⚖ LAWYER L-T3: "kept, not erased" against the DPDP Act's erasure and retention limits and the SOW's earlier "deletion with purge" (docs/particl-sow-v1.md, Isolation and lifecycle). See L-P4.
[OWNER DECISION OD-T3: what happens when a workspace owner or a person asks for erasure. Options: (a) keep the "nothing is erased" rule and say so, with a stated exception process for the law; (b) erase on request after a stated period, except billing records we must keep; (c) erase workspace content on deletion, keep billing records.]

## 4. Credits, plans and packs

Rules in this section follow CLAUDE.md › Pricing [D8]. Where a figure differs from the billing page at launch, the billing page is the source and this draft is wrong.

**Credits.** 1 credit is US$0.10 (the public price of a credit; fixed). Prices in the product read "N cr", "up to N cr" (a live estimate) or "free". You see the price before you press the button. Only a person approves spending; Atomik and outside agents can prepare and price a job but never approve one [D13]. A job estimated above 200 cr always needs the workspace's cost-approval rule, whatever the workspace's own setting [D8, guardrail 4].

**Failed work.** A refused or failed request that cost nothing says "Nothing billed" and can be retried under the same approval. A failed request that was charged says what it cost. A confirmed provider rejection releases its reservation. If a request times out after submission, we reconcile it with the provider before we adjust the charge. Undo never changes billing [docs/redesign-plan.md › "Owner bug and rule (Akshay, 13 Oct afternoon): deleting cards, undo"; live Terms page].

**Plans** (sample figures from CLAUDE.md; confirm before launch, see OD-T4):

| Plan | Price | Included | Members |
|---|---|---|---|
| Invite | $0 | 250 cr once, 1 production | 3 |
| Studio | $49 a month | 400 cr | unlimited |
| Agency | $199 a month | 1,600 cr | unlimited |
| Production | $999 a month | 9,000 cr | unlimited |

No seat fees on any paid plan. Annual billing is 20% off. If a workspace has generated nothing in the 60 days before a renewal, we do not renew; the plan lapses and we say so. Selecting a plan at sign-up does not activate it or grant credits [live Terms page].
[OWNER DECISION OD-T4: which plan table is final. CLAUDE.md lists Invite, Studio, Agency, Production. Prototype v15 shows other placeholders marked "confirm" (Explore $50, Create $100, Master $250; Business 100, 250, 500 per seat, pooled).]

**Included credits** expire at the end of their credit window (monthly; annual plans have monthly credit windows [live Terms page]). They do not roll over, and they are spent before purchased credits [D8].

**Packs.** A pack's credits, and its bonus credits, last 12 months, counted only while the workspace is off a paid plan. The clock pauses while the workspace is on a plan and runs again when the plan ends. Bonus credits are at most 20% of a pack, are given free [D8; lib/creditTerms.ts]. [OWNER DECISION OD-T18: whether bonus credits carry no cash value. Not recorded; the refund treatment is OD-R10.] Existing credits are not given a retroactive expiry [live Terms page].
[OWNER DECISION OD-T5: when a workspace leaves a plan, does the pack clock resume with its remaining months or restart at 12? CLAUDE.md › Pricing says this is "still open".]
[OWNER DECISION OD-T6: the one-time free grant (250 cr on the Invite plan). The record gives it no expiry, and the code does not expire it. Options: (a) no expiry; (b) expires 12 months after it is given; (c) expires with the first paid purchase.]
[OWNER DECISION OD-T7: whether credits can be transferred between workspaces or exchanged for cash. Not recorded. Options: (a) neither; (b) transfer inside one owner's workspaces only.]

⚖ LAWYER L-T4: GST on credit sales (time and place of supply; whether a prepaid credit is a voucher or a service), invoice contents, and a GST number field. SOW: whether invoicing ships now or later is open.
⚖ LAWYER L-T5: credits that expire (cycle end; 12 months off plan) against the Consumer Protection (E-Commerce) Rules 2020, the Consumer Protection Act 2019 on unfair terms, and what the checkout must show first.
⚖ LAWYER L-T6: whether prepaid credits could count as a prepaid payment instrument under RBI rules (we expect not, because credits buy only our own services; confirm).
⚖ LAWYER L-T7: payments from customers outside India (FEMA, export of services, the payment processor's terms) and the billing currency [OD-G3].

Refunds are in the Refund Policy (`refund-policy.md`).

## 5. Your work

What you make is yours. We claim no rights in your prompts, references or takes. Particl does not train on customer content. Providers may, under their own policies, which our Privacy Policy links [D5]. You give us only the licence we need to run the service: to store, process, copy and send your content to the engines you choose, show it to your team and to the people you share it with, and keep backups.
What an engine's own terms say about its output applies to that output.
You promise you have the rights to what you upload, and that your use of it does not break anyone else's rights.

⚖ LAWYER L-T8: ownership and copyright of generated output under Indian law (a work with no human author may not be protected); wording that "yours" does not over-promise; the licence grant; third-party engine terms that limit commercial use (see `licence-register.md`, engine outputs).
⚖ LAWYER L-T8b: the promise is "Particl does not train on customer content; providers may, under their own policies" (owner, 15 Oct 22:15). There is no promise on a provider's behalf, and no no-training gate on wiring a provider. Check the wording, that it is true for each provider in `where-your-data-goes.md`, and that the Privacy Policy section 6 says the same (L-P6, L-W1).

## 6. Real people: faces, voices and likeness

**Owner's decision, 16 Oct 2026** (`docs/redesign-plan.md`, "Owner, 16 Oct 2026, 10:55 IST", item 1): any likeness or real face in generated content is the **sole responsibility of the person generating it**. Likeness references are for **pre-production and pitching**: storyboards, animatics and pitch decks may name real people as casting references. **Publishing a real person's likeness needs that person's rights.** Sexual content stays prohibited (see the Acceptable Use Policy). Particl does not block or screen prompts for resemblance to real people; each provider's own filters apply, and a provider's refusal is shown as it comes.
When you upload a photo or video of a real person, you tick "I have this person's permission". You may also attach a permission file (a no-objection certificate, NOC), kept with the asset. **Particl stores the tick and the file and never checks either automatically.** Recording the tick is done by a person, never by Atomik or an outside agent [D13]. We do not offer voice cloning now [D10]. You may not use a real person's likeness to deceive (see the Acceptable Use Policy).

⚖ LAWYER L-T9: the likeness decision as a clause: sole responsibility of the person generating; pre-production and pitching use of real people's names and likenesses as references; publication needing the person's rights (personality and publicity rights, defamation, deceptive content); that a tick plus an optional unchecked NOC is enough evidence and does not make Particl an intermediary that must screen; whether "never checked automatically" and "does not screen prompts" should be stated to customers; face and voice data held as photos and recordings (DPDP Act notice, consent, withdrawal, retention, transfer to US vendors) [D10].

## 7. Disclosure: "no AI tag"

Recorded: "no AI tag" and "customer handles disclosure" [D2, D4]. Drafted on that wording: we do not add an AI label or tag to what you make. You decide whether and how to tell your audience that AI was used, and you are responsible for any disclosure that the law, a platform or your client requires.
[OWNER DECISION OD-T8: what "no AI tag" covers. Options: (a) no visible label on any output; (b) also no metadata marker (for example a content-credentials or C2PA mark) added by Particl; (c) also we will not remove a mark that an engine adds itself. Today, in the code, Google's image outputs always carry SynthID (lib/models.ts) and a BytePlus draft carries the engine's watermark, which the final never does (lib/draftFinal.ts). Nothing in the record says whether we may strip those.]

⚖ LAWYER L-T10: current and proposed Indian rules on labelling synthetically generated content (IT Rules amendments), and whether a "no tag" policy is safe for us as a tool provider, for content shared through our client review links, and for customers who publish in India. Also advertising and consumer rules on undisclosed AI content.

## 8. Acceptable use and what you generate

The Acceptable Use Policy (`acceptable-use-policy.md`) is part of these terms. You are responsible for what you generate and publish [D9]. Gemini's adjustable safety filters are set to their least restrictive level [D9; lib/geminiSafety.ts], so the policy and the report process are our controls. [OWNER DECISION OD-T17: whether to publish this setting at all. Options: state it in the Terms and the AUP; say only that the engines' own filters apply and keep the setting out of public text.] Breaking the policy can suspend or end your workspace.

## 9. Reports, takedown and the grievance officer

Anyone can report content at /report, without an account: a link or a take id, what is wrong, and a way to reach them if they want one. The platform's desk reads every report. We can flag a workspace for review. For abuse we suspend it: rendering stops, everything already made stays readable, and the workspace is told why. Repeated or serious abuse ends the workspace [live content policy; D17].
[OWNER DECISION OD-T9: the grievance officer's name, address and email; how long we take to acknowledge and to resolve a report; whether we notify the person whose content is removed. Not recorded.]

⚖ LAWYER L-T11: whether we are an "intermediary" and what that needs (IT Act s.79 conditions, Intermediary Rules 2021 due diligence, the user notice of prohibited content, grievance officer, takedown timelines, records, cooperation with authorities). Check that the report process in the product meets them.

## 10. Engines and availability

The engines are third parties, and so is the storage. We do our best to keep everything reachable and show on the Usage page what each engine is doing; we cannot promise a vendor stays up. A lost response does not prove that a provider did no work; we reconcile those requests before adjusting the charge [live Terms page].
[OWNER DECISION OD-T10: any uptime promise (SLA) for paid plans. Not recorded. Options: none; a stated target without credit; a credit for downtime.]

## 11. Review links and sharing

A client review link is a read-only page of approved takes with the workspace's name and logo, with no login, and is tokenised, expiring and revocable. On a member's private board only its owner can create one [D15; docs/particl-sow-v1.md §8]. You are responsible for who you send a link to.

## 12. Ending

You may stop using Particl and the owner may delete the workspace. We may suspend or end a workspace for breaking these terms or the policy, [OWNER DECISION OD-T15: for non-payment, or if the law requires. Not recorded; the record has suspension for abuse only. Options: add both; abuse only.] Unused credits on a workspace we end for breaking the terms are [OWNER DECISION OD-T11: forfeited, or refunded in part. Not recorded; see also OD-R4].

## 13. Disclaimers and liability

[OWNER DECISION OD-T12: the cap on our liability (for example, fees paid in the last 12 months), the exclusions, and the warranty language.]
⚖ LAWYER L-T12: enforceability of disclaimers and a liability cap under the Indian Contract Act and the Consumer Protection Act, and for consumers against businesses.

## 14. Indemnity

[OWNER DECISION OD-T16: an indemnity from the customer. Not recorded. Options: include it as drafted (claims from content you upload or generate, and from your breach of these terms or the policy); narrow it to content; leave it out.]
⚖ LAWYER L-T13: scope and fairness of the indemnity.

## 15. Governing law and disputes

Indian law governs these terms [D6]. Disputes are decided by arbitration under the Arbitration and Conciliation Act, 1996, with its seat and venue in Mumbai [D6].
[OWNER DECISION OD-T13: the rest of the arbitration clause. Options for the rules: ad hoc, or an institution (for example MCIA); one arbitrator or three; language English; who pays; which courts may grant urgent relief; whether small consumer claims may go to a consumer commission.]
⚖ LAWYER L-T14: arbitration against a consumer and against a click-wrap acceptance; whether a consumer commission's jurisdiction can be excluded; seat against venue wording; urgent relief before the courts (s.9); confidentiality; customers outside India and enforcement abroad.

## 16. Changes

These terms change here, with the date at the bottom. A change that matters is announced in the product before it applies [live Terms page].
⚖ LAWYER L-T15: notice and consent for a material change; what happens to a customer who does not accept.

## 17. The rest

Entire agreement, severability, assignment, notices, force majeure, waiver.
⚖ LAWYER L-T16: standard boilerplate. The lawyer's own text replaces this section.
