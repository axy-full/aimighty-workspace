import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import type { TenantWorkspace } from "../../lib/tenant";

/**
 * Make's results (owner, 13 Oct: "show only takes made in Make"): GET /api/jobs?madeIn=make lists the takes the server marked `params.madeIn = "make"` and nothing else, newest first,
 * through the same filters as the list: limit, the cursor, stable pagination, and a private board's rule (lib/draftProject.ts: a take on a board the person may not see is left out of the
 * query itself). A take with no mark (every one made before this) is not Make's. Only that one value is a filter. Real temporary databases; sign-in is a fake; nothing is sent or spent.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-private-takes-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";
const run = Math.random().toString(36).slice(2, 8);
const workspace = (id: string) => ({ id, name: id, slug: id, legacy: false, dbUrl: `file:${path.join(dir, id + ".db")}`, dbToken: null, keys: {}, usesPlatformKeys: true }) as TenantWorkspace;
const user = (id: string, role: "admin" | "member" = "member", owner = false) => ({ id, email: `${id}@example.test`, name: id, role, owner, disabled: false, lastSeen: null, createdAt: 0 });
type Actor = { user: ReturnType<typeof user>; token?: unknown };
const as = (id: string, role: "admin" | "member" = "member", token = false, owner = false): Actor => ({ user: user(id, role, owner), ...(token ? { token: { id: `tok_${id}`, name: "agent", scope: "render" as const, capUsd: null } } : {}) });

function loadRoute<T>(file: string, who: () => Actor, extra: Record<string, unknown> = {}): T {
  const root = process.cwd();
  const real = createRequire(path.resolve(file));
  const fakes: Record<string, unknown> = {
    "@/lib/auth": { withTenant: (handler: unknown) => handler, requireUser: async () => ({ ...who() }), requireRender: async () => ({ ...who() }), requireSession: async () => ({ ...who() }) },
    "@/lib/workbench/request-scope": { workbenchScopeProblem: () => null },
    ...extra,
  };
  const filename = path.resolve(file);
  const compiled = ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const mod = { exports: {} };
  new Function("require", "module", "exports", compiled)((name: string) => (Object.hasOwn(fakes, name) ? fakes[name] : name.startsWith("@/") ? real(path.join(root, name.slice(2))) : real(name)), mod, mod.exports);
  return mod.exports as T;
}


async function fixture(ws: TenantWorkspace) {
  const tenant = await import("../../lib/tenant"), database = await import("../../lib/db"), draft = await import("../../lib/draftProject");
  const { newProject } = await import("../../lib/workbench/studio");
  const { workbenchReady } = await import("../../lib/workbench/records");
  const board = (owner: string, id: string) => draft.mappedId("prj_wb_", ws.id, owner, id);
  const priv = board("u_owner", "d1");
  await tenant.runInTenant(ws, async () => {
    await database.ready(); await workbenchReady();
    const db = database.db();
    for (const [id, name] of [[priv, "Private board"], ["prod_open", "Ordinary production"]]) await db.execute({ sql: "INSERT OR IGNORE INTO projects(id,name,created_at) VALUES(?,?,0)", args: [id, name] });
    await db.execute({ sql: "INSERT INTO workbench_projects(key,owner,project_id,name,body,revision,updated_at) VALUES(?,?,?,?,?,1,0)", args: ["u_owner:d1", "u_owner", "d1", "d1", JSON.stringify({ ...newProject("d1"), id: "d1", productionProjectId: priv })] });
    const take = (id: string, prompt: string, params: unknown, projectId: string | null, at: number) => db.execute({
      sql: "INSERT INTO generations(id,model,prompt,params,status,created_at,updated_at,kind,title,deleted,created_by,project_id,stored_url) VALUES(?,?,?,?,?,?,?,'image',?,0,'u_owner',?,?)",
      args: [id, "m", prompt, typeof params === "string" ? params : JSON.stringify(params), "succeeded", at, at, prompt, projectId, "/api/platform/previews/x"],
    });
    /* Newest first. Marked: made in Make (filed on a board, on a private board, unfiled). Not: made before the mark, another value, the mark nested in another key, params that are not an object. */
    await take(`t_m1_${run}`, "make-newest-private", { madeIn: "make" }, priv, 100);
    await take(`t_old1_${run}`, "old-no-mark", {}, "prod_open", 95);
    await take(`t_m2_${run}`, "make-filed-on-board", { madeIn: "make", ratio: "16:9" }, "prod_open", 90);
    await take(`t_other_${run}`, "other-value", { madeIn: "board" }, "prod_open", 85);
    await take(`t_nested_${run}`, "nested-mark", { shotSpec: { madeIn: "make" }, enhanced: { madeIn: "make" } }, "prod_open", 80);
    await take(`t_m3_${run}`, "make-unfiled", { madeIn: "make" }, null, 70);
    await take(`t_bad_${run}`, "array-params", ["make"], "prod_open", 60);
    await take(`t_m4_${run}`, "make-oldest", { madeIn: "make" }, "prod_open", 50);
  }, { user: user("u_owner") });
  return { tenant, priv };
}

