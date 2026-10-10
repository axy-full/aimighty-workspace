import { test, expect, request as pwRequest, type APIRequestContext } from "@playwright/test";
import { leaks, seedPrivate, type Private } from "./helpers/privacyV12";
import { setSite } from "./helpers/visitorV12";
import { signInLocally } from "./helpers/workbenchLocal";

/**
 * PRIVACY, enforced on the server (redesign P4, docs/redesign/inventory.md § 8.2, § 8.7): a visitor, and a member of
 * another workspace, never get a workspace's boards, names, assets, memory, people or takes — through any surface the new
 * interface draws data from. Search and ⌘K are drawn from the boards, library, jobs and approvals routes; Atomik from its
 * own routes; a board link from the shell page; the wall from the public showcase. Each is asked as an anonymous visitor
 * and as a signed-in member of a DIFFERENT workspace (alone, and claiming the first one's scope), against private work
 * made in workspace A. A response may be an error or empty; it may never carry anything of A's.
 *
 * Runs once (API only), on the local ENGINE_MOCK server.
 */
let a: Private;
let member: APIRequestContext;      // a member of another workspace (B)
let visitor: APIRequestContext;     // no session at all
let memberScope = "";
const base = process.env.PW_BASE_URL || "http://localhost:4551";

test.describe.configure({ mode: "serial" });
test.beforeAll(async ({}, info) => {
  test.skip(info.project.name !== "workbench-1440x900", "one run, API only");
  const probe = await pwRequest.newContext({ baseURL: base });
  const health = await probe.get("/api/health").then((r) => r.json()).catch(() => null);
  await probe.dispose();
  test.skip(!health?.mock, "requires a local ENGINE_MOCK=1 server");
  const owner = await pwRequest.newContext({ baseURL: base });
  a = await seedPrivate(owner);
  member = await pwRequest.newContext({ baseURL: base });
  const b = await signInLocally(member, "Other Workspace Member");
  const me = await member.get("/api/me").then((r) => r.json()) as { id: string };
  memberScope = `particl-active-${b.workspace.id}-${me.id}`;
  visitor = await pwRequest.newContext({ baseURL: base });
  await setSite({ guestHome: true, guestWorkspace: null });
});
test.afterAll(async () => {
  await setSite({});
  await Promise.all([a?.api, member, visitor].map((c) => c?.dispose()));
});

