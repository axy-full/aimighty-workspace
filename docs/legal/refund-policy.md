# Refund Policy: DRAFT for the owner's lawyer

Draft 0.1, 15 Oct 2026. Not live. The live Terms page only says "Contact the platform about disputed charges or refunds." Tags and decision ids are explained in `README.md`.

## 1. The rule

Recorded: "Refund Policy (7 days if no credits used)" [D7]. Drafted on that wording:

You can ask for a refund of a plan or a credit pack within 7 days of paying, if none of the credits from that purchase have been used. We refund what you paid for it, to the method you paid with.

[OWNER DECISION OD-R1: the 7-day rule is not in CLAUDE.md › Pricing, and that section is the source of truth for what customers are charged. If confirmed, Pricing needs a refund paragraph; nothing in the code refunds a purchase today.]

## 2. What "used" means

A credit is used when it is spent on a job, or held for a job that is still running [D8: reservations; live Terms page].
[OWNER DECISION OD-R2: exact test. Options: (a) none of the credits of that purchase have been spent or held; (b) none of the workspace's credits at all, including the free grant; (c) less than a stated amount used, refunded in proportion. The drafting above is (a).]
[OWNER DECISION OD-R3: whether a held reservation counts as used while it is held, and whether a job that failed and was fully released counts.]

## 3. Plans

- A first payment for a monthly or annual plan: refundable in the first 7 days if none of its included credits are used. Included credits are spent before purchased credits [D8], so a plan with any use is not refundable under this rule.
- Renewals: [OWNER DECISION OD-R4: does the 7-day rule apply to each renewal, or to the first payment only? Options: first payment only; each monthly renewal; annual renewals only.]
- Annual plans after day 7: [OWNER DECISION OD-R5: no refund for the unused months, or a pro-rata refund. Not recorded.]
- If we do not renew a plan because nothing was generated in the 60 days before renewal, there is no charge to refund [D8].
- Included credits expire at the end of the cycle and are not refundable [D8].

## 4. Packs and bonus credits

- A pack bought within 7 days with none of its credits used is refundable. Bonus credits are free [D8; lib/creditTerms.ts], so a refund returns the price paid and cancels the bonus credits [OWNER DECISION OD-R10: confirm; not recorded].
- Pack credits last 12 months, counted only while the workspace is off a plan [D8]. Credits that have expired are not refundable.
[OWNER DECISION OD-R6: a refund after day 7 for a pack with nothing used. Not recorded. Options: none; at the owner's discretion; credit note.]

## 5. The free grant

The one-time free grant has no cash value and is never refunded [D8: "Free grant is one-time, never recurring"].

## 6. Failed or refused work is not a refund

A refused or failed request that cost nothing says "Nothing billed" and can be retried under the same approval. A request that was charged and failed shows what it cost. A provider rejection releases its reservation. If a request times out after submission, we reconcile it before changing the charge. Undo does not change billing [D8; Terms › Credits]. These adjust your credits and are separate from a refund of money.
[OWNER DECISION OD-R7: whether a failed charged request is returned as credits only, or as money on request. Not recorded. Today the product returns credits.]

## 7. How and when

Ask through [OWNER DECISION OD-R8: the contact for refunds]. We reply within [OD-R8: days] and pay within [OD-R8: business days] to the original payment method.
[OWNER DECISION OD-R9: who bears the payment processor's fees on a refund.]

## 8. Disputes

A customer who disputes a charge with their bank or card network first writes to us. See Terms section 15 for disputes.
⚖ LAWYER L-R1: whether a 7-day rule with a "none used" condition is lawful and clear for consumers (Consumer Protection (E-Commerce) Rules 2020 on cancellation and refund; Consumer Protection Act 2019 on unfair terms), and whether it must be shown before payment.
⚖ LAWYER L-R2: GST treatment of a refund (credit note), and the invoice trail.
⚖ LAWYER L-R3: refunds for customers outside India and the processor's refund rules.
⚖ LAWYER L-R4: the interplay of expiry (cycle end; 12 months off plan) with refunds, and what a customer must be told at checkout. See L-T5.
⚖ LAWYER L-R5: chargebacks and the right to withhold a refund for suspected abuse.

## Check against CLAUDE.md › Pricing

| Pricing says | This draft | Match |
|---|---|---|
| Included credits expire at cycle end, no rollover | Section 3 | Yes |
| Packs last 12 months, counted off-plan; no expiry while on a plan | Section 4 | Yes |
| Bonus credits at most 20% of a pack, free | Section 4 | Yes |
| Free grant one time | Section 5 | Yes |
| Auto-cancel if nothing generated in the 60 days before renewal | Section 3 | Yes |
| Annual 20% off | Not repeated here | n/a |
| A refund of any kind | Section 1 | **Not in Pricing**: OD-R1 |
| Whether leaving a plan resumes or restarts the pack months | Not needed for a refund | **Open in Pricing**: OD-T5 |
