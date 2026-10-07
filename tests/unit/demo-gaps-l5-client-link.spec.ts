import { test, expect } from "@playwright/test";
import { authAs, freshDatabases, load, rawToken, scoped, seedPeople, workspace, type Who } from "./demo-gaps-l5-harness";

/*
 * Lane 5 · The Crew review client link (Gaps A). Tenant separation, proved through the real routes and databases:
 * a link opens exactly one production's review set in one workspace; it reads nothing else (other productions, other
 * workspaces, takes outside the set, prompts, people, balances); it writes only a decision or a comment on a take in
 * that set; it expires; it is withdrawn at once; it is limited per link; it never works as an API token; and only a
 * signed-in owner or admin makes or withdraws one. Neutral names only.
 */
const dir = freshDatabases("client-link");
const A = workspace(dir, "ws_linka"), B = workspace(dir, "ws_linkb");
const ORIGIN = "http://localhost";

async function seed() {
  const { platformDb, platformReady } = await import("../../lib/platform");
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  await platformReady();
  for (const ws of [A, B]) {
    await platformDb().execute({ sql: "INSERT OR IGNORE INTO workspaces(id,slug,name,db_url,legacy,uses_platform_keys,owner_id,created_at,updated_at) VALUES(?,?,?,?,0,1,'owner',0,0)", args: [ws.id, ws.id, `Studio ${ws.id.slice(-1)}`, ws.dbUrl] });
    await platformDb().execute({ sql: "INSERT OR IGNORE INTO credit_grants(id,workspace_id,credits,note,created_at) VALUES(?,?,1234,'fixture',0)", args: [`grant_${ws.id}`, ws.id] });
  }
  await seedPeople(A, [{ id: "owner", name: "Owner Person" }, { id: "member", name: "Member Person" }], [{ id: "tok_admin", userId: "owner", scope: "render", raw: rawToken(A, "5") }]);
  await seedPeople(B, [{ id: "owner", name: "Other Owner" }]);
  const gen = (id: string, project: string, state: string, extra: { status?: string; deleted?: number; shot?: string } = {}) => ({
    sql: `INSERT OR IGNORE INTO generations(id,kind,provider,model,prompt,params,status,created_by,created_at,updated_at,project_id,shot_id,version,review_state,deleted)
          VALUES(?,'video','mock','mock-model',?,'{}',?,'owner',1,1,?,?,1,?,?)`,
    args: [id, `SECRET PROMPT ${id}`, extra.status ?? "succeeded", project, extra.shot ?? null, state, extra.deleted ?? 0],
  });
  await runInTenant(A, async () => {
    await ready();
    await db().batch([
      "INSERT OR IGNORE INTO projects(id,name,description,created_at) VALUES('prod_one','A short film','internal notes',0)",
      "INSERT OR IGNORE INTO projects(id,name,description,created_at) VALUES('prod_two','Another production','',0)",
      "INSERT OR IGNORE INTO shots(id,project_id,code,title,position,created_at,updated_at) VALUES('shot_1','prod_one','Shot 1','Opening',1,0,0)",
      "INSERT OR IGNORE INTO shots(id,project_id,code,title,position,created_at,updated_at) VALUES('shot_3','prod_one','Shot 3','Close',3,0,0)",
      gen("g_approved", "prod_one", "approved", { shot: "shot_1" }),
      gen("g_review", "prod_one", "picked", { shot: "shot_3" }),
      gen("g_unjudged", "prod_one", ""),
      gen("g_changes", "prod_one", "changes"),
      gen("g_deleted", "prod_one", "picked", { deleted: 1 }),
      gen("g_failed", "prod_one", "picked", { status: "failed" }),
      gen("g_other", "prod_two", "picked"),
      "INSERT OR IGNORE INTO notes(id,gen_id,user_id,text,created_at) VALUES('n1','g_review','owner','Is the walk speed right for you?',5)",
    ], "write");
  });
  await runInTenant(B, async () => {
    await ready();
    await db().batch([
      "INSERT OR IGNORE INTO projects(id,name,description,created_at) VALUES('prod_b','Workspace B film','',0)",
      gen("g_b", "prod_b", "picked"),
    ], "write");
  });
}

