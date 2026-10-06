import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type CanvasNode, type Project } from "../lib/workbench/studio";

const shot = (id: string, title: string, x: number, y: number): CanvasNode => ({
  id, title, type: "scene", x, y, width: 238, linked: [], role: "Director", status: "draft", mode: "Video",
  engine: "dreamina-seedance-2-5-260628", durationS: 5, ratio: "16:9", resolution: "720p",
});

async function setUp(page: Page, name: string) {
  await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((r) => r.json());
  const headers = { "X-Workbench-Scope": `particl-active-${me.workspace.id}-${me.id}` };
  const draft: Project = { ...newProject(name), id: `agent-${Date.now().toString(36)}`, nodes: [shot("theirs", "Ana's opening", 100, 100)] };
  const saved = await page.request.put("/api/workbench/projects", { headers, data: { project: draft, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBe(true);
  const { productionProjectId } = (await saved.json()) as { productionProjectId: string };
  return { draft, headers, productionId: productionProjectId };
}


const canvasOf = async (api: APIRequestContext, headers: Record<string, string>, productionId: string) =>
  (await api.get(`/api/workbench/team-canvas?productionId=${productionId}`, { headers }).then((r) => r.json())) as { canvas: { nodes: Record<string, CanvasNode>; removedIds: string[]; serverMade: Record<string, string> } | null };
const agentOf = async (api: APIRequestContext, headers: Record<string, string>, productionId: string) =>
  (await api.get(`/api/workbench/team-canvas?productionId=${productionId}&agent=1`, { headers }).then((r) => r.json())) as { agent: { enabled: boolean; run: { id: string; state: string; proposal: { fingerprint: string } | null; built: { cards: number; wires: number }; undo: { removed: number; kept: number } | null; credits: number } | null; ask?: unknown } };


test("the Atomik build API: free, checked, scoped to this workspace and production; approve only as shown; undo once", async ({ page }, info) => {
  test.skip(info.project.name !== "workbench-1440x900", "one desktop: API only");
  const { draft, headers, productionId } = await setUp(page, "Build API");
  const api = page.request;
  expect((await api.patch("/api/workbench/team-canvas", { headers, data: { productionId, upsertNodes: [shot("theirs", "Ana's opening", 100, 100)], removeNodes: [], upsertAssets: [], order: ["theirs"] } })).ok()).toBe(true);
  expect(await agentOf(api, headers, productionId)).toEqual({ agent: { enabled: true, run: null, ask: null } });
  const post = (data: Record<string, unknown>, withScope = true) => api.post("/api/workbench/team-canvas", { ...(withScope ? { headers } : {}), data: { productionId, ...data } });
  expect((await post({ action: "agent.plan", projectId: draft.id, requestId: "req-api-00000001", limit: 500 })).status()).toBe(400);
  expect((await post({ action: "agent.plan", projectId: draft.id, requestId: "req-api-00000001", goal: "Two shots." })).status()).toBe(400);
  expect((await post({ action: "agent.plan", projectId: draft.id, requestId: "req-api-00000001", goal: "Two shots.", limit: 500, productionId: "not-here" })).status()).toBe(404);
  expect((await post({ action: "agent.plan", projectId: "someone-else", requestId: "req-api-00000001", goal: "Two shots.", limit: 500 })).status()).toBe(404);
  expect((await post({ action: "agent.plan", projectId: draft.id, requestId: "req-api-00000001", goal: "Two shots.", limit: 500 }, false)).status()).toBe(409);
  const asked = await post({ action: "agent.plan", projectId: draft.id, requestId: "req-api-00000001", goal: "Two shots.", limit: 500 });
  expect(asked.status()).toBe(202);
  const first = await asked.json();
  expect(first).toMatchObject({ agent: { enabled: true, run: { state: "planning", credits: 0, money: { limit: 500, mode: "ask", spent: 0 } } } });
  const runId = first.agent.run.id as string;
  /* The same request again is the same run. */
  expect((await (await post({ action: "agent.plan", projectId: draft.id, requestId: "req-api-00000001", goal: "Two shots.", limit: 500 })).json()).agent.run.id).toBe(runId);
  await expect.poll(async () => (await agentOf(api, headers, productionId)).agent.run?.state, { timeout: 20_000 }).toBe("awaiting_approval");
  const proposed = (await agentOf(api, headers, productionId)).agent.run!;
  expect((await post({ action: "agent.approve", runId, fingerprint: "0".repeat(64) })).status()).toBe(409);
  expect((await post({ action: "agent.approve", runId: "rar_000000000000000000000000", fingerprint: proposed.proposal!.fingerprint })).status()).toBe(404);
  const approved = await post({ action: "agent.approve", runId, fingerprint: proposed.proposal!.fingerprint });
  expect(approved.status()).toBe(200);
  /* Planning was metered into the run's limit; building is free. */
  const planned = (await approved.json()).agent.run;
  expect(planned).toMatchObject({ state: "running", money: { planning: { state: "settled" } } });
  expect(planned.credits).toBeGreaterThan(0);
  /* Built; then the first render waits for its tap (Ask). */
  await expect.poll(async () => (await agentOf(api, headers, productionId)).agent.run?.state, { timeout: 30_000 }).toBe("needs_you");
  expect((await agentOf(api, headers, productionId)).agent.run).toMatchObject({ built: { cards: 4, wires: 4 }, credits: planned.credits });
  expect(Object.keys((await canvasOf(api, headers, productionId)).canvas!.nodes)).toHaveLength(5);
  /* Stop: nothing more is sent; undo takes the build off once. */
  expect((await (await post({ action: "agent.stop", runId })).json()).agent.run.state).toBe("stopped");
  const undone = await (await post({ action: "agent.undo", runId })).json();
  expect(undone).toMatchObject({ agent: { run: { undo: { removed: 4, kept: 0 }, canUndo: false } } });
  expect(Object.keys((await canvasOf(api, headers, productionId)).canvas!.nodes)).toEqual(["theirs"]);
  expect((await (await post({ action: "agent.undo", runId })).json()).agent.run.undo).toEqual(undone.agent.run.undo);
  /* A proposal set aside builds nothing. */
  const again = await (await post({ action: "agent.plan", projectId: draft.id, requestId: "req-api-00000002", goal: "One shot.", limit: 500 })).json();
  await expect.poll(async () => (await agentOf(api, headers, productionId)).agent.run?.state, { timeout: 20_000 }).toBe("awaiting_approval");
  const declined = await (await post({ action: "agent.decline", runId: again.agent.run.id })).json();
  expect(declined.agent.run).toMatchObject({ state: "stopped", built: { cards: 0, wires: 0 }, canUndo: false });
  expect(Object.keys((await canvasOf(api, headers, productionId)).canvas!.nodes)).toEqual(["theirs"]);
});
