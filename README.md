# aimighty workspace

Internal video-generation workspace on BytePlus ModelArk (Seedance 2.x).

Prompt + settings → job queue → bins → shared library → cost accounting,
with named accounts so every clip and every dollar has an owner.

## Run it

```bash
npm install
cp .env.example .env.local     # add ARK_API_KEY
npm run dev
```

Local dev needs nothing else — SQLite lands in `.data/ark.db` and finished
renders in `.data/generations/`.

## Screens

| Route | What it does |
|---|---|
| `/` | Compose — prompt-first composer, viewer, settings, project filmstrip |
| `/all` | Library — the current project's clips, searchable and filterable |
| `/usage` | Credit drawdown, spend by model/project/person/month, cost per render |

Which project everything scopes to is the **title-bar project switcher** —
create, rename, delete and select projects there; new renders file into the
selected project automatically. `/projects/*` URLs redirect accordingly.
| `/team` | **Admins only** — invite, promote, disable, unlock; clips and spend per person |
| `/login`, `/setup`, `/invite/[code]` | Public auth screens |

## How costs are calculated

ModelArk returns the billed token count on every completed job, so recorded
spend is **actual**, not estimated:

```
cost = completion_tokens ÷ 1,000,000 × rate(model, output_resolution)
```

**Rates are tiered by output resolution**, and differ again when the input
includes video (we only do text-to-video today, so the `withoutVideo` column
applies). List prices from the [ModelArk pricing page](https://docs.byteplus.com/en/docs/ModelArk/1544106):

| Model | 480p / 720p | 1080p | 4K |
|---|---|---|---|
| Seedance 2.5 | 10.70 | 11.70 | — |
| Seedance 2.0 | 7.00 | 7.70 | 4.00 |

`ACCOUNT_DISCOUNT` in `lib/models.ts` applies an account-level discount to
every list rate. It is currently **0** — the introductory 20% has ended, so
the workspace bills at list. Changing it affects future renders only:
every generation snapshots the rate it was charged at.

BytePlus advertises a public promo — 1080p on Seedance 2.5 at 72% of list to
17 Sep 2026 — which is **not** applied, since it's unconfirmed on this
account. If it does apply, add it with its expiry so it lapses on its own.

Failed generations are not billed, and only succeeded clips enter the ledger.

The pre-flight estimate uses the official token formula, verified against the
published price examples:

```
tokens = width × height × fps × duration ÷ 1024
```

Cross-checked against Seedance 2.5's published example: 5s 16:9 720p =
108,000 tokens × $10.70/M = **$1.156**, which matches BytePlus exactly.

Each generation snapshots the rate it was charged at, so changing a rate never
rewrites history.

## Accounts

Invite-only, built for a team of about six. No external identity provider and no
email sending to configure.

**Getting started:** the first person to open the app is sent to `/setup` and
becomes the admin. That route closes permanently once one account exists.
The admin then invites people from `/team`, which mints a one-time link —
**copy it and send it over Slack/WhatsApp yourself.** The invitee sets their own
password; nobody ever types a password for someone else.

**Roles.** `member` can render, browse and organise. `admin` can additionally
manage people and record credit top-ups (`/api/topups` is admin-only, since it's
the money). The last remaining admin can't be demoted or disabled.

**How it's built.** Passwords are scrypt-hashed with node's stdlib — no bcrypt
dependency. Sessions are server-side rows storing only a SHA-256 of the token,
so a database copy hands over no live sessions; disabling someone deletes their
sessions immediately. Login failures are counted per account and lock it for 15
minutes after 8 tries, and an admin can clear a lockout from `/team`. Wrong
password and unknown email return the identical message, so the login form can't
be used to discover who has an account.

**Every API route requires a session** — including `/api/media/[id]` and
`/api/uploads/[id]`, so renders and reference images aren't publicly fetchable.
Only the four `/api/auth/*` endpoints are open.

Cloudflare Access is no longer required. It's still a reasonable second lock if
you want the app invisible to the public internet, but the app now knows who
people are on its own, which is what makes per-person attribution possible.

## Auto-refine

Every prompt is rewritten server-side by a ModelArk text model
(dola-seed-2.1-turbo, falling back to seed-2-0-pro) using ByteDance's own
published Seedance optimization recipe, before it reaches the video model —
the layer prompt-aggregator platforms charge for. Rules: `@ImageN`/`@VideoN`
citations preserved verbatim; already-structured 【…】 prompts pass through
untouched; a `raw:` prefix sends your exact words; if no text model is
reachable the render proceeds with the raw prompt rather than blocking.
The stored prompt is the refined one that actually generated the clip; the
original idea rides along in `params.rawPrompt`. Costs ~$0.001 per render,
outside the credit ledger.

## Reference images — and why they are never compressed

Drop images into the **References** rail under the prompt. Two mutually
exclusive modes, per ModelArk:

| Mode | Roles | Count |
|---|---|---|
| Image-to-video | `first_frame`, optional `last_frame` | 1–2 |
| Omni reference-to-video | `reference_image` | 1–30 (2.5) / 1–9 (2.0) |

Reference images are cited in the prompt as `@Image1`, `@Image2`… — click the
`@` on a thumbnail to insert the token at the caret.

**Nothing in the upload path touches pixel data.** There is no image library,
no canvas, no resize, no re-encode and no metadata stripping:

- `lib/imagemeta.ts` identifies format and dimensions by reading **header bytes
  only** — it never decodes the image.
- `/api/uploads` writes the received bytes verbatim, re-reads them from storage
  and returns the **sha256 of what actually landed**. The browser hashes the
  file before upload and compares; the rail shows **✓ BYTE-IDENTICAL** when they
  match.
- `/api/uploads/[id]` serves the original bytes with the original content type.
- `lib/ark.ts` base64-encodes those exact bytes. Base64 is a transport encoding,
  not compression — what ByteDance decodes is bit-identical to the file picked.
  (Verified end-to-end by capturing a real request body and re-hashing the
  decoded image.)

Base64 is used rather than a public URL because the app sits behind Cloudflare
Access, so ModelArk cannot reach our storage.

ModelArk limits, enforced at upload rather than worked around:
formats jpeg/png/webp/bmp/tiff/gif/heic/heif · **300–6000 px** · aspect ratio
**0.4–2.5** · **<30 MB** per image · **≤64 MB** total request body. If the
encoded payload would exceed 64 MB the render is blocked with a message —
**it is never shrunk to fit**.

## Things worth knowing

- **Ark's `video_url` expires (~24h).** Every finished render is copied into
  our own storage the first time the poller sees it complete. Never hand anyone
  an Ark URL.
- **Models are Seedance 2.5 and 2.0.** Both send settings as real JSON fields
  (`paramStyle: "fields"`). The `"flags"` branch in `lib/ark.ts` exists because
  Seedance 1.x appended `--flags` to the prompt text instead — kept in case an
  older engine is ever added back.
- **Only 2.5 supports `generate_audio`.** Switching engines auto-clamps ratio,
  resolution, duration and audio to what the selected model accepts.
- **`adaptive` ratio means no pre-flight estimate** — the frame size is chosen at
  render time, so cost is only known once the job returns its token count.
- **No background worker.** Jobs are reconciled when a list view is opened or
  polled. Closing the tab mid-render loses nothing.
- **Model IDs are dated strings** and BytePlus retires them. When one 404s,
  update `lib/models.ts`.

## Deploy

Vercel + Turso + Vercel Blob. Set `ARK_API_KEY`, `TURSO_DATABASE_URL`,
`TURSO_AUTH_TOKEN`, `BLOB_READ_WRITE_TOKEN`, then put Cloudflare Access in
front of the domain.

## Look

DaVinci Resolve-style application chrome. Fixed title bar carrying the aimighty
mark, a **bottom page switcher** (Compose / Bins / Library / Usage) with
transport readouts either side, and a horizontal three-column bench —
**media pool │ viewer │ inspector** — with a full-width **filmstrip** beneath.
Nothing scrolls but the panels themselves.
aimighty palette: near-black desk, `#C3161C` for fills, `#FF4B3E` for red type
and data marks (plain brand red is only 2.1:1 on near-black). Saira for panel
titles, Inter Tight for body, JetBrains Mono for every number and micro-label.

## Deployment

Runs on Vercel in **Mumbai (`bom1`)**, pinned in `vercel.json` — colocated
with the team and with the Blob store, which is what the hot path touches:
media is proxied through the app on every view, whereas ModelArk is called
once per render. Create the Blob store in the same region. The US default
would bounce everything across two oceans for nothing.

Required environment variables in Vercel:

| Variable | Where it comes from |
|---|---|
| `ARK_API_KEY` | BytePlus console → API key management |
| `TURSO_DATABASE_URL` | Turso database |
| `TURSO_AUTH_TOKEN` | Turso database |
| `BLOB_READ_WRITE_TOKEN` | injected automatically when a Blob store is attached |
| `CRON_SECRET` | any long random string; authenticates `/api/cron/sync` and the app's own `/api/worker` (native background dispatch, `docs/native-dispatch.md`) |
| `APP_ORIGIN` | the canonical HTTPS origin, e.g. `https://www.particl.app`; where `/api/worker` is reached |

Inngest is optional: without `DISPATCH_MODE=inngest` and its two keys, background
work is dispatched natively on Vercel.

With `BLOB_READ_WRITE_TOKEN` set, uploads go browser → Blob directly and the
database and media live in the cloud. Without it everything falls back to the
local `.data/` directory, which is what local development uses. No code
changes between the two.

**Production starts empty.** The local database doesn't travel; the first
person to open the deployed site creates the admin account there.
