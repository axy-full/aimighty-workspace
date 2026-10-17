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
| (a) LibreOffice headless on the droplet | Sun 18 Oct evening | done, below (measured 17 Oct) |
| (b) Tesseract accuracy harness (English, Hindi) | Sun 18 Oct evening | harness done and proven on synthetic scans; the five real briefs: not yet (the owner sends them) |

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

### What was run

- **Binary:** LibreOffice **26.2.7.1** (the "previous", i.e. Still, branch), Basic x86_64 AppImage.
  libreoffice.org's own page, https://www.libreoffice.org/download-other/ ("LibreOffice as AppImage", read 17 Oct 2026), links its AppImages to `https://appimages.libreitalia.org/`.
  Downloaded `LibreOffice-26.2.7.1.basic-x86_64.AppImage` (298,267,840 bytes, 36 s) into its own folder `~/spikes/libreoffice-20261017/download/`.
  Its md5 matches the published `.md5` (`3ac9aee71a39be2458ae6fcc613dcdf5`); sha256 `07d68376…4056a`.
  Extracted with `--appimage-extract` (no FUSE, no sudo): 740 MB.
  "Latest" (Fresh) was 26.8.1.1; Still is the branch for a server.
- **Launcher note:** the `soffice` wrapper starts `oosplash`, which needs `libXinerama.so.1`, and that is not on the droplet. Headless conversion does not need it, so the runs call `program/soffice.bin` directly.
  On a fresh profile, soffice.bin exits **81** once ("restart after first start", normally handled by oosplash); the runner re-runs it once, inside the measurement.
  The other missing libraries (`ldd`) are only for GUI plugins (Qt, GTK, KF5, GStreamer, Java), which headless does not load.
