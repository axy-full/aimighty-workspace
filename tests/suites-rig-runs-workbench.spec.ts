import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type CanvasNode, type Project } from "../lib/workbench/studio";

const shot = (id: string, title: string, x: number, y: number): CanvasNode => ({
  id, title, type: "scene", x, y, width: 238, linked: [], role: "Director", status: "draft", mode: "Video",
  engine: "dreamina-seedance-2-5-260628", durationS: 5, ratio: "16:9", resolution: "720p",
});

type Paid = { seq: number; tool: string; title: string; state: string; quote: number | null; charged: number | null; outcome: string | null; pause: string | null; canRender: boolean; fingerprint: string | null };
type Run = {
  id: string; state: string; reason: string | null; credits: number;
  money: { limit: number; mode: string; jobCeiling: number; spent: number; inFlight: number; left: number; planning: { state: string; credits: number | null } | null } | null;
  paid: Paid[]; proposal: { fingerprint: string } | null;
};
type Agent = { agent: { enabled: boolean; run: Run | null; ask: { limit: number; jobCeiling: number; planning: number | null } | null } };

async function setUp(page: Page, name: string) {
  await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((r) => r.json());
  const headers = { "X-Workbench-Scope": `particl-active-${me.workspace.id}-${me.id}` };
  const draft: Project = { ...newProject(name), id: `runs-${Date.now().toString(36)}`, nodes: [shot("theirs", "Ana's opening", 100, 100)] };
  const saved = await page.request.put("/api/workbench/projects", { headers, data: { project: draft, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBe(true);
  const { productionProjectId } = (await saved.json()) as { productionProjectId: string };
  return { draft, headers, productionId: productionProjectId };
}


const agentOf = async (api: APIRequestContext, headers: Record<string, string>, productionId: string, projectId?: string) =>
  (await api.get(`/api/workbench/team-canvas?productionId=${productionId}&agent=1${projectId ? `&projectId=${projectId}` : ""}`, { headers }).then((r) => r.json())) as Agent;





test("the run API: a limit is required and bounded; only the person who asked taps, at the price shown; a tap twice approves once", async ({ page }, info) => {
  test.skip(info.project.name !== "workbench-1440x900", "one desktop: API only");
  const { draft, headers, productionId } = await setUp(page, "Runs API");
  const api = page.request;
  expect((await api.patch("/api/workbench/team-canvas", { headers, data: { productionId, upsertNodes: [shot("theirs", "Ana's opening", 100, 100)], removeNodes: [], upsertAssets: [], order: ["theirs"] } })).ok()).toBe(true);
  const post = (data: Record<string, unknown>) => api.post("/api/workbench/team-canvas", { headers, data: { productionId, ...data } });
  /* No limit, a nonsense limit, or one past the most a run may have: refused before anything runs. */
  expect((await post({ action: "agent.plan", projectId: draft.id, requestId: "req-runs-00000001", goal: "Two shots." })).status()).toBe(400);
  expect((await post({ action: "agent.plan", projectId: draft.id, requestId: "req-runs-00000001", goal: "Two shots.", limit: -5 })).status()).toBe(400);
  expect((await post({ action: "agent.plan", projectId: draft.id, requestId: "req-runs-00000001", goal: "Two shots.", limit: 12.34 })).status()).toBe(400);
  expect((await post({ action: "agent.plan", projectId: draft.id, requestId: "req-runs-00000001", goal: "Two shots.", limit: 2_000_000 })).status()).toBe(400);
  expect((await post({ action: "agent.plan", projectId: draft.id, requestId: "req-runs-00000001", goal: "Two shots.", limit: 500, mode: "sometimes" })).status()).toBe(400);
  const asked = await post({ action: "agent.plan", projectId: draft.id, requestId: "req-runs-00000001", goal: "Two shots.", limit: 500 });
  expect(asked.status()).toBe(202);
  const runId = (await asked.json()).agent.run.id as string;
  await expect.poll(async () => (await agentOf(api, headers, productionId)).agent.run?.state, { timeout: 20_000 }).toBe("awaiting_approval");
  const fingerprint = (await agentOf(api, headers, productionId)).agent.run!.proposal!.fingerprint;
  expect((await post({ action: "agent.approve", runId, fingerprint })).status()).toBe(200);
  await expect.poll(async () => (await agentOf(api, headers, productionId)).agent.run?.state, { timeout: 30_000 }).toBe("needs_you");
  const run = (await agentOf(api, headers, productionId)).agent.run!;
  const waiting = run.paid.find((p) => p.state === "waiting")!;
  /* The card never carries the priced request itself, only its price and fingerprint. */
  expect(JSON.stringify(run)).not.toMatch(/compiled|estUsd|engine_cost|vendor/i);
  expect((await post({ action: "agent.render", runId, seq: waiting.seq, fingerprint: "0".repeat(64) })).status()).toBe(409);
  expect((await post({ action: "agent.render", runId, seq: 999, fingerprint: waiting.fingerprint })).status()).toBe(404);
  expect((await post({ action: "agent.limit", runId, limit: 499 })).status()).toBe(409);
  const tap = await post({ action: "agent.render", runId, seq: waiting.seq, fingerprint: waiting.fingerprint });
  expect(tap.status()).toBe(200);
  /* The same tap again (a lost reply): the same answer, one render. */
  expect((await post({ action: "agent.render", runId, seq: waiting.seq, fingerprint: waiting.fingerprint })).status()).toBe(200);
  await expect.poll(async () => (await agentOf(api, headers, productionId)).agent.run!.paid.find((p) => p.seq === waiting.seq)!.state, { timeout: 60_000 }).toBe("done");
  const jobs = (await (await api.get("/api/jobs?sync=0", { headers })).json()) as { generations?: unknown[]; jobs?: unknown[] };
  const list = (jobs.generations ?? jobs.jobs ?? []) as { id: string }[];
  expect(list.length).toBe(1);
  expect((await post({ action: "agent.stop", runId })).status()).toBe(200);
});
