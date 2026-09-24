# Backup, restore and interrupted-provider recovery

This runbook covers the platform database, every tenant database, private media,
the original application keyring and the records that prevent duplicate paid
submissions. It changes no price, entitlement or billing integration. The tool
never calls an engine, sends mail, starts the app, releases held jobs or runs purge.

Use `node scripts/ops/backup-restore.mjs --help` from the repository. Node 20+
and the installed `@libsql/client` and `@vercel/blob` dependencies are required.
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

Backups are **weekly and kept forever** (owner, 24 September 2026): see
[weekly-backup.md](weekly-backup.md). Each verified ciphertext bundle is written
once to a dedicated private Blob store that nothing deletes from, and kept for
90 days as a run artifact. (Superseded: the earlier daily 30-day / Sunday 12-week
retention.) Every capture includes a complete
offline restore verification; continue a monthly independent operator/cloud
restore rehearsal. GitHub's retained immutable artifact contains only ciphertext;
record its backup-key version and capture time in the separately held recovery
inventory. Hourly freshness checks fail when no verified artifact is newer than
26 hours. No production schedule, secrets or opt-in variable have been activated,
and no production RPO/RTO has been measured. Retain old backup key versions until
the last archive using them expires.
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

```sh
node scripts/ops/backup-restore.mjs backup /secure/source.json /secure/backups/unique-capture
node scripts/ops/backup-restore.mjs restore /secure/backups/unique-capture /secure/rehearsals/unique-restore
node scripts/ops/backup-restore.mjs report /secure/rehearsals/unique-restore
```

Both destination directories must not exist. Keep the complete archive directory,
including `header.json`, `manifest.enc` and every numbered encrypted object.
The command prints only counts and success metadata. Provider error details are
withheld because SDK exceptions can contain credentials. A nonzero exit is not a
successful backup. Upload only the encrypted archive; never upload a decrypted
rehearsal directory as a normal CI artifact.

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
A manual `capture` fails explicitly while disabled or outside `main`.

Before enabling it, create a protected GitHub environment named `particl-backup`,
restrict deployment branches to `main`, configure the appropriate approval/access
policy, and escrow these environment secrets:

| Secret                           | Contents                                                                                                                                                                      |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PARTICL_BACKUP_SOURCE_JSON`     | The complete source JSON inventory from this runbook. Keep it synchronized with newly provisioned workspaces; omissions cause failure.                                        |
| `PARTICL_BACKUP_ENV_JSON`        | A JSON object of the scoped URL/token variables referenced by that inventory, plus the original `KEYRING_SECRET`. Do not include a Turso organization/provisioning API token. |
| `PARTICL_BACKUP_KEY`             | The independent 32-byte base64 archive key, also retained outside GitHub by recovery custodians.                                                                              |
| `PARTICL_BACKUP_QUIESCENCE_JSON` | Fresh confirmation from the operator or maintenance orchestrator that the exact sources are fenced and all mutating services are paused.                                      |

The quiescence record is valid for at most two hours and must remain valid through
capture and verification. For example (replace times and fingerprint):

```json
{
  "issuedAt": "2026-09-14T02:00:00Z",
  "expiresAt": "2026-09-14T03:30:00Z",
  "sourceFingerprint": "<sha256 from the fingerprint command>",
  "mutationsPaused": true,
  "workersPaused": true,
  "uploadsPaused": true,
  "provisioningPaused": true,
  "purgePaused": true
}
```

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

On success, the workflow uploads only the encrypted bundle after a complete
restore has passed, then removes runner copies. Expired quiescence, new uncertain
work, missing credentials/inventory, corruption, or an unsuccessful restore
removes the unpublished bundle and fails the job. There is no `always()` upload
of a failed backup. Retention is 30 days, or 84 for a Sunday capture, within the
repository's artifact-retention policy; configure that policy to permit 84 days.
Check runner disk and repository Actions/storage limits before activation. The
workflow provisions no paid service and has not uploaded production data.

The hourly freshness job uses only the short-lived built-in GitHub token with
`actions: read` to inspect artifact metadata. Missing, expired, empty or stale
verified artifacts fail the check. Enable GitHub Actions failure notifications
for the operational owner and test that delivery before relying on it; there is
no separately configured email/Slack sender in this workflow. A failed capture
is actionable even when yesterday's artifact is still within 26 hours. Download
the exact retained encrypted artifact for recovery, retain its complete bundle,
and use the original matching backup key; never replace it with a newly generated
key and assume an old archive will decrypt.

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

### Higgsfield consumer jobs

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
