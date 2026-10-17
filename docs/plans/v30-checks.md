# v30 checks: Liveblocks, full-text search, LibreOffice headless, Tesseract

Lane v30-X (checks), 17 Oct 2026. This is evidence, not product code: nothing here changes the app.
Every claim has its command, numbers and versions next to it, and web sources give the URL and the date read.
"Not yet" means I have not seen the result.

Machine: the droplet "particl-app", Linux 6.8.0-146-generic, 8 vCPU / 31 GB visible (`nproc`, `free -g`).
The agent user is capped at **5 cores / 20 GB** by its systemd slice (ops/HEAVY-RULES.txt rule 4), at lower CPU weight than production, which runs on the same box.
Node v24.21.0.

Status:

| Check | Owner's due date | State |
|---|---|---|
| (c) Liveblocks: what we use, what the plans include | 17 Oct (tonight) | done, below |
| (d) Full-text search in libSQL / Turso | 17 Oct (tonight) | done, below |
| (a) LibreOffice headless on the droplet | Sun 18 Oct evening | not yet |
| (b) Tesseract accuracy harness (English, Hindi) | Sun 18 Oct evening | not yet |

---

## (c) Liveblocks

### What release/1 uses today

Command: `git grep -n "@liveblocks" origin/release/1` (origin/release/1 = `85cb7a07`, fetched 17 Oct 15:09 UTC).

Packages in `package.json` and the lockfile: **`@liveblocks/client` 3.24.2** and **`@liveblocks/node` 3.24.2** (plus `@liveblocks/core` 3.24.2, which they pull in).
Nothing else from the scope is installed: no `@liveblocks/react`, `react-ui`, `yjs`, `react-tiptap`, `react-lexical`, `emails`.
`yjs` itself is not a dependency either.

Code that imports it (three files):

| File | What it does with Liveblocks |
|---|---|
| `app/api/collab/auth/route.ts` | ID-token auth: `liveblocks.prepareSession(<workspace>:<user>, { userInfo: { name, color } })`, then `session.allow(room, ["*:write"])` for **one room**, only after `productionOfRoom(room, tenant.id)` and `requireProduction` prove the production belongs to the caller's workspace. |
| `components/workspace/rig/use-team-canvas.ts` | Browser client: `createClient({ throttle: 50, authEndpoint })`, `client.enterRoom(room, { initialPresence, initialStorage })`, `room.getStorage()`, `room.subscribe(root, …, { isDeep: true })`, `room.subscribe("others", …)`, `room.updatePresence(…)`. |
| `lib/workbench/canvas-push.ts` | Server client: `mutateStorage(roomId, …)` (server-made cards pushed into the room from an outbox) and `setPresence(roomId, { userId: "particl-atomik", ttl: 12 })` so Atomik shows as a cursor. |

Config name: `LIVEBLOCKS_SECRET_KEY` (`lib/collab.ts`: collaboration is on only when it matches `/^sk_/`). CSP allows `wss://*.liveblocks.io` (`next.config.ts`).

So, by Liveblocks product:

| Liveblocks product | Used on release/1? | Evidence |
|---|---|---|
| Rooms | **Yes**, one room per production, named by workspace | `productionOfRoom(room, tenant.id)` in the auth route |
| Presence (cursors, selection) | **Yes**: `cursor`, `selected`, `drag`; and Atomik's server-side presence | `type Presence = { cursor; selected; drag }` in use-team-canvas.ts; `setPresence` in canvas-push.ts |
| Storage (Liveblocks Storage CRDT: LiveMap) | **Yes**: `nodes` and `assets` LiveMaps, `order`, `serverMade` | `type Storage = { nodes: LiveMap…; assets: LiveMap…; order; serverMade }` |
| Broadcast events | No | no `broadcastEvent` |
| Yjs (`@liveblocks/yjs`) | **No.** Two docs say it is (`docs/handover-2026-10-05.md:532,599`, `docs/particl-sow-2026-10-04.md:151,214`), but the package is not installed and nothing imports it | `git show origin/release/1:package.json` |
| Comments (threads) | No | no `@liveblocks/react-ui`, no thread calls |
| Text editor (Tiptap / Lexical / BlockNote integration) | No | no `@liveblocks/react-tiptap` / `react-lexical` |
| Notifications (inbox) | No | no inbox calls, no `@liveblocks/emails` |
| AI Copilots | No | |

