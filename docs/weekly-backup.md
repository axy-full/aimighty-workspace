# Weekly backups — kept forever

Owner decisions, 24 September 2026: backups run **weekly** with the existing encrypted tool, and **nothing is ever deleted** — every verified backup is kept indefinitely.

Each weekly run closes the site to writes for a few minutes (visitors see a maintenance page), drains work in flight, captures every database and the private media store, encrypts it, restores it on an isolated runner to prove it, then stores only the ciphertext:

- **forever** in a dedicated private Vercel Blob store (`backups/<run>/…`, written once, read back and checksummed);
- for 90 days as a GitHub Actions artifact (a second copy).

The site reopens at the end of every run, including a failed one.

## One-time setup (owner)

Nothing below is done by Claude: each step handles a credential.

1. **Escrow the keyring.** Copy the production `KEYRING_SECRET` (Vercel › particlstudio › Settings › Environment Variables) into your password manager as *Particl KEYRING_SECRET — original*, and give a second trusted person access. Never rotate it: every sealed vendor key and database token depends on the original.
2. **Make the backup key.** Generate 32 random bytes as base64 (`openssl rand -base64 32`), save it in the password manager as *Particl backup key v1*, and add it to GitHub as below. Do not reuse `KEYRING_SECRET`.
3. **Make the permanent backup store.** Vercel › Storage › Create › Blob, name it `particl-backups`, private. Copy its read-write token. Do not connect it to the app, and do not reuse the app's media store.
4. **GitHub environment.** Repository › Settings › Environments › New environment `particl-backup` (restrict it to the `main` branch and yourself as reviewer if you like). Add:
   - secret `PARTICL_BACKUP_KEY` — the key from step 2
   - secret `PARTICL_BACKUP_ARCHIVE_TOKEN` — the `particl-backups` token from step 3
5. **Switch on.** Repository › Settings › Secrets and variables › Actions › Variables › `PARTICL_BACKUP_ENABLED` = `true`. From then on a daily check fails (and GitHub emails you) when no verified backup is newer than eight days.

## Every week (about 15 minutes, a quiet hour)

On a machine with an encrypted disk, signed in to `gh`, in the repository on `main`:

1. Put the four credentials in the shell from the password manager / Vercel (never in a file in the repository): `PLATFORM_DATABASE_URL`, `PLATFORM_AUTH_TOKEN`, `KEYRING_SECRET`, `BLOB_READ_WRITE_TOKEN`.
2. Write the checkpoint input once and reuse it (a private file outside the repository), e.g. `~/particl-backup/input.json`:

   ```json
   {
     "preconditions": {
       "deployments": [{ "id": "production", "protocol": "particl-recovery-fence-v1" }],
       "oldDeploymentsStopped": true,
       "externalWritersExcluded": true,
       "evidence": "Only the current production deployment holds write credentials; no manual writers during the window."
     },
     "media": { "kind": "blob", "tokenEnv": "BLOB_READ_WRITE_TOKEN" }
   }
   ```

3. Run, with a new directory each week:

   ```sh
   node scripts/ops/weekly-backup.mjs ~/particl-backup/$(date +%F) ~/particl-backup/input.json
   ```

   It prints five steps: close, drain, seal, capture (watching the protected run), reopen. `--dry-run` shows the commands without running anything.

4. Keep the week's directory (it holds the coordinator key) on the encrypted disk; the per-checkpoint secrets are removed from GitHub automatically.

If work does not drain within 20 minutes the run stops and reopens the site; reconcile what it names (see `docs/enforced-recovery-fence.md`) and run again. If the reopen itself fails, the script prints the exact command to reopen by hand — run it at once.

## Restore

`docs/backup-restore.md` covers restore. Fetch the run's objects from the `particl-backups` store (`backups/<run>-<attempt>/`) or the artifact, then `node scripts/ops/backup-restore.mjs restore …` with the backup key from the password manager. Rehearse a restore monthly.