async function routes(who: Who) {
  const auth = await authAs(who);
  const tenant = await import("../../lib/tenant");
  const database = await import("../../lib/db");
  const shares = await import("../../lib/shares");
  const link = await import("../../lib/security/review-link");
  const settings = await import("../../lib/settings");
  const originalMedia = await import("../../lib/originalMedia");
  const served: string[] = [];
  const common = { "@/lib/tenant": tenant, "@/lib/db": database, "@/lib/shares": shares, "@/lib/security/review-link": link };
  return {
    served,
    team: load<typeof import("../../app/api/review-links/route")>("app/api/review-links/route.ts", { ...common, "@/lib/auth": auth }),
    shares: load<typeof import("../../app/api/shares/route")>("app/api/shares/route.ts", { ...common, "@/lib/auth": auth }),
    view: load<typeof import("../../app/api/review/[token]/route")>("app/api/review/[token]/route.ts", { ...common, "@/lib/settings": settings, "@/lib/originalMedia": originalMedia }),
    verdict: load<typeof import("../../app/api/review/[token]/verdict/route")>("app/api/review/[token]/verdict/route.ts", common),
    notes: load<typeof import("../../app/api/review/[token]/notes/route")>("app/api/review/[token]/notes/route.ts", common),
    media: load<typeof import("../../app/api/review/[token]/media/[genId]/route")>("app/api/review/[token]/media/[genId]/route.ts", {
      ...common, "@/lib/originalMedia": originalMedia,
      "@/lib/storage": {
        openOriginalStream: async (_kind: string, genId: string) => { served.push(genId); return { stream: new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1, 2, 3])); c.close(); } }), size: 3 }; },
        originalSize: async () => 3,
      },
      "@/lib/mediaRange": await import("../../lib/mediaRange"),
      "@/lib/downloadName": { downloadFilename: async () => "x.glb" },
      "@/lib/contentDisposition": await import("../../lib/contentDisposition"),
    }),
  };
}

const ctx = (token: string) => ({ params: Promise.resolve({ token }) });
const post = (url: string, body: unknown) => new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test.describe.configure({ mode: "serial" });

test("only a signed-in owner or admin makes or withdraws a client link; tokens are refused; another workspace's production is not found", async () => {
  await seed();
  const who: Who = { mode: "session", ws: A, userId: "owner", name: "Owner Person", role: "owner", bearer: "" };
  const r = await routes(who);
  const made = await r.team.POST(scoped(who, `${ORIGIN}/api/review-links`, { method: "POST", body: JSON.stringify({ projectId: "prod_one" }) }), undefined as never);
  expect(made.status).toBe(201);
  const { url } = await made.json();
  /* The secret names nothing: not the workspace, not the production. */
  expect(url).toMatch(/^http:\/\/localhost\/review\/rv_[A-Za-z0-9_-]{43}$/);
  expect(url).not.toContain("linka");
  expect(url).not.toContain("prod_one");

  /* B's production id is not a production of A. */
  const foreign = await r.team.POST(scoped(who, `${ORIGIN}/api/review-links`, { method: "POST", body: JSON.stringify({ projectId: "prod_b" }) }), undefined as never);
  expect(foreign.status).toBe(404);

  Object.assign(who, { userId: "member", name: "Member Person", role: "member" });
  expect((await r.team.POST(scoped(who, `${ORIGIN}/api/review-links`, { method: "POST", body: JSON.stringify({ projectId: "prod_one" }) }), undefined as never)).status).toBe(403);
  const asMember = await (await r.team.GET(scoped(who, `${ORIGIN}/api/review-links?projectId=prod_one`), undefined as never)).json();
  expect(asMember.canManage).toBe(false);
  expect(asMember.links).toHaveLength(1);
  expect(JSON.stringify(asMember)).not.toContain("rv_");

  /* A render token an owner made: refused everywhere a link is made, listed or withdrawn, here and on the older route. */
  Object.assign(who, { mode: "token", bearer: rawToken(A, "5"), userId: "owner", role: "owner" });
  expect((await r.team.GET(scoped(who, `${ORIGIN}/api/review-links?projectId=prod_one`), undefined as never)).status).toBe(403);
  expect((await r.team.POST(scoped(who, `${ORIGIN}/api/review-links`, { method: "POST", body: JSON.stringify({ projectId: "prod_one" }) }), undefined as never)).status).toBe(403);
  expect((await r.team.DELETE(scoped(who, `${ORIGIN}/api/review-links?id=${asMember.links[0].id}`, { method: "DELETE" }), undefined as never)).status).toBe(403);
  expect((await r.shares.POST(scoped(who, `${ORIGIN}/api/shares`, { method: "POST", body: JSON.stringify({ projectId: "prod_one" }) }), undefined as never)).status).toBe(403);
  expect((await r.shares.DELETE(scoped(who, `${ORIGIN}/api/shares?id=${asMember.links[0].id}`, { method: "DELETE" }), undefined as never)).status).toBe(403);
});

