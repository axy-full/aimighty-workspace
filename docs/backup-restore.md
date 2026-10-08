# Backup, restore and interrupted-provider recovery

This runbook covers the platform database, every tenant database, private media,
the original application keyring and the records that prevent duplicate paid
submissions. It changes no price, entitlement or billing integration. The tool
never calls an engine, sends mail, starts the app, releases held jobs or runs purge.

Use `node scripts/ops/backup-restore.mjs --help` from the repository. Node 20+
and the installed `@libsql/client`, `@vercel/blob` and `@aws-sdk/client-s3`
(R2) dependencies are required.
No `.env` file is loaded automatically. Do not put credentials in JSON files,
shell arguments, logs, CI artifacts or the repository.

## Scope and recovery boundary

The platform and tenant databases are separate physical databases. A consistent
backup needs an explicit maintenance window: stop incoming mutations, disable
scheduled sync/purge and worker dispatch (native `/api/worker`, or Inngest if opted in), drain or fence workers, and pause
provisioning and uploads. Keep them stopped until capture finishes. The
`quiesced: true` assertion records the operator's confirmation; it is **not** a
maintenance switch and the tool cannot fence deployed applications for you.
Do not attest to quiescence while a worker can still complete a write.

There is no distributed snapshot transaction across databases and Blob. Each
database is individually consistent; consistency across them depends on this
maintenance window. Media inventories are compared before and after transfer,
and owned media references must exist. Source writes can still escape that
check if the maintenance window was not enforced.

Include active workspaces, deleted but not yet purged workspaces, databases held
by incomplete provisioning requests, and the legacy workspace. Purged database
resources may be absent, but their platform tombstones must be retained. Do not
replace this with `/api/export`: that customer export intentionally omits other
collaborators' private drafts, credentials and recovery internals.

Database snapshots retain accounts, password hashes, memberships, sessions,
invitations, private drafts and version history, published bibles, production/shot
mappings, generation idempotency requests, paid claims and produced outcomes,
training handles, meter events, credit lots/debits/allocations/refunds, pending
provisioning, and purge tombstones. The complete schema and rows are preserved,
including BLOB values and SQLite AUTOINCREMENT state. The original databases are
not migrated by these scripts.

Private Blob capture includes the **entire explicitly selected store**, paginated,
including `ws/<workspace>/...`, legacy paths, platform assets and pending chunks.
Only use a store dedicated to this Particl environment. The backup does not fetch
external provider URLs: temporary provider output is not a durable master. Owned
upload URLs outside the selected store fail coverage validation and must be
accounted for separately before a complete backup can be recorded.

R2 capture (`r2` or `dual`) likewise includes the **entire bucket**. Production
runs `STORAGE_BACKEND=r2` with `BLOB_READ_WRITE_TOKEN` kept: new objects are on
R2 and older ones remain on Blob, read through the app's dual backend. Capture
that layout with `"kind": "dual"`, which inventories and archives **both** whole
stores. Objects already copied to R2 by the migration exist in both and are kept
twice in the archive (the R2 copy is the one the app reads); size the runner's
disk and the backup bucket for both stores together.

## Keys and retention

Generate `PARTICL_BACKUP_KEY` as 32 cryptographically random bytes, encoded with
standard base64. Retain it in the team's password manager or KMS under a unique
key-version name, separate from the archive storage account. Inject it into the
operator process from the secret manager. Do not reuse `KEYRING_SECRET` as the
backup key, and do not print either value. Keep a second authorized recovery
custodian and exercise retrieval of both the archive and backup key.

`KEYRING_SECRET` must be the **original** value from the source environment.
The application seals tenant database tokens and vendor keys under a SHA-256
derived AES key. Changing the secret without resealing every value makes those
records unreadable. Backup validates all nonempty platform `*_enc` columns and
escrows the original keyring inside its encrypted manifest. Local installations
using the application's development fallback must explicitly inject
`KEYRING_SECRET=particl-dev-keyring` for their local fixture backup; never use that
fallback in production.

The archive uses AES-256-GCM per object, fresh nonces, authenticated object/path
bindings and an encrypted authenticated manifest. Every object also has a
plaintext SHA-256 and byte count checked during restore. Archive files are 0600,
directories 0700. Temporary SQLite replicas and snapshots are plaintext in 0700
temporary directories and are removed on success or ordinary failure. Use an
encrypted operator disk; process kill or host failure can leave a `.particl-ops-*`
directory requiring controlled removal. Filesystem deletion is not a guaranteed
secure erase on SSDs or snapshots.

The prepared, **disabled** workflow below copies each verified encrypted backup
to a **private R2 bucket** (never a GitHub artifact: the repository is public).
Retention is the bucket's own lifecycle rule, set by the owner when the nightly
backup is turned on (for example: delete `bundles/` objects after 90 days); the
code never deletes anything there. Every
capture includes a complete offline restore verification; continue a monthly
independent operator/cloud restore rehearsal. The bucket holds only ciphertext;
record the backup-key version and capture time in the separately held recovery
inventory. Hourly freshness checks fail when no complete bundle in the bucket is
newer than 26 hours. No production schedule, secrets or opt-in variable have been
activated, and no production RPO/RTO has been measured. Retain old backup key
versions until the last archive using them expires.
Align deletion/tombstone retention and any legal holds with the actual data
retention policy; an old restore must not resurrect an erased workspace.

## Capture

Prepare a source inventory with **environment-variable names**, never token values:

```json
{
  "version": 1,
  "label": "particl-staging-2026-09-14",
  "sourceCommit": "<deployed git commit>",
  "quiesced": true,
  "databases": [
    {
      "id": "platform",
      "role": "platform",
      "urlEnv": "BACKUP_PLATFORM_URL",
      "tokenEnv": "BACKUP_PLATFORM_TOKEN"
    },
    {
      "id": "tenant-a",
      "role": "tenant",
      "workspaceIds": ["ws_exact_id"],
      "urlEnv": "BACKUP_TENANT_A_URL",
      "tokenEnv": "BACKUP_TENANT_A_TOKEN"
    }
  ],
  "media": { "kind": "blob", "tokenEnv": "BACKUP_BLOB_TOKEN" }
}
```

Every workspace or provisioned-but-incomplete database must map to a source;
nonlegacy database URLs must match the platform row exactly. One database can
carry multiple workspace IDs only for a deliberately shared legacy physical
database. A legacy workspace using the platform's physical database can put its
workspace ID on the `platform` entry. Avoid exporting the same physical database
twice. The script fails if a required database is omitted or a sealed value cannot
be opened. Credentials should be scoped to this environment and databases.

For local capture, use explicit `file:///absolute/path.db` values under `url`
and set media to:

```json
{
  "kind": "local",
  "root": "/absolute/project/.data",
  "directories": ["generations", "uploads", "platform", "identities", "chunks"]
}
```

The directory allowlist excludes unrelated `.data` databases. Missing empty media
directories are allowed; missing referenced masters/uploads are not.