type Probe = { method: "GET" | "POST"; path: (p: Private) => string; data?: (p: Private) => unknown; why: string };
const get = (path: (p: Private) => string, why: string): Probe => ({ method: "GET", path, why });
/* Every route the new interface reads a workspace's data from. */
const PROBES: Probe[] = [
  get(() => "/api/me", "who am I (the header, the avatar)"),
  get(() => "/api/workbench/projects", "boards: Your boards, the + popover, ⌘K's go-to"),
  get((p) => `/api/workbench/projects?id=${encodeURIComponent(p.draftId)}`, "a board by its id: a board link"),
  get(() => "/api/workbench/projects?kinds=1", "boards with their kinds: Home's filters"),
  get(() => "/api/projects", "productions: the jobs tray's board names"),
  get(() => "/api/productions", "productions list"),
  get((p) => `/api/projects/${encodeURIComponent(p.productionId)}`, "a production by id"),
  get(() => "/api/jobs?status=succeeded&kind=image&limit=50", "takes: the wall, the Library tray, search"),
  get(() => "/api/jobs?view=tray", "the Activity pill's running list"),
  get((p) => `/api/jobs/${encodeURIComponent(p.genId)}`, "a take by id"),
  get((p) => `/api/media/${encodeURIComponent(p.genId)}`, "a take's picture"),
  get((p) => `/api/media/${encodeURIComponent(p.genId)}?download=1`, "a take's original"),
  get((p) => `/api/workbench/library?projectId=${encodeURIComponent(p.draftId)}&source=generations`, "a board's Library: the tray, @ mentions"),
  get((p) => `/api/workbench/library?projectId=${encodeURIComponent(p.draftId)}&source=generations&q=${encodeURIComponent(p.mark)}`, "the Library tray's search for a private word"),
  get((p) => `/api/workbench/library?projectId=${encodeURIComponent(p.draftId)}&source=uploads`, "a board's uploads"),
  get((p) => `/api/jobs?q=${encodeURIComponent(p.mark)}&status=succeeded`, "search over takes for a private word: ⌘K, the wall"),
  get((p) => `/api/jobs?projectId=${encodeURIComponent(p.productionId)}&status=succeeded`, "a board's takes"),
  get((p) => `/api/workbench/team-canvas?agent=1&productionId=${encodeURIComponent(p.productionId)}&projectId=${encodeURIComponent(p.draftId)}`, "a board's canvas and Atomik's run"),
  get(() => "/api/workbench/team-canvas?agent=1&board=new", "Atomik's thinking price for a new board"),
  get(() => "/api/atomik", "Atomik's own state"),
  get(() => "/api/atomik/memory", "what Atomik keeps in mind"),
  get((p) => `/api/atomik/memory?projectId=${encodeURIComponent(p.draftId)}`, "what Atomik keeps for a board"),
  get(() => "/api/atomik/threads", "Atomik's threads: the panel's switcher"),
  get(() => "/api/atomik/ideas", "Atomik's ideas"),
  get(() => "/api/atomik/skills", "Atomik's saved skills: the \"/\" list"),
  get(() => "/api/control-room/approvals", "approvals: Waiting for you, ⌘K's approve"),
  get(() => "/api/control-room/activity", "the activity feed"),
  get((p) => `/api/rig/boards?projectId=${encodeURIComponent(p.productionId)}`, "the Rig's boards"),
  get((p) => `/api/shots?projectId=${encodeURIComponent(p.productionId)}`, "a production's shots"),
  get(() => "/api/cast", "cast"),
  get(() => "/api/uploads", "uploads"),
  get(() => "/api/members", "who is in the workspace"),
  get(() => "/api/team", "the team"),
  get(() => "/api/usage/summary", "spend"),
  get(() => "/api/billing", "plan and credits"),
  get(() => "/api/demo/sample", "the sample production, as a member reads it"),
  { method: "POST", path: () => "/api/atomik", data: (p) => ({ message: `What is on ${p.draftId}?`, projectId: p.draftId, quoteOnly: true }), why: "asking Atomik about a board" },
  { method: "POST", path: () => "/api/generate/quote", data: (p) => ({ prompt: "anything", model: "gemini-3.1-flash-image", projectId: p.productionId, ratio: "16:9", resolution: "1K", references: [] }), why: "pricing a make inside a board" },
];

async function ask(api: APIRequestContext, probe: Probe, p: Private, headers?: Record<string, string>) {
  const url = probe.path(p);
  const options = { headers, maxRedirects: 0, failOnStatusCode: false, data: probe.data?.(p) };
  const res = probe.method === "GET" ? await api.get(url, options) : await api.post(url, options);
  const text = await res.text().catch(() => "");
  return { status: res.status(), text, location: res.headers().location ?? "" };
}

test("a visitor with no session: every route answers with an error or nothing, and nothing of workspace A", async () => {
  for (const probe of PROBES) {
    const got = await ask(visitor, probe, a);
    const where = `${probe.method} ${probe.path(a)} (${probe.why})`;
    expect(leaks(got.text + got.location, a.secrets), `${where} → ${got.status}`).toEqual([]);
    expect(got.status, `${where}: a visitor is refused`).toBeGreaterThanOrEqual(300);
  }
});

test("a member of another workspace, alone: nothing of workspace A, from any route", async () => {
  for (const probe of PROBES) {
    const got = await ask(member, probe, a);
    const where = `${probe.method} ${probe.path(a)} (${probe.why})`;
    expect(leaks(got.text + got.location, a.secrets), `${where} → ${got.status}`).toEqual([]);
  }
});

