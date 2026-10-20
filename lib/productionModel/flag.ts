import { newInterfaceFor } from "../newInterface.server";

/**
 * The switch for the v30 production model (docs/plans/v30-data-model.md § 8: PRs A1, A2 and A7).
 *
 *   on  =  the deployment's `V30_PRODUCTION_MODEL` is exactly "1"            (unset or anything else: off for everyone)
 *          AND the workspace has the new interface (lib/newInterface.server.ts: the house workspace, and any workspace the
 *          platform owner lists in the site setting `newInterfaceWorkspaces`).
 *
 * OFF by default. With it off, nothing reads or writes the v30 step tables, no workspace database gains them, and no
 * route, screen or charge changes. Read when asked, never at import.
 */
export const PRODUCTION_MODEL_FLAG = "V30_PRODUCTION_MODEL";

export const productionModelSwitchOn = (env: Record<string, string | undefined> = process.env): boolean =>
  env[PRODUCTION_MODEL_FLAG] === "1";

export async function productionModelOn(workspace: { id: string } | null | undefined): Promise<boolean> {
  if (!productionModelSwitchOn() || !workspace) return false;
  return newInterfaceFor(workspace);
}

export class ProductionModelOffError extends Error {
  readonly status = 404;
  constructor() {
    super("Not found.");
    this.name = "ProductionModelOffError";
  }
}