- **Inputs** (synthetic, made by `scripts/make-inputs.mjs` with pptxgenjs 3.12.0, exceljs 4.4.0 and pngjs 7.0.0, installed into `~/spikes/libreoffice-20261017/node-libs/` with `--ignore-scripts`):
  - `deck-40.pptx`: 40 slides of bullet text, 10 slides with a 1600×900 photo-like PNG, 5 slides with a 9×5 table, speaker notes on every slide. **37.5 MB.**
  - `book-20.xlsx`: 20 sheets × 1,000 rows × 15 columns, 40,140 formulas (row SUM×takes, each row's share of the sheet total, a totals row with SUM/AVERAGE/MAX/MIN and a cross-sheet reference). **1.8 MB.**
- **Each run:** `~/ops/heavy.sh timeout -k 10s 600s /usr/bin/time -v soffice.bin -env:UserInstallation=<profile> --headless --invisible --norestore --nologo --nodefault --nolockcheck --convert-to <pdf|png> …` (`scripts/run-lo.sh`, `scripts/batch.sh`).
  That is nice 19, idle I/O, the 3-slot gate, the 5-core / 20 GB cap of the agent slice, and the host shared with production. Load average was 0.97–1.29 during the batch (8 vCPU).
- **Cold** = all 14,347 LibreOffice files (773 MB) and the input evicted from the page cache (`posix_fadvise(DONTNEED)`, `scripts/evict.py`) plus a brand-new profile, so the first-start restart is included. The 851–897 major page faults per cold run confirm the files came from disk.
  **Warm** = the same profile as the previous run, files cached (0 major faults); a priming run before the three warm runs is not counted.
- Batch 17 Oct 2026, 15:23:41–15:25:42 UTC; every run rc=0, no timeout hit. Raw output: `~/spikes/libreoffice-20261017/runs-20261017-a/` (`summary.txt`, `runs.log`, a `time -v` file per run).

### Results (three runs each)

| Conversion | Output | Mode | Wall time (s) | CPU time user+sys (s) | Peak RSS (MiB) |
|---|---|---|---|---|---|
| 40-slide .pptx → PDF | 40 pages, 20 image objects, 5.3 MB | cold | 4.94 / 5.61 / 5.16 | 4.60 / 5.23 / 4.79 | 341.6 / 341.6 / 341.7 |
| | | warm | 4.37 / 4.32 / 4.46 | 4.36 / 4.30 / 4.42 | 341.7 / 341.7 / 341.6 |
| 40-slide .pptx → PNG of slide 1 | 1280×720, 79 KB | cold | 2.23 / 2.19 / 2.27 | 1.89 / 1.85 / 1.90 | 275.4 / 275.5 / 275.8 |
| | | warm | 1.50 / 1.56 / 1.52 | 1.48 / 1.55 / 1.52 | 276.3 / 275.8 / 275.9 |
| 20-sheet .xlsx → PDF | **920 pages, 80.1 MB** | cold | 10.50 / 10.39 / 10.73 | 10.97 / 10.87 / 11.21 | 643.7 / 633.3 / 642.2 |
| | | warm | 10.01 / 9.88 / 9.94 | 10.82 / 10.62 / 10.69 | 638.9 / 638.4 / 636.5 |

Peak RSS is `/usr/bin/time -v` "Maximum resident set size" (KiB ÷ 1024). Page counts were read from the PDFs (`/Type /Page` objects). The slide-1 PNG was opened and checked by eye.

**Two at once** (two workbook → PDF conversions started together, separate profiles, each through the gate; `runs-20261017-concurrency/`): 9.92 s and 10.05 s wall, 640 MiB and 645 MiB peak, both rc=0. No slowdown versus one at a time. Each conversion uses about one core: CPU 83–108% in every run.

Not measured: a hard memory cap. `systemd-run --user --scope -p MemoryMax=…` was **refused by the permission system** and I did not work around it. The cap below is sized from the measured peaks, not tested.

### Image size if added to `ops/selfhost/Dockerfile` (not edited)

The run stage is `node:24-bookworm-slim` (Debian 12). Estimate from Debian's own package indexes (`deb.debian.org` bookworm, bookworm-updates, bookworm-security and bookworm-backports `Packages.xz`, fetched 17 Oct 2026 15:24 UTC into `~/spikes/debian-pkgs-20261017/`).
`scripts/deb-closure.py` sums `Installed-Size` and `Size` over the `Depends`/`Pre-Depends` closure (as `--no-install-recommends`), minus the closure of every `Priority: required` package as a stand-in for the slim base:

| `apt-get install --no-install-recommends …` | Packages added | Installed (layer, uncompressed) | Download (.deb, compressed) |
|---|---|---|---|
| `libreoffice-writer-nogui libreoffice-calc-nogui libreoffice-impress-nogui` (bookworm, 4:7.4.7-1+deb12u13) | 154 | **412 MiB** | 135 MiB |
| … + `fonts-liberation2 fonts-dejavu-core` | 155 | 416 MiB | 136 MiB |
| … + `fonts-noto-core` (Devanagari and other scripts, for Hindi documents) | 156 | **458 MiB** | 148 MiB |
| same, from bookworm-backports (4:25.2.3) | 162 | 470 MiB | 146 MiB |

Largest pieces: libreoffice-core-nogui 103 MiB, libreoffice-common 57 MiB, fonts-noto-core 42 MiB, libicu72 35 MiB.
So adding LibreOffice grows the image by roughly **0.4–0.5 GB uncompressed (about 0.15 GB to pull)**. This is an estimate: it slightly overcounts anything the node base already has, and it ignores Recommends.
Bookworm's own LibreOffice is 7.4; backports carry 25.2. The AppImage route instead (26.2, extracted) would add about 740 MB.

### Conclusion: carry it on the droplet, in its own worker, with limits

At the sizes the brief names, conversion is small: at most 11 s and 0.65 GB for the 20-sheet workbook, and 5 s and 0.35 GB for the 40-slide deck, on one core each, at nice 19.
That fits on the droplet without a service, and documents never leave our server. Limits I propose:

- **Concurrency: 2 conversions at a time**, platform-wide (an Inngest concurrency limit of 2 on the conversion function), the rest queued. Two ran side by side with no slowdown. At about one core each, that leaves production its share of 8 vCPU.
- **Memory: 1.5 GiB per conversion**, hard cap (about 2.4× the largest measured peak), the job failing cleanly with "could not convert" when hit. **3 GiB total** for the pair. To be enforced by the container or cgroup (`docker --memory` / a cgroup `MemoryMax`) and verified there, since I could not test it here.
- **Timeout: 120 s per document** (over 10× the slowest measured), then kill the process group; plus an input size limit (for example 100 MB).
- **Isolation: its own container**, not the web image. That keeps the web image about 0.45 GB smaller and puts the parsing of untrusted customer files in a container with no network and no secrets.
  Each process needs its own profile directory, because two processes cannot share one. Macros stay disabled (the default).
- **Watch:** an xlsx → PDF of 20 × 1,000 rows made **920 pages (80 MB)**. For viewing large workbooks, convert per sheet or cap the page count rather than producing one huge PDF.

If the owner would rather not run LibreOffice at all, two conversion services. Both mean **customer documents leave our server**:

| Service | How it treats documents (its own words) | Pricing page |
|---|---|---|
| CloudConvert | "Files are kept only for processing and deleted immediately afterwards"; "hosted in the selected geographical processing region exclusively", on providers "such as AWS"; "even the CloudConvert team technically can't access your files"; ISO 27001 (TÜV Süd); DPA on request. https://cloudconvert.com/security, read 17 Oct 2026 (curl, HTTP 200) | https://cloudconvert.com/pricing: conversion credits, as one-time packages or a monthly subscription; figures not copied here |
| ConvertAPI | Converted files kept "for up to 3 hours and then deleted automatically" with short-term storage, or an in-memory option with no disk storage; hosted at IBM Cloud data centres, stating "all our data shall be processed within the EU/EEA"; ISO 27001 (TÜV Thüringen), SOC 2 Type 2, DPA, HIPAA BAA available. https://www.convertapi.com/security, read 17 Oct 2026 (via WebFetch; the site answers curl with HTTP 403) | https://www.convertapi.com/prices: subscription tiers with a conversion allowance and overage; figures not copied here |

Either service would also need a line in our privacy terms and a DPA, since a brief is customer content. On the evidence above I recommend the droplet.

---

## (b) Tesseract

### The harness

Folder `~/spikes/tesseract-20261017/` (outside the repo):

- `harness/ocr-eval.mjs`: runs the repo's **tesseract.js 7.0.0** (OEM LSTM only, PSM 3, `user_defined_dpi` 300) over a folder of page images, each next to a hand-typed `<stem>.gt.txt`. Language comes from the file name: `hi-…` uses `hin+eng` (Hindi briefs carry English words), anything else uses `eng`; both can be overridden. Per page it reports:
  - **CER**: Levenshtein over Unicode code points ÷ ground-truth length, after NFC and whitespace collapsing. Also "loose" (lowercase, punctuation dropped), "grapheme" (Intl.Segmenter clusters, fairer for Devanagari) and "danda-fixed" (see below).
  - **WER**: word-level Levenshtein ÷ ground-truth words, same variants.
  - **mean confidence** (tesseract's page mean) and the **share of words under 60 confidence**; time per page.
  - a **fallback** flag under the proposed rule, and **needed** (CER > 5%).
  - A **threshold sweep** (confidence 50…95) counting, over the labelled pages, flagged / caught / missed / unnecessary.
  - Output goes only to the `--out` folder (`results.json`, `results.md`, a `.ocr.txt` per page). It refuses to overwrite an earlier run.
- `harness/make-synthetic.mjs`: renders each ground-truth text to an A4 page at 300 dpi with sharp 0.35.5 (Pango + HarfBuzz shaping; Liberation Serif for English, FreeSerif for Devanagari). It then makes scanned variants:
  - **mild**: rotate 1.2°, noise σ10, blur 0.6, JPEG q70.
  - **hard**: rotate −2°, grey paper, noise σ25, blur 1.0, JPEG q45.
  - **xhard**, beyond the brief's recipe: rotate 1.8°, noise σ35, blur 1.6, half resolution (about 150 dpi), JPEG q30.
- `harness/pdf-to-png.mjs`: rasterises a scanned PDF to 300 dpi greyscale PNGs, one per page, with the repo's pdfjs-dist 6.3.289 and @napi-rs/canvas 1.0.9. Tested on a 40-page PDF: 40 pages of 4001×2250.
- Language data, each download in its own folder:
  - `eng` 4.0.0_best_int: the repo's `@tesseract.js-data/eng` 1.0.0, which is what the app ships.
  - `hin` 4.0.0_best_int from `@tesseract.js-data/hin` 1.0.0 (`npm pack`, `data-hin-npm/`).
  - `hin` from tessdata_fast, `https://github.com/tesseract-ocr/tessdata_fast/raw/main/hin.traineddata` (1,122,751 bytes, sha256 `4c73ffc5…71825`, `data-hin-fast/`, read 17 Oct 2026 15:25 UTC).
- Ground truth: one English and one Hindi (Devanagari) one-page creative brief, typed for this test (`synthetic/ground-truth/`, synthetic, no client content).

### Results on synthetic scans (17 Oct 2026; runs in `~/spikes/tesseract-20261017/runs/`)

Each run: `~/ops/heavy.sh timeout -k 10s 900s node harness/ocr-eval.mjs --pages synthetic/pages-v3 --out runs/<new> --langdata langdata/<set> [--hi-langs …]`; all rc=0.

| Page | Language data | CER | CER danda-fixed | WER | WER loose | Mean conf | Words < 60 | s/page |
|---|---|---|---|---|---|---|---|---|
| English clean / mild / hard / xhard | eng best_int | 0.0 / 0.0 / 0.1 / 0.3% | same | 0.0 / 0.0 / 0.4 / 1.7% | 0.0 / 0.0 / 0.0 / 0.4% | 95 / 95 / 95 / 94 | 0% | 1.8–3.4 |
| Hindi clean | hin+eng best_int | 2.1% | 1.0% | 7.5% | 1.8% | 91 | 3.0% | 5.2 |
| Hindi mild | hin+eng best_int | 1.2% | 0.4% | 6.6% | 1.4% | 91 | 2.6% | 4.9 |
| Hindi hard | hin+eng best_int | 2.2% | 1.2% | 10.2% | 2.2% | 89 | 5.1% | 5.6 |
| Hindi xhard | hin+eng best_int | 2.0% | 1.4% | 8.8% | 3.6% | 90 | 3.9% | 3.7 |
| Hindi clean / mild / hard / xhard | hin+eng **fast** | 0.9 / 1.8 / 1.8 / 2.7% | 0.5 / 1.0 / 1.2 / 2.2% | 5.3 / 6.6 / 9.3 / 9.3% | 1.8 / 1.8 / 2.2 / 4.0% | 92 / 92 / 91 / 91 | 2.2–3.0% | 3.3–5.1 |
| Hindi clean / mild / hard / xhard | **hin only** best_int | 0.7 / 0.8 / 1.3 / 1.3% | 0.7 / 0.8 / 1.1 / 1.1% | 6.2 / 6.6 / 9.7 / 8.8% | 0.9 / 1.4 / 1.4 / 3.1% | 91 / 91 / 88 / 89 | 3.4–6.8% | 2.2–3.7 |

What the Hindi errors are (word diff of the clean page, best_int hin+eng):
- Most are the **danda "।" read as a pipe "|"**, split from its word. A one-line post-fix (`|` → `।` after Devanagari) halves CER; that is the "danda-fixed" column.
- The real misreads: "क्लोज़" (an English loanword in Devanagari with a nukta) → "FT"; "14" → "4"; "हैं।" → "&"; "1." → "|.".
- Strict WER overstates the damage because a stray space before punctuation splits a word; loose WER (punctuation ignored) is 0.9–4.0% for Hindi.

**Negative controls** (`synthetic/pages-control/`), to prove the fallback signal fires:

| Page | CER | WER | Mean conf | Words < 60 |
|---|---|---|---|---|
| English hard page shrunk to 75 dpi | 70.0% | 79.2% | 67 | 45.8% |
| Hindi hard page shrunk to 75 dpi | 20.8% | 33.6% | 75 | 23.5% |
| Hindi page read with the English model only | 88.9% | 98.2% | 32 | 91.9% |

All three are flagged under every threshold in the sweep (caught 3, missed 0, unnecessary 0).
**Read with care:** the synthetic pages are typeset text, so they are easier than real scans of printed or handwritten briefs. No good synthetic page needed the fallback, so the sweep cannot be calibrated on them. That is what the five real briefs are for.

### Proposed fallback to the multimodal model

Per page, send the page image to the multimodal model we already pay for when any of these holds:

1. **Mean confidence < 85.** Every good page here scored 88–95; every failed page 32–75.
2. **More than 15% of words under 60 confidence.** Good pages: 0–6.8%; failed pages: 23.5–91.9%.
3. **Fewer than 20 words on a page that is not blank.** Catches photos and diagrams, where OCR has nothing to report.

Also:
- Always read Hindi-workspace pages, or pages whose script is unknown, with **`hin+eng`**. The wrong model alone produced 89% CER at confidence 32, and rule 1 catches that, but it costs a fallback call.
- Apply the danda post-fix before storing the text.
- The **harness measures the rule**: on the labelled real pages, `results.md` lists for each page whether it was flagged and whether it needed help (CER > 5%), and the sweep shows, for each confidence line, how many needy pages are caught or missed and how many calls would be wasted.
- **Calibrate on the five real briefs:** choose the highest line that misses none, then re-check when new scans arrive.
- Reading for understanding is a billed job under the v30 brief. The fallback's price comes from the rate card and is out of scope here.

### Running it on the owner's five real briefs (not yet: waiting for the files)

Real files never enter the repo, a commit, a PR, a log or a report. Only the numbers (CER, WER, confidence, flags) are reported, never text from the documents.

1. Make a **new** folder: `mkdir -p ~/spikes/tesseract-real-<YYYYMMDD>/{originals,pages,runs}` (for example `tesseract-real-20261019`). Put the five files in `originals/`, renamed so the prefix gives the language: `en-01.pdf`, `en-02.jpg`, `en-03.png`, `hi-01.pdf`, `hi-02.jpg`.
2. PDFs: `~/ops/heavy.sh timeout -k 10s 600s node ~/spikes/tesseract-20261017/harness/pdf-to-png.mjs ~/spikes/tesseract-real-<date>/originals/hi-01.pdf ~/spikes/tesseract-real-<date>/pages hi-01`. This writes `hi-01-p01.png`, `hi-01-p02.png`, …
   Images: copy them into `pages/` under the same stems. HEIC phone photos: export as JPEG first.
3. Ground truth: for each page image, a person types `pages/<stem>.gt.txt` in UTF-8, exactly what is printed: original spelling and typos kept, line breaks free, Hindi in Unicode Devanagari (for example Windows "Hindi Phonetic" or Google Input Tools). Use `।` for the danda, never `|`.
   A page left without a `.gt.txt` is still scored for confidence.
4. Run, one new `--out` folder each time:
   - `~/ops/heavy.sh timeout -k 10s 1800s node ~/spikes/tesseract-20261017/harness/ocr-eval.mjs --pages ~/spikes/tesseract-real-<date>/pages --out ~/spikes/tesseract-real-<date>/runs/best_int-hin_eng --langdata ~/spikes/tesseract-20261017/langdata/best_int`
   - The same with `--langdata …/langdata/fast` and `--out …/runs/fast-hin_eng`.
   - The same with `--hi-langs hin` and `--out …/runs/best_int-hin`.
5. Read `runs/*/results.md`. Copy into this document only the per-page numbers (no text) and the sweep, then set the fallback line from the sweep as described above.
6. When done, leave the folder for the owner; it is never deleted by a lane.