test("a member of another workspace claiming A's scope or switching into A: refused, and still nothing of A", async () => {
  /* The scope header names workspace and account; a request drawn for A is refused whole when the session is not A's. */
  for (const probe of PROBES.filter((p) => p.method === "GET")) {
    const got = await ask(member, probe, a, { "X-Workbench-Scope": a.scope });
    const where = `${probe.path(a)} claiming A's scope`;
    expect(leaks(got.text + got.location, a.secrets), `${where} → ${got.status}`).toEqual([]);
  }
  const switched = await member.post("/api/workspaces/switch", { data: { workspaceId: a.workspaceId }, failOnStatusCode: false });
  expect(switched.status(), "switching into a workspace you are not a member of").toBeGreaterThanOrEqual(400);
  expect((await member.get("/api/me").then((r) => r.json())).workspace?.id).not.toBe(a.workspaceId);
  for (const probe of PROBES) {
    const got = await ask(member, probe, a);
    expect(leaks(got.text + got.location, a.secrets), `${probe.path(a)} after trying to switch`).toEqual([]);
  }
  /* A's own session still reads A's work: the probes are not simply empty. */
  const own = await a.api.get("/api/workbench/projects", { headers: a.headers }).then((r) => r.text());
  expect(leaks(own, [a.mark, a.draftId])).toEqual([a.mark, a.draftId]);
  const jobs = await a.api.get(`/api/jobs/${a.genId}`, { headers: a.headers }).then((r) => r.text());
  expect(jobs).toContain(a.genId);
});

test("a board link: a visitor is sent to log in, a member of another workspace is shown nothing of the board", async () => {
  const link = `/suites?view=board&project=${encodeURIComponent(a.draftId)}`;
  const seen = await visitor.get(link, { maxRedirects: 0, failOnStatusCode: false });
  expect([302, 303, 307, 308], "a visitor is redirected, never served the board").toContain(seen.status());
  expect(seen.headers().location ?? "").toMatch(/^\/login\?next=/);
  expect(leaks(await seen.text(), a.secrets.filter((s) => s !== a.draftId)), "the redirect carries no board data").toEqual([]);
  /* The new interface's visitor page for the same link shows "You don't have access" (tests/visitor-v12-workbench.spec.ts) and
     asks the server for nothing. A member of another workspace gets the shell, whose data routes (above) answer with nothing of A. */
  const shell = await member.get(link, { maxRedirects: 0, failOnStatusCode: false });
  expect(leaks(await shell.text(), a.secrets.filter((s) => s !== a.draftId)), "the shell page for a member of another workspace").toEqual([]);
});

test("the visitor's page and the wall: only Particl's public showcase, whatever the address asks for", async () => {
  for (const query of ["?guest=1", `?guest=1&board=${a.draftId}`, `?guest=1&screen=board&workspace=${a.workspaceId}&guestWorkspace=${a.workspaceId}&sample=${a.draftId}`, `?guest=1&screen=make&project=${a.draftId}`]) {
    const page = await visitor.get(`/${query}`, { failOnStatusCode: false });
    const html = await page.text();
    /* Only the address the visitor typed may come back; nothing read from the workspace behind it. */
    const echoed = html.split(query.replace(/&/g, "\\u0026")).join("").split(query).join("");
    expect(leaks(echoed, [a.mark, a.workspaceName, a.email, a.userId, a.productionId, a.genId]), `/${query}`).toEqual([]);
  }
  /* Guest Home's sample is read from the one workspace the platform owner named, never from the request. */
  const page = await visitor.get(`/?guest=1&screen=board&guestWorkspace=${encodeURIComponent(a.workspaceId)}`);
  expect(leaks(await page.text(), [a.mark, a.workspaceName])).toEqual([]);
});

test("invite codes reveal nothing without the code; a wrong code is the same answer whoever asks", async () => {
  for (const code of ["", "not-a-code", a.workspaceId, a.draftId, a.userId]) {
    for (const api of [visitor, member]) {
      for (const route of ["/api/auth/accept", "/api/auth/signup"]) {
        const res = await api.get(`${route}?code=${encodeURIComponent(code)}`, { failOnStatusCode: false });
        const text = await res.text();
        expect(leaks(text, [a.mark, a.workspaceName, a.email, a.userId]), `${route}?code=${code}`).toEqual([]);
        if (code) expect(res.status(), `${route}?code=${code}`).toBeGreaterThanOrEqual(400);
      }
    }
  }
  /* Request access answers the same for everyone and names nothing. */
  const res = await visitor.post("/api/access-request", { data: { name: "Privacy Probe", email: `probe-${a.mark.toLowerCase()}@example.test`, note: "probe" }, failOnStatusCode: false });
  expect(leaks(await res.text(), a.secrets)).toEqual([]);
});
