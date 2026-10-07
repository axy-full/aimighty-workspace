import { test, expect, type APIRequestContext } from "@playwright/test";
import { createClient } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { localPlatformDbUrl, signInLocally } from "./helpers/workbenchLocal";

/**
 * The money rules the old Gen, Rig-canvas, Shots and Edit & Sound pages each showed in a browser, held where they live: at
 * the routes, against the real ENGINE_MOCK backend and its real ledger (OLD-PAGES-SPECS, port "paid sends").
 *
 * Those pages are gone (their addresses redirect into the shell), and the rules did not move with them. Every paid send is
 * priced first, sent once under its own Idempotency-Key with the price it showed as its ceiling, and a lost reply is asked
 * about by that key, never repeated. What was asserted of a button in a page is asserted here of the request the button sent:
 * the same keys, the same ceilings, and the same books (jobs made, credits billed).
 *
 * Nothing here is billed for real: the mock engine makes the jobs, the ledger is the local one, and the workspace is funded
 * by a local grant row.
 */

const MODEL = "dreamina-seedance-2-0-260128";

type Books = { jobs: string[]; charges: number[] };

async function fundedWorkspace(page: { request: APIRequestContext }) {
  const signed = await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((response) => response.json());
  const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  let tenantUrl: string;
  try {
    await platform.execute({
      sql: "INSERT INTO credit_grants(id,workspace_id,credits,note,kind,created_by,created_at) VALUES(?,?,?,?,?,?,?)",
      args: [randomUUID(), signed.workspace.id, 2000, "Local mock paid-send fixture", "admin", "test", Date.now()],
    });
    tenantUrl = String((await platform.execute({ sql: "SELECT db_url FROM workspaces WHERE id=?", args: [signed.workspace.id] })).rows[0].db_url);
  } finally {
    platform.close();
  }
  const scope = `particl-active-${signed.workspace.id}-${me.id}`;
  return { signed, me, scope, tenantUrl };
}

/** The jobs the workspace's tenant database holds, and the credits its meter billed, since `since`. */
async function books(tenantUrl: string, workspaceId: string, since: number): Promise<Books> {
  const tenant = createClient({ url: tenantUrl, timeout: 10_000 });
  const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try {
    const jobs = (await tenant.execute({ sql: "SELECT id FROM generations WHERE created_at >= ? ORDER BY created_at", args: [since] })).rows.map((row) => String(row.id));
    const charges = (await platform.execute({ sql: "SELECT billed_credits FROM meter_events WHERE workspace_id=? AND created_at >= ? ORDER BY created_at", args: [workspaceId, since] })).rows.map((row) => Number(row.billed_credits));
    return { jobs, charges };
  } finally {
    tenant.close();
    platform.close();
  }
}

async function project(page: { request: APIRequestContext }, name: string) {
  const made = await page.request.post("/api/projects", { data: { name: `${name} ${randomUUID().slice(0, 6)}` } });
  expect(made.ok(), await made.text()).toBe(true);
  const id = String((await made.json()).id);
  const shot = await page.request.post("/api/shots", { data: { projectId: id, code: "SH01", title: "Wide", kind: "shot", description: "Rowan crosses the ice at dawn" } });
  expect(shot.ok(), await shot.text()).toBe(true);
  const made2 = (await shot.json()) as { id?: string; shot?: { id: string } };
  return { projectId: id, shotId: String(made2.id ?? made2.shot?.id) };
}

const requestBody = (projectId: string, shotId: string, extra: Record<string, unknown> = {}) => ({
  prompt: "Rowan crosses the ice at dawn, wide, slow push in.",
  model: MODEL, projectId, shotId, ratio: "16:9", resolution: "720p", duration: 5, refine: false, references: [], firstFrameAssetId: "", ...extra,
});

