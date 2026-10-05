# Credit switchover: particl.si back to US$0.10 a credit

For the owner, in one sitting (about 45 minutes). Every step is the owner's;
Claude does none of them.

**Decision (5 October 2026).** 1 credit = US$0.10, as `CLAUDE.md` § Pricing and
the code default already say. Same dollars, new unit: no balance gains or loses
a cent, and no job, pack or plan costs more or less.

**What happened.** `CREDIT_USD` = 0.80 was set on Vercel (one entry, Production
and Preview) on 2 October at 15:33 UTC. It took effect at the first Production
build after that, on 3 October at about 14:39 UTC. Nothing converted the
balances, so the record holds two units: rows from before the cutover are $0.10
credits, rows from after it are $0.80 credits.

**How the conversion works (PR #524).** Per row, exact:
- rows from before the cutover stay as they are;
- rows from inside the $0.80 window are ×8. The window is `[cutoverAt, endAt)`:
  `endAt` is when an instance first ran at $0.10 (recorded on its own as
  `pausedSince`), so a sign-up or grant during the pause, or after, is never ×8;
- a job is restated by the price it was reserved at (`meter_events.credit_usd`), a pack by its own dollars;
- **caps** (shot cap, production and project caps, API token ceilings, the
  platform's default production cap) carry no time they were set, so none is
  guessed: the dry run lists each, in credits and in dollars at both prices, and
  each is **kept** unless you choose `x8` for it. The per-shot default stays 50 cr.

Every balance ends at the dollars actually paid or granted. A workspace whose
balance would go **down or below zero** (it spent pre-cutover $0.10 credits on
$0.80 jobs) is listed under `needsDecision` with the dollars. It is never
converted until you decide `goodwill` or `apply` for it.

**The pause is automatic.** The ledger stores the price it counts in. While
`CREDIT_USD` differs from it, every new paid job is refused with "Paid work is
paused for a few minutes while we update pricing. Nothing has been charged."
Free actions keep working. Jobs already running finish and settle at the price
they were approved at. Held takes stay held and are converted with the balances.

---

## 0. Before you start

1. **Back up the production databases**: the platform database and every
   workspace database. Use `node scripts/ops/backup-restore.mjs`
   (`docs/backup-restore.md`), or make Turso copies
   (`turso db create <copy> --from-db <prod-db>`).
   *Check:* the copies exist with a timestamp from now.
2. **Write down `cutoverAt`.** It is the time the first Production deployment
   built with `CREDIT_USD` = 0.80 went live: Vercel → particlstudio →
   Deployments, the 3 October redeploy of `a381ee67`, "Ready" time, or
   `vercel ls --prod`. Use it as an ISO time, for example `2026-10-03T14:39:00Z`,
   to the minute or better.
3. **Optional, but best: a full rehearsal on a copy.** Point a Preview's
   database variables at the Turso copies and follow "Preview test" in PR #524's
   description. This runs the real conversion on a copy, with the real data.

## 1. Merge PR #524 while particl.si is still at $0.80

Merge it. Production builds at `CREDIT_USD` = 0.80, and the ledger records
0.80 as its unit on first use.

- *Check:* signed in on particl.si as the platform owner, in the devtools console:
  ```js
  await (await fetch("/api/admin/credit-unit")).json()
  ```
  It must show `creditUsd: 0.8` and `ledgerUnitUsd: 0.8`. If `ledgerUnitUsd`
  is anything else, **stop**: roll back (below) and ask Claude.
- particl.si looks and charges exactly as before.
- *Roll back:* Vercel → Instant Rollback to the previous deployment. Nothing
  else changed.

## 2. Dry run on particl.si (changes nothing)

Still at $0.80, preview the conversion to $0.10. A dry run is a transaction
that is rolled back. `cutoverAt` must carry `Z` or an offset; a time with no
zone is refused.

```js
await (await fetch("/api/admin/credit-unit", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ action: "convert", fromUnitUsd: 0.8, toUnitUsd: 0.1,
                         cutoverAt: "2026-10-03T14:39:00Z" /* yours, from 0.2 */ })
})).json()
```

Read it:
- **Each workspace:** balance before → after in credits, and in dollars. Dollars
  before and after are identical, except under `needsDecision`.
- **`needsDecision`:** each workspace whose balance goes down or below zero,
  with the shortfall in credits and dollars. Decide each one: `goodwill` (a
  recorded grant covers the shortfall) or `apply` (the balance takes it).
- **Marks:** internal, house, your own and test workspaces are marked, not
  left out. The house workspace is skipped (it is never billed in credits).
- **Open top-up requests at $0.80 terms:** listed. The real run declines them
  with "Price changed; please ask again at US$0.10." Nobody is emailed.
- **`firstOldPriceJobAt`:** the first job on record approved at $0.80. It should
  sit just after your `cutoverAt`; if it is earlier, recheck the time.
- **`dollarsShownDrop`:** listed apart, no decision needed. Workspaces whose
  balance reads fewer dollars after, because their credits were written at
  $0.10 and particl.si has shown them at $0.80 since 3 October. The "after" is
  what was actually paid or granted.
- **`caps`:** every stored cap, `capId`, credits, `usdAtTo` ($0.10) and
  `usdAtFrom` ($0.80). Choose `x8` for any set during the $0.80 days that should
  keep its dollars; anything not named is kept as it is.
- **Open top-up requests at $0.80 terms (`declinedTopups`):** each with the
  requester's name and email, the workspace, the pack, credits and dollars. The
  real run declines them with "Price changed; please ask again at US$0.10."
  Nobody is emailed by the app: you contact them.
- **Your plan for `needsDecision`:** `goodwill` by default; `apply` for your own
  and test workspaces. Each line carries `marks` (`platformOwner`, `test`,
  `internal`, `house`) so you can tell them apart.
- **`comparison.uniform`:** what a flat ×8 would have given. Reference only;
  a real run is always per row.

*Roll back:* nothing to roll back.

## 3. Pause: set `CREDIT_USD` to 0.10 and redeploy

Vercel → particlstudio → Settings → Environment Variables → **edit**
`CREDIT_USD` to `0.10`. Edit it; don't delete it, so a future change to the code
default can't move particl.si. Then Deployments → Redeploy the current
Production deployment. An env change takes effect only at a build.

From the moment that build is live, paid work is paused on its own.

- *Check:* `GET /api/admin/credit-unit` shows `creditUsd: 0.1`,
  `ledgerUnitUsd: 0.8` and a `pausedSince` time: the end of the $0.80 window.
- *Check:* a paid button in an internal workspace answers with the pause
  message. A free action (opening a project, a quote) works.
- Keep this window short. Prices now read in $0.10 credits, but balances are
  still $0.80 credits until step 4, so balances look 8× smaller.
- The same entry targets Preview. Previews also run at 0.10 from their next
  build, and a preview whose database was seeded at 0.80 shows the pause until
  converted.
- *Roll back:* set `CREDIT_USD` back to `0.80` and redeploy. Paid work resumes,
  and nothing was converted.

## 4. Convert

Same request as step 2, with `dryRun: false`, your decisions, and no `toUnitUsd`
(a real run always converts to the deployed price):

```js
await (await fetch("/api/admin/credit-unit", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ action: "convert", fromUnitUsd: 0.8,
                         cutoverAt: "2026-10-03T14:39:00Z",
                         decisions: { /* "<workspaceId>": "goodwill" | "apply", one per needsDecision */ },
                         caps: { /* "<capId>": "x8", only for caps you want restated; the rest are kept */ },
                         dryRun: false })
})).json()
```

- Every workspace is converted in one platform transaction, then its own
  database. When the last one is done, the ledger's unit moves to 0.10 and
  **paid work resumes on its own**.
- `decisions` must cover **every** workspace under `needsDecision`, or the
  request is refused and nothing at all is written. Run the dry run again just
  before, so the list is current.
- `endAt` defaults to `pausedSince`; give it only to override.
- A workspace half that failed (for example, its database was unreachable) is
  recorded, listed under `waiting`, and keeps paid work paused. Sending the
  same request again finishes it; converting twice converts once. If a
  workspace's own database is gone for good, add `skipTenant: ["<workspaceId>"]`
  and it is marked skipped. A deleted workspace never holds the platform up.
- Once the ledger counts in $0.10, a real run converts nothing more; it only
  finishes or skips failed halves.
- *Check:* the response lists no `waiting` and no failures, and
  `GET /api/admin/credit-unit` shows `ledgerUnitUsd: 0.1`.
- *Roll back:* `{ action: "reverse", dryRun: false }` restores every number
  exactly, **only before paid work resumes**: once any workspace has a job,
  grant or running job written after the conversion, the reversal is refused for
  everyone and lists them. After that, the backup is the way back. It takes back goodwill grants (anything already spent from one stays
  as debt) and leaves declined requests declined. The ledger goes back to 0.80,
  which pauses paid work again. Then either convert again, or set `CREDIT_USD`
  back to 0.80 and redeploy. Last resort: restore the step 0 backup.

## 5. Check a sample of balances in dollars

- `/admin` → Workspaces: pick five or six you know, and include one from
  `needsDecision` and one with a pack. Balance × $0.10 must equal the dry run's
  "after" dollars.
- `/statements` in two workspaces: past purchases show the dollars paid. Past
  jobs show credits in the new unit for the same dollars, and the foot reads
  "Credits shown at US$0.10 each from <the day of step 4>."
- `/admin` top-up queue: no request left open at $0.80 terms.
- `/pricing`: "1 credit = US$0.10", Starter $50 · 500 cr, plans 400 / 1,600 /
  9,000 cr, welcome 250 cr.
- *Roll back:* as in step 4.

## 6. Resume

Paid work resumed at the end of step 4.
- Run one cheap paid job in your own internal workspace (a Nano Banana 2 still,
  1 cr) and check it bills 1 cr.
- Watch the first few customer jobs' `billed_credits` in `/admin`.

---

## By hand, outside the code

| What | Where | Change | When |
|---|---|---|---|
| `CREDIT_USD` | Vercel, one entry for Production and Preview | `0.10` | Step 3 |
| `CREDIT_USD` | Coolify, before particl.si's DNS moves there (P4/P5) | `0.10`, and copy the **already converted** database | At the move, not today |
| `SIGNUP_CREDITS`, `CREDIT_PACKS`, `CREDIT_MARGINS` | Vercel | not set, so the code defaults apply (250 welcome; §7A packs) | Nothing |
| Platform layer overrides (welcome credits, plans) | `/admin` platform layer | kept as set (the default production cap is in the run's `caps` list); if welcome or plans were set during the $0.80 days, set them for $0.10 | After step 4 |
| Requesters whose $0.80 pack requests were declined | email or message, outside the app (names and emails are in the dry run's `declinedTopups`) | tell them to ask again at US$0.10 | After step 6 |
| Money taken off-platform | your records | none was taken at $0.80 prices (owner, 5 Oct); nothing to reconcile | — |
| Stripe / Razorpay | not wired; Production uses `manual` (`lib/payments.ts`) | nothing | — |
| Anything published that quoted $0.80 or "500 cr for $400" | outside the repo | correct it | After step 6 |

## Never by Claude

Claude never changes Vercel or Coolify settings, Turso, DNS or a payment
provider. Claude never calls `/api/admin/credit-unit` or any other API on
particl.si, and never reads a production database.
