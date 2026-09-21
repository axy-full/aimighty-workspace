import { requireRender, requireSession } from "../auth";
import { requireTenant } from "../tenant";
import { readDraft, workbenchReady } from "../workbench/records";
import { workbenchScopeProblem } from "../workbench/request-scope";
import type { Project } from "../workbench/studio";
import { CONTEXT_LABELS, DEFAULT_CONTEXT, GOAL_MAX, type CrewContext } from "./room";
import { CrewError } from "./store";

/** What every Crew route needs first: who is asking, in which workspace, from a page that still belongs to them. */
export const NO_STORE = { "Cache-Control": "no-store" };

export async function crewCaller(req: Request, paid = false): Promise<{ userId: string; response?: never } | { userId?: never; response: Response }> {
  const auth = paid ? await requireRender() : await requireSession();
  if (auth.response) return { response: auth.response };
  const scopeError = workbenchScopeProblem(req, requireTenant().id, auth.user.id, true);
  if (scopeError) return { response: Response.json({ error: scopeError }, { status: 409, headers: NO_STORE }) };
  return { userId: auth.user.id };
}

export async function crewProject(userId: string, projectId: unknown): Promise<Project> {
  if (typeof projectId !== "string" || !/^[A-Za-z0-9._:-]{1,120}$/.test(projectId)) throw new CrewError("Open a project first.", 400);
  await workbenchReady();
  const draft = await readDraft(userId, projectId);
  if (!draft) throw new CrewError("Save your project first.", 404);
  return draft.project;
}

export function crewFailure(error: unknown): Response {
  if (error instanceof CrewError) return Response.json({ error: error.message }, { status: error.status, headers: NO_STORE });
  const status = typeof (error as { status?: unknown })?.status === "number" ? (error as { status: number }).status : 500;
  const message = status === 500 ? "Crew could not do that. Nothing was charged." : error instanceof Error ? error.message : "Crew could not do that.";
  if (status === 500) console.error("crew:", error);
  return Response.json({ error: message }, { status, headers: NO_STORE });
}

export function cleanContext(value: unknown): CrewContext {
  const given = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return Object.fromEntries(CONTEXT_LABELS.map(([key]) => [key, typeof given[key] === "boolean" ? given[key] : DEFAULT_CONTEXT[key]])) as CrewContext;
}
export function cleanGoal(value: unknown): string {
  const goal = String(value ?? "").trim();
  if (!goal) throw new CrewError("Write the goal.", 400);
  return goal.slice(0, GOAL_MAX);
}
