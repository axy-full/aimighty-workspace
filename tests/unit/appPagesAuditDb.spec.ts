import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/* A throwaway platform and workspace database; nothing here reaches a vendor. */
const dir = mkdtempSync(path.join(tmpdir(), "particl-app-pages-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.CREDIT_USD = "0.10";
process.env.ENGINE_MOCK = "1";

const workspace = (id: string, own = false) => ({
  id, slug: id, name: id, legacy: false, dbUrl: process.env.TURSO_DATABASE_URL, dbToken: null,
  keys: own ? { openai: "own", gateway: "own" } : {}, usesPlatformKeys: !own, allowanceUsd: null, gatewayKeyId: null, ownerId: "u", createdAt: 0,
  suspendedAt: null, suspendedReason: null, flaggedAt: null, flagNote: null, concurrency: null, rendersPerHour: null, storageQuotaBytes: null, deletedAt: null,
});

test("a board write from a stale revision is refused with the board as it stands; a current one lands", async () => {
  const { createBoard, getBoard, saveBoard, saveBoardIfCurrent } = await import("../../lib/boards");
  const { runInTenant } = await import("../../lib/tenant");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ws = workspace("ws_boards") as any;
  await runInTenant(ws, async () => {
    const board = await createBoard("proj_1", "Board");
    const note = (id: string) => ({ id, kind: "note", x: 0, y: 0, label: id, text: id, ports: [], inputs: [], settings: {}, state: "idle", credits: 0, staleSince: null, output: null });
    /* Mine, from the loaded revision: lands, and moves the revision on. */
    const mine = await saveBoardIfCurrent(board.id, { nodes: [note("a")] as never, wires: [] }, board.updatedAt);
    expect(mine && "board" in mine).toBe(true);
    const after = (mine as { board: { updatedAt: number; nodes: unknown[] } }).board;
    expect(after.updatedAt).toBeGreaterThan(board.updatedAt);
    /* A teammate still on the loaded revision is refused, and gets what is there. */
    const theirs = await saveBoardIfCurrent(board.id, { nodes: [note("b")] as never, wires: [] }, board.updatedAt);
    expect(theirs && "conflict" in theirs).toBe(true);
    expect(((theirs as { conflict: { nodes: { id: string }[] } }).conflict.nodes).map((n) => n.id)).toEqual(["a"]);
    expect((await getBoard(board.id))!.nodes.map((n) => n.id)).toEqual(["a"]);
    /* From the new revision it lands. */
    const next = await saveBoardIfCurrent(board.id, { nodes: [note("a"), note("c")] as never, wires: [] }, after.updatedAt);
    expect(next && "board" in next).toBe(true);
    /* A write that names no revision behaves as it always did. */
    expect((await saveBoard(board.id, { name: "Renamed" }))!.name).toBe("Renamed");
    expect(await saveBoardIfCurrent("brd_missing", { nodes: [] }, 1)).toBeNull();
  });
});

test("a finished text run on credits reports the credits the ledger billed; on own keys, its dollars", async () => {
  const { meter } = await import("../../lib/meter");
  const { textRunCost } = await import("../../lib/textRunCost");
  const { billCredits } = await import("../../lib/creditTerms");
  const { runInTenant } = await import("../../lib/tenant");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const credits = workspace("ws_text") as any, own = { ...workspace("ws_text_own", true), usesPlatformKeys: false } as any;
  await runInTenant(credits, () => meter({ id: "text_1", kind: "text", engine: "vercel", model: "anthropic/claude-sonnet-4.5", status: "succeeded", engineCostUsd: 0.12 }));
  const billed = await runInTenant(credits, () => textRunCost({ id: "text_1", costUsd: 0.12 }));
  expect(billed).toEqual({ credits: billCredits(0.12, "text") });
  /* Not settled on the ledger: nothing is claimed. */
  expect(await runInTenant(credits, () => textRunCost({ id: "text_unmetered", costUsd: 0.12 }))).toEqual({ credits: null });
  /* Still the reservation (the settling write was lost): its figure is an estimate, not a bill. */
  const { platformDb } = await import("../../lib/platform");
  await platformDb().execute({
    sql: `INSERT INTO meter_events (id, workspace_id, kind, engine, model, status, engine_cost_usd, billed_credits, paid_by_platform, created_by, created_at, updated_at)
          VALUES ('text_reserved', 'ws_text', 'text', 'vercel', 'anthropic/claude-sonnet-4.5', 'running', 0.12, 2, 1, 'u', 1, 1)`,
    args: [],
  });
  expect(await runInTenant(credits, () => textRunCost({ id: "text_reserved", costUsd: 0.12 }))).toEqual({ credits: null });
  expect(await runInTenant(own, () => textRunCost({ id: "text_2", costUsd: 0.12 }))).toEqual({ costUsd: 0.12 });
});

/* ── The list routes, run for real against the throwaway database ─────────── */

/** A route module, compiled as it ships, with `@/…` served from `deps` (the auth wrapper is the only stand-in). */
async function route<T>(file: string, deps: Record<string, unknown>): Promise<T> {
  const { readFileSync } = await import("node:fs");
  const { createRequire } = await import("node:module");
  const ts = (await import("typescript")).default;
  const filename = path.resolve(file), requireHere = createRequire(filename);
  const compiled = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const mod = { exports: {} };
  new Function("require", "module", "exports", compiled)(
    (name: string) => {
      if (Object.hasOwn(deps, name)) return deps[name];
      if (name.startsWith("@/")) throw new Error(`${file} imports ${name}, which this test does not provide.`);
      return requireHere(name);
    },
    mod, mod.exports,
  );
  return mod.exports as T;
}

async function listRoutes(ws: { current: unknown }) {
  const tenant = await import("../../lib/tenant");
  const lib = {
    "@/lib/tenant": tenant,
    "@/lib/db": await import("../../lib/db"),
    "@/lib/credits": await import("../../lib/credits"),
    "@/lib/creditSql": await import("../../lib/creditSql"),
    "@/lib/shots": await import("../../lib/shots"),
    "@/lib/productions": await import("../../lib/productions"),
    "@/lib/cache": await import("../../lib/cache"),
    "@/lib/platform": await import("../../lib/platform"),
    "@/lib/planLimits": await import("../../lib/planLimits"),
    "@/lib/archive": await import("../../lib/archive"),
    "@/lib/workbench/request-scope": await import("../../lib/workbench/request-scope"),
    /* Signed in as an admin of whichever workspace the test has chosen. */
    "@/lib/auth": {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      withTenant: (handler: (...a: any[]) => Promise<unknown>) => (...a: unknown[]) => tenant.runInTenant(ws.current as never, () => handler(...a)),
      requireUser: async () => ({ user: { id: "u_admin", role: "admin" } }),
    },
  };
  type Get = { GET: (req: Request, ctx?: unknown) => Promise<Response> };
  return {
    shots: await route<Get>("app/api/shots/route.ts", lib),
    projects: await route<Get>("app/api/projects/route.ts", lib),
    project: await route<Get>("app/api/projects/[id]/route.ts", lib),
    productions: await route<Get>("app/api/productions/route.ts", lib),
  };
}

test("a workspace on credits is sent its credits and never the vendor's dollars; one on its own keys gets its dollars", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  const { createShot } = await import("../../lib/shots");
  const dbUrl = `file:${path.join(dir, "lists.db")}`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const credits = { ...workspace("ws_lists"), dbUrl } as any, own = { ...workspace("ws_lists_own", true), usesPlatformKeys: false, dbUrl } as any;
  /* One project, one shot, one metered take at a vendor cost of $1.88. */
  const shotId = await runInTenant(credits, async () => {
    await ready();
    await db().execute({ sql: "INSERT INTO productions (id, name, created_at) VALUES ('prd_l', 'Rain film', 1)", args: [] });
    await db().execute({ sql: "INSERT INTO projects (id, name, created_at, production_id) VALUES ('prj_l', 'Rain film', 1, 'prd_l')", args: [] });
    const shot = await createShot({ projectId: "prj_l", title: "Courier", planned: 5, createdBy: "u_admin" });
    await db().execute({
      sql: "INSERT INTO generations (id, project_id, shot_id, model, prompt, params, status, cost_usd, created_at, updated_at, kind) VALUES ('gen_l', 'prj_l', ?, 'seedance-2-0', 'A courier', '{}', 'succeeded', 1.88, 2, 2, 'video')",
      args: [shot.id],
    });
    return shot.id;
  });
  const ws = { current: credits as unknown };
  const r = await listRoutes(ws);
  const get = async (h: { GET: (req: Request, ctx?: unknown) => Promise<Response> }, url: string, ctx?: unknown) => {
    const res = await h.GET(new Request(`http://localhost${url}`), ctx);
    return { status: res.status, json: await res.json() };
  };

  const shotsCr = (await get(r.shots, "/api/shots?projectId=prj_l")).json.shots as { id: string; spend: number; credits: number }[];
  const mine = shotsCr.find((s) => s.id === shotId)!;
  expect(mine.spend).toBe(0);
  expect(mine.credits).toBeGreaterThan(0);
  const projectsCr = (await get(r.projects, "/api/projects")).json as { unit: string; projects: { id: string; spend: number; credits: number }[] };
  expect(projectsCr.unit).toBe("cr");
  expect(projectsCr.projects.find((p) => p.id === "prj_l")).toMatchObject({ spend: 0, credits: mine.credits });
  const prodsCr = (await get(r.productions, "/api/productions")).json.productions as { id: string; spentUsd: number; spentCredits: number; projects: { spentUsd: number; spentCredits: number }[] }[];
  const prodCr = prodsCr.find((p) => p.id === "prd_l")!;
  expect(prodCr.spentUsd).toBe(0);
  expect(prodCr.projects[0].spentUsd).toBe(0);
  expect(prodCr.spentCredits).toBe(mine.credits);
  /* Nothing in any of the three answers carries the vendor figure. */
  for (const body of [shotsCr, projectsCr, prodsCr]) expect(JSON.stringify(body)).not.toContain("1.88");

  ws.current = own;
  const shotsUsd = (await get(r.shots, "/api/shots?projectId=prj_l")).json.shots as { id: string; spend: number }[];
  expect(shotsUsd.find((s) => s.id === shotId)!.spend).toBeCloseTo(1.88, 9);
  const projectsUsd = (await get(r.projects, "/api/projects")).json as { unit: string; projects: { id: string; spend: number }[] };
  expect(projectsUsd.unit).toBe("usd");
  expect(projectsUsd.projects.find((p) => p.id === "prj_l")!.spend).toBeCloseTo(1.88, 9);
  const prodUsd = ((await get(r.productions, "/api/productions")).json.productions as { id: string; spentUsd: number }[]).find((p) => p.id === "prd_l")!;
  expect(prodUsd.spentUsd).toBeCloseTo(1.88, 9);

  /* One project, from its own row: the page asks here before it says a project does not exist. */
  ws.current = credits;
  const one = await get(r.project, "/api/projects/prj_l", { params: Promise.resolve({ id: "prj_l" }) });
  expect(one.status).toBe(200);
  expect(one.json.project).toMatchObject({ id: "prj_l", name: "Rain film", productionId: "prd_l" });
  expect((await get(r.project, "/api/projects/prj_gone", { params: Promise.resolve({ id: "prj_gone" }) })).status).toBe(404);
});
