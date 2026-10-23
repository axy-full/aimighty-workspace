import { newInterfaceFor } from "../newInterface.server";

/**
 * The switch for v30 jobs and commands (docs/plans/v30-data-model.md § 4.1, 4.2, 4.4 and § 8: PR A3).
 *
 *   on  =  the deployment's `V30_JOBS` is exactly "1"                          (unset or anything else: off for everyone)
 *          AND the workspace has the new interface (lib/newInterface.server.ts: the house workspace, and any workspace the
 *          platform owner lists in the site setting `newInterfaceWorkspaces`).
 *
 * OFF by default. With it off, nothing reads or writes `quoted_jobs` or `agent_commands`, no workspace database gains
 * them, and no route, screen or charge changes. Nothing that bills calls this store yet: wiring the paid paths to it is
 * PR A10, behind its own switch (`V30_JOB_WIRING`). Read when asked, never at import.
 */
export const JOBS_FLAG = "V30_JOBS";

export const jobsSwitchOn = (env: Record<string, string | undefined> = process.env): boolean => env[JOBS_FLAG] === "1";

export async function jobsOn(workspace: { id: string } | null | undefined): Promise<boolean> {
  if (!jobsSwitchOn() || !workspace) return false;
  return newInterfaceFor(workspace);
}

export class JobsOffError extends Error {
  readonly status = 404;
  constructor() {
    super("Not found.");
    this.name = "JobsOffError";
  }
}
