import { test, expect, request as pwRequest, type APIRequestContext } from "@playwright/test";
import { createClient } from "@libsql/client";
import { leaks, seedPrivate, type Private } from "./helpers/privacyV12";
import { localPlatformDbUrl, signInLocally } from "./helpers/workbenchLocal";
import { newProject } from "../lib/workbench/studio";

/**
 * TEAMMATES' BOARDS (owner, 11 Oct 2026): every member of a workspace sees every board in it, and opens a teammate's view-only.
 * Server side, on the local ENGINE_MOCK server through the real routes:
 *  - a member of A lists and reads A's boards (their own marked as theirs), and a teammate's board comes with its maker's name;
 *  - a save of a teammate's board is refused and the maker's board is unchanged (never a second copy under the saver's name);
 *  - a member of ANOTHER workspace gets nothing of A's through any of those routes (by id, by the owner's id, claiming A's scope);
 *  - a person who leaves (or is switched off) stops seeing the boards.
 * Boards are private drafts of their maker inside the workspace's own database; productions, takes and files were already the
 * workspace's, and stay so (the takes and picture of A's board are asked for below as the outsider too).
 */
const base = process.env.PW_BASE_URL || "http://localhost:4551";
let a: Private;
let teammate: APIRequestContext, teammateId: string, teammateName: string;
let outsider: Private;
let teammateHeaders: Record<string, string>;

const platform = async <T>(run: (db: ReturnType<typeof createClient>) => Promise<T>) => {
  const db = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try { return await run(db); } finally { db.close(); }
};

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
  /* A teammate: their own account, made a member of A, and switched into it. */
  teammate = await pwRequest.newContext({ baseURL: base });
  teammateName = "Teammate Reader";
  await signInLocally(teammate, teammateName);
  teammateId = String((await teammate.get("/api/me").then((r) => r.json())).id);
  await platform((db) => db.execute({ sql: "INSERT INTO memberships(workspace_id,account_id,role,disabled,created_at) VALUES(?,?,?,?,?)", args: [a.workspaceId, teammateId, "member", 0, Date.now()] }));
  const switched = await teammate.post("/api/workspaces/switch", { data: { id: a.workspaceId } });
  expect(switched.ok(), await switched.text()).toBe(true);
  teammateHeaders = { "X-Workbench-Scope": `particl-active-${a.workspaceId}-${teammateId}`, "Content-Type": "application/json" };
});
test.afterAll(async () => { await Promise.all([a?.api, outsider?.api, teammate].map((c) => c?.dispose())); });

type Team = { team?: { id: string; name: string; mine: boolean; owner: { id: string; name: string } }[]; project?: { id: string } | null; viewOnly?: { owner: { id: string; name: string } }; projects?: { id: string }[] };
const asJson = async (r: Awaited<ReturnType<APIRequestContext["get"]>>) => ({ status: r.status(), text: await r.text() });

