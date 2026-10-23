# A server record of "training sent", seen on every device — [schema] plan

Status: **plan, for the owner's yes.** Docs only. No migration, product code or test is written until he says yes ("A schema migration waits for my yes: plan and docs only").

Code read at `origin/release/1` `f542e552`; every `file:line` is on that commit.

---

## 1. The problem

Handover, section d, item 9: "A card on another browser can still offer Train for a training already sent."

How a card knows a training was sent today:

- **The browser that pressed Train** saves the exact request in `localStorage` before sending (`lib/usePaidAction.ts:23-27`, `:132-142`). Until its reply is read, the Cast card reads that saved request (`components/graphite/board/cards/cast/CastCard.tsx:58-62`) and passes `requestSaved` (`:68`) to `identityCardView`, which shows "Training sent · reply not read yet" (`lib/security/identity-card.ts:107`) with Recover instead of Train (`components/graphite/security/IdentityBlock.tsx:84-88`).
- **The reply** binds the new identity to the card (`CastIdentities.tsx:116` → `bindStarted`, `components/graphite/board/inspector/CastBody.tsx:54-71`). A bound identity speaks for the card on every device (`identity-card.ts:97-105`).
- **A cited consent tick** is linked to the identity on the server (`app/api/soul/identities/route.ts:86`), and the card finds the identity through that link on any device (`identity-card.ts:88`).

Since #894 (consent is a tick, not a gate) a training may cite no tick. Then, until the pressing browser reads the reply, nothing on the server ties the training to its card. Another browser lists the identity (same person, same draft: `lib/soulIdentities.ts:355-370`) but cannot place it, so its card says "No identity yet" with Train, and its Inspector offers the Build identity form again.

Only the draft's owner can train or list identities for it (`lib/soulIdentities.ts:215-232`, `:361-370`), so "another browser" is the same person on another device or window.

---

## 2. The fix in one line

Write, on the server, which card a training was sent from, at the moment it is sent, for every training (ticked or not). The card reads it the way it reads the consent link today.

---

## 3. The table [schema]

A new table in each workspace's own database. No existing table is changed.

```sql
CREATE TABLE IF NOT EXISTS identity_training_sends(
  workspace_id TEXT NOT NULL CHECK(workspace_id <> ''),
  identity_id  TEXT NOT NULL,   -- soul_identities.id
  project_id   TEXT NOT NULL,   -- the production the press was made in (the request's projectId)
  subject_key  TEXT NOT NULL,   -- the Cast card's id (the request's subjectKey)
  sent_by      TEXT NOT NULL,   -- the person who pressed
  sent_at      INTEGER NOT NULL,
  PRIMARY KEY(workspace_id, identity_id))
CREATE INDEX IF NOT EXISTS idx_identity_training_sends_card
  ON identity_training_sends(workspace_id, project_id, subject_key, sent_at)
```

- `workspace_id` on every row, first in the key and the index; every statement binds it (ground rule 2).
- **No money column:** no credits, no dollars, no price. **No consent column:** the tick stays in `identity_consents` and is never required. **No request key:** the saved request stays with the browser that sent it.
- A new table rather than a column on `soul_identities`: that table has no `workspace_id`, holds the paid claim and cost, and is read by settlement. The record stays out of it.

### How it is made (the repo's real mechanism)
There are no migration files. Each module makes its tables on first use with `CREATE … IF NOT EXISTS`, memoised per client. The identities module does this in `soulIdentitiesReady()` (`lib/soulIdentities.ts:146-187`): one write batch, forgotten on failure so the next call retries.

The two statements join that batch, after `soul_identities` and its index (`:155-163`). So the table exists wherever `soul_identities` does, and the list query (§5) can always read it.

- **Idempotent:** `IF NOT EXISTS` on both; a second boot changes nothing; a batch is all or nothing.
- **No backfill:** a card's id was never stored with a training before, so there is nothing to backfill from. Older trainings behave as today.

---

## 4. Where it is written

At the moment training is sent, inside the existing training route's one claimed run: `POST /api/soul/identities` (`app/api/soul/identities/route.ts:57-107`) claims the request (`:79`) and calls `createSoulIdentity(body, claim)` (`:84`).

