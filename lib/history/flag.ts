import { newInterfaceFor } from "../newInterface.server";

/**
 * The switch for v30 History (docs/plans/v30-data-model.md § 5 and § 8: PR A9).
 *
 *   on  =  the deployment's `V30_HISTORY` is exactly "1"                      (unset or anything else: off for everyone)
 *          AND the workspace has the new interface (lib/newInterface.server.ts: the house workspace, and any workspace the
 *          platform owner lists in the site setting `newInterfaceWorkspaces`).
 *
 * History reads the v30 jobs, so it also needs their own switch (`V30_JOBS`); the read model asks for both, this one
 * first. OFF by default. With it off, the History route answers 404 before any database is opened, and nothing else
 * changes: today's Usage page and export are untouched. Read when asked, never at import.
 */
export const HISTORY_FLAG = "V30_HISTORY";

export const historySwitchOn = (env: Record<string, string | undefined> = process.env): boolean => env[HISTORY_FLAG] === "1";

export async function historyOn(workspace: { id: string } | null | undefined): Promise<boolean> {
  if (!historySwitchOn() || !workspace) return false;
  return newInterfaceFor(workspace);
}

export class HistoryOffError extends Error {
  readonly status = 404;
  constructor() {
    super("Not found.");
    this.name = "HistoryOffError";
  }
}
