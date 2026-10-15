import { exportWorkerConfig } from "../exports/limits";
import { engineEnabled, engineSwitchOn } from "../engineGate";

/**
 * The gate for deck PDFs is the shared engine gate (lib/engineGate.ts, the owner's standing rule of 15 Oct 2026): `PDF_EXPORTS` is this engine's own kill
 * switch, on only when it is exactly "1" (unset or anything else is off for everyone), and then it is on for the house workspace and the workspaces the owner
 * lists in the site setting `enginesOnWorkspaces`, and off for every customer workspace until launch. Off: the route answers 404 before the session, the body or
 * anything else is touched, the MCP tool is not offered and answers "Unknown tool", and nothing is sent to a worker.
 */
export const PDF_SWITCH = "PDF_EXPORTS";
export const pdfExportsEnabled = (): boolean => engineSwitchOn(PDF_SWITCH);

/** Whether this workspace (default: the one in scope) has deck PDFs. */
export const pdfAllowedFor = (workspace?: { id: string } | null): Promise<boolean> =>
  workspace === undefined ? engineEnabled(PDF_SWITCH) : engineEnabled(PDF_SWITCH, workspace);

/** Whether the tool can run now in an allowed workspace, and when it cannot, why (naming the missing setting, never its value). */
export function pdfWorkersReady(env: Readonly<Record<string, string | undefined>> = process.env): { ready: boolean; reason: string | null } {
  return exportWorkerConfig(env) ? { ready: true, reason: null } : { ready: false, reason: "Deck PDFs need REMOTION_WORKER_URLS and REMOTION_WORKER_SECRETS: one to three worker addresses and a secret for each." };
}
