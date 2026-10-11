/**
 * Start on Home: Atomik reads the brief and plans, on today's agent (lib/workbench/rig-agent.ts), through
 * its existing routes only. A person's press of "Start · up to N cr" is the approval of that thinking:
 * the run is asked with a limit of N, so planning is the only thing it can spend; every render after it
 * asks again at its own price (lead decisions 27 and 29). Nothing here is a new way to spend.
 *
 *  1. the project, made by the template path (Home's create);
 *  2. its production, from the saved draft (GET /api/workbench/projects?id=…);
 *  3. the figure for that project now (GET /api/workbench/team-canvas?agent=1): if it is above the pressed N,
 *     nothing is asked and the button shows the new figure for another press;
 *  4. the ask (POST /api/workbench/team-canvas `agent.plan`, mode Ask, limit N).
 */
type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

const fail = async (response: Response | null, fallback: string) =>
  ((await response?.json().catch(() => null)) as { error?: unknown } | null)?.error as string | undefined || fallback;

/** The production a saved draft belongs to (its first save made it). */
export async function productionOf(fetcher: Fetcher, draftId: string): Promise<{ productionId: string } | { error: string }> {
  const response = await fetcher(`/api/workbench/projects?id=${encodeURIComponent(draftId)}`, { cache: "no-store" }).catch(() => null);
  const body = (await response?.json().catch(() => null)) as { project?: { id?: unknown; productionProjectId?: unknown } } | null;
  const id = body?.project?.id === draftId && typeof body.project.productionProjectId === "string" ? body.project.productionProjectId : null;
  return id ? { productionId: id } : { error: "The project isn't ready for Atomik yet. Try again." };
}

/** Planning's figure for this project as it is now; null when Atomik can't be asked here. */
export async function planningFor(fetcher: Fetcher, productionId: string, draftId: string): Promise<{ planning: number } | { error: string }> {
  const query = new URLSearchParams({ agent: "1", productionId, projectId: draftId });
  const response = await fetcher(`/api/workbench/team-canvas?${query}`, { cache: "no-store" }).catch(() => null);
  if (!response?.ok) return { error: await fail(response, "Atomik's thinking price didn't load. Try again.") };
  const body = (await response.json().catch(() => null)) as { agent?: { enabled?: boolean; run?: { state?: string } | null; ask?: { planning?: unknown } | null } } | null;
  const agent = body?.agent;
  if (!agent?.enabled) return { error: "Atomik isn't on for this workspace yet." };
  if (!agent.ask) return { error: "Atomik is already working on this project." };
  const planning = agent.ask.planning;
  return typeof planning === "number" && planning > 0 ? { planning } : { error: "Atomik's thinking can't be priced right now. Try again." };
}

/** Ask Atomik to plan, with the limit the person pressed. */
export async function askAtomik(fetcher: Fetcher, ask: { productionId: string; draftId: string; goal: string; limit: number; requestId: string }): Promise<{ ok: true } | { error: string }> {
  const response = await fetcher("/api/workbench/team-canvas", {
    method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store",
    body: JSON.stringify({ action: "agent.plan", productionId: ask.productionId, projectId: ask.draftId, requestId: ask.requestId, goal: ask.goal, limit: ask.limit, mode: "ask" }),
  }).catch(() => null);
  if (response?.ok) return { ok: true };
  return { error: response ? await fail(response, "Atomik could not be asked. Nothing was charged.") : "The answer didn't arrive. Open the project to see whether Atomik started." };
}
