import { cleanRule, cleanShotCap } from "../approvalRule";
import { db } from "../db";
import { workspaceAdmins } from "../platform";
import { notify } from "../push";
import { getSetting } from "../settings";
import { requireTenant } from "../tenant";
import { priceRender, stepTitle } from "../workbench/rig-agent-runs";
import { shotCreditsSoFar } from "../shotCap";
import { rigAgentExists, runOfProduction, stepsOf, type RunRow, type StepRow } from "../workbench/rig-agent-store";

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
export const ASK_NOT_OVER = "That step is not over the per-shot cap: it needs no admin.";
export const ASK_AGAIN_MS = 10 * 60_000;
export const askedRecently = (minutes: number) => `You asked about this ${minutes <= 1 ? "a minute" : `${minutes} minutes`} ago. Ask again in a little while.`;

/*
 * One ask per person and subject (a step, or the rules) every ten minutes, counted whether it was refused or not.
 * Kept on this server instance: asking spends nothing and changes nothing, so a lost count only lets one more through.
 */
const asked = new Map<string, number>();

/**
 * Whether this render is over the workspace's per-shot cap, judged on the figure the gate and admission use
 * (lib/shotCap.ts shotCapGate): what the shot already holds plus this render's price. A render the run paused for an
 * admin is over by definition. The render's price is the run's own when it has one, else a fresh, free pricing of the
 * exact request the run will send (lib/workbench/rig-agent-runs.ts priceRender), where admission's own refusal of a
 * member over the cap also says so.
 */
export async function overCap(run: RunRow, step: StepRow, cap: number): Promise<boolean> {
  if (step.state === "paused" && step.pause === "admin") return true;
  const shotOf = (a: { request?: Record<string, unknown> } | null | undefined) => (typeof a?.request?.shotId === "string" && a.request.shotId ? a.request.shotId : null);
  let quote: number, shot: string | null;
  if (step.quoteCredits != null) { quote = step.quoteCredits; shot = shotOf(step.admission); }
  else {
    const priced = await priceRender(run, step);
    if (!priced.ok) return priced.pause === "admin";
    quote = priced.quote; shot = shotOf(priced.admission);
  }
  const sofar = shot ? await shotCreditsSoFar(shot) : 0;
  return sofar + quote > cap;
}

export type AskDeps = {
  admins?: (workspaceId: string) => Promise<{ id: string }[]>;
  tell?: (ids: string[], payload: { title: string; body: string; url: string }) => Promise<void>;
  /** Whether a render is over the per-shot cap (default: the server's price, `overCap`). */
  over?: (run: RunRow, step: StepRow, cap: number) => Promise<boolean>;
  now?: () => number;
};

/** Tells the workspace's owner and admins what this person asks them to look at. Returns how many were asked. */
export async function askAdmin(actor: AskActor, ask: AskAbout, deps: AskDeps = {}): Promise<{ asked: number; line: string }> {
  if (!isPersonId(actor.id)) throw new AskAdminError(ASK_NOT_A_PERSON, 403);
  if (actor.admin) throw new AskAdminError(ASK_ADMIN_ALREADY, 409);
  const ws = requireTenant();
  const at = (deps.now ?? Date.now)();
  const key = [ws.id, actor.id, ask.about, ask.about === "step" ? `${ask.productionId}:${ask.runId}:${ask.seq}` : ""].join("|");
  const last = asked.get(key);
  if (last != null && at - last < ASK_AGAIN_MS) throw new AskAdminError(askedRecently(Math.max(1, Math.round((at - last) / 60_000))), 429);
  /* Every ask counts, refused or not: the step is judged (and priced) at most once per person and subject in the window. */
  asked.set(key, at);
  let title: string, body: string, url: string;
  if (ask.about === "step") {
    if (cleanRule(await getSetting("approvalRule")) !== "cap") throw new AskAdminError(ASK_NO_CAP, 409);
    if (!(await rigAgentExists())) throw new AskAdminError(ASK_NO_STEP, 404);
    const run = await runOfProduction(db(), ask.productionId, ask.runId);
    const step = run ? (await stepsOf(db(), run.id)).find((s) => s.seq === ask.seq && s.purpose === "take") : undefined;
    if (!run || !step) throw new AskAdminError(ASK_NO_STEP, 404);
    if (!(await (deps.over ?? overCap)(run, step, cleanShotCap(await getSetting("shotCapCredits"))))) throw new AskAdminError(ASK_NOT_OVER, 409);
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