### R2 and production's dual R2 + Blob layout

Every R2 field is the **name** of an environment variable, as with Blob's
`tokenEnv`; a value written into the JSON is refused. `endpointEnv` is optional
(the app's `R2_ENDPOINT`); without it the endpoint is
`https://<account>.r2.cloudflarestorage.com`. It must be a bare `https` origin.
Use a read-only API token scoped to the one bucket: capture only lists and reads.

R2 only (every object on R2; an absolute Blob URL in a row is then read from R2
at its decoded pathname, with no Blob fallback, exactly as the app does without
a Blob token):

```json
{
  "kind": "r2",
  "accountIdEnv": "BACKUP_R2_ACCOUNT_ID",
  "accessKeyIdEnv": "BACKUP_R2_ACCESS_KEY_ID",
  "secretAccessKeyEnv": "BACKUP_R2_SECRET_ACCESS_KEY",
  "bucketEnv": "BACKUP_R2_BUCKET"
}
```

Production today (R2 first, Blob fallback):

```json
{
  "kind": "dual",
  "r2": {
    "accountIdEnv": "BACKUP_R2_ACCOUNT_ID",
    "accessKeyIdEnv": "BACKUP_R2_ACCESS_KEY_ID",
    "secretAccessKeyEnv": "BACKUP_R2_SECRET_ACCESS_KEY",
    "bucketEnv": "BACKUP_R2_BUCKET",
    "endpointEnv": "BACKUP_R2_ENDPOINT"
  },
  "blob": { "tokenEnv": "BACKUP_BLOB_TOKEN" }
}
```

Coverage follows `lib/storage/backend.ts`: a referenced key (renders, uploads,
platform assets, a bare stored key) must exist on R2 or, failing that, on Blob
under the same key; an absolute Blob URL must exist on R2 at its decoded
pathname or on Blob at that exact URL. Any other absolute URL fails. A failure
names up to 20 missing objects as `database/table/row` only, never a key, URL,
file name or credential (an upload's key can carry the customer's file name).

Each R2 object is read pinned to its listed ETag (`If-Match`), its length is
checked, and a single-part ETag is checked as the MD5 of the bytes. Objects
stream straight into the encrypted archive (bounded memory). A dropped
connection, 408/429 or 5xx is retried up to four times with backoff, restarting
that object; integrity failures are never retried. Like Blob capture, a run is
not resumable: a failed run publishes nothing; repeat it into a new directory.
The archive stores single-store media at `media/<key>`; `dual` stores
`media/r2/<key>` and `media/blob/<pathname>` so a migrated key keeps both copies.

```sh
node scripts/ops/backup-restore.mjs backup /secure/source.json /secure/backups/unique-capture
node scripts/ops/backup-restore.mjs restore /secure/backups/unique-capture /secure/rehearsals/unique-restore
node scripts/ops/backup-restore.mjs report /secure/rehearsals/unique-restore
```

`restore` re-checks that every referenced object resolves to a restored,
digest-verified file; `report` proves it again against the offline directory
and prints `media: { kind, verified, references, byStore, objects }`, naming
(by database/table/row) any referenced file that is missing or changed.

Both destination directories must not exist. Keep the complete archive directory,
including `header.json`, `manifest.enc` and every numbered encrypted object.
The command prints only counts and success metadata. Provider error details are
withheld because SDK exceptions can contain credentials. A nonzero exit is not a
successful backup. Upload only the encrypted archive, and only to the private
backup bucket (`upload`, below); never upload a decrypted rehearsal directory, and
never use a GitHub artifact for either (the repository is public).

Local snapshots use `VACUUM INTO`, so committed WAL content is included. For remote
Turso, the script creates a new local embedded replica, explicitly calls `sync()`,
closes the replication client, then opens it as a standalone local database for
`VACUUM INTO`. No application SQL writes are sent to the source. This workflow
targets the current libSQL-backed Turso databases used by Particl; unsupported
TursoDB/MVCC replication fails rather than quietly producing a stale snapshot.

Do not copy a live `.db` alone or discard an export's sidecars. The installed Turso
CLI can emit `.db-wal` or `.db-log`; its export documentation also warns that an
export may need SDK synchronization to contain the latest changes. The replica
workflow avoids treating that base export as a complete backup.

## Prepared daily workflow (not activated)

`.github/workflows/backup.yml` prepares daily capture at 02:17 UTC and hourly
freshness checks at minute 47. It remains inert while the repository variable
`PARTICL_BACKUP_ENABLED` is absent or not `true`. A manual `dry-run` executes the
local fixture tests and prints the plan without reading any backup credentials.
A manual `capture` fails explicitly while disabled or outside `main`. The nightly
capture still needs a sealed fence receipt, so today the only capture is the
attended one (runbook below); a nightly backup without a maintenance window is
separate, later work.

Before enabling it, create the protected GitHub environment `particl-backup`
(restricted to `main`; owner clicks in "Private backup bucket: owner setup") and
set these environment secrets:

| Secret                                | Contents                                                                                                                                                                      |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PARTICL_BACKUP_SOURCE_JSON`          | The complete source JSON inventory (`sources.json` from `seal`). Keep it synchronized with newly provisioned workspaces; omissions cause failure.                            |
| `PARTICL_BACKUP_ENV_JSON`             | A JSON object of the scoped URL/token variables referenced by that inventory (for `dual` media: every R2 variable named and the Blob token), plus the original `KEYRING_SECRET` (`source-env.json` from `seal`). Do not include a Turso organization/provisioning API token. |
| `PARTICL_BACKUP_KEY`                  | The independent 32-byte base64 archive key, also retained outside GitHub by recovery custodians.                                                                              |
| `PARTICL_BACKUP_QUIESCENCE_JSON`      | The fence receipt (`receipt.json` from `seal`). A legacy self-asserted JSON is refused.                                                                                        |
| `BACKUP_TARGET_R2_ACCOUNT_ID`         | Cloudflare account ID of the private backup bucket.                                                                                                                           |
| `BACKUP_TARGET_R2_ACCESS_KEY_ID`      | Access Key ID of the bucket's own token (Object Read & Write, that bucket only).                                                                                              |
| `BACKUP_TARGET_R2_SECRET_ACCESS_KEY`  | Secret Access Key of that token.                                                                                                                                              |
| `BACKUP_TARGET_R2_BUCKET`             | The bucket name, for example `particl-backups`.                                                                                                                               |
| `BACKUP_TARGET_R2_ENDPOINT`           | Optional. Leave unset; only a bucket created in a jurisdiction (for example EU) needs its `https://<account>.eu.r2.cloudflarestorage.com` address here.                      |

The quiescence record must remain valid through capture and verification. The
enforced receipt expires when its fence lease does: 30 minutes after the last
`renew` before `seal`. The capture step has a 35-minute limit for that reason.

```sh
node scripts/ops/backup-automation.mjs fingerprint /secure/source.json
node scripts/ops/backup-automation.mjs plan
node --test tests/ops/*.test.mjs
```

The confirmation is a protected operational assertion, **not an application pause
switch**. This implementation does not automatically pause Vercel, the native worker, Inngest or
external writers. Do not activate the schedule until an operator or maintenance
orchestrator actually fences them for the window and refreshes this record. An
old permanent `true` setting is rejected. Read-only database preflight checks
also reject queued/running/uncertain jobs, retained failed meter reservations,
active identity training, provisioning and purge leases before and after capture.
The checks cannot replace the fence or rule out a new writer starting later.

### Where the verified bundle goes

On success, a separate step (it sees only the `BACKUP_TARGET_R2_*` secrets, never
the production source credentials) runs `backup-automation.mjs upload` and copies
the encrypted bundle to the private bucket:

- Key layout: `bundles/<UTC timestamp>-<run id>/` (for example
  `bundles/20261012T204512Z-18234567890/`), holding `header.json`,
  `manifest.enc`, every numbered `.enc` object and, written **last**,
  `upload-index.json` (each file's name, size and SHA-256, plus the verified
  counts: databases, media objects, and media objects per store, `r2` and `blob`).
  Without `upload-index.json` a folder is an unfinished upload and is not a backup.
- Every write is conditional (`If-None-Match: *`): an existing key is never
  overwritten, and a folder that already holds anything is refused before the
  first write. Files over 100 MiB go up in 64 MiB parts; the completion is
  conditional too.
- Every object is read back in full and its SHA-256 and size compared with the
  local file; then the folder listing must match exactly; only then is the index
  written and read back. Any mismatch fails the job and writes no index.
- The job's summary page shows a small non-secret table: the folder, file count
  and size, database count and media objects per store. Nothing is uploaded as a
  GitHub artifact.

Expired quiescence, new uncertain work, missing credentials/inventory,
corruption, or an unsuccessful restore removes the unpublished bundle and fails
the job before the upload step. A failed upload leaves an unfinished folder (no
index); the lifecycle rule removes it in time, and freshness ignores it. Runner
copies are always removed. The workflow provisions no paid service and has not
uploaded production data. Check the runner's disk before relying on it: the
runner holds the bundle and a full decrypted verification copy at once (about
twice the databases plus media).

The hourly freshness job uses the **same** bucket token today (Object Read &
Write, that bucket only); when the nightly backup is turned on, give it its own
Object Read only token for the bucket. It lists `bundles/`, takes the newest
folder that has a valid `upload-index.json`, checks every listed file exists at
its recorded size, and fails when that index was uploaded more than 26 hours ago
(the bucket's own timestamp). Enable GitHub Actions failure notifications for the
operational owner and test that delivery before relying on it; there is no
separately configured email/Slack sender in this workflow. A failed capture is
actionable even when yesterday's bundle is still within 26 hours.

To recover, fetch the exact bundle with the same checks, then restore it with the
original matching backup key; never replace it with a newly generated key and
assume an old archive will decrypt:

```sh
# BACKUP_TARGET_R2_* and PARTICL_BACKUP_KEY in the shell (never on the command line)
node scripts/ops/backup-automation.mjs download latest /secure/restore/bundle
#   or: download bundles/<UTC timestamp>-<run id>/ /secure/restore/bundle
node scripts/ops/backup-restore.mjs restore /secure/restore/bundle /secure/restore/offline
node scripts/ops/backup-restore.mjs report /secure/restore/offline
```

`upload` also works from an operator machine (`backup-automation.mjs upload
VERIFIED_BUNDLE_DIRECTORY`, folder suffix `manual`), for a bundle that
`restore` has already verified there.

## Private backup bucket: owner setup

The owner does these clicks and enters every key himself. **Never paste a key,
secret or token into a chat, an issue, a pull request or a terminal command line.**
Copy each value straight from the Cloudflare page into the password manager, and
from the password manager into GitHub's secret box (or a hidden `read -rs`
prompt, below). Dashboard labels may differ slightly from these words.

### 1. Create the bucket

1. Cloudflare dashboard, the Particl account, **R2 Object Storage** (left menu),
   **Overview**, **Create bucket**.
2. **Bucket name:** `particl-backups`. **Location:** Automatic (leave
   "Specify jurisdiction" off). **Default storage class:** Standard.
   **Create bucket**.
3. Open the bucket, **Settings**:
   - **Public Development URL (r2.dev):** must say *Disabled*. Do not enable it.
   - **Custom Domains:** none. Do not connect a domain.
   - **CORS policy:** none needed. Leave empty.
   The bucket is then private: only a token can read it.

### 2. The bucket's token (Object Read & Write, this bucket only)

1. **R2 Object Storage**, **Overview**, on the right **API** (or **Manage API
   tokens**), **Manage API tokens**, **Create API token** (choose *Account API
   token* if offered: it does not depend on one person's login).
2. **Token name:** `particl-backups-write`.
   **Permissions:** *Object Read & Write*.
   **Specify bucket(s):** *Apply to specific buckets only*, select `particl-backups`.
   **TTL:** *Forever* (or a long date; an expired token stops the backups).
   **Client IP address filtering:** leave empty (GitHub's runners change address).
   **Create API Token**.
3. The next page shows the values **once**. Copy into the password manager:
   - **Access Key ID**
   - **Secret Access Key**
   - the **account ID**: the hex string in the S3 endpoint shown there,
     `https://<account ID>.r2.cloudflarestorage.com` (also on the R2 Overview
     page, "Account ID").
   Ignore the "Token value" (it is for Cloudflare's own API, not used here).

### 3. Lifecycle rule (retention): only when the nightly backup is turned on

**Do not create this rule for the attended capture.** With attended captures
only, nothing needs deleting automatically, and the attended bundle is the last
copy of media that lives only on Vercel Blob once Vercel is cancelled: it must
never be deleted by a rule. Create the rule on the day the nightly backup is
enabled, and decide then how the attended bundle is kept (for example a rule
limited to nightly folders, or a longer period).

When that day comes:

1. **R2 Object Storage**, `particl-backups`, **Settings**, **Object lifecycle
   rules**, **Add rule**.
2. **Rule name:** `delete-bundles-after-90-days`. **Apply to:** objects with the
   prefix `bundles/`. **Action:** delete (expire) objects **90 days** after upload.
   Save.
3. Keep the default rule that aborts incomplete multipart uploads after 7 days.

Cost guide: R2 charges for storage (about US$0.015 per GB-month after the free
10 GB) and write operations, not for downloads. Ninety nightly bundles of 1 GB
is about 90 GB, roughly US$1.20 a month.

**Keep a second copy of the attended capture:** download it once to the owner's
encrypted backup disk (the `download` command in "Confirm the bundle landed") and
keep that copy, whatever the bucket's rules become later.

### 4. The production media READ token (Object Read only, the media bucket only)

Capture lists and reads production's media bucket; it never needs to write.

1. **Manage API tokens**, **Create API token** (Account API token).
2. **Token name:** `particl-media-read-for-backup`. **Permissions:** *Object Read
   only*. **Specify bucket(s):** *Apply to specific buckets only*, select
   **production's media bucket** (the bucket production's `R2_BUCKET` names; not
   `particl-backups`). **TTL:** Forever (or past the planned nightly work).
   **Create API Token**.
3. Copy **Access Key ID** and **Secret Access Key** into the password manager as
   `BACKUP_R2_ACCESS_KEY_ID` and `BACKUP_R2_SECRET_ACCESS_KEY`. Also note the
   media bucket name as `BACKUP_R2_BUCKET` and the account ID as
   `BACKUP_R2_ACCOUNT_ID`.

**Where it goes:** not into a GitHub secret of its own. During the window those
four values are typed into the operator shell's hidden prompt (runbook step 2);
`seal` copies them into its private `source-env.json`, and that file becomes the
`PARTICL_BACKUP_ENV_JSON` secret. The same goes for the Vercel Blob token
(`BACKUP_BLOB_TOKEN` = production's `BLOB_READ_WRITE_TOKEN`; Vercel Blob has no
read-only token).

### 5. GitHub environment and secrets

1. GitHub, repository `axy-full/aimighty-workspace`, **Settings**,
   **Environments**, **New environment**, name `particl-backup`, **Configure
   environment**.
2. **Deployment branches and tags:** *Selected branches and tags*, **Add
   deployment branch or tag rule**, `main`, **Add rule**.
3. **Required reviewers:** leave off. Once the nightly work enables the schedule,
   every hourly freshness check would otherwise wait for an approval.
4. **Environment secrets**, **Add environment secret**, once per row
   (Name exactly as written; Value from the password manager):

   | Name                                 | Value                                                                                          |
   | ------------------------------------ | ---------------------------------------------------------------------------------------------- |
   | `BACKUP_TARGET_R2_ACCOUNT_ID`        | the account ID (step 2)                                                                        |
   | `BACKUP_TARGET_R2_ACCESS_KEY_ID`     | Access Key ID of `particl-backups-write`                                                       |
   | `BACKUP_TARGET_R2_SECRET_ACCESS_KEY` | Secret Access Key of `particl-backups-write`                                                   |
   | `BACKUP_TARGET_R2_BUCKET`            | `particl-backups`                                                                              |
   | `PARTICL_BACKUP_KEY`                 | the archive key: run `openssl rand -base64 32` once on your own machine, save it in the password manager as "Particl backup key v1 (date)", then paste it here (removed again after the attended run, runbook step 9) |

   Do **not** add `BACKUP_TARGET_R2_ENDPOINT` (the bucket has no jurisdiction).
   `PARTICL_BACKUP_SOURCE_JSON`, `PARTICL_BACKUP_ENV_JSON` and
   `PARTICL_BACKUP_QUIESCENCE_JSON` are set during the window from `seal`'s files
   (runbook step 5), never typed by hand.
5. Do not create the repository variable `PARTICL_BACKUP_ENABLED` yet: it is set
   only for the attended run (runbook step 5) and removed afterwards, so the
   nightly schedule stays off.

## Attended capture runbook

One attended capture, with production in maintenance, before Vercel (and its Blob
store) is cancelled on 27 October. It includes the old Vercel Blob media (media
kind `dual`: R2 and Blob).

**When:** 02:00 to 03:00 IST (20:30 to 21:30 UTC), on a weekday night. There is
no usage data in the repository; this is chosen as the lowest-use hour for a
studio whose people and production region (`bom1`, Mumbai) are in India. Write the
chosen date into the announcement.

**Where:** the *operator machine*: the owner's computer, or the advisor's shell
with the owner present. It needs the repository at the `main` commit production
runs (`npm ci` done), Node 20+, and `gh` signed in as the repository owner. Never a
shared CI runner, never a chat.

**Duration (not yet measured):** draining 0 to 10 minutes (one 10-minute cron
cycle at most, usually nothing is running at that hour), seal and secrets about 3
minutes, runner start and `npm ci` 2 to 4 minutes, capture plus full restore check
5 to 15 minutes (Blob held 404 MB on 19 September, plus R2 since then). Expect the
site to be down about **20 to 30 minutes**. **Hard stop: T+40 minutes** after
`begin`. Whatever state things are in, resume then and abort.

### Before the night

- This workflow change is on `main` (capture runs only from `main`).
- Every production deployment with write credentials runs the fence protocol
  `particl-recovery-fence-v1`, and old deployments are stopped
  (`docs/enforced-recovery-fence.md`; on Vercel, plan this with the advisor).
- Setup sections 1 to 5 above are done.
- Measure: Vercel, Storage, the Blob store's size; Cloudflare, R2, the media
  bucket's **Metrics** (storage and object count). If the two together exceed
  about 6 GB, stop and tell the advisor: the runner's disk holds the bundle and a
  decrypted copy at once.
- Actions, **Encrypted Particl backups**, **Run workflow**, branch `main`,
  operation `dry-run`: it must be green.
- Write the fence input outside the repository, for example
  `~/particl-checkpoint-input.json` (`chmod 600`):

  ```json
  {
    "preconditions": {
      "deployments": [{ "id": "<production deployment id>", "protocol": "particl-recovery-fence-v1" }],
      "oldDeploymentsStopped": true,
      "externalWritersExcluded": true,
      "evidence": "<what was checked: the deployments that exist, that old ones are stopped, who else holds write credentials>"
    },
    "media": {
      "kind": "dual",
      "r2": {
        "accountIdEnv": "BACKUP_R2_ACCOUNT_ID",
        "accessKeyIdEnv": "BACKUP_R2_ACCESS_KEY_ID",
        "secretAccessKeyEnv": "BACKUP_R2_SECRET_ACCESS_KEY",
        "bucketEnv": "BACKUP_R2_BUCKET"
      },
      "blob": { "tokenEnv": "BACKUP_BLOB_TOKEN" }
    }
  }
  ```

  Add `"endpointEnv": "BACKUP_R2_ENDPOINT"` under `r2` only if production sets
  `R2_ENDPOINT`.
- Announce a day ahead, and again 15 minutes before: "Particl is down for
  maintenance on <date>, 02:00 to 03:00 IST, for a full backup. Your work is
  saved. Renders already running finish first; please don't start new ones after
  01:45 IST."

### On the night (T = when `begin` runs)

All commands run on the operator machine, in the repository folder, in one
terminal opened only for this.

1. **T-10: load the values without showing them.** Paste each from the password
   manager at the hidden prompt; press Enter on a name production does not set.
   Use production's own values for the database and keyring names.

   ```sh
   for name in PLATFORM_DATABASE_URL PLATFORM_AUTH_TOKEN TURSO_DATABASE_URL TURSO_AUTH_TOKEN \
       KEYRING_SECRET BACKUP_R2_ACCOUNT_ID BACKUP_R2_ACCESS_KEY_ID BACKUP_R2_SECRET_ACCESS_KEY \
       BACKUP_R2_BUCKET BACKUP_R2_ENDPOINT BACKUP_BLOB_TOKEN; do
     printf '%s: ' "$name"; IFS= read -rs value; echo
     if [ -n "$value" ]; then export "$name=$value"; else unset "$name"; fi
   done; unset value
   REPO=axy-full/aimighty-workspace
   CP=~/particl-checkpoint-$(date -u +%Y%m%dT%H%M)
   ```

2. **T+0: begin the fence** (the site starts answering 503):

   ```sh
   node scripts/ops/recovery-fence.mjs begin "$CP" ~/particl-checkpoint-input.json
   ```

   It prints `{"state":"draining","epoch":…}`. Note the time: the hard stop is
   T+40.

3. **Status until drained.** Every minute:

   ```sh
   node scripts/ops/recovery-fence.mjs status "$CP"
   ```

   Go on when `"activities":[]` and `"intents":[]`. Not drained by **T+15**:
   resume (step 8) and abort; investigate in daylight.

4. **Renew, then seal at once.** The receipt is valid 30 minutes from this renew.

   ```sh
   node scripts/ops/recovery-fence.mjs renew "$CP"
   node scripts/ops/recovery-fence.mjs seal "$CP"
   ```

   `seal` prints `{"state":"closed",…}` and writes `sources.json`,
   `source-env.json` and `receipt.json` into `$CP`. Any refusal: resume and abort.

5. **Load the seal outputs into the environment secrets and start the run.**
   `gh` reads each file itself; nothing is shown or pasted.

   ```sh
   gh secret set PARTICL_BACKUP_SOURCE_JSON --env particl-backup --repo "$REPO" < "$CP/sources.json"
   gh secret set PARTICL_BACKUP_ENV_JSON --env particl-backup --repo "$REPO" < "$CP/source-env.json"
   gh secret set PARTICL_BACKUP_QUIESCENCE_JSON --env particl-backup --repo "$REPO" < "$CP/receipt.json"
   gh variable set PARTICL_BACKUP_ENABLED --body true --repo "$REPO"
   gh workflow run backup.yml --repo "$REPO" --ref main -f operation=capture
   date -u +%H:%M:%S   # the dispatch time
   ```

6. **Watch.**

   Wait about 10 seconds (the run takes a moment to appear), then:

   ```sh
   gh run list --workflow backup.yml --event workflow_dispatch --repo "$REPO" --limit 1 \
     --json databaseId,createdAt,status
   gh run watch <run id> --repo "$REPO"
   ```

   Check the run's `createdAt` (UTC) is **after** the dispatch time; if not, wait
   and list again (that is an older run). While `PARTICL_BACKUP_ENABLED` is
   `true`, the hourly scheduled freshness run (minute 47, 20:47 UTC in this
   window) may also start and **fail** because no bundle exists yet: ignore that
   failure. It shares the workflow's queue, so it can delay the capture run's
   start by a couple of minutes.

   The job is `capture`; its steps are "Capture only quiesced sources and
   rehearse the entire restore" (the part that needs the site down), then "Upload
   verified ciphertext to the private backup bucket", then `freshness`.

7. **Resume as soon as the capture step is green**, or at once if anything fails,
   or at **T+40** whatever is happening (then also `gh run cancel <run id> --repo
   "$REPO"`). The upload does not need the site down.

8. **Resume:**

   ```sh
   node scripts/ops/recovery-fence.mjs resume "$CP"
   node scripts/ops/recovery-fence.mjs status "$CP"   # "state":"open"
   ```

   Then open the production site and sign in; `/api/health` answers 200 again.
   If `resume` refuses, run it again; the gate never reopens on its own. Call the
   advisor if it keeps refusing; do not delete `$CP` (it holds the owner key).

9. **After the run finishes** (green or not):

   ```sh
   gh variable delete PARTICL_BACKUP_ENABLED --repo "$REPO"
   gh secret delete PARTICL_BACKUP_QUIESCENCE_JSON --env particl-backup --repo "$REPO"
   gh secret delete PARTICL_BACKUP_ENV_JSON --env particl-backup --repo "$REPO"
   gh secret delete PARTICL_BACKUP_SOURCE_JSON --env particl-backup --repo "$REPO"
   gh secret delete PARTICL_BACKUP_KEY --env particl-backup --repo "$REPO"
   rm -rf "$CP"        # only after status said "open": it holds production credentials
   ```

   `PARTICL_BACKUP_KEY` stays in the password manager (the full proof below and
   any restore use it from there); it goes back into the environment only when
   the nightly backup is turned on. The bucket token secrets
   (`BACKUP_TARGET_R2_*`) stay. When the nightly backup is turned on, also give
   the hourly freshness check its own **Object Read only** token for
   `particl-backups`, so the job that runs every hour cannot write.
   Close the terminal (the values loaded in step 1 go with it). A failed run:
   nothing was published; fix the cause in daylight and repeat on another night.

### Confirm the bundle landed and includes the Blob media

1. **Run page, Summary.** The table "Encrypted backup uploaded to the private
   bucket" shows the folder `bundles/<UTC timestamp>-<run id>/`, the files, and
   **Media objects: N (R2: a, Blob: b)**. **b must be more than 0**: that is the old
   Vercel Blob media inside the bundle. The `freshness` job's table names the same
   folder.
2. **Cloudflare**, R2, `particl-backups`, **Objects**, `bundles/`, that folder:
   `header.json`, `manifest.enc`, the numbered `.enc` files and `upload-index.json`.
3. **Full proof** (no downtime, any day before 27 October; do it once). On the
   operator machine, with `BACKUP_TARGET_R2_ACCOUNT_ID`,
   `BACKUP_TARGET_R2_ACCESS_KEY_ID`, `BACKUP_TARGET_R2_SECRET_ACCESS_KEY`,
   `BACKUP_TARGET_R2_BUCKET` and `PARTICL_BACKUP_KEY` loaded the same hidden way
   as step 1:

   ```sh
   node scripts/ops/backup-automation.mjs download latest ~/particl-proof/bundle
   node scripts/ops/backup-restore.mjs restore ~/particl-proof/bundle ~/particl-proof/offline
   node scripts/ops/backup-restore.mjs report ~/particl-proof/offline
   ```

   `download` checks every file's SHA-256 and prints the same counts. `report`
   prints `media: { kind: "dual", verified: true, references, byStore: { r2, blob },
   objects }`: `verified: true` means every file a database row points at is in
   the bundle and intact; `byStore.blob` counts rows that are served from the old
   Blob media. Then copy `~/particl-proof/bundle` (ciphertext) to the owner's
   encrypted backup disk and keep it, and delete `~/particl-proof/offline` (it is
   plaintext: databases and the keyring).

## Restore into new infrastructure

1. Restore the archive into a new offline directory using the command above.
   This verifies GCM tags, object byte counts and hashes, database integrity,
   schema and per-table content digests, and original keyring values. Historical
   foreign-key violations are preserved and compared in the inventory; the tool
   does not claim to repair them. Treat `recovery-secrets.json` as a secret: it
   contains the recovered original keyring. The tool intentionally does not emit
   an application `.env` file or start a server.
2. Keep the restored application isolated from the network. Original snapshots
   still contain source URLs and credentials, sessions and permanent paid claims.
   Run the read-only reconciliation report. It writes a private 0600 file with
   IDs/handles and reserved credits, excluding prompts and provider response bodies.
3. Restore media into a **new dedicated empty private Blob store**. Inject its
   token under `RESTORE_BLOB_TOKEN`, then use this target config:

   ```json
   { "tokenEnv": "RESTORE_BLOB_TOKEN", "confirmEmptyPrivateStore": true }
   ```

   ```sh
   node scripts/ops/backup-restore.mjs restore-blobs /secure/rehearsals/unique-restore /secure/new-blob.json
   ```

   Writes use `access: private`, preserve the original pathname, and disable
   overwrite/random suffixes. Every object is read back from origin and checked
   by SHA-256 and size. The private URL map is saved for direct-upload records.
   A partial failure leaves the new store quarantined; it is not silently resumed
   or cleared. Investigate it and use a new empty store for a full rerun.

   **Or into a new empty R2 bucket** (any `blob`, `r2` or `dual` archive). Inject
   its variables, then use a target config of names only:

   ```json
   {
     "accountIdEnv": "RESTORE_R2_ACCOUNT_ID",
     "accessKeyIdEnv": "RESTORE_R2_ACCESS_KEY_ID",
     "secretAccessKeyEnv": "RESTORE_R2_SECRET_ACCESS_KEY",
     "bucketEnv": "RESTORE_R2_BUCKET",
     "confirmEmptyBucket": true
   }
   ```

   ```sh
   node scripts/ops/backup-restore.mjs restore-r2 /secure/rehearsals/unique-restore /secure/new-r2.json
   ```

   The bucket must be empty. R2 objects keep their key and Blob objects go to
   their pathname; a Blob copy shadowed by an R2 object of the same key (one the
   app never reads) stays only in the offline directory. Writes use
   `If-None-Match: *` (multipart above 100 MiB), every object is read back and
   checked by SHA-256 and size, and `r2-restore-keys.json` records the result for
   `prepare`. A partial failure quarantines the bucket, as for Blob.

   **Or onto local disk**: no upload step; `prepare` builds the media root (below).

4. Plan new target Turso database names in an isolated group.
   Build a target mapping with the same database IDs as the archive and
   `invalidateAccess: true`. Each remote tenant entry uses `urlEnv`, `tokenEnv`, and
   its exact new `dbName`; local rehearsal entries can use a new `file:` URL.
   The platform entry needs only its planned new name because its own connection
   belongs in deployment configuration, not a database row.

   With database-scoped tokens, do this in two passes: first use new temporary
   local `file:` targets for tenant entries, producing media-remapped tenant
   copies. Import those copies into the planned new tenant databases and mint
   database-scoped credentials. Then run `prepare` again **from the original
   verified restore directory** with their real remote URLs and tokens. Import
   that second prepared platform copy last. Never deploy the temporary local
   mapping. This is the sequence exercised by the staging rehearsal script.

   ```json
   {
     "invalidateAccess": true,
     "databases": [
       { "id": "platform", "dbName": "particl-recovery-platform" },
       {
         "id": "tenant-a",
         "urlEnv": "RESTORE_TENANT_A_URL",
         "tokenEnv": "RESTORE_TENANT_A_TOKEN",
         "dbName": "particl-recovery-tenant-a"
       }
     ]
   }
   ```

   ```sh
   node scripts/ops/backup-restore.mjs prepare /secure/rehearsals/unique-restore /secure/targets.json /secure/prepared-copy
   ```

   Add `"media": { "kind": "r2" }` or `"media": { "kind": "local" }` to the
   mapping to point media somewhere other than a restored Blob store (the
   default, `"blob"`, is unchanged). `r2` requires the `restore-r2` record and
   rewrites absolute Blob URLs in upload rows to the bare R2 keys they were
   restored to. `local` writes `local-media/` in the app's local layout
   (`generations/<id>.<ext>`, `uploads/<id>.<ext>`, `platform/...`; use it as the
   app's `.data` directory) with every referenced object copied and checked by
   SHA-256, and rewrites absolute upload URLs to the upload's own key. `local`
   copies **only referenced objects** (renders, uploads, platform assets);
   identity zips, consent recordings, pending chunks and any unreferenced object
   stay in the offline directory under `media/` for the operator to place. Both
   check every reference first and refuse if one cannot be placed.

   `prepare` creates new local copies, remaps workspace and provisioning database
   URLs/tokens (sealed with the original keyring), replaces absolute upload URLs
   using the verified Blob map, and removes restored sessions, API bearer tokens,
   review links, password-reset tokens and consumer OAuth grants. It does not change drafts, membership,
   ledger balances, job IDs, request keys or paid claims. Consumer jobs that were
   quoted or dispatching are quarantined as uncertain; their quotes cannot be
   reused to submit work. Old consumer polling leases are invalidated. It refuses targets equal
   to the source. The original snapshots remain unchanged for audit.

5. Import prepared SQLite copies into **new** Turso databases, using the installed
   CLI's supported `turso db create <new-name> --from-file <file> --group <group>
--wait`. Database-scoped tokens can be minted after creation; group-scoped
   target tokens may be prepared beforehand under the organization's credential
   policy. If using database-scoped tokens, import the tenant copies first, obtain
   their tokens, prepare again with those tokens, and import the prepared platform
   copy last. Never point an import command at an existing customer database.

   ```sh
   turso db create particl-recovery-tenant-a --from-file /secure/prepared-copy/tenant-a.db --group particl-recovery --wait
   node scripts/ops/backup-restore.mjs verify-db /secure/prepared-copy/tenant-a.db /secure/target-tenant-a.json
   ```

   `target-tenant-a.json` contains the same `urlEnv` and `tokenEnv` target entry.
   `verify-db` compares schema, all row content, counts, AUTOINCREMENT state,
   `user_version`, integrity and foreign-key results against the prepared file.
   Compare against **prepared**, not original, snapshots when remapping or access
   revocation intentionally changed rows.

6. Configure an isolated deployment with the new platform URL/token, new Blob
   token and the **recovered original** keyring. Legacy workspaces read
   `TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN` from the deployment, so those must point
   at the restored legacy database, not the old environment. Restore other server
   credentials separately from the secret manager, with provider/email actions
   still disabled. Do not copy `.env.local` from a developer laptop.
7. Reapply post-backup deletions, membership/token revocations and invitation
   decisions from the incident log before users can sign in. Verify two fixture
   members' private draft isolation, shared bibles, shot mappings, media reads,
   membership removal, and ledger source allocations. Do not move domains yet.
8. Reconcile interrupted jobs below, review all credit reservations, and establish
   one active worker/scheduler owner. Then reenable access and background work in
   stages. Record actual data-loss window and recovery duration in the incident
   report. Never promise the local fixture timing as a production RTO.

## Interrupted jobs: never submit twice

Do **not** call `/api/cron/sync` to inspect a restored database. In addition to
status polling, it releases held jobs and runs pending destructive purges. Do not
start the worker (native or Inngest) with restored events before ownership has been reconciled.

| Report disposition                                                             | Operator action                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `poll-existing-handle-only` / `poll-existing-training-handle-only`             | Check that exact provider task. Poll/download the existing result only. Retain its generation/training ID and reconcile its original meter event.                                                                                                                                                                 |
| `recover-persisted-outcome-no-submit` / `recover-persisted-response-no-submit` | Recover the stored result through the existing recovery path after inspection. Preserve the handle, response and original billing attribution.                                                                                                                                                                    |
| `uncertain-provider-outcome-never-resubmit`                                    | Keep the permanent claim and estimated reservation. Correlate provider dashboard/log records by task, request time and workspace in a restricted support session. No new paid request until nonacceptance is established. A timeout, 5xx, unreadable response or missing handle does not establish nonacceptance. |
| `held-review-before-release`                                                   | Confirm user intent, account/workspace status, funding source, current credits/caps and per-workspace capacity before reactivating the ordinary atomic release path.                                                                                                                                              |
| `verify-no-provider-acceptance-before-new-action`                              | Lack of a saved claim in an older backup does not prove no later submission happened. Check the outage interval and provider records before any new action.                                                                                                                                                       |
| `check-existing-database-before-provisioning-retry`                            | Check the deterministic database name and recorded resource before retrying. Do not mint a second workspace or duplicate its one-time grant.                                                                                                                                                                      |

`params.paidClaim` is deliberately permanent. Do not delete it, clear an
idempotency key, mark a job newly queued, or replay provider POSTs to "unstick" a
record. UI retries with the same request key must recover the existing action.
The jobs API hides `paidClaim` and `producedOutcome`; the full database backup
retains both. Provider acceptance without durable handle persistence requires
support investigation; automated recovery cannot safely invent the missing
provider ID.

### Rig master locks

Every tenant snapshot includes `element_lock_events`, the append-only history of
each element lock and unlock (the Rig's locked masters): who, when, whether
Atomik did it, the reason an unlock gave, and a snapshot of what the lock froze
(each attribute's current version with the sha256 of its source). The element
row itself keeps only its last lock state, and `attribute_versions.sha256` keeps
the hash recorded when a lock first froze that version. Nothing in either is paid
or priced. Restore both with the elements they describe; never edit or delete
history rows. A master whose source was changed or re-rendered after a restore is
reported by the Rig's source check against the restored snapshot, not repaired
by rewriting it.

### Higgsfield consumer jobs

> **Sign-in retired 28 September 2026.** Particl uses provider APIs and loginless MCP only (`CLAUDE.md` ground rule 10), so it no longer connects to a Higgsfield account. `higgsfield_consumer_jobs` stays in every snapshot as history and the dispositions below still describe restored rows, but a disposition that needs the old connection is reconciled from the saved receipt and the provider's own records, never by signing in again.

Every tenant snapshot includes `higgsfield_consumer_jobs`, its immutable payload
and quote fingerprints, original asset IDs, OAuth connection generation,
idempotency key, dispatch claim, provider UUID and saved result/acknowledgement.
Its quoted amount is in **Higgsfield credits**, separate from Particl credits or
USD. The reconciliation report exposes the amount and unit, IDs and disposition;
it excludes prompts, claim hashes, provider response bodies and results.

Scheduled backup preflight rejects dispatching, accepted, uncertain or unknown
consumer states. Offline forensic restore still preserves such records exactly.
Preparation always quarantines quoted and dispatching snapshots as uncertain:
a quote in an older backup may have been submitted after capture. It retains
the original quote expiry, fingerprints and claims rather than clearing or
renewing them. A known accepted UUID remains attached to the same job. Stale GET
polling leases are cleared, and completed/failed records and their receipts stay
intact. No preparation or report step sends a provider request.

| Consumer report disposition | Recovery action |
| --- | --- |
| `restored-consumer-quote-requires-reconciliation-never-submit` | Check the post-backup interval before any new action; the restored quote is permanently ineligible for automatic dispatch. |
| `uncertain-consumer-outcome-never-resubmit` | Preserve the claim and quoted Higgsfield amount. Reconcile the original owner, consumer workspace and provider records; do not infer rejection from a missing UUID. |
| `verify-consumer-connection-then-poll-existing-handle-only` | Re-establish and verify the original account/workspace through an explicit recovery procedure before reading the saved UUID. A fresh OAuth grant does not automatically satisfy the immutable old connection generation. |
| `recover-persisted-consumer-result-no-submit` | Recover the saved receipt and original media. Attaching output to a deleted or changed draft can fail without losing the receipt or requiring another generation. |
| `terminal-consumer-no-provider-work` | Retain the failed record and original idempotency key; it does not authorize new work. |

Collected consumer files must use the existing owned upload/generation storage
paths. Their bytes are captured and verified by the normal media inventory.
Deleting a workspace follows the existing disabled-access, grace-period and
retryable purge sequence: media first, then the entire tenant database containing
the consumer ledger. Other tenants' ledgers and media remain separate. There is
no consumer-specific remote deletion, generation or credit adjustment during
this lifecycle. Reapply post-backup workspace deletions before reopening access.

Do not set an uncertain job's cost or credits to zero. Keep its estimate in both
the generation row and authoritative meter reservation until the provider outcome
is known. For confirmed completion reconcile the original event ID and source
allocation; for confirmed rejection/refund use the existing idempotent ledger
path. Never rebuild balances from a sum of grants or edit lot balances by hand.
Credits that expired or changed funding source after the backup need reconciliation
against the original event and incident interval, not a new paid action.

### Rig Verify checks

Every tenant snapshot includes `take_verifications`: each finished check of a
take against its masters (the Rig's Verify card), with the key it is stored
under (the take, digests of its master set and frame points, the rubric), the
masters and frames it used, each check's verdict and reasons, the judge model,
the development job that ran it (its meter event) and the credits it was
charged. The table is created the first time a check is asked for, so older
snapshots simply lack it. A row is written in the same database write that
marks its job succeeded, so a restored job and its row agree. Never edit or
delete rows to "re-run" a check; a new master version is a new key, and a
check still marked running after a restore follows the development-job rules
above (an uncertain phase is never resubmitted).

### Rig canvas operations

Opening an old Rig board in the new Rig never writes the board itself: its
nodes, wires and `updated_at` stay as they were. Two nullable columns on
`boards`, `imported_at` and `imported_to`, record when its cards last came
across and which production's team canvas holds them; the cards carry
`imported` (the board and card each came from), and each batch is an `import`
row in `rig_canvas_ops`, below. After a restore, opening a board again is
safe: cards are keyed by stable ids, so nothing is made twice and a card
someone took off stays off.

Every tenant snapshot includes `rig_canvas_ops`, the append-only record of each
change the server made to a production's shared Rig canvas (a Tidy, an Atomik
run's cards): who asked, the run, each card's fields before and after, and
whether the live room has taken it. The table is created the first time the
server changes a canvas, so older snapshots simply lack it. Nothing in it is
paid or priced. A row still marked `pending` after a restore is safe to push
again: a pushed change lands in the live room only where the room still holds
what the canvas had before it, and a room with no canvas is started from the
restored `workbench_team_canvas` by the first window that opens it. Never
delete rows to "clear" the outbox; a row that cannot be pushed only stays
pending, and the saved canvas is already correct.

### Atomik threads

A project's Atomik threads are rows of `atomik_chats`, which every tenant
snapshot already includes with `atomik_messages` and `atomik_steps`: a project
with several threads has several chats with the same `project_id`, each with
its own messages and steps (lib/atomikThreads.ts). Three columns are added in
place the first time a workspace is read, so older snapshots simply lack them
and their chats read as before, the first becoming the project's thread 1.
`atomik_chats.archived_at` and `archived_by` say a thread was archived and by
whom: a flag, never a delete, and Restore clears both. `atomik_steps.request_key`
is the Idempotency-Key a step's latest approval rendered under, naming its
thread (`atomik-step:<thread>:<step>`, then `:<attempt>` from the second
approval on); a step approved before threads keeps its own key
(`atomik-step:<step>`). Restore the rows as they are. Never clear
`request_key`, `attempt` or `claimed_by` to "unstick" a step: a running step is
settled from the render request filed under that key when its thread's plan is
next read. Never delete a thread to tidy a project; archive hides it, and
Restore brings it back with everything in it.

### Atomik board runs

Every tenant snapshot includes `rig_agent_runs` and `rig_agent_steps`: each
time someone asked Atomik to build a production's Rig board, the request, the
proposal the person approved (and its fingerprint), the run's state, and each
step's batch of canvas operations with what became of them. Both tables are
created the first time someone asks, so older snapshots simply lack them.
Placing cards is free. A run also records the limit the person approved for it
(and every raise), and each render after the build records its price, who
approved it, its request key (saved before anything was sent), the job it made
and the credits reserved and settled; these columns are added to an older
table when the workspace next uses it. After a restore, a run still marked
`planning`, `running`, `paused` or `needs_you` is safe to wake: a step applied
again changes nothing, because its canvas op id is already in
`rig_canvas_ops`; a planning turn that had started is not sent again (the run
asks the person to ask again, and its reserved planning charge is released);
and a render whose key was saved is asked about by that key — followed if it
landed, fenced if it never arrived — and never sent again. The charges
themselves live in the platform ledger: each reservation names its run
(`generation_reservations.run_id`, with its band in `run_band`), and a run's
limit is counted from there. Never delete runs, steps or reservations; an undo
takes a build's cards off the canvas softly and records itself on the run.

### Atomik skills

Every tenant snapshot includes `atomik_skills` and `atomik_skill_versions`:
the runs a workspace saved as skills (lib/atomikSkills.ts). Each row carries
`workspace_id`; the first holds a skill's current name, command, who sees it
(personal or workspace), its maker, its current version and whether it is
archived, and the second holds every version as it was saved, append-only.
A version is a template: steps with their engines and settings, and named
parameters with their defaults. Nothing in either table is paid, priced or
produced; running a skill files ordinary proposals in `atomik_chats`,
`atomik_messages` and `atomik_steps`, each approved on its own. Both tables
are created the first time a workspace reads or saves a skill, so older
snapshots simply lack them. Archive is a flag on the skill's row, never a
delete: restore it from the snapshot as it is, and never remove a version to
"tidy" a skill's history.

## Verification evidence

Run the disposable local suite (no remote calls or application env loading):

```sh
node --test tests/ops/backup-restore.test.mjs
```

It verifies live committed WAL capture; both members' private drafts, shared bible
and shot mapping; credit lot/allocation and uncertain meter preservation; permanent
generation claims and task handles; binary data; original keyring escrow; media
bytes; authenticated corruption/wrong-key failures; missing tenant/media failure;
path/symlink defenses; no overwrite; paginated private Blob API contracts and
readback verification; and preparing new endpoints while revoking old access.
Remote Turso and real private Blob rehearsal evidence must be recorded separately.

Verified on **14 September 2026**, using disposable staging resources only:

- Local suite: 13 tests passed; no network access required.
- Turso-only rehearsal: synced source snapshot, encrypted/offline restore and
  fresh remote import; all 5 tables/5 rows, binary values and AUTOINCREMENT state
  matched. Both disposable databases were removed.
- Combined rehearsal: 2 databases, 1 private Blob, 73,771 snapshot/media bytes,
  and 2 sealed keyring values. The restored tenant matched 8 tables/10 rows; the
  prepared platform matched 7 tables/6 rows after endpoint remapping and session
  revocation. The private object passed origin readback SHA-256 and size checks.
  The report retained 2 interrupted-job actions and 1 reserved meter event.
- The combined run started at 02:49:34 UTC and completed verification at
  02:50:15 UTC. All four uniquely named fixture databases and both media copies
  were removed. This tiny fixture timing is not a production RTO.

The combined fixture evidence is stored outside the repository at
`work/backup-cloud-rehearsal/rehearsal.json`; no decrypted customer data or secrets
are in the report. The actual staging platform database was untouched, and no
paid provider call or real email was made. The separate restore Blob token was
retrieved through a temporary, uniquely prefixed Development-only connection;
the connection and prefixed env variable were removed, with the existing Blob
variable and local `.env.local` verified unchanged.

`scripts/ops/staging-rehearsal.mjs` is a separate, explicitly enabled cloud test.
It accepts four arguments: the staging secret file, staging source Blob secret
file, distinct empty restore Blob secret file, and a new evidence directory.
Set `PARTICL_ALLOW_STAGING_REHEARSAL=1`; `TURSO_CLI` may select the installed CLI.
It refuses a nonempty source/target store and is pinned to the designated staging
source store. It creates uniquely named `particl-staging-recovery-*` fixture
databases in `particl-staging`, mints seven-day database-scoped tokens, captures
synced replicas and private media, restores new Turso databases/Blob bytes, checks
all content, and removes only its own disposable databases and fixture objects.
The actual staging platform database is not read or seeded. The output contains
verification counts and cleanup evidence, never keys, tokens or decrypted data.
Do not run this command against a production environment.

Primary references: [Turso embedded replicas](https://docs.turso.tech/features/embedded-replicas/introduction),
[Turso export](https://docs.turso.tech/cli/db/export),
[Turso create](https://docs.turso.tech/cli/db/create),
[Vercel Blob SDK](https://vercel.com/docs/vercel-blob/using-blob-sdk).