test("the client sees this production's review set and nothing else: no other takes, productions, workspaces, prompts, people or balances", async () => {
  const who: Who = { mode: "session", ws: A, userId: "owner", name: "Owner Person", role: "owner", bearer: "" };
  const r = await routes(who);
  const { url } = await (await r.team.POST(scoped(who, `${ORIGIN}/api/review-links`, { method: "POST", body: JSON.stringify({ projectId: "prod_one" }) }), undefined as never)).json();
  const token = url.split("/review/")[1];
  const got = await r.view.GET(new Request(`${ORIGIN}/api/review/${token}`), ctx(token));
  expect(got.status).toBe(200);
  expect(got.headers.get("cache-control")).toContain("no-store");
  const body = await got.json();
  expect(body.kind).toBe("review");
  expect(body.takes.map((t: { id: string; state: string }) => [t.id, t.state])).toEqual([["g_approved", "approved"], ["g_review", "review"]]);
  expect(Object.keys(body).sort()).toEqual(["expiresAt", "kind", "production", "takes", "workspace"]);
  expect(Object.keys(body.workspace).sort()).toEqual(["logo", "name"]);
  const text = JSON.stringify(body);
  for (const leak of ["g_unjudged", "g_changes", "g_deleted", "g_failed", "g_other", "Another production", "g_b", "Workspace B", "SECRET PROMPT", "internal notes", "Owner Person", "Member Person", "@example.invalid", "1234", "credits", "balance", "ws_linka", "owner"]) {
    expect(text, leak).not.toContain(leak);
  }
  /* The team's note is signed by the production, never by a person. */
  /* The team's own notes stay inside the workspace (review of #558, L2): the client sees their own words only. */
  expect(body.takes[1].notes).toEqual([]);

  /* Media: the set only. A take outside it, another production's, or another workspace's is not found, and nothing is read. */
  for (const genId of ["g_unjudged", "g_other", "g_deleted", "g_b", "../g_review"]) {
    const res = await r.media.GET(new Request(`${ORIGIN}/x`), { params: Promise.resolve({ token, genId }) });
    expect(res.status, genId).toBe(404);
  }
  expect(r.served).toEqual([]);
  expect((await r.media.GET(new Request(`${ORIGIN}/x`), { params: Promise.resolve({ token, genId: "g_review" }) })).status).toBe(200);
  expect(r.served).toEqual(["g_review"]);
});

