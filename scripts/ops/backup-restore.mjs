#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import {
  createBackup,
  restoreBackup,
  restoreBlobs,
  verifyDatabase,
  OpsError,
} from "./backup-lib.mjs";
import { recoveryReport } from "./recovery-report.mjs";
import { prepareRestore } from "./prepare-restore.mjs";

const [command, ...args] = process.argv.slice(2);
const config = async (path) => JSON.parse(await readFile(path, "utf8"));
const usage = `Particl operational backup (Node 20+, existing dependencies).
Secrets are read only from named environment variables; .env files are not loaded.

  backup SOURCE.json NEW_BUNDLE_DIRECTORY
  restore BUNDLE_DIRECTORY NEW_OFFLINE_DIRECTORY
  report OFFLINE_DIRECTORY
  prepare OFFLINE_DIRECTORY TARGET_MAPPING.json NEW_PREPARED_DIRECTORY
  verify-db SQLITE_SNAPSHOT TARGET_DB.json
  restore-blobs OFFLINE_DIRECTORY EMPTY_PRIVATE_STORE.json

Backup/restore require PARTICL_BACKUP_KEY (32 random bytes, base64).
Backup also requires the ORIGINAL KEYRING_SECRET. See docs/backup-restore.md.
Remote capture is read only; restore-blobs writes to an explicitly empty store.
The tool never starts the app, creates a paid job, calls email or changes billing.
`;
try {
  let result;
  if (command === "backup" && args.length === 2)
    result = await createBackup(await config(args[0]), args[1]);
  else if (command === "restore" && args.length === 2)
    result = await restoreBackup(args[0], args[1]);
  else if (command === "report" && args.length === 1)
    result = await recoveryReport(args[0]);
  else if (command === "prepare" && args.length === 3)
    result = await prepareRestore(args[0], await config(args[1]), args[2]);
  else if (command === "verify-db" && args.length === 2)
    result = await verifyDatabase(args[0], await config(args[1]));
  else if (command === "restore-blobs" && args.length === 2)
    result = await restoreBlobs(args[0], await config(args[1]));
  else {
    console.log(usage);
    process.exitCode = command === "--help" || !command ? 0 : 2;
  }
  if (result) console.log(JSON.stringify({ command, ...result }));
} catch (error) {
  // SDK errors can include authorization headers or URLs. Keep CLI diagnostics
  // bounded; debug SDK failures privately, never by printing the original error.
  console.error(
    error instanceof OpsError
      ? error.message
      : "Operation failed; no successful verification was recorded. Check the source/target configuration and provider status. Secret-bearing SDK errors are withheld.",
  );
  process.exitCode = 1;
}
