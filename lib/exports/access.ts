import { engineEnabledFor } from "../engineGate.server";
import { currentTenant } from "../tenant";

/**
 * Are exports on for the workspace this code is running for? REMOTION_EXPORTS on AND the workspace is the house or is
 * listed in the site setting `enginesOnWorkspaces` (lib/engineGate.ts; owner, 15 Oct 2026, 22:15: off for customer
 * workspaces until launch). With no workspace in scope the answer is no. The global switch is read first.
 */
export async function exportsOnHere(env: Readonly<Record<string, string | undefined>> = process.env): Promise<boolean> {
  return engineEnabledFor("remotion", currentTenant()?.workspace, env);
}
