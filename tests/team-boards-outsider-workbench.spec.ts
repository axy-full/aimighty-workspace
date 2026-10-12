import { test, expect, request as pwRequest, type APIRequestContext } from "@playwright/test";
import { leaks, seedPrivate, type Private } from "./helpers/privacyV12";
import { newProject } from "../lib/workbench/studio";

/**
 * Someone outside the workspace gets nothing of its boards, shared or private (owner, 12 Oct 2026: "anyone outside the workspace still gets
 * nothing"). Server side, on the local ENGINE_MOCK server through the real routes. A has two boards: one it shared with its team, one it kept
 * private. A person in ANOTHER workspace asks for each by its id, by its id with its maker named, in the team list, by its production and in the
 * library, in their own scope and claiming A's. Nothing of either comes back. (The same person inside A would read the shared one, view-only:
 * tests/team-boards-workbench.spec.ts.)
 */
const base = process.env.PW_BASE_URL || "http://localhost:4551";
let a: Private;
let outsider: Private;
let sharedId: string;
let shared: { name: string; mark: string };

test.describe.configure({ mode: "serial" });
test.beforeAll(async ({}, info) => {
  test.skip(info.project.name !== "workbench-1440x900", "one run, API only");
  test.setTimeout(240_000);
  const probe = await pwRequest.newContext({ baseURL: base });
  const health = await probe.get("/api/health").then((r) => r.json()).catch(() => null);
  await probe.dispose();
  test.skip(!health?.mock, "requires a local ENGINE_MOCK=1 server");
  a = await seedPrivate(await pwRequest.newContext({ baseURL: base }), "Board Owner");
  outsider = await seedPrivate(await pwRequest.newContext({ baseURL: base }), "Outside Workspace");
  /* A second board of A's, shared with its team; the seeded one stays private. */
  shared = { name: `Shared board ${a.mark}`, mark: a.mark };
  const draft = { ...newProject(shared.name), brief: `Shared brief ${a.mark}`, script: `Shared script ${a.mark}` };
  sharedId = draft.id;
  const saved = await a.api.put("/api/workbench/projects", { headers: a.headers, data: { project: draft, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBe(true);
  const on = await a.api.post("/api/workbench/projects", { headers: a.headers, data: { action: "team-share", projectId: sharedId, shared: true } });
  expect(on.ok(), await on.text()).toBe(true);
});
test.afterAll(async () => { await Promise.all([a?.api, outsider?.api].map((c) => c?.dispose())); });

const asked = async (api: APIRequestContext, path: string, headers: Record<string, string>) => {
  const r = await api.get(path, { headers, maxRedirects: 0 });
  return { status: r.status(), text: await r.text() };
};

test("an outsider reads neither the shared board nor the private one: by id, by id and maker, by team list, by production, in the library, in their own scope or claiming A's", async () => {
  for (const headers of [outsider.headers, { ...outsider.headers, "X-Workbench-Scope": a.scope }]) {
    const claiming = headers["X-Workbench-Scope"] === a.scope ? "claiming A's scope" : "own scope";
    for (const id of [sharedId, a.draftId]) {
      for (const path of [`/api/workbench/projects?id=${id}`, `/api/workbench/projects?id=${id}&owner=${a.userId}`, `/api/workbench/library?projectId=${id}&source=uploads`, `/api/workbench/library?projectId=${id}&source=generations`]) {
        const r = await asked(outsider.api, path, headers);
        expect(leaks(r.text, [...a.secrets, `Shared brief ${a.mark}`, `Shared script ${a.mark}`]), `${path} (${claiming}): ${r.status}`).toEqual([]);
        if (r.status < 400) expect((JSON.parse(r.text) as { project?: unknown }).project ?? null, `${path} (${claiming})`).toBeNull();
      }
    }
    for (const path of ["/api/workbench/projects?team=1", "/api/workbench/projects?team=1&kinds=1", `/api/workbench/projects?production=${a.productionId}`]) {
      const r = await asked(outsider.api, path, headers);
      expect(leaks(r.text, [...a.secrets, shared.name, "Board Owner"]), `${path} (${claiming}): ${r.status}`).toEqual([]);
    }
  }
});

test("an outsider cannot share, unshare or save A's boards either, and A's boards stay as they were", async () => {
  for (const id of [sharedId, a.draftId]) {
    for (const headers of [outsider.headers, { ...outsider.headers, "X-Workbench-Scope": a.scope }]) {
      const r = await outsider.api.post("/api/workbench/projects", { headers: { ...headers, "Content-Type": "application/json" }, data: { action: "team-share", projectId: id, shared: id === sharedId ? false : true } });
      expect(r.status(), `team-share ${id}`).toBeGreaterThanOrEqual(400);
    }
  }
  /* A save naming either board changes nothing of A's and says nothing of A (it is the outsider's own draft, if anything). */
  const revisions = async () => Promise.all([sharedId, a.draftId].map(async (id) => ((await (await a.api.get(`/api/workbench/projects?id=${id}`, { headers: a.headers })).json()) as { revision: number }).revision));
  const before = await revisions();
  for (const id of [sharedId, a.draftId]) {
    for (const headers of [outsider.headers, { ...outsider.headers, "X-Workbench-Scope": a.scope }]) {
      const put = await outsider.api.put("/api/workbench/projects", { headers: { ...headers, "Content-Type": "application/json" }, data: { project: { ...newProject("Intruder"), id }, revision: 0 } });
      expect(leaks(await put.text(), [...a.secrets, shared.name, "Board Owner", "view_only"]), `put ${id}`).toEqual([]);
    }
  }
  expect(await revisions()).toEqual(before);
  /* A's boards are exactly as they were: the shared one still shared, the private one still private, to a member of A. */
  const own = await (await a.api.get(`/api/workbench/projects?id=${sharedId}`, { headers: a.headers })).json() as { project: { teamShared?: boolean } };
  expect(own.project.teamShared).toBe(true);
  const priv = await (await a.api.get(`/api/workbench/projects?id=${a.draftId}`, { headers: a.headers })).json() as { project: { teamShared?: boolean } };
  expect(priv.project.teamShared).toBeUndefined();
});
