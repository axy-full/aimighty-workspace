import { exportWorkerConfig } from "../exports/limits";
import { newInterfaceFor } from "../newInterface.server";

/**
 * The switch for deck PDFs (owner, 15 Oct 2026): `PDF_EXPORTS`, read at run time, its own, apart from `REMOTION_EXPORTS`. Unset or anything
 * but 1/on/true/yes is OFF, which is the production default. On, it is on for the house workspace and the workspaces the owner lists in the
 * site setting (`newInterfaceWorkspaces`, lib/newInterface.ts), and off for every customer workspace until launch. Off, the route answers 404, the
 * tool is not offered over MCP, and nothing is read, written or sent to a worker.
 */
export function pdfExportsEnabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  const value = (env.PDF_EXPORTS ?? "").trim().toLowerCase();
  return value === "1" || value === "on" || value === "true" || value === "yes";
}

/** Whether this workspace has deck PDFs: the switch is on and the workspace is the house workspace or listed. */
export async function pdfAllowedFor(workspace: { id: string } | null | undefined, env: Readonly<Record<string, string | undefined>> = process.env): Promise<boolean> {
  if (!pdfExportsEnabled(env) || !workspace) return false;
  return newInterfaceFor(workspace);
}

/** Whether the tool can run now in an allowed workspace, and when it cannot, why (naming the missing setting, never its value). */
export function pdfWorkersReady(env: Readonly<Record<string, string | undefined>> = process.env): { ready: boolean; reason: string | null } {
  return exportWorkerConfig(env) ? { ready: true, reason: null } : { ready: false, reason: "Deck PDFs need REMOTION_WORKER_URLS and REMOTION_WORKER_SECRETS: one to three worker addresses and a secret for each." };
}
