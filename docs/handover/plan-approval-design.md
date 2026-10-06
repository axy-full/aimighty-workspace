# Plan approval: approve once, up to the plan's total

For the owner to read before any code merges. Release 1, money. Branch `money/plan-approval` (from `release/1`), draft PR only.

## Why
Today the board's plan card reads "Make 2 shots · Approve". Approve builds the board (free), then every render stops and asks for its own price. The scope (§0 Money, §2 item 3) and CLAUDE.md rule 14 say instead: **one tap approves the plan, up to its total, including a fix allowance (at most two fixes per shot); anything outside it asks again.** This note says exactly what that one tap allows, and nothing more.

## What the card shows
1. **Before the build** (Atomik has proposed cards and shots): "Make 3 shots", the steps, and **Build · free**. Building places cards and wires; it spends nothing. Shots that do not exist yet cannot be priced, and a thing that cannot be priced cannot be approved, so there is no money button yet.
2. **After the build, before any render** (the plan gate): the server prices every render the plan names, on the exact request it will send (the same free, repeatable pricing the render uses). The card reads:
   - title line: **Make 3 shots · 93 cr · at most 186 cr**
   - one line per shot: "Shot 1 · Seedance 2.5 · 5 s · 1080p · 43 cr" (each figure is the server's quote; an approximate engine shows "up to N cr" at its worst case);
   - "Fixes if needed: up to 2 per shot, within the 186 cr";
   - the balance after, or "Short by N cr" with **Top up**;
   - the button **Approve · 93 cr** (the price is the button), with Hold and Change beside it.
   - T (93) is the sum of the server's quotes; "at most" is 2 × T. The browser never adds up its own figures for the button: it shows the server's T and 2T.
3. **While it works:** "Making 3 shots", each shot's state, what has been spent against the approval ("41 of 186 cr used"), and fixes used per shot.

## What one approval allows
- **Exactly the listed renders**, each at the price it was approved at (its quote's fingerprint), plus **at most two fixes per shot**, each priced no higher than its shot's approved price.
- **Never more than 2 × T in total** (renders, fixes, anything the run reserves). This is enforced where money is held, under the database write lock (the run's limit is set to what the planning turn already used plus 2T at the moment of approval), not on the screen.
- **Nothing else:** a new shot, a different engine, a changed prompt or reference (the price's fingerprint moves), a third fix, a fix priced above its shot, or anything past 2T asks again, one tap at its own price, as today.
- **How long:** until the run ends, the person stops it, or 7 days after the approval, whichever comes first (owner decision 4). After that, nothing more is drawn from it.
- **Who:** only the signed-in person who asked Atomik for the plan. Agents, Atomik (`agent:<run>`), MCP callers and API tokens cannot approve: the route takes a browser session only (tokens refused), and the approval function itself refuses any approver id that is not a person.

## How it is recorded
A new additive table in the workspace's own database, `rig_plan_approvals`, one row per approval:
the run and production; **who approved and when**; the build proposal's fingerprint; **each listed step** (shot, quote, worst case, the quote's fingerprint); **T and the ceiling 2T**; fixes used per shot; the run limit it set; and when and why it closed (stopped, ended, expired). Nothing is updated in place except the fix counters and the closing time. S1's project record ("every approval with its quote and settled cost") reads this row later.

## How each render is admitted inside the plan
No new tap. When the run reaches a render, it checks, in order:
1. the step is on the approval's list, and its fresh quote's fingerprint equals the one approved (otherwise it asks, saying the price changed);
2. the approval is open (not stopped, ended or expired);
3. the step is under the per-job line (200 cr) and needs no admin under the workspace's rule (otherwise it asks, or waits for an admin, as today);
4. the run's limit (planning used + 2T) still has room for this render at its worst case;
5. the balance covers it.
Then the render goes through the **same admission as every render today**: the durable request key is saved first, and the hold is checked again against the **balance, the production's cap, the workspace's monthly allowance and the run's limit** inside the reservation. The plan approval only replaces the tap; it removes none of these checks.

## When things go differently
- **Would exceed the approved total:** refused at the hold ("This would pass the limit approved for this run. Nothing was charged."); the run waits for the person to raise the limit, skip, or stop.
- **The quote changes** (prompt, reference, engine or price moved): that render asks again at the new price. It is never adopted silently, even if cheaper (owner decision 7).
- **A render fails with nothing billed:** "Nothing billed" and Retry, under the same approval and price, as a new attempt with a new key. It is not a fix and uses no allowance.
- **A render fails and was charged, or is refunded:** the approval counts what the ledger actually charged. A refund lowers what is used, so its credits return to the approval's room (and the balance). A re-render of a failed shot is a fix.
- **The person cancels** (Stop): unsent renders are let go with nothing charged, renders already sent settle at what they cost, and the approval closes. Hold on the card spends nothing.
- **The balance runs short:** checked against T before approval (Approve waits, with Top up); checked again at every hold. If short mid-way, that render pauses with "Top up, then press Retry" and nothing is charged.

## Ask stays the default outside a plan
Make, one-off renders, Retry on a charged take, anything Atomik proposes outside an approved plan, and anything listed above as "asks again" all keep today's one-tap-at-its-price. Auto (drafts under the per-job line) is unchanged (owner decision 6).

## The phone
The phone plan screen reads the same model: the steps with prices, the fix line, the Total, the balance after, and one pinned button **Approve · 93 cr** (or Build · free before the build; Top up when short). The tab bar is hidden on this screen. After approval it says "Approved · 93 cr, at most 186 cr" and goes Home.

## Fits A1 later
This is the A1 paid path with the plan as the approval's scope: **quote** (each step priced by the existing preparation) → **approval** (one person's row, scope = plan, with its limit) → **durable claim** (the request key saved before sending) → **poll** → **collect** (settled credits and the provider's outcome from the ledger). When A1 lands, `rig_plan_approvals` becomes `tool_approvals` rows with scope `plan`; no second path is made.

## Owner decisions needed
1. **"At most 186 cr" means the whole plan, fixes included, never exceeds 2 × T.** The scope's words "a fix allowance of 2 × the plan's shot prices" can also be read as fixes up to 2T on top (ceiling 3T, 279 cr). Built: 2T, the smaller, matching the card. Confirm.
2. **One approval replaces the per-render taps inside a plan** (rule 14 over lead decision 27); Ask stays the default outside a plan.
3. **Fixes are drawn by the person** ("Fix" on a rendered shot, no price question, inside the allowance). Atomik drawing fixes by itself (U1 decision 3) waits for S2/P6b and your yes.
4. **How long an approval lasts:** 7 days, or until the run ends or is stopped.
5. **Two taps in all:** Build · free, then Approve · T. Shots that do not exist yet cannot be priced. Accept for Release 1, or later price planned shots before the build so it is one tap.
6. **Auto runs** keep today's behaviour (no plan gate) for now. Alternative: Auto runs also stop at the plan gate.
7. **A changed quote always asks again**, even when cheaper. Alternative: adopt an equal or lower price silently.
8. **Steps above the per-job line (200 cr) or needing an admin** are not covered by the plan approval; they ask (or wait for an admin) on their own, and the card says so.
9. **The balance check at approval is against T** (rule 14), not 2T; every hold checks again.