### The @liveblocks 3.x product line (npm)

Command: `curl "https://registry.npmjs.org/-/v1/search?text=%40liveblocks&size=100"` and `npm view @liveblocks/client dist-tags` (17 Oct 2026, 15:12 UTC).
Latest is **3.24.3** (published 1 Oct 2026); we are on 3.24.2.

| Package (3.24.3) | Product |
|---|---|
| `@liveblocks/client`, `@liveblocks/node` | Rooms, presence, broadcast, Storage; server REST client and auth (what we use) |
| `@liveblocks/react`, `@liveblocks/react-ui` | React hooks; prebuilt Comments, Notifications (inbox) and AI chat components |
| `@liveblocks/yjs` | Yjs documents stored in a Liveblocks room |
| `@liveblocks/react-tiptap`, `@liveblocks/react-lexical`, `@liveblocks/react-blocknote`, `@liveblocks/prosemirror`, `@liveblocks/codemirror` | **Text editor**: collaborative editors with comments and cursors |
| `@liveblocks/node-prosemirror`, `@liveblocks/node-lexical` | Server-side edits to those editor documents |
| `@liveblocks/emails` | Email notifications from notification events |
| `@liveblocks/react-flow`, `@liveblocks/redux`, `@liveblocks/zustand`, `@liveblocks/chat-sdk-adapter` | Integrations |

What the Tiptap integration needs (`npm view @liveblocks/react-tiptap@3.24.2 dependencies peerDependencies`): `@liveblocks/yjs`, `@liveblocks/react`, `@liveblocks/react-ui`, `@liveblocks/prosemirror`, `y-prosemirror`; peers `yjs ^13` and `@tiptap/core|react|pm|suggestion ^3`.
So the Phase B editor on TipTap, through Liveblocks, needs **Tiptap 3**.

Liveblocks' text-editing docs (https://liveblocks.io/docs/ready-made-features/text-editor, which redirects to https://liveblocks.io/docs/products/sync/text-editing; read 17 Oct 2026) describe two ways: "LiveText, the recommended choice for new applications, and Yjs, for editors that require the Yjs ecosystem". They also say "Comments, mentions, cursors, and toolbars work the same in either mode", that "Tiptap and BlockNote AI and experimental offline support currently require Yjs mode", and that "Each LiveText has a 2 MB limit".
Tiptap, BlockNote, ProseMirror and CodeMirror support both; Lexical is "Not supported yet" on LiveText.
`LiveText` is already in our installed 3.24.2 (`class LiveText extends AbstractCrdt` in `node_modules/@liveblocks/core/dist/index.d.ts`).

### What each public plan includes (liveblocks.io/pricing, read 17 Oct 2026 15:11 UTC)

Source: `curl -sSL https://liveblocks.io/pricing` (HTTP 200, 505,371 bytes), tags stripped to text; the copy is kept outside the repo at `~/spikes/liveblocks-20261017/pricing.txt`.
The page carries no "last updated" date.
**Pricing is now credit-based, not seat- or MAU-based.** Every plan lists the same three products, "Sync · Comments · Notifications", and "Monthly active users: Unlimited", "Monthly active rooms: Unlimited".