test("the client approves or asks for changes on a take in the set, and on nothing else; the team's own review is untouched", async () => {
  const who: Who = { mode: "session", ws: A, userId: "owner", name: "Owner Person", role: "owner", bearer: "" };
  const r = await routes(who);
  const { url } = await (await r.team.POST(scoped(who, `${ORIGIN}/api/review-links`, { method: "POST", body: JSON.stringify({ projectId: "prod_one" }) }), undefined as never)).json();
  const token = url.split("/review/")[1];
  const ok = await r.verdict.POST(post(`${ORIGIN}/api/review/${token}/verdict`, { genId: "g_review", verdict: "approved", name: "Client", text: "Love the light." }), ctx(token));
  expect(ok.status).toBe(201);
  for (const genId of ["g_unjudged", "g_other", "g_b", "g_deleted", "nope"]) {
    const res = await r.verdict.POST(post(`${ORIGIN}/api/review/${token}/verdict`, { genId, verdict: "approved" }), ctx(token));
    expect(res.status, genId).toBe(404);
  }
  expect((await r.verdict.POST(post(`${ORIGIN}/api/review/${token}/verdict`, { genId: "g_review", verdict: "delete" }), ctx(token))).status).toBe(400);
  expect((await r.notes.POST(post(`${ORIGIN}/api/review/${token}/notes`, { genId: "g_review", text: "Slower walk?", name: "Client" }), ctx(token))).status).toBe(201);
  expect((await r.notes.POST(post(`${ORIGIN}/api/review/${token}/notes`, { genId: "g_other", text: "x" }), ctx(token))).status).toBe(404);

  const { runInTenant } = await import("../../lib/tenant");
  const { db } = await import("../../lib/db");
  const states = await runInTenant(A, () => db().execute("SELECT id, review_state FROM generations WHERE id IN ('g_review','g_approved') ORDER BY id"));
  expect(states.rows.map((row) => [row.id, row.review_state])).toEqual([["g_approved", "approved"], ["g_review", "picked"]]);

  /* The team reads what the client said; the client's view shows its own decision. */
  const team = await (await r.team.GET(scoped(who, `${ORIGIN}/api/review-links?projectId=prod_one`), undefined as never)).json();
  expect(team.said.map((s: { verdict: string | null; text: string | null }) => [s.verdict, s.text])).toEqual(expect.arrayContaining([["approved", "Love the light."], [null, "Slower walk?"]]));
  expect(team.said).toHaveLength(2);
  const view = await (await r.view.GET(new Request(`${ORIGIN}/api/review/${token}`), ctx(token))).json();
  expect(view.takes[1].verdict).toMatchObject({ verdict: "approved", guest: "Client" });

  /* An older link (the Approved takes only) cannot decide, and cannot comment on a take waiting for review. */
  Object.assign(who, { role: "owner" });
  const older = await r.shares.POST(scoped(who, `${ORIGIN}/api/shares`, { method: "POST", body: JSON.stringify({ projectId: "prod_one" }) }), undefined as never);
  expect(older.status).toBe(201);
  const oldToken = (await older.json()).url.split("/review/")[1];
  expect((await r.verdict.POST(post(`${ORIGIN}/api/review/${oldToken}/verdict`, { genId: "g_approved", verdict: "approved" }), ctx(oldToken))).status).toBe(403);
  expect((await r.notes.POST(post(`${ORIGIN}/api/review/${oldToken}/notes`, { genId: "g_review", text: "x" }), ctx(oldToken))).status).toBe(404);
  expect((await r.media.GET(new Request(`${ORIGIN}/x`), { params: Promise.resolve({ token: oldToken, genId: "g_review" }) })).status).toBe(404);
  const oldView = await (await r.view.GET(new Request(`${ORIGIN}/api/review/${oldToken}`), ctx(oldToken))).json();
  expect(oldView.takes.map((t: { id: string }) => t.id)).toEqual(["g_approved"]);
});