async function quote(page: { request: APIRequestContext }, scope: string, body: Record<string, unknown>) {
  const response = await page.request.post("/api/generate/quote", { headers: { "X-Workbench-Scope": scope }, data: body });
  expect(response.ok(), await response.text()).toBe(true);
  const priced = (await response.json()) as { estimatedCredits: number; fingerprint: string };
  expect(priced.estimatedCredits).toBeGreaterThan(0);
  expect(priced.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  return priced;
}

const send = (page: { request: APIRequestContext }, scope: string, key: string, body: Record<string, unknown>) =>
  page.request.post("/api/generate", { headers: { "X-Workbench-Scope": scope, "Idempotency-Key": key, "Content-Type": "application/json" }, data: body });

const check = (page: { request: APIRequestContext }, scope: string, key: string, body: Record<string, unknown>) =>
  page.request.post("/api/generate/check", { headers: { "X-Workbench-Scope": scope }, data: { key, endpoint: "/api/generate", body: JSON.stringify(body) } });

test("a paid send goes at the price it was quoted, under its own key; a lost reply is checked and followed, and it is billed once", async ({ page }) => {
  test.setTimeout(240_000);
  const { signed, scope, tenantUrl } = await fundedWorkspace(page);
  const { projectId, shotId } = await project(page, "Paid send");
  const since = Date.now();

  /* Priced first, as it will be sent. Asking is free. */
  const priced = await quote(page, scope, requestBody(projectId, shotId));
  expect(await books(tenantUrl, signed.workspace.id, since)).toEqual({ jobs: [], charges: [] });

  /* Sent once, the quote as its ceiling and its fingerprint as its approval, under a key claimed before it went. */
  const key = `r1-port-${randomUUID()}`;
  const sent = requestBody(projectId, shotId, { maxCredits: priced.estimatedCredits });
  const withFingerprint = { ...sent, quoteFingerprint: priced.fingerprint };
  const first = await send(page, scope, key, withFingerprint);
  expect(first.ok(), await first.text()).toBe(true);
  const made = (await first.json()) as { id: string };
  expect(made.id).toBeTruthy();

  /* The browser never saw that reply. It asks the server what became of the key, naming the request exactly as it was sent
     (its key, route and body, the approval included). */
  const asked = await check(page, scope, key, withFingerprint);
  expect(asked.ok(), await asked.text()).toBe(true);
  expect(await asked.json()).toMatchObject({ state: "landed", id: made.id });

  /* Pressed again with the same key: the server replays its answer. Nothing is made, nothing is charged twice. */
  const again = await send(page, scope, key, withFingerprint);
  expect(again.ok(), await again.text()).toBe(true);
  expect(again.headers()["idempotency-replayed"]).toBe("true");
  expect((await again.json()).id).toBe(made.id);

  const after = await books(tenantUrl, signed.workspace.id, since);
  expect(after.jobs).toEqual([made.id]);
  expect(after.charges).toEqual([priced.estimatedCredits]);

  /* The same key naming a DIFFERENT request is refused: a key never carries another body. */
  const other = await send(page, scope, key, { ...withFingerprint, prompt: "A different request under the same key." });
  expect(other.ok()).toBe(false);
  expect(await books(tenantUrl, signed.workspace.id, since)).toEqual(after);
});

test("a send that never arrived is fenced, so it cannot land later; what is on screen goes under a new key at the price on the button", async ({ page }) => {
  test.setTimeout(240_000);
  const { signed, scope, tenantUrl } = await fundedWorkspace(page);
  const { projectId, shotId } = await project(page, "Never arrived");
  const since = Date.now();
  const priced = await quote(page, scope, requestBody(projectId, shotId));
  const lostKey = `r1-port-lost-${randomUUID()}`;
  const lost = requestBody(projectId, shotId, { maxCredits: priced.estimatedCredits });

  /* The request never reached the server. Asked about, the server says so, and fences the key for good. */
  const asked = await check(page, scope, lostKey, lost);
  expect(asked.ok(), await asked.text()).toBe(true);
  expect((await asked.json()).state).toBe("absent");
  const late = await send(page, scope, lostKey, { ...lost, quoteFingerprint: priced.fingerprint });
  expect(late.ok(), "a fenced key can no longer land").toBe(false);
  expect(await books(tenantUrl, signed.workspace.id, since)).toEqual({ jobs: [], charges: [] });

  /* A new key, at the price the person is looking at now: one job, one charge. */
  const fresh = await quote(page, scope, requestBody(projectId, shotId));
  const sent = await send(page, scope, `r1-port-new-${randomUUID()}`, requestBody(projectId, shotId, { maxCredits: fresh.estimatedCredits, quoteFingerprint: fresh.fingerprint }));
  expect(sent.ok(), await sent.text()).toBe(true);
  const after = await books(tenantUrl, signed.workspace.id, since);
  expect(after.jobs).toHaveLength(1);
  expect(after.charges).toEqual([fresh.estimatedCredits]);
});

test("a price that moved sends nothing: a ceiling under the price, or a quote that no longer matches, makes no job and bills nothing", async ({ page }) => {
  test.setTimeout(240_000);
  const { signed, scope, tenantUrl } = await fundedWorkspace(page);
  const { projectId, shotId } = await project(page, "Moved price");
  const since = Date.now();
  const priced = await quote(page, scope, requestBody(projectId, shotId));

  const under = await send(page, scope, `r1-port-under-${randomUUID()}`, requestBody(projectId, shotId, { maxCredits: priced.estimatedCredits - 1 }));
  expect(under.ok(), "a ceiling under the price is refused").toBe(false);

  /* A quote for another body: the source or settings changed since it was shown. */
  const changed = await send(page, scope, `r1-port-changed-${randomUUID()}`, requestBody(projectId, shotId, { duration: 8, maxCredits: priced.estimatedCredits, quoteFingerprint: priced.fingerprint }));
  expect(changed.ok(), `a fingerprint for another request is refused (${changed.status()} ${await changed.text()})`).toBe(false);
  expect([400, 409, 422], "refused as a changed request, not a server error").toContain(changed.status());

  /* A malformed fingerprint is not an approval. */
  const malformed = await send(page, scope, `r1-port-bad-${randomUUID()}`, requestBody(projectId, shotId, { maxCredits: priced.estimatedCredits, quoteFingerprint: "not-a-fingerprint" }));
  expect(malformed.status()).toBe(400);

  expect(await books(tenantUrl, signed.workspace.id, since)).toEqual({ jobs: [], charges: [] });
});

test("a key and a scope belong to one person in one workspace: another workspace cannot see or replay a claim, and a stale tab's scope is refused", async ({ page, browser }, info) => {
  test.setTimeout(240_000);
  const { scope } = await fundedWorkspace(page);
  const { projectId, shotId } = await project(page, "Isolation");
  const priced = await quote(page, scope, requestBody(projectId, shotId));
  const key = `r1-port-iso-${randomUUID()}`;
  const body = requestBody(projectId, shotId, { maxCredits: priced.estimatedCredits });
  const made = await send(page, scope, key, { ...body, quoteFingerprint: priced.fingerprint });
  expect(made.ok(), await made.text()).toBe(true);

  /* Another account in another workspace asks about the same key, naming the same request: it sees nothing of this one. */
  const otherContext = await browser.newContext({ baseURL: String(info.project.use.baseURL ?? process.env.PW_BASE_URL) });
  try {
    const other = await signInLocally(otherContext.request);
    const otherMe = await otherContext.request.get("/api/me").then((response) => response.json());
    const otherScope = `particl-active-${other.workspace.id}-${otherMe.id}`;
    const seen = await otherContext.request.post("/api/generate/check", { headers: { "X-Workbench-Scope": otherScope }, data: { key, endpoint: "/api/generate", body: JSON.stringify(body) } });
    expect(seen.ok(), await seen.text()).toBe(true);
    expect((await seen.json()).state, "another workspace's check never names this job").not.toBe("landed");

    /* A stale tab: this person's own scope from before another account or workspace was signed in is refused, not honoured. */
    for (const stale of [scope.replace(/-[^-]+$/, "-someone-else"), `particl-active-${other.workspace.id}-${otherMe.id}`, "particl-visitor"]) {
      const refused = await page.request.post("/api/generate/check", { headers: { "X-Workbench-Scope": stale }, data: { key, endpoint: "/api/generate", body: JSON.stringify(body) } });
      expect(refused.status(), `scope ${stale}`).toBe(409);
      const send409 = await send(page, stale, `r1-port-stale-${randomUUID()}`, { ...body, quoteFingerprint: priced.fingerprint });
      expect(send409.status(), `send under ${stale}`).toBe(409);
    }
  } finally {
    await otherContext.close();
  }
});

test("a sound effect is paid the same way: quoted, sent once with its ceiling, a lost reply is followed by its key, a late copy admits nothing", async ({ page }) => {
  test.setTimeout(240_000);
  const { signed, scope, tenantUrl } = await fundedWorkspace(page);
  const since = Date.now();
  const sfx = { task: "sound", text: "Rain on a tin roof, distant thunder.", durationSeconds: 4 };
  const headers = { "X-Workbench-Scope": scope };

  /* Asking is free. */
  const asked = await page.request.post("/api/audio", { headers, data: { ...sfx, quoteOnly: true } });
  expect(asked.ok(), await asked.text()).toBe(true);
  const priced = (await asked.json()) as { estimatedCredits: number };
  expect(priced.estimatedCredits).toBeGreaterThan(0);
  expect(await books(tenantUrl, signed.workspace.id, since)).toEqual({ jobs: [], charges: [] });

  const key = `r1-port-sfx-${randomUUID()}`;
  const body = { ...sfx, maxCredits: priced.estimatedCredits };
  const first = await page.request.post("/api/audio", { headers: { ...headers, "Idempotency-Key": key }, data: body });
  expect(first.ok(), await first.text()).toBe(true);
  const made = (await first.json()) as { id: string };

  /* The reply was lost: the server is asked, naming the request as it was sent. It names the job. */
  const checked = await page.request.post("/api/generate/check", { headers, data: { key, endpoint: "/api/audio", body: JSON.stringify(body) } });
  expect(checked.ok(), await checked.text()).toBe(true);
  expect(await checked.json()).toMatchObject({ state: "landed", id: made.id });
  const again = await page.request.post("/api/audio", { headers: { ...headers, "Idempotency-Key": key }, data: body });
  expect(again.ok(), await again.text()).toBe(true);
  expect(again.headers()["idempotency-replayed"]).toBe("true");
  expect((await again.json()).id).toBe(made.id);
  const after = await books(tenantUrl, signed.workspace.id, since);
  expect(after.charges, "billed once, at the quote").toEqual([priced.estimatedCredits]);

  /* One that never arrived is fenced when it is checked: arriving late, it admits nothing. */
  const lostKey = `r1-port-sfx-lost-${randomUUID()}`;
  const lost = { ...sfx, text: "Wind over dunes, a low constant bed.", maxCredits: priced.estimatedCredits };
  const absent = await page.request.post("/api/generate/check", { headers, data: { key: lostKey, endpoint: "/api/audio", body: JSON.stringify(lost) } });
  expect((await absent.json()).state).toBe("absent");
  const late = await page.request.post("/api/audio", { headers: { ...headers, "Idempotency-Key": lostKey }, data: lost });
  expect(late.status(), "a fenced key admits nothing").toBe(409);
  expect(await books(tenantUrl, signed.workspace.id, since)).toEqual(after);

  /* A ceiling under the price sends nothing. */
  const under = await page.request.post("/api/audio", { headers: { ...headers, "Idempotency-Key": `r1-port-sfx-under-${randomUUID()}` }, data: { ...sfx, text: "Another effect.", maxCredits: Math.max(0, priced.estimatedCredits - 1) } });
  expect(under.ok(), "a ceiling under the price is refused").toBe(false);
  expect(await books(tenantUrl, signed.workspace.id, since)).toEqual(after);
});

test("a tab that captured one account and workspace cannot write into another: refused whole, and nothing is written under the new one", async ({ page }) => {
  test.setTimeout(240_000);
  const first = await signInLocally(page.request);
  const owner = await page.request.get("/api/me").then((response) => response.json());
  const captured = `particl-active-${first.workspace.id}-${owner.id}`;
  const headers = { "X-Workbench-Scope": captured };

  /* Under its own scope the tab writes. */
  const own = await page.request.post("/api/cast", { headers, data: { name: "Original_character", kind: "character" } });
  expect(own.ok(), await own.text()).toBe(true);

  /* The cookie changes (another account signs in, in another workspace) while the old document stays mounted. */
  await signInLocally(page.request);
  const member = await page.request.get("/api/me").then((response) => response.json());
  expect(member.workspace.id).not.toBe(first.workspace.id);
  const refused = async (label: string) => {
    for (const [method, path, data] of [
      ["POST", "/api/uploads/chunk", {}],
      ["POST", "/api/uploads/finish", {}],
      ["POST", "/api/cast", { name: "Old_private_character", kind: "character" }],
    ] as const) {
      const response = await page.request.post(path, { headers, data });
      expect(response.status(), `${label}: ${method} ${path}`).toBe(409);
      expect((await response.json()).error, `${label}: ${path}`).toMatch(/account or workspace changed/i);
    }
  };
  await refused("another workspace");
  expect((await page.request.get("/api/uploads").then((response) => response.json())).uploads, "nothing was uploaded under the new workspace").toEqual([]);
  expect((await page.request.get("/api/cast").then((response) => response.json())).cast, "nothing was written under the new workspace").toEqual([]);

  /* Another account in the SAME workspace: invited, accepted. The old tab's scope still names the first account: refused. */
  const code = randomUUID().replaceAll("-", "").slice(0, 24);
  const platform = createClient({ url: localPlatformDbUrl(), timeout: 5_000 });
  try {
    await platform.execute({
      sql: "INSERT INTO workspace_invites(code,workspace_id,email,name,role,created_by,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)",
      args: [code, first.workspace.id, member.email, "Another crew member", "member", owner.id, Date.now(), Date.now() + 3_600_000],
    });
  } finally {
    platform.close();
  }
  const accepted = await page.request.post("/api/auth/accept", { data: { code } });
  expect(accepted.ok(), await accepted.text()).toBe(true);
  const current = await page.request.get("/api/me").then((response) => response.json());
  expect(current.workspace.id).toBe(first.workspace.id);
  expect(current.id).not.toBe(owner.id);
  await refused("another account in the same workspace");
  const cast = (await page.request.get("/api/cast").then((response) => response.json())).cast as { name: string }[];
  expect(cast.map((c) => c.name), "the first account's own write is all there is").toEqual(["Original_character"]);
});