| | Free | Pro | Team | Enterprise |
|---|---|---|---|---|
| Price | [pricing page](https://liveblocks.io/pricing); figures with the lead (private) | | | Custom |
| Monthly credits | "Free monthly credits" | monthly credits (figure with the lead (private)) | monthly credits (figure with the lead (private)) | custom |
| Products | Sync, Comments, Notifications | same | same | same |
| Simultaneous connections per room | 10 | 10 | 50 | 100 |
| Presence (avatar stack, live cursors, live selection) | Included | Included | Included | Included |
| Storage: CRDT, multiplayer undo/redo, offline | Included | Included | Included | Included |
| Sync engines: Liveblocks Storage; **Yjs** | Included | Included | Included | Included |
| Realtime collaboration minutes | 3,000 included | metered per minute | metered per minute | Custom |
| Realtime data storage updates | 3M included | metered per update | metered per update | Custom |
| Realtime data stored | 1 GB included | metered per GB | metered per GB | Custom |
| Data stored per room | 10 MB | 10 MB | 50 MB | Custom |
| Version history | 24 hours | 30 days | 90 days | Custom |
| **Comments**: threads, reactions, metadata, mentions (user, group, AI) | Included | Included | Included | Included |
| Comments: public/private comments | Not included | Not included | Included | Included |
| Comments created | 200 included | metered per comment | metered per comment | Custom |
| **Notifications**: collaboration notifications | Unlimited | Unlimited | Unlimited | Unlimited |
| Notifications: custom notifications | 200 included | metered per event | metered per event | Custom |
| Channels: in-app, email, Slack, Teams, web push, webhook | Included | Included | Included | Included |
| AI Copilots (agent presence, multiplayer agent editing, …) | Included | Included | Included | Included |
| "Remove Liveblocks branding" | Not included | Included | Included | Included |
| Dashboard seats | 3 | 3 | 10, then paid per seat | Custom |
| Projects | 10 | 10 | 10 | Custom |
| SOC 2 report, SAML SSO | Not included | Not included | Included | Included |
| HIPAA BAA | Not included | Not included | paid add-on | Included |

Prices: see https://liveblocks.io/pricing; figures with the lead (private). The metered rows say "metered" where the page gives a per-unit price beyond the included amount.
`https://liveblocks.io/docs/pricing/plans` (read 17 Oct 2026) adds that credits "reset at the start of each billing cycle and do not roll over"; on Free, hitting a cap pauses the feature.

**The page has no separate "Text editor" product or row.** Text editor is listed under the menu as a use case ("Edit documents together"), not as a product.
It is built from Sync (Storage/LiveText or Yjs) plus Comments, all on every current plan. On today's public plans, then, **text editor and comments are included on every plan**, metered by collaboration minutes, storage updates and comments created.
What none of the plans includes: public/private comments below Team; more than 10 connections per room below Team; SOC 2 / SAML below Team.

**Caveat: this describes the plans sold today. Our account may be on an older plan**, which would have a different name and would not list "monthly credits". The handover (`docs/handover-2026-10-05.md:1123`) says Particl "already pays for" Liveblocks' Yjs support, and `docs/particl-sow.md:167` names "Free or Pro" with a price. Neither is evidence of the account's plan. Only the dashboard can answer it (steps below).

### Steps for the owner: read the plan name and included products (no key needed)

Liveblocks' docs name only the dashboard URLs, not the menu labels (`/dashboard/billing` in docs/pricing/plans; `/dashboard/usage` in https://liveblocks.io/docs/pricing/billing, read 17 Oct 2026).
If a label below differs, go by the URL.

1. Open https://liveblocks.io/dashboard and sign in with the account that owns Particl's Liveblocks team. Billing belongs to team **Owners**: https://liveblocks.io/docs/platform/account-management/manage-team-members (read 17 Oct 2026) lists, as off-limits to members, "editing team settings, such as billing information".
2. Top left, in the scope (team) selector, choose the team that holds the Particl project. The project's secret key is the one set as `LIVEBLOCKS_SECRET_KEY` in the app's server config; do not copy it anywhere.
3. Open **https://liveblocks.io/dashboard/billing** (the team's Billing page). Write down:
   - the **plan name** exactly as shown (Free / Pro / Team / Enterprise, or an older name);
   - **monthly or annual** billing, and the renewal date;
   - the **monthly credits** line, if there is one. If there is none, it is an older plan: note every add-on line, especially anything named Comments, Text Editor, Notifications or Yjs.
4. Open **https://liveblocks.io/dashboard/usage**. Note this month's collaboration minutes, storage updates, comments created and the credits left, if shown.
5. Optional: on the Billing page, open the latest **invoice** and note its line items. They name exactly what is billed.
6. Send the lead the plan name, the credit line or add-on lines, and a screenshot of the Billing page with card details cropped out. No keys.

Once we have the plan name, the table above says what it includes. If it is an older plan, the invoice lines say it.

---

## (d) Full-text search (FTS5) with the repo's libSQL client

### Spike: FTS5 in local-file mode works

Folder: `~/spikes/fts-20261017/` (the script is in `script/`, databases and logs in `data/`). Nothing was downloaded or installed: the script loads the repo's own `@libsql/client` from `~/aimighty-workspace/node_modules`.

- `@libsql/client` **0.18.0** (`package.json` `^0.18.0`, lockfile 0.18.0), native `libsql` **0.5.29**, `sqlite_version()` = **3.45.1**, `pragma compile_options` contains `ENABLE_FTS5` = **true**.
- Command: `timeout -k 10s 120s node script/fts-spike.mjs ~/spikes/fts-20261017/data/fts-run3.db` → exit 0, log `data/fts-run3.log`, last line `RESULT: PASS`.

What it does. Every row and every query carries `workspace_id` (tenant rule 2):

```sql
create virtual table search_idx using fts5(
  workspace_id UNINDEXED, kind UNINDEXED, ref_id UNINDEXED, title, body,
  tokenize = 'unicode61 remove_diacritics 2', prefix = '2 3');
select kind, ref_id, bm25(search_idx, 0, 0, 0, 10.0, 1.0) as score, snippet(search_idx, 4, '[', ']', '…', 8)
from search_idx where search_idx match ? and workspace_id = ? order by score limit 10;
```

Results (run 3, 17 Oct 15:14 UTC). The small table holds 7 synthetic rows: a production, cards, a prompt, an @handle, a history row, one other-workspace row, and one Devanagari row.

| Query | Result |
|---|---|
| `perfume` (ws_a) | 3 rows, the ws_b row excluded; bm25 ascending (best first) = true |
| prefix `perf*` | 3 rows |
| prefix `bo*` | 3 rows (`bottle` in two cards and a history row) |
| phrase `"bottle hero"` | 1 row (history/j1), score -1.5835 |
| boolean `rain NOT window` | p1, c1; the "rain on a window" prompt excluded |
| column filter `title:rain` | 1 row |
| Devanagari `बारिश` | 1 row; `snippet()` highlights `[बारिश]` |
| Devanagari prefix `मान*` | 1 row (`मानसून`) |
| tenant check: `perfume` in ws_b | only ws_b's own row |

Ranking at scale: 20,000 synthetic rows over 20 workspaces, inserted in 882 ms (batches of 2,000). The rare term `saree` sits in some titles and some bodies.
`MATCH 'saree'` with title weight 10 returns title hits first (top score -12.278, ascending order true), in 0.74 ms.
Prefix `ri*` scoped to one workspace counts 798 rows in 19.49 ms.

Notes for the design:
- bm25 returned 0 for `perfume` in the 7-row table: the term is in 4 of 7 rows, so FTS5 floors its IDF to near zero. That is expected on tiny tables; the 20k-row run shows real ranking.
- `workspace_id UNINDEXED` filters **after** the MATCH. That suits a per-workspace database (below), where every row is already the workspace's. In a shared table, a common prefix scans every workspace's hits: `ri*` took 19 ms over 20k rows.
- `unicode61` tokenises Devanagari on spaces and punctuation, which works for whole words and prefixes. It does no Hindi stemming. The `trigram` tokenizer is the option for infix search; not tested here.

### Hosted Turso: does it support FTS5?

**Turso Cloud databases (libSQL, which @libsql/client talks to): yes, built in.**
https://docs.turso.tech/features/sqlite-extensions (read 17 Oct 2026 15:14 UTC, fetched as `.md`) lists under "Preloaded Extensions — The following extensions are always-on and available": "| FTS5 | Built-in | Full-text search and indexing. |" (with JSON and R*Tree).

**The newer Turso engine (the Rust rewrite, "Turso Database"): no FTS5.** It has its own full-text search on Tantivy:
- https://docs.turso.tech/sql-reference/functions/fts (read 17 Oct 2026): "Full-text search (FTS) in Turso is powered by Tantivy, not SQLite's FTS3/FTS4/FTS5 modules. The syntax and functions differ from SQLite FTS." It uses `CREATE INDEX … USING fts (…)`, `fts_match`, `fts_score` (BM25) and `fts_highlight`.
- https://github.com/tursodatabase/turso/blob/main/COMPAT.md (raw, read 17 Oct 2026): "| SQLite FTS3/FTS4/FTS5 | ❌ No | Use Turso FTS instead |", "| snippet() | ❌ No | |".
- https://docs.turso.tech/sql-reference/experimental-features (read 17 Oct 2026): index methods (`index_method`, "CREATE INDEX ... USING for FTS") are listed as an **experimental** feature.

So FTS5 syntax works on what we connect to today: libSQL, local files and Turso Cloud databases over `libsql://`.
It would **not** carry over unchanged if the databases ever moved to the new Turso engine. The search endpoint should keep its SQL behind one module so that swap stays a one-file change.

### How production connects (code only, by config name; no env file read)

From `lib/db.ts`, `lib/tenant.ts` and the two files they defer to, `lib/platform.ts` and `lib/provision.ts`, on origin/release/1:

- **One database per workspace** (`lib/db.ts` header: "Local dev -> file:.data/ark.db for the studio's workspace, file:.data/ws_<slug>.db for others; Production -> the primary Turso database for the studio's workspace; one Turso database per other workspace").
  `db()` returns the client of the workspace in scope (`currentTenant()`) and throws without one. Clients come from `createPlatformDatabaseClient({ url: ws.dbUrl, authToken: ws.dbToken })`: a `file:` URL gets the local wrapper, anything else the plain `@libsql/client` remote client.
- **Platform database** (accounts, workspaces): `PLATFORM_DATABASE_URL` ?? `TURSO_DATABASE_URL` ?? `file:.data/ark.db`, token `PLATFORM_AUTH_TOKEN` ?? `TURSO_AUTH_TOKEN` (`lib/platform.ts` `platformDb()`).
- **House (legacy) workspace**: `TURSO_DATABASE_URL` (default `file:.data/ark.db`) with `TURSO_AUTH_TOKEN`, "never copied into a row" (`lib/platform.ts` `rowToWorkspace`).
- **Every other workspace**: its own `db_url` and sealed `db_token_enc` in the `workspaces` row (`TenantWorkspace.dbUrl/dbToken` in `lib/tenant.ts`).
  Provisioned through the Turso Platform API with `TURSO_API_TOKEN`, `TURSO_ORG`, `TURSO_GROUP` (default `default`) and `TURSO_API_URL` (default `https://api.turso.tech`), which returns `libsql://<hostname>` plus a full-access token (`lib/provision.ts`).
  In production (`NODE_ENV=production`) without `TURSO_API_TOKEN` + `TURSO_ORG`, provisioning **fails closed**. Locally it writes `file:<WORKSPACE_DB_DIRECTORY or .data>/<name>.db`.

So, in production, customer workspaces are hosted Turso databases (`libsql://`), one each, and FTS5 is built in on them.
The house and platform databases are whatever `TURSO_DATABASE_URL` / `PLATFORM_DATABASE_URL` name. The code allows a local file there, and `ops/selfhost/Dockerfile` creates `/app/.data`. Which one production uses can't be read from code; the owner can confirm by looking at whether `TURSO_DATABASE_URL` starts with `libsql://` in the server config (do not paste its value).
Either way FTS5 works: local libSQL has it (spike above) and Turso Cloud has it (docs above).

**For the search endpoint (Phase A item 7):** one FTS5 table per workspace database, so the index is tenant-scoped by where it lives and `workspace_id` stays on every row too. Keep it in step with triggers or the write path; FTS5's `content=` external-content tables avoid storing text twice.
Search across productions inside one workspace needs nothing extra. There is no cross-workspace search, and none should exist.

---

## (a) LibreOffice headless

Not yet. Due Sun 18 Oct evening.

## (b) Tesseract

Not yet. Due Sun 18 Oct evening.
