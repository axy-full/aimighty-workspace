# Acceptable Use Policy: DRAFT for the owner's lawyer

Draft 0.1, 15 Oct 2026. Not live. The live page is `app/(app)/policy/page.tsx` ("Content policy", 6 Sep 2026); the Terms make it part of the contract. Tags and decision ids are explained in `README.md`.

Particl is for film made with generative engines by working teams. This is what may not be made with it, what the engines refuse on their own, and what happens when something is reported.

## 1. Not allowed

1. **Sexual content involving anyone under 18**, in any form, real or generated [live policy].
2. **Sexual content of a real person who has not agreed to it** [live policy].
3. **Sexual content at all** [D3: "no sexual content"].
   [OWNER DECISION OD-A1: the owner's recorded words are "no sexual content". The live policy bans only items 1 and 2. Options: (a) ban all sexual content (this draft); (b) keep the live wording; (c) allow adult content between consenting adults who are not real people, in a gated way. Define "sexual" and say whether nudity in art, medical or educational use is covered.]
4. **A real person's likeness used to deceive**: putting words in their mouth, showing them doing what they did not do, or passing generated footage off as real [live policy].
5. **Publishing a real person's likeness without that person's rights.** **Owner's decision, 16 Oct 2026:** any likeness or real face in generated content is the sole responsibility of the person generating it. Likeness references are for pre-production and pitching: storyboards, animatics and pitch decks may name real people as casting references. Publishing a real person's likeness needs that person's rights. Particl does not block or screen prompts for resemblance to real people; providers' own filters apply. On an upload of a real person you tick "I have this person's permission" and may attach a permission file (NOC), stored with the asset and never checked automatically; a person records the tick, Atomik and outside agents never do [D13]. ⚖ LAWYER L-A7: this paragraph as the likeness clause; sole responsibility; no screening; the tick as evidence.
6. **Harassing, threatening or dehumanising people** for who they are, or inciting violence [live policy].
7. **Anything unlawful** where you or we operate, and anything that tries to defeat an engine's own safety rules [live policy].
8. **Content that breaks someone's rights**: copyright, trademark, privacy, publicity [OWNER DECISION OD-A2: confirm. Not in the live policy; usual for such a policy].
9. **Abusing the service**: sharing a login, getting around spend limits or approvals, probing another workspace, using tokens or the API to do what a person must approve, or reselling access [OWNER DECISION OD-A3: confirm each. Not in the live policy. Spending approval by a person is recorded: D13].

[OWNER DECISION OD-A4: public figures, satire and parody, and political or election content. The 16 Oct likeness decision puts responsibility for any likeness on the person generating it and requires the person's rights to publish it, without a public-figure exception; whether clearly labelled parody of public figures is allowed, and whether political deepfakes are banned specifically, are not recorded. Options: (a) as the decision says, no exception; (b) allow clearly labelled parody of public figures; (c) ban political deepfakes specifically.]

## 2. You are responsible

You are responsible for what you generate and publish [D9]. Gemini's adjustable safety filters are set to their least restrictive level (BLOCK_NONE on all four adjustable categories; Google's fixed filters stay) [D9; lib/geminiSafety.ts]. [OWNER DECISION OD-T17: whether to publish this setting at all; see Terms section 8.] So this policy, not the filters, is the control, and a report and takedown process is part of it.

## 3. What the engines refuse

Every engine has rules of its own and refuses some prompts, sometimes ones that break none of the above. A refused take says so plainly on its card; a refusal before the render starts costs nothing [live policy].

## 4. Reporting and what happens

- Anyone can report at /report, with no account: a link or a take id, what is wrong, and an email if they want an answer.
- The platform's desk reads every report. A workspace can be flagged for review.
- For abuse we suspend the workspace: rendering stops, everything already made stays readable, and the workspace is told why. Repeated or serious abuse ends the workspace [live policy; D17].
- Particl does not train on a workspace's work. The providers that receive prompts and references to render may, under their own policies [D5].

[OWNER DECISION OD-A5: appeal. Not recorded. Options: none; one written appeal to the desk within a stated time.]
[OWNER DECISION OD-A6: reports of content that is unlawful (for example child sexual abuse material): keep, preserve and report to authorities. Not recorded as a process. See L-A2.]

## 5. Checks for the lawyer

⚖ LAWYER L-A1: align the list in section 1 with the content the Intermediary Rules 2021 require us to tell users not to host or share, and the due-diligence duties that follow (IT Act s.79).
⚖ LAWYER L-A2: our duties on child sexual abuse material and on unlawful content (preservation, reporting, cooperation with authorities), under the IT Act, the POCSO Act and the Bharatiya Nyaya Sanhita.
⚖ LAWYER L-A3: personality and publicity rights, defamation and deceptive-content exposure for a tool that makes likenesses; whether an "I have this person's permission" tick, with an optional NOC file that is never checked, is enough evidence (see L-A7).
⚖ LAWYER L-A4: how the draft relates to the "no AI tag" decision (Terms section 7): deceptive use against an undisclosed-AI rule. See L-T10.
⚖ LAWYER L-A5: the grievance officer and takedown timelines (Terms section 9; L-T11), and the user's right to be told why content was removed.
⚖ LAWYER L-A6: whether switching engine filters to the least restrictive level changes our exposure as a publisher or intermediary (D9).