test("a member lists every board of their workspace, their own marked, with each maker's name", async () => {
  /* The teammate has a board of their own too. */
  const mine = { ...newProject(`Teammate board ${a.mark}`) };
  const saved = await teammate.put("/api/workbench/projects", { headers: teammateHeaders, data: { project: mine, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBe(true);
  const body = await (await teammate.get("/api/workbench/projects?team=1", { headers: teammateHeaders })).json() as Team;
  const owners = body.team!.find((b) => b.id === a.draftId)!;
  expect(owners, "the owner's board is listed for the teammate").toBeTruthy();
  expect(owners.mine).toBe(false);
  expect(owners.owner.name).toContain("Board Owner");
  expect(owners.owner.id).toBe(a.userId);
  expect(body.team!.find((b) => b.id === mine.id)).toMatchObject({ mine: true });
  /* The plain list is still the person's own boards alone. */
  expect(body.projects!.map((p) => p.id)).toEqual([mine.id]);
  /* And the owner sees the teammate's, the same way round. */
  const back = await (await a.api.get("/api/workbench/projects?team=1", { headers: a.headers })).json() as Team;
  expect(back.team!.find((b) => b.id === mine.id)).toMatchObject({ mine: false, owner: { name: teammateName } });
  expect(back.team!.find((b) => b.id === a.draftId)).toMatchObject({ mine: true });
});

test("a teammate's board opens view-only, whole, with its maker: by its id alone (a board link) or with the maker named", async () => {
  const seen = await (await teammate.get(`/api/workbench/projects?id=${a.draftId}&owner=${a.userId}`, { headers: teammateHeaders })).json() as Team;
  expect(seen.project?.id).toBe(a.draftId);
  expect(seen.viewOnly?.owner).toMatchObject({ id: a.userId });
  expect(seen.viewOnly?.owner.name).toContain("Board Owner");
  const link = await (await teammate.get(`/api/workbench/projects?id=${a.draftId}`, { headers: teammateHeaders })).json() as Team;
  expect(link.project?.id).toBe(a.draftId);
  expect(link.viewOnly?.owner.id).toBe(a.userId);
  /* The maker's own read of it is not view-only. */
  const mine = await (await a.api.get(`/api/workbench/projects?id=${a.draftId}`, { headers: a.headers })).json() as Team;
  expect(mine.project?.id).toBe(a.draftId);
  expect(mine.viewOnly).toBeUndefined();
  /* Naming oneself as the maker is no different: the board is not theirs, so it opens view-only. */
  const self = await (await teammate.get(`/api/workbench/projects?id=${a.draftId}&owner=${teammateId}`, { headers: teammateHeaders })).json() as Team;
  expect(self.viewOnly?.owner.id).toBe(a.userId);
  /* Who is not a member is not a maker: a made-up id, and the id of another workspace's person. */
  for (const owner of ["usr_nobody", outsider.userId]) {
    const r = await teammate.get(`/api/workbench/projects?id=${a.draftId}&owner=${owner}`, { headers: teammateHeaders });
    expect(r.status(), owner).toBe(404);
  }
  /* A board that exists nowhere in the workspace is just not found, however it is asked for. */
  const none = await (await teammate.get("/api/workbench/projects?id=no-such-board", { headers: teammateHeaders })).json() as Team;
  expect(none.project ?? null).toBeNull();
});

test("a save of a teammate's board is refused, and the maker's board is exactly as it was", async () => {
  const before = await (await a.api.get(`/api/workbench/projects?id=${a.draftId}`, { headers: a.headers })).json() as { project: { name: string }; revision: number };
  const seen = await (await teammate.get(`/api/workbench/projects?id=${a.draftId}&owner=${a.userId}`, { headers: teammateHeaders })).json() as { project: { name: string } };
  const edited = { ...seen.project, name: "Renamed by a teammate" };
  const put = await teammate.put("/api/workbench/projects", { headers: teammateHeaders, data: { project: edited, revision: 0 } });
  expect(put.status()).toBe(403);
  const refusal = await put.json() as { error: string; code: string };
  expect(refusal.code).toBe("view_only");
  expect(refusal.error).toContain("Board Owner");
  /* Nor does any other action on it: map and publish are refused as view-only, whatever else is in the body. */
  for (const action of ["map-shot", "publish"]) {
    const r = await teammate.post("/api/workbench/projects", { headers: teammateHeaders, data: { action, projectId: a.draftId, nodeId: "n", expectedBibleVersion: 0 } });
    expect(r.status(), action).toBe(403);
    expect((await r.json() as { code: string }).code, action).toBe("view_only");
  }
  /* "Did my save land?" is asked about the caller's own saves only: a teammate has none of this board, so it answers no, and changes nothing. */
  const check = await teammate.post("/api/workbench/projects", { headers: teammateHeaders, data: { action: "check-write", projectId: a.draftId, write: { writer: "teammate-writer-1", seq: 1 } } });
  expect(check.status()).toBe(200);
  expect(await check.json()).toMatchObject({ landed: null, project: null });
  const after = await (await a.api.get(`/api/workbench/projects?id=${a.draftId}`, { headers: a.headers })).json() as { project: { name: string }; revision: number };
  expect(after.project.name).toBe(before.project.name);
  expect(after.revision).toBe(before.revision);
  /* And the teammate has no copy of it. */
  const theirs = await (await teammate.get("/api/workbench/projects", { headers: teammateHeaders })).json() as Team;
  expect(theirs.projects!.some((p) => p.id === a.draftId)).toBe(false);
});

test("the workspace's takes and files were already its members', and stay so: a teammate reads them, an outsider does not", async () => {
  expect((await teammate.get(`/api/jobs/${a.genId}`, { headers: teammateHeaders })).status()).toBe(200);
  expect((await teammate.get(`/api/media/${a.genId}`, { headers: teammateHeaders, maxRedirects: 0 })).status()).toBeLessThan(400);
  for (const path of [`/api/jobs/${a.genId}`, `/api/media/${a.genId}`, `/api/media/${a.genId}?download=1`]) {
    const r = await outsider.api.get(path, { headers: outsider.headers, maxRedirects: 0 });
    const text = r.status() < 400 ? "" : await r.text();
    expect(r.status(), path).toBeGreaterThanOrEqual(400);
    expect(leaks(text, a.secrets), path).toEqual([]);
  }
});

test("another workspace's member gets nothing of A's boards: by team list, by id, by maker, claiming A's scope, and A's prices", async () => {
  const probes: { path: string; headers: Record<string, string> }[] = [];
  for (const headers of [outsider.headers, { ...outsider.headers, "X-Workbench-Scope": a.scope }]) {
    for (const path of ["/api/workbench/projects?team=1", "/api/workbench/projects?team=1&kinds=1", `/api/workbench/projects?id=${a.draftId}&owner=${a.userId}`,
      `/api/workbench/projects?id=${a.draftId}`, `/api/workbench/projects?production=${a.productionId}`, `/api/projects/${a.productionId}`,
      `/api/jobs?projectId=${a.productionId}&status=succeeded`, `/api/workbench/library?projectId=${a.draftId}&source=generations`,
      `/api/workbench/team-canvas?agent=1&productionId=${a.productionId}&projectId=${a.draftId}`]) probes.push({ path, headers });
  }
  for (const { path, headers } of probes) {
    const r = await outsider.api.get(path, { headers, maxRedirects: 0 });
    const text = await r.text();
    expect(leaks(text, a.secrets), `${path} (${headers["X-Workbench-Scope"] === a.scope ? "claiming A's scope" : "own scope"}): ${r.status()}`).toEqual([]);
  }
  /* A's prices: a quote of A's production asked as the outsider, and a save of A's draft id, reach nothing of A's. */
  const body = { prompt: "x", model: "gemini-3.1-flash-image", projectId: a.productionId, shotId: "", ratio: "16:9", resolution: "1K", duration: 5, refine: false, references: [] };
  for (const headers of [outsider.headers, { ...outsider.headers, "X-Workbench-Scope": a.scope }]) {
    const quote = await outsider.api.post("/api/generate/quote", { headers, data: body });
    expect(quote.status() >= 400 || leaks(await quote.text(), a.secrets).length === 0).toBe(true);
    expect(quote.ok() && headers["X-Workbench-Scope"] === a.scope).toBe(false);
  }
  const before = await (await a.api.get(`/api/workbench/projects?id=${a.draftId}`, { headers: a.headers })).json() as { revision: number };
  await outsider.api.put("/api/workbench/projects", { headers: { ...outsider.headers, "X-Workbench-Scope": a.scope }, data: { project: { ...newProject("Intruder"), id: a.draftId }, revision: 0 } });
  const after = await (await a.api.get(`/api/workbench/projects?id=${a.draftId}`, { headers: a.headers })).json() as { revision: number };
  expect(after.revision).toBe(before.revision);
  /* The outsider's own team list names none of A's people. */
  const own = await asJson(await outsider.api.get("/api/workbench/projects?team=1", { headers: outsider.headers }));
  expect(leaks(own.text, [...a.secrets, "Board Owner", teammateName])).toEqual([]);
});

test("a member who is switched off, or removed, sees no board of the workspace", async () => {
  await platform((db) => db.execute({ sql: "UPDATE memberships SET disabled=1 WHERE workspace_id=? AND account_id=?", args: [a.workspaceId, teammateId] }));
  const r = await teammate.get("/api/workbench/projects?team=1", { headers: teammateHeaders });
  expect(leaks(await r.text(), a.secrets)).toEqual([]);
  const seen = await teammate.get(`/api/workbench/projects?id=${a.draftId}&owner=${a.userId}`, { headers: teammateHeaders });
  expect(leaks(await seen.text(), a.secrets)).toEqual([]);
  /* Their boards leave the workspace's list too while they are off. */
  const owners = await (await a.api.get("/api/workbench/projects?team=1", { headers: a.headers })).json() as Team;
  expect(owners.team!.some((b) => b.owner.id === teammateId)).toBe(false);
  await platform((db) => db.execute({ sql: "UPDATE memberships SET disabled=0 WHERE workspace_id=? AND account_id=?", args: [a.workspaceId, teammateId] }));
});
