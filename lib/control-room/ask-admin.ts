import { db } from "../db";
import { takeOncePerWindow } from "../operationLease";
import { workspaceAdmins } from "../platform";
import { notify } from "../push";
import { requireTenant } from "../tenant";

/*
 * "Ask an admin" (Settings › Spending rules for a member). A person who is not an admin asks the workspace's owner and admins to
 * look at the budget per production, which only an admin changes: they are told (the "A take is waiting on you" notification,
 * lib/notifyPrefs.ts). Asking spends nothing, approves nothing and changes no rule: it is a message. Only a person asks; Atomik
 * and outside agents never do (CLAUDE.md rule 14).
 *
 * There is no ask about a step any more: the admin approval rule and its per-shot cap were retired on 21 Oct 2026 (owner:
 * "every member approves their own spend with their own tap on the quote"), so no step waits for an admin.
 */

export type AskAbout =
  /** The budget per production, which only an admin changes. */
  { about: "rules" };

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
export const ASK_AGAIN_MS = 10 * 60_000;
export const ASK_TRY_AGAIN = "Try again in a moment.";
export const askedRecently = (minutes: number) => `You asked about this ${minutes <= 1 ? "a minute" : `${minutes} minutes`} ago. Ask again in a little while.`;

/*
 * One ask per person and subject every ten minutes, counted whether it was refused or not.
 * Kept in the workspace's database (lib/operationLease.ts takeOncePerWindow), so every server process counts the
 * same asks: one person is not let through once per process.
 */
const askMark = (key: string) => `ask-admin:${key}`;

export type AskDeps = {
  admins?: (workspaceId: string) => Promise<{ id: string }[]>;
  tell?: (ids: string[], payload: { title: string; body: string; url: string }) => Promise<void>;
  now?: () => number;
};

/** Tells the workspace's owner and admins what this person asks them to look at. Returns how many were asked. */
export async function askAdmin(actor: AskActor, ask: AskAbout, deps: AskDeps = {}): Promise<{ asked: number; line: string }> {
  if (!isPersonId(actor.id)) throw new AskAdminError(ASK_NOT_A_PERSON, 403);
  if (actor.admin) throw new AskAdminError(ASK_ADMIN_ALREADY, 409);
  const ws = requireTenant();
  const at = (deps.now ?? Date.now)();
  const key = [ws.id, actor.id, ask.about, ""].join("|");
  /* Every ask counts, refused or not: at most once per person and subject in the window. */
  let mark: Awaited<ReturnType<typeof takeOncePerWindow>>;
  try { mark = await takeOncePerWindow(db(), askMark(key), ASK_AGAIN_MS, at); }
  catch (error) {
    /* Maintenance keeps its own answer (lib/recovery.ts recoveryRoute); any other database trouble is a moment's wait. */
    if (typeof error === "object" && error !== null && "code" in error && error.code === "RECOVERY_FENCED") throw error;
    throw new AskAdminError(ASK_TRY_AGAIN, 503);
  }
  if (!mark.taken) throw new AskAdminError(askedRecently(Math.max(1, Math.round((at - mark.since) / 60_000))), 429);
  /* Marks whose window has ended say nothing any more: cleared while taking one, never in the way of the ask. */
  await db().execute({ sql: "DELETE FROM operation_leases WHERE name GLOB 'ask-admin:*' AND lease_until<=?", args: [at] }).catch(() => {});
  const title = `${clip(actor.name) || "A teammate"} asks an admin`;
  const body = "About the budget per production, in Settings › Spending rules.";
  const url = "/suites?view=workspace&ws=rules";
  const admins = (await (deps.admins ?? workspaceAdmins)(ws.id)).map((a) => a.id).filter((id) => id !== actor.id);
  if (admins.length) await (deps.tell ?? ((ids, payload) => notify("approvalNeeded", ids, payload)))(admins, { title, body, url });
  return { asked: admins.length, line: admins.length ? "Asked. The owner and admins were told; nothing was spent." : "No admin to ask in this workspace yet." };
}

const clip = (text: string, max = 40) => (text.length > max ? `${text.slice(0, max - 1)}…` : text).trim();
