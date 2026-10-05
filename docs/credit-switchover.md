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

**Where it stands (5 October).** `CREDIT_USD` is already set back to 0.10 on
Vercel, for Production and Preview, and stays so. Nothing has deployed since, so
the live build still runs at $0.80 (an env change takes effect only at a build).
**The deploy of PR #524 is the switch:** it is the first build at $0.10.

**How the conversion works (PR #524).** Per row, exact:
- rows from before the cutover stay as they are;
- rows from inside the $0.80 window are ×8. The window is `[cutoverAt, endAt)`:
  `endAt` is when an instance first ran at $0.10 (recorded on its own as
  `pausedSince`), so a sign-up or grant after that is never ×8;
- a job is restated by the price it was reserved at (`meter_events.credit_usd`),
  a pack by its own dollars. A job reserved at $0.10 before the cutover keeps
  its credits, even if it settles after the merge;
- **caps** (shot cap, production and project caps, API token ceilings, the
  platform's default production cap) carry no time they were set, so none is
  guessed: the dry run lists each, in credits and in dollars at both prices, and
  each is **kept** unless you choose `x8` for it. The per-shot default stays 50 cr.

Every balance ends at the dollars actually paid or granted: a workspace that
holds only credits from before the cutover keeps its credit count, and one with
$0.80-window credits keeps their dollar value (×8 credits). A workspace whose
balance would go **down or below zero** (it spent pre-cutover $0.10 credits on
$0.80 jobs) is listed under `needsDecision` with the dollars. It is never
converted until you decide `goodwill` or `apply` for it.

**The pause is automatic.** On its first start, the merged build reads the
record: if any workspace (the house aside) wrote credits, jobs, grants or pack
requests since 2 October 15:33 UTC, the ledger counts in $0.80. `CREDIT_USD` is
0.10, so every new paid job is refused with "Paid work is paused for a few
minutes while we update pricing. Nothing has been charged." This holds from
the first request the new build serves: every billing write waits for that
first read. Free actions keep working. Jobs already running finish and settle
at the price they were approved at. Held takes stay held and are converted with
the balances. The conversion ends the pause.

**At a glance.** Each step says what you should see; send Claude what it
asks for, privately, never in the repo.

| Step | Where | You should see | Send Claude |
|---|---|---|---|
| 0 | Turso, Vercel, `/admin` → Workspaces and Top-ups, the console | backups; `CREDIT_USD` 0.10; /pricing still $0.80; every workspace's balance, credits granted, used, bought and given, jobs and running jobs; open pack requests | the cutover time, the two tables, the running total |
| 1 | GitHub (merge), then the console | `creditUsd 0.1`, `ledgerUnitUsd 0.8`, `pausedSince`; the pause message on a paid button | the GET output |
| 2 | the console (dry run) | one line per workspace, before and after in credits and dollars; `needsDecision`; `caps` | the tables and your decisions |
| 3 | the console (convert) | `ledgerUnitAfter 0.1`, `waiting` empty; paid buttons work | the result |
| 4 | `/admin`, `/statements`, `/pricing` | balances × $0.10 = the dry run's dollars | "checks done" |

---

## 0. Before you merge (read-only)

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
3. **Check the variable and the live build.** Vercel → Settings → Environment
   Variables: `CREDIT_USD` reads `0.10` for Production. particl.si/pricing still
   reads "1 credit = US$0.80" (the live build is the $0.80 one).
4. **Your list of workspaces.** Signed in on particl.si as the platform owner,
   open the devtools console and paste:
   ```js
   const d = await (await fetch("/api/admin/invites")).json();
   console.table(d.workspaces.filter((w) => !w.deletedAt).map((w) => ({
     name: w.name, id: w.id, owner: w.owner?.email, house: Boolean(w.house),
     balance: w.credits?.balance, granted: w.credits?.granted, used: w.credits?.used,
     bought: w.grants?.paid, given: w.grants?.free,
     jobs30d: w.spend30?.jobs ?? 0, running: w.spend30?.running ?? 0,
   })));
   const q = await (await fetch("/api/admin/topups")).json();
   console.table(q.open.map((t) => ({ workspace: t.workspaceName, pack: t.label, credits: t.credits + t.bonus, usd: t.usd, asked: new Date(t.createdAt).toISOString(), by: t.requesterEmail })));
   ```
   These are the reads behind `/admin` → **Workspaces** (balance under KEYS,
   jobs and "N running" under 30 DAYS) and `/admin` → **Top-ups**; they change
   nothing. Credits here are as recorded (two units mixed); the exact
   per-workspace window, with dollars, comes from the dry run in step 2. No
   existing screen totals "since 3 October" before the merge: `jobs30d` covers
   30 days.
5. **Nothing running, nothing waiting.**
   - `running` in the table above: paid jobs reserved and not yet settled,
     platform-wide (a Cinema Studio take's hold is one of them). Wait for it to
     read 0 everywhere, or accept them: a running job settles at the price it
     was approved at and is converted with its workspace, so the dollars stay
     exact either way.
   - The second table: pack requests still open. Approve or decline any you
     already intend to before the merge; the conversion declines the ones still
     open at $0.80 terms.
   - Takes held for credits live in each workspace's own database; no
     platform-wide screen lists them before the merge. Nothing is charged
     while a take is held. The dry run (step 2) lists them per workspace.

## 1. Merge PR #524: the switch

Merge it. Production builds with `CREDIT_USD` = 0.10, and paid work pauses on
its own (see "The pause is automatic").

- *Check:* signed in as the platform owner, in the console:
  ```js
  await (await fetch("/api/admin/credit-unit")).json()
  ```
  It must show `creditUsd: 0.1`, `ledgerUnitUsd: 0.8` and a `pausedSince` time
  (the end of the $0.80 window, about when the build went live).
  - If it shows `ledgerUnitUsd: 0.1` and `pausedSince: null`: nothing was
    written by any workspace since 2 October 15:33 UTC, so there is nothing to
    convert and nothing was paused. Run the dry run (step 2) to confirm it shows
    no changed rows, then go to step 4.
  - Anything else: **stop**, roll back (below) and ask Claude.
- *Check:* a paid button in your own workspace answers with the pause message.
  A free action (opening a project, a price quote) works.
- Prices now read in $0.10 credits, but balances are still $0.80 credits until
  step 3, so balances look 8× smaller. Keep steps 1 to 3 short.
- For a minute or two, instances of the previous build can finish requests
  already under way and admit them at $0.80. Those jobs are converted by their
  own price, so the figures stay exact, but the pause is not absolute.
- *Roll back (only before step 3):* Vercel → Instant Rollback to the previous
  deployment. It runs at $0.80 over the unconverted $0.80 record, as before.
- **After any rollback and a redeploy of #524**, `pausedSince` still shows the
  first deploy's time, while the $0.80 build may have written more since. In
  steps 2 and 3, add `endAt`: the time the redeployed build went live (Vercel
  "Ready" time, ISO with `Z`). The step 1 check tells you: a `pausedSince`
  earlier than this deployment's Ready time means it happened. A conversion
  without `endAt` refuses when a $0.80 job was approved well after
  `pausedSince`; grants alone leave no such trace, so give `endAt` either way.

## 2. Dry run (changes no balance)

In the console, with your `cutoverAt` from 0.2:

```js
const r = await (await fetch("/api/admin/credit-unit", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ action: "convert", fromUnitUsd: 0.8,
                         cutoverAt: "2026-10-03T14:39:00Z" /* yours */ })
})).json();
console.table(r.results.map((x) => ({
  workspace: x.marks?.name ?? x.workspaceId, id: x.workspaceId,
  marks: Object.entries(x.marks ?? {}).filter(([, v]) => v === true).map(([k]) => k).join(" "),
  status: x.status, rowsInWindow: Object.values(x.rows ?? {}).reduce((a, b) => a + b, 0),
  beforeCr: x.before?.balance, beforeUsd: x.before?.balanceUsd,
  afterCr: x.after?.balance, afterUsd: x.after?.balanceUsd,
  boughtLeftCr: x.before?.purchased, includedLeftCr: x.before?.included,
  runningJobs: x.before?.running, reservedCr: x.before?.reserved, openPacksCr: x.before?.pendingPacks,
  heldTakes: (x.tenant ?? []).filter((f) => f.what === "generations.params.held.needs").length,
  shortfallCr: x.shortfall ?? 0, shortfallUsd: x.shortfallUsd ?? 0,
})));
r
```

`cutoverAt` must carry `Z` or an offset; a time with no zone is refused.

**Reading the table.** One line per workspace, internal or external.
- `before` is what the workspace reads today: credits as recorded, dollars at
  $0.80 (what particl.si has shown since 3 October). `after` is credits at
  $0.10 and their dollars.
- `rowsInWindow` above 0 means the workspace had credit activity in the $0.80
  window (jobs, grants, packs, plan credits): those rows are ×8. This is your
  list of every workspace active since the cutover.
- `afterUsd` equals `beforeUsd` for a workspace whose credits all came in the
  window. It is lower for one whose credits were given or bought before the
  cutover: their count stays, and the dollars return to what was paid or
  granted (listed again under `dollarsShownDrop`).
- `status`: `planned` (will convert), `needs-decision` (see below), `new`
  (made after the window: nothing to convert), `house` (never billed in credits).
- `runningJobs`, `reservedCr`: jobs still running and their reservation;
  `openPacksCr`: pack requests still open; `heldTakes`: takes held for credits.

**Then read the rest of `r`:**
- **`needsDecision`:** each workspace whose balance goes down or below zero,
  with the shortfall in credits and dollars. Decide each one: `goodwill` (a
  recorded grant covers the shortfall) or `apply` (the balance takes it). Your
  plan: `goodwill` by default; `apply` for your own and test workspaces. Each
  line carries `marks` (`platformOwner`, `test`, `internal`, `house`).
- **`debts`:** listed apart, no decision needed. Balances already below zero
  before the conversion: they owe the same dollars after, counted in more
  credits.
- **`dollarsShownDrop`:** listed apart, no decision needed (see above).
- **`declinedTopups`:** pack requests open at $0.80 terms, each with the
  requester's name and email, the workspace, the pack, credits and dollars. The
  real run declines them with "Price changed; please ask again at US$0.10."
  Nobody is emailed by the app: you contact them.
- **`caps`:** every stored cap, `capId`, credits, `usdAtTo` ($0.10) and
  `usdAtFrom` ($0.80). Choose `x8` for any set during the $0.80 days that should
  keep its dollars; anything not named is kept as it is.
- **`firstOldPriceJobAt`:** the first job on record approved at $0.80. It should
  sit just after your `cutoverAt`; if it is earlier, recheck the time.
- **`endAt`:** the `pausedSince` from step 1.
- **`comparison.uniform`:** what a flat ×8 would have given. Reference only;
  a real run is always per row.

The dry run writes no balances. It does create the conversion's own record
tables, and it runs each workspace database's pending migrations (the same ones
any page in that workspace would run).

## 3. Convert (the pause ends)

The same request with `dryRun: false`, your decisions and cap choices:

```js
const done = await (await fetch("/api/admin/credit-unit", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ action: "convert", fromUnitUsd: 0.8,
                         cutoverAt: "2026-10-03T14:39:00Z" /* the same */,
                         decisions: { /* "<workspaceId>": "goodwill" | "apply", one per needsDecision */ },
                         caps: { /* "<capId>": "x8", only for caps you want restated; the rest are kept */ },
                         dryRun: false })
})).json();
done.ledgerUnitAfter
```

- Every workspace is converted in one platform transaction, then its own
  database. When the last one is done, the ledger's unit moves to 0.10 and
  **paid work resumes on its own**: `done.ledgerUnitAfter` reads `0.1`.
- `decisions` must cover **every** workspace under `needsDecision`, or the
  request is refused and nothing at all is written. Run the dry run again just
  before, so the list is current.
- `endAt` defaults to `pausedSince` or, once a conversion has run, to the
  window it recorded; give it only to override.
- A real run refuses a window the record cannot have: `cutoverAt` before
  2 October 15:33 UTC (when `CREDIT_USD` = 0.80 was set), in the future, or after
  `firstOldPriceJobAt`; an `endAt` not after `cutoverAt`, or in the future.
- A workspace half that failed (for example, its database was unreachable) is
  recorded, listed under `waiting`, and keeps paid work paused. Sending the
  same request again finishes it; converting twice converts once. If a
  workspace's own database is gone for good, add `skipTenant: ["<workspaceId>"]`
  and it is marked skipped. A skipped half is never converted later: that
  workspace's caps and limits stay as they were, the stricter side. A deleted
  workspace never holds the platform up.
- Once the ledger counts in $0.10, a real run converts nothing new: it only
  finishes or skips failed halves, and converts again a workspace that a
  reversal put back (see Roll back).
- *Check:* `done.waiting` is empty, and `GET /api/admin/credit-unit` shows
  `ledgerUnitUsd: 0.1`.
- **From here on, never Instant-Rollback to a deployment from before #524.**
  That build runs at $0.80 and would read the converted $0.10 credits at $0.80:
  eight times the dollars. Reverse first (below), or restore the backup.
- *Roll back:* `{ action: "reverse", dryRun: false }` gives back the exact
  numbers, **only before paid work resumes**. It is refused for everyone, and
  lists why, once any workspace has a job, grant or running job written after
  its conversion, or anything saved since in its own database: a cap, an Atomik
  run limit or step, a pipeline attempt, a held take. A workspace whose own
  database cannot be read refuses it too. After that, the backup is the way back.
  - A reversal takes back goodwill grants (anything already spent from one stays
    as debt) and leaves declined requests declined.
  - The ledger goes back to 0.80, which pauses paid work again. Then convert
    again with the same request, with no `endAt` (it reuses the window the
    first conversion recorded). Only after a reversal may you Instant-Rollback
    to the $0.80 build; once particl.si takes paid work at $0.80 again, the
    recorded window no longer covers the record and a later conversion refuses
    to use it: ask Claude before converting.
  - If a workspace's own half fails during a reversal, it is listed: send the
    reversal again to finish it.
  - **One workspace**, with `workspaceId` (to change its decision, say): only
    that workspace goes back to $0.80 credits, and it alone is paused until you
    convert it again with the same `workspaceId` and its decision. Everyone else
    keeps working.
  - Last resort: restore the step 0 backup.

## 4. Check a sample of balances in dollars

- `/admin` → Workspaces: pick five or six you know, and include one from
  `needsDecision` and one with a pack. Balance × $0.10 must equal the dry run's
  `afterUsd`.
- `/statements` in two workspaces: past purchases show the dollars paid. Past
  jobs show credits in the new unit for the same dollars, and the foot reads
  "Credits shown at US$0.10 each from <the day of step 3>."
- `/admin` top-up queue: no request left open at $0.80 terms.
- `/pricing`: "1 credit = US$0.10", Starter $50 · 500 cr, plans 400 / 1,600 /
  9,000 cr, welcome 250 cr.
- *Roll back:* as in step 3.

## 5. Resume

Paid work resumed at the end of step 3.
- Run one cheap paid job in your own internal workspace (a Nano Banana 2 still,
  1 cr) and check it bills 1 cr.
- Watch the first few customer jobs' `billed_credits` in `/admin`.

## 6. Afterwards

A separate PR sweeps the site's copy for $0.10. It changes no money and does
not depend on this runbook.

---

## By hand, outside the code

| What | Where | Change | When |
|---|---|---|---|
| `CREDIT_USD` | Vercel, one entry for Production and Preview | `0.10` (set already; keep it) | Before step 1 |
| `CREDIT_USD` | Coolify, before particl.si's DNS moves there (P4/P5) | `0.10`, and copy the **already converted** database | At the move, not today |
| `SIGNUP_CREDITS`, `CREDIT_PACKS` | Vercel | not set, so the code defaults apply (250 welcome; §7A packs) | Nothing |
| Platform layer overrides (welcome credits, plans) | `/admin` platform layer | kept as set (the default production cap is in the run's `caps` list); if welcome or plans were set during the $0.80 days, set them for $0.10 | After step 3 |
| Requesters whose $0.80 pack requests were declined | email or message, outside the app (names and emails are in the dry run's `declinedTopups`) | tell them to ask again at US$0.10 | After step 5 |
| Money taken off-platform | your records | none was taken at $0.80 prices (owner, 5 Oct); nothing to reconcile | — |
| Stripe / Razorpay | not wired; Production uses `manual` (`lib/payments.ts`) | nothing | — |
| Anything published that quoted $0.80 or "500 cr for $400" | outside the repo | correct it | After step 5 |

## Never by Claude

Claude never changes Vercel or Coolify settings, Turso, DNS or a payment
provider. Claude never calls `/api/admin/credit-unit` or any other API on
particl.si, and never reads a production database.
