import { cleanRule } from "../approvalRule";
import { db } from "../db";
import { workspaceAdmins } from "../platform";
import { notify } from "../push";
import { getSetting } from "../settings";
import { requireTenant } from "../tenant";
import { stepTitle } from "../workbench/rig-agent-runs";
import { rigAgentExists, runOfProduction, stepsOf } from "../workbench/rig-agent-store";

/*
 * "Ask an admin" (design Gaps B: a step over the per-shot cap; Settings › Spending rules for a member). A person who
 * is not an admin asks the workspace's owner and admins to look: they are told (the "A take is waiting on you"
 * notification, lib/notifyPrefs.ts), and the step is already in the control room's Approvals for them, marked
 * "needs an admin" (lib/control-room/approvals.server.ts). Asking spends nothing, approves nothing and changes no
 * rule: it is a message. Only a person asks; Atomik and outside agents never do (CLAUDE.md rule 14).
 */

export type AskAbout =
  /** A render of Atomik's plan on a board, over the per-shot cap. */
  | { about: "step"; productionId: string; runId: string; seq: number }
  /** The budget and the per-shot cap, which only an admin changes. */
  | { about: "rules" };

export type AskActor = { id: string; name: string; admin: boolean };

export class AskAdminError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

/** A person's id: never Atomik's (`agent:<run>`), the run's own Auto, the server, or nobody. */
export function isPersonId(id: string | null | undefined): boolean {
  return typeof id === "string" && id.trim() !== "" && !id.startsWith("agent:") && id !== "auto" && id !== "server";
}

export const ASK_NOT_A_PERSON = "Only a person asks an admin. Atomik and outside agents prepare; people approve.";
export const ASK_ADMIN_ALREADY = "You are an admin: you can change this yourself.";
export const ASK_NO_CAP = "This workspace has no per-shot cap: anyone on the team may approve this.";
export const ASK_NO_STEP = "That step is not on this board's plan.";

export type AskDeps = {
  admins?: (workspaceId: string) => Promise<{ id: string }[]>;
  tell?: (ids: string[], payload: { title: string; body: string; url: string }) => Promise<void>;
};

/** Tells the workspace's owner and admins what this person asks them to look at. Returns how many were asked. */
export async function askAdmin(actor: AskActor, ask: AskAbout, deps: AskDeps = {}): Promise<{ asked: number; line: string }> {
  if (!isPersonId(actor.id)) throw new AskAdminError(ASK_NOT_A_PERSON, 403);
  if (actor.admin) throw new AskAdminError(ASK_ADMIN_ALREADY, 409);
  const ws = requireTenant();
  let title: string, body: string, url: string;
  if (ask.about === "step") {
    if (cleanRule(await getSetting("approvalRule")) !== "cap") throw new AskAdminError(ASK_NO_CAP, 409);
    if (!(await rigAgentExists())) throw new AskAdminError(ASK_NO_STEP, 404);
    const run = await runOfProduction(db(), ask.productionId, ask.runId);
    const step = run ? (await stepsOf(db(), run.id)).find((s) => s.seq === ask.seq && s.purpose === "take") : undefined;
    if (!run || !step) throw new AskAdminError(ASK_NO_STEP, 404);
    title = `${clip(actor.name) || "A teammate"} asks an admin`;
    body = `${clip(stepTitle(run, step), 80)} is over the per-shot cap. It waits in Approvals, marked for an admin.`;
    url = "/suites?suite=atomik&page=approvals";
  } else {
    title = `${clip(actor.name) || "A teammate"} asks an admin`;
    body = "About the budget per production or the per-shot cap, in Settings › Spending rules.";
    url = "/suites?view=workspace&ws=rules";
  }
  const admins = (await (deps.admins ?? workspaceAdmins)(ws.id)).map((a) => a.id).filter((id) => id !== actor.id);
  if (admins.length) await (deps.tell ?? ((ids, payload) => notify("approvalNeeded", ids, payload)))(admins, { title, body, url });
  return { asked: admins.length, line: admins.length ? "Asked. The owner and admins were told; nothing was spent." : "No admin to ask in this workspace yet." };
}

const clip = (text: string, max = 40) => (text.length > max ? `${text.slice(0, max - 1)}…` : text).trim();