`createSoulIdentity` makes the identity in one write transaction **before anything is reserved or sent** (`lib/soulIdentities.ts:681-739`): it inserts the identity as `submitting` (`:692`) and stores the claim's reply in the same write (`:729-737`). The record's `INSERT` goes into that same transaction, right after the identity's:

- so an identity sent from a card (both fields below present and valid) never exists without its record, and a record never exists without its identity;
- it is written before the reservation (`:742`) and before the trainer is asked (`:780`), so every device sees it for the whole time the training runs.

Details:
- `subjectKey` is already in the request body the Inspector sends (`components/graphite/production/CastIdentities.tsx:110-112`). It joins `CreateSoulIdentityInput` (`lib/soulIdentities.ts:388-400`) as an optional field. **The client body does not change**, so the request's fingerprint and every saved request replay exactly as before.
- **A record is written only when both fields are there:**
  - `projectId` is present. `cleanInput` accepts a training with no production (`lib/soulIdentities.ts:422-428`), and `project_id` is `NOT NULL`, so without this condition such a body would fail the identity's own transaction and refuse the training. With a production named, `productionFor` has already checked it is the person's own draft, in the same transaction, before the identity is inserted (`:682-686`);
  - `subjectKey` passes the rule the consent tick already uses for the same card id: `/^[A-Za-z0-9_.:-]{1,160}$/` (`lib/security/consent-words.ts:92`, applied to `subjectKey` at `:116-117`). That rule fits how card ids are made: an entry's card is `cast:<kind>:<entry id>` (`components/graphite/board/cards/cast/cast-model.ts:379`, used at `:423`, `:436`), and a canvas node's card is the node's id (`:402`). The PR shares that one rule rather than writing a second.
- **A record never stops a training.** No `projectId`, no `subjectKey`, or a `subjectKey` that fails the rule: no record is written, and the training goes ahead exactly as before. Nothing is refused for it.
- **The route file does not change.** The write lives in `lib/soulIdentities.ts`. This also keeps `tests/unit/demo-gaps-l5-review-558.spec.ts:137-149` (a guard that loads this route with a fixed module list) untouched.
- **Scoping:** the `INSERT` binds `workspace_id` to `requireTenant().id`, the workspace in scope, never to anything in the request. `sent_by` is the person in scope; `createSoulIdentity` already refuses anyone else and any token or agent (`:658-664`). `project_id` is the request's `projectId`, checked as above.

---

## 5. How the card reads it

No new request. The card already polls `GET /api/soul/identities?projectId=` (`lib/workspace/identities.ts:29-46`, every 8 s while one is training, `:55-63`).

- `listSoulIdentities(projectId)` (`lib/soulIdentities.ts:355-387`) makes one more read: `SELECT identity_id, subject_key FROM identity_training_sends WHERE workspace_id=? AND project_id=? AND identity_id IN (…)`, over the identities it already returns. Same reach as today: only the draft's owner gets any rows (`:361-370`).
- Each listed identity gains `sentFor: string | null`, the card it was sent from. The two `SoulIdentity` types gain the optional field (`lib/soulIdentities.ts:90`, `lib/workbench/soul-identity.ts:5`).
- `CastCard` and `CastBody` pass `sent`: the newest listed identity with `sentFor === card.id`.
- `identityCardView` (`lib/security/identity-card.ts:68-112`) reads it in this order. Every existing path is kept exactly; the record only fills the cases that today fall through to Train:
  1. the bound identity, else the consent link's (`:88-105`), as today;
  2. "Couldn't read this" (`:106`), as today;
  3. this browser's saved request: "Training sent · reply not read yet", with Recover (`:107`), as today;
  4. **new:** the identity the record names, by its own status, using the same words as the consent link: "Training" while it runs, "Training needs review", "Training failed · <what was billed>" with Retry, "Identity ready · <name>";
  5. held, ticked, no identity (`:109-111`), as today.