test("a withdrawn link stops at once, an expired one is gone, a guessed one opens nothing, and no link works as an API token", async () => {
  const who: Who = { mode: "session", ws: A, userId: "owner", name: "Owner Person", role: "owner", bearer: "" };
  const r = await routes(who);
  const made = await (await r.team.POST(scoped(who, `${ORIGIN}/api/review-links`, { method: "POST", body: JSON.stringify({ projectId: "prod_one" }) }), undefined as never)).json();
  const token = made.url.split("/review/")[1];
  expect((await r.view.GET(new Request(`${ORIGIN}/api/review/${token}`), ctx(token))).status).toBe(200);

  /* B's owner cannot withdraw A's link (it is filed under A), and B's session sees none of A's links. */
  const fromB: Who = { mode: "session", ws: B, userId: "owner", name: "Other Owner", role: "owner", bearer: "" };
  const rb = await routes(fromB);
  expect((await (await rb.team.DELETE(scoped(fromB, `${ORIGIN}/api/review-links?id=${made.link.id}`, { method: "DELETE" }), undefined as never)).json()).ok).toBe(false);
  expect((await r.view.GET(new Request(`${ORIGIN}/api/review/${token}`), ctx(token))).status).toBe(200);

  expect((await (await r.team.DELETE(scoped(who, `${ORIGIN}/api/review-links?id=${made.link.id}`, { method: "DELETE" }), undefined as never)).json()).ok).toBe(true);
  expect((await r.view.GET(new Request(`${ORIGIN}/api/review/${token}`), ctx(token))).status).toBe(404);
  expect((await r.verdict.POST(post(`${ORIGIN}/api/review/${token}/verdict`, { genId: "g_review", verdict: "approved" }), ctx(token))).status).toBe(404);
  expect((await r.media.GET(new Request(`${ORIGIN}/x`), { params: Promise.resolve({ token, genId: "g_review" }) })).status).toBe(404);

  /* Expired: the stored expiry has passed. */
  const again = await (await r.team.POST(scoped(who, `${ORIGIN}/api/review-links`, { method: "POST", body: JSON.stringify({ projectId: "prod_one" }) }), undefined as never)).json();
  const { platformDb } = await import("../../lib/platform");
  await platformDb().execute({ sql: "UPDATE p_shares SET expires_at = ? WHERE id = ?", args: [Date.now() - 1, again.link.id] });
  const expired = again.url.split("/review/")[1];
  expect((await r.view.GET(new Request(`${ORIGIN}/api/review/${expired}`), ctx(expired))).status).toBe(404);

  /* A guess, and a link's secret as a bearer token: nothing. */
  const guess = `rv_${"A".repeat(43)}`;
  expect((await r.view.GET(new Request(`${ORIGIN}/api/review/${guess}`), ctx(guess))).status).toBe(404);
  const { callerFromToken } = await import("../../lib/auth");
  expect(await callerFromToken(token)).toBeNull();
  expect(await callerFromToken(expired)).toBeNull();
});

test("a link is limited per client: too many decisions from one place are refused, another client still writes, and reading never locks out", async () => {
  const who: Who = { mode: "session", ws: A, userId: "owner", name: "Owner Person", role: "owner", bearer: "" };
  const r = await routes(who);
  const { url } = await (await r.team.POST(scoped(who, `${ORIGIN}/api/review-links`, { method: "POST", body: JSON.stringify({ projectId: "prod_one" }) }), undefined as never)).json();
  const token = url.split("/review/")[1];
  const { LIMITS } = await import("../../lib/security/review-link");
  /* Behind the self-hosted proxy, whose own entry is the last one in X-Forwarded-For (lib/clientIp.ts); the
     spoofed first entries change nothing. */
  const from = (ip: string, path: string, body: unknown, spoof = "") => new Request(`${ORIGIN}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": spoof ? `${spoof}, ${ip}` : ip }, body: JSON.stringify(body) });
  const saved = process.env.SELFHOST_BEHIND_PROXY;
  process.env.SELFHOST_BEHIND_PROXY = "1";
  try {
    const statuses: number[] = [];
    for (let i = 0; i <= LIMITS.write; i++) statuses.push((await r.verdict.POST(from("203.0.113.9", `/api/review/${token}/verdict`, { genId: "g_review", verdict: "changes" }, i % 2 ? `192.0.2.${i}` : ""), ctx(token))).status);
    expect(statuses.slice(0, LIMITS.write).every((s) => s === 201)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
    expect((await r.notes.POST(from("203.0.113.9", `/api/review/${token}/notes`, { genId: "g_review", text: "x" }), ctx(token))).status).toBe(429);
    expect((await r.notes.POST(from("203.0.113.9", `/api/review/${token}/notes`, { genId: "g_review", text: "x" }, "198.51.100.7"), ctx(token))).status).toBe(429);
    /* The real client, elsewhere, is not locked out by a flood from a leaked copy; and anyone can still read. */
    expect((await r.verdict.POST(from("198.51.100.7", `/api/review/${token}/verdict`, { genId: "g_review", verdict: "approved" }), ctx(token))).status).toBe(201);
    for (let i = 0; i < 50; i++) expect((await r.view.GET(new Request(`${ORIGIN}/api/review/${token}`), ctx(token))).status).toBe(200);
  } finally {
    if (saved === undefined) delete process.env.SELFHOST_BEHIND_PROXY; else process.env.SELFHOST_BEHIND_PROXY = saved;
  }
});