const prompts = (body: { generations: { prompt: string }[] }) => body.generations.map((g) => g.prompt);
const OWNER = as("u_owner"), MATE = as("u_mate"), ADMIN = as("u_admin", "admin");

test("GET /api/jobs?madeIn=make lists only the takes marked made in Make, with limit, cursor and stable pages, and a private board's rule", async () => {
  const ws = workspace(`mr-a-${run}`);
  const { tenant, priv } = await fixture(ws);
  let who: Actor = OWNER;
  const route = loadRoute<typeof import("../../app/api/jobs/route")>("app/api/jobs/route.ts", () => who);
  const call = async (actor: Actor, query: string, within: TenantWorkspace = ws) => {
    who = actor;
    return tenant.runInTenant(within, async () => { const res = await route.GET(new Request(`https://particl.test/api/jobs${query}`), undefined as never); return { status: res.status, body: await res.json() }; }, { user: actor.user, token: actor.token as never });
  };
  /* Without the filter nothing changes: every take, marked or not. */
  expect(prompts((await call(OWNER, "?sync=0&limit=60")).body)).toHaveLength(8);
  /* The owner sees every marked one, on a board or not, newest first; the unmarked, mis-marked, nested and broken ones are not Make's. */
  const owner = await call(OWNER, "?sync=0&limit=60&madeIn=make");
  expect(owner.status).toBe(200);
  expect(prompts(owner.body)).toEqual(["make-newest-private", "make-filed-on-board", "make-unfiled", "make-oldest"]);
  /* A workspace admin sees the same (the work belongs to the workspace); a teammate does not see the one on the owner's private board, and the page holds no gap for it. */
  expect(prompts((await call(ADMIN, "?sync=0&madeIn=make")).body)).toEqual(["make-newest-private", "make-filed-on-board", "make-unfiled", "make-oldest"]);
  const mate = await call(MATE, "?sync=0&madeIn=make");
  expect(prompts(mate.body)).toEqual(["make-filed-on-board", "make-unfiled", "make-oldest"]);
  expect(JSON.stringify(mate.body)).not.toContain("make-newest-private");
  /* limit: the newest marked ones, and the unmarked are not spent from the page. */
  expect(prompts((await call(OWNER, "?sync=0&madeIn=make&limit=2")).body)).toEqual(["make-newest-private", "make-filed-on-board"]);
  /* The cursor (before) continues through the marked ones only. */
  const first = (await call(OWNER, "?sync=0&madeIn=make&limit=2")).body;
  expect(prompts((await call(OWNER, `?sync=0&madeIn=make&limit=2&before=${first.nextCursor}`)).body)).toEqual(["make-unfiled", "make-oldest"]);
  /* Stable pagination: pages of one, an asset cursor, and "more" only when a marked one remains. */
  const seen: string[] = [];
  let cursor: string | null = null;
  for (let guard = 0; guard < 8; guard++) {
    const page: { generations: { prompt: string }[]; nextPageCursor: string | null } = (await call(OWNER, `?sync=0&madeIn=make&pagination=stable&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`)).body;
    seen.push(...prompts(page));
    cursor = page.nextPageCursor;
    if (!cursor) break;
  }
  expect(seen).toEqual(["make-newest-private", "make-filed-on-board", "make-unfiled", "make-oldest"]);
  /* It composes with the other filters: a board's own, and search. */
  expect(prompts((await call(OWNER, `?sync=0&madeIn=make&projectId=${priv}`)).body)).toEqual(["make-newest-private"]);
  expect(prompts((await call(OWNER, "?sync=0&madeIn=make&q=unfiled")).body)).toEqual(["make-unfiled"]);
  expect(prompts((await call(MATE, `?sync=0&madeIn=make&projectId=${priv}`)).body)).toEqual([]);
  /* Another workspace sees none of it. */
  const other = workspace(`mr-a2-${run}`);
  await tenant.runInTenant(other, async () => { await (await import("../../lib/db")).ready(); }, { user: user("u_admin", "admin") });
  expect((await call(ADMIN, "?sync=0&madeIn=make", other)).body).toMatchObject({ generations: [] });
});

test("GET /api/jobs: madeIn takes one value, make; anything else is refused, not ignored", async () => {
  const ws = workspace(`mr-b-${run}`);
  const { tenant } = await fixture(ws);
  const route = loadRoute<typeof import("../../app/api/jobs/route")>("app/api/jobs/route.ts", () => OWNER);
  for (const query of ["madeIn=Make", "madeIn=board", "madeIn=", "madeIn=make&madeIn=make", "madeIn=make,board", "madeIn=1"]) {
    const res = await tenant.runInTenant(ws, async () => route.GET(new Request(`https://particl.test/api/jobs?sync=0&${query}`), undefined as never), { user: OWNER.user });
    expect(res.status, query).toBe(400);
  }
});