- **The Inspector** offers the Build identity form only when the card's stage is no identity (ticked or not) or failed, and shows the Recover block wherever this browser holds the saved request. Today `trainable` reads the bound identity only (`CastBody.tsx:48`), so a device that shows "Training" through a consent link still offers the form. Same PR, UI only.

---

## 6. How a reply clears it

Nothing is deleted, and nothing needs writing (rule 13). The record stops speaking on its own:

- **The reply is read** on the pressing browser, live or by Recover: the identity is bound to the card (`CastBody.tsx:54-71`), and a bound identity is read before the record (step 1 above).
- **The training's outcome is known:** the card shows it (ready, or failed with what was billed and Retry), as the consent link does. Retry is a new press at its price, as today.
- A card later bound to another identity reads that one first.

---

## 7. Recover

Recover is unchanged and stays on the browser that holds the saved request:

- It replays the same request under the same `Idempotency-Key` (`lib/usePaidAction.ts:157-170`). The server answers from the stored reply (`lib/generationRequests.ts:249-260`), written in the same transaction as the identity and its record. `createSoulIdentity` does not run again: no second record, no second charge.
- If the claim never reached the identity's transaction, there is no identity and no record; Recover gets today's answer, and nothing was reserved or sent.
- Another device has no saved request, so it offers no Recover and no Train; it shows the training's state from the record.

---

## 8. Money: nothing changes

Training is a paid step. This plan does not change **what** is charged, **when**, or **any approval**:

| What | Where | Why it is unchanged |
|---|---|---|
| The price | `cleanInput`, `lib/soulIdentities.ts:462-478`; the button, `CastIdentities.tsx:22-27`, `:192` | the record reads and writes no figure |
| The person's approval | the press sends the fixed price as `maxCredits` (`CastIdentities.tsx:112`), checked at `lib/soulIdentities.ts:470-478` | the body is unchanged, so the same figure is approved and checked |
| Who may train | `route.ts:61-64`, `lib/soulIdentities.ts:658-664` | unchanged; the record is written only on a person's press that passed both |
| Idempotency | the claim, `lib/generationRequests.ts:196-201`, `:233-260`; its reply, `lib/soulIdentities.ts:729-737` | the fingerprint covers the body, which is unchanged; a replay never re-runs the write |
| When it is charged | the reservation after the identity's write (`:740-752`); "charged once the trainer accepts it" (`CastIdentities.tsx:189`; the trainer call at `:780`) | the record's `INSERT` sits before both and changes neither |
| Failure | "Nothing billed" when nothing was sent (`failUnsent`, `:744-751`); the charge when there was one (`identity-card.ts:61-66`) | unchanged; a refused reservation still fails the identity unsent, and the record then shows "Training failed · Nothing billed" |
| Consent | `route.ts:67-78`, `:86` | unchanged. The record has no consent column and is written ticked or not. A tick is never required (#894); no gate is added |
| The credit-unit conversion | `lib/creditConversionTenant.ts:68-91` | the table has no credit column, so nothing joins it |

The record's `INSERT` adds no new reason for the identity's write to fail:
- it runs only when `projectId` is present and `subjectKey` passes the rule (§4), so every `NOT NULL` column has a value;
- `identity_id` is the id just made, so the primary key cannot collide;
- the table is made in `soulIdentitiesReady()` before the transaction opens, so it is never missing.

What is left is the database refusing a write, which would refuse the identity's own `INSERT` today. Then nothing is reserved or sent, and the claim answers as it does now.

No vendor call, tool, MCP door or price path is added or changed.

---

## 9. Tests

Unit specs on file databases, `ENGINE_MOCK=1`, no network; the browser spec on the mock server.

| Spec | Test | Proves |
|---|---|---|
| `tests/unit/identityTrainingSent.spec.ts` | a press from a card records its card | an unticked press with `subjectKey` writes one record (this workspace, this production, this card, this person) in the identity's own write, before any reservation |
| | ticked or not | ticked and unticked presses both record and both train; nothing is refused for want of a tick |
| | no card, no record | without `subjectKey`, or with one that fails the consent rule, no record is written and the training goes ahead as before |
| | no production, no record | a body with a valid `subjectKey` and no `projectId` trains exactly as before: the identity is made, nothing is refused, and no record is written |
| | card ids pass | both kinds of card id (`cast:<kind>:<entry id>` and a node id) are recorded |
| | a replay writes nothing new | the same `Idempotency-Key` replayed returns the first reply and leaves exactly one record |
| | refused, nothing billed | a refused reservation leaves the identity failed unsent, the record in place, and nothing billed |
| | money unchanged | the same press with and without `subjectKey` writes the same reservation, meter row, billed credits, settlement and reply (ids and times aside) |
| | tenant isolation | two databases, then one file holding two workspace ids: each list names only its own workspace's records |
| | reach | the list carries `sentFor` only for a draft the reader owns; anyone else gets no identities, as today |
| | schema | made with `soul_identities`; idempotent on a database with data; changes no existing table; `workspace_id` leads the key and the index; no credit, dollar or consent column |
| `tests/unit/identityCardSent.spec.ts` | another device | a card with a record and no bound identity shows the training's state and offers no Train; ready and failed show as the consent link shows them |
| | the pressing browser | with its saved request, the card still says "Training sent · reply not read yet" with Recover |
| | the Inspector | the form is offered only for no identity or a failed one; the Recover block shows wherever the saved request is |
| `tests/identity-sent-cross-device-workbench.spec.ts` | two windows, one person | window A presses Train and its reply is dropped; window B opens the same production: its card shows "Training", no Train button, and no Build identity form; when the mock training is ready, both show it; A's Recover binds it. At 360×640, 390×844, 844×390, 1440×900 and 1920×1080 (rule 7) |

Kept green without edits: `tests/unit/demo-gaps-l5-consent.spec.ts`, `tests/unit/demo-gaps-l5-review-558.spec.ts` (guard), `tests/unit/workspaceCapDoors.spec.ts` (guard; its door for this route, `:438`, is unchanged), `tests/helpers/paidRoutes.ts:30` (unchanged), `tests/unit/soulIdentities.spec.ts`. No guard is edited. The PR touches `lib/` and `components/graphite/`, so CI runs the full plan (`scripts/ci-select.mjs`, `NEVER` list).

---

## 10. Rollback

- **Revert the PR.** Cards go back to today's behaviour. The table stays, unread; nothing is dropped. Trainings, charges and Recover are as before.
- **No switch** (question 4): the write is one `INSERT` in an existing transaction, and the read one `SELECT` in an existing list.

---

## What the owner is asked

1. **Yes to the table and the plan** as written: one new table, made with the identities table, written in the identity's own transaction, read through the existing list.
2. **What another device shows while it runs:** (a) the training's own state, "Training", then ready or failed, the words the consent link already uses (recommended: no new copy, and it moves on by itself); or (b) "Training sent" on every device until the outcome (new words)?
3. **Written inside the identity's transaction** (recommended: never an identity without its record), or after it, best effort, as the consent link is (`route.ts:85-86`), which leaves a gap of up to a few minutes while the trainer is asked?
4. **No switch;** a revert is the rollback. Yes?
5. **The Inspector fix in the same PR** (§5: the form is offered by the card's stage, not the bound identity alone; UI only, no money). Yes?
6. **What happens to the record elsewhere.** It holds ids, a time, and `sent_by` (a person's id). As planned:
   - **Project delete** leaves it. The identities it points at stay too (the route re-files them, `app/api/projects/[id]/route.ts:177`), and the record is only read beside its identity.
   - **Workspace export** leaves it out. It is bookkeeping, as `generation_requests` is, and is not in the export's allowlist (`lib/workspaceExport.ts:48-76`).
   - **Identity purge** runs only inside a workspace purge (`lib/purge.ts:157`), which then removes the whole database (`:207-212`), record included. A purged identity is never listed (`lib/soulIdentities.ts:374`), so its record is never shown.

   Recommend as written. Or should the record be archived with a project delete, or be in the export?
7. **Not in this plan:** a ready identity found through the record (or the consent link) but never bound to its card says "Identity ready" while the card still renders without it, until the pressing browser binds it. Should any device offer Attach (free, undoable, the held path's existing button) for it? A separate UI PR if yes.
