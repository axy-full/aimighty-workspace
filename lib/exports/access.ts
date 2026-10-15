import { engineEnabled } from "../engineGate";

/**
 * Are exports on for the workspace this code is running for? REMOTION_EXPORTS exactly "1" AND the workspace is the house or is
 * listed in the site setting `enginesOnWorkspaces` (lib/engineGate.ts; owner, 15 Oct 2026, 22:15: off for customer workspaces
 * until launch). With no workspace in scope the answer is no. The global switch is read first.
 */
export const exportsOnHere = (): Promise<boolean> => engineEnabled("REMOTION_EXPORTS");
