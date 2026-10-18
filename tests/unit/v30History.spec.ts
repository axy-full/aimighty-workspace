import { test, expect } from "@playwright/test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import ts from "typescript";
import type { Client } from "@libsql/client";
import type { TenantUser, TenantWorkspace } from "../../lib/tenant";
import type { ProviderOutcome } from "../../lib/providerOutcome";
import type { AgentRow, DirectorRow, HistoryAggregates, HistoryPage, HistoryViewer } from "../../lib/history/read";

/*
 * v30 PR A9 (docs/plans/v30-data-model.md § 5, § 8 "A9"; owner's brief, Phase A item 5; owner's 17 Oct answer 15):
 * the History read models, read-only, behind V30_HISTORY (and V30_JOBS), both off by default.
 *
 * Every credit amount, quote and vendor figure below is SYNTHETIC, built in the test: none is a price, a margin or a
 * vendor cost. Every engine, model and provider name is a SENTINEL made here, so finding one names the leak.
 */

const dir = mkdtempSync(path.join(tmpdir(), "particl-v30-history-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";

const run = randomUUID().slice(0, 8);
function workspace(name: string, id = `ws_hist_${name}_${run}`): TenantWorkspace {
  return {
    id, slug: `hist-${name}`, name, legacy: false,
    dbUrl: `file:${path.join(dir, `${name}.db`)}`, dbToken: null, keys: {}, usesPlatformKeys: true,
    allowanceUsd: null, gatewayKeyId: null, ownerId: "u_owner", createdAt: 0, suspendedAt: null, suspendedReason: null,
    flaggedAt: null, flagNote: null, concurrency: 10, rendersPerHour: 1000, storageQuotaBytes: null, deletedAt: null,
  };
}
const A = workspace("a");
const B = workspace("b");

/* Sentinels and synthetic figures, named as such. */
const SENTINEL_ENGINE = "zqx-sentinel-engine-a9";
const SENTINEL_MODEL = "zqx-sentinel-model-a9";
const SENTINEL_PROVIDER = "zqxprovidera9";
const SENTINEL_METER_ENGINE = "zqx-meter-engine-a9";
const SENTINEL_METER_MODEL = "zqx-meter-model-a9";
const SENTINEL_WORDS = [SENTINEL_ENGINE, SENTINEL_MODEL, SENTINEL_PROVIDER, SENTINEL_METER_ENGINE, SENTINEL_METER_MODEL, "zqx"];
/* A vendor cost on every meter row, with a recognisable sixth decimal: any sum of these that leaks is findable. */
const SYNTHETIC_VENDOR_USD = 7.654321;
const SYNTHETIC_QUOTE = 4;
const RECEIPT = { cmd: 3, dir: 5, loose: 2, old: 4, oldDeleted: 1.5, board: 6, text: 0.5, b: 9 } as const;

const PEOPLE = [
  { id: "u_owner", name: "Owner Fixture", email: "owner-fixture@example.test", role: "admin" as const, owner: true },
  { id: "u_crew", name: "Crew Fixture", email: "crew-fixture@example.test", role: "member" as const, owner: false },
  { id: "u_member", name: "Member Fixture", email: "member-fixture@example.test", role: "member" as const, owner: false },
];
const person = (id: string): TenantUser => ({ ...PEOPLE.find((p) => p.id === id)!, disabled: false, lastSeen: null, createdAt: 0 });
const OWNER: HistoryViewer = { id: "u_owner", admin: true, role: "admin" };
const MEMBER: HistoryViewer = { id: "u_member", admin: false, role: "member" };
const TEAMMATE_WORDS = PEOPLE.filter((p) => p.id !== "u_member").flatMap((p) => [p.name, p.email]);

/* Fixed times for earlier work (before History), in two calendar months, UTC. */
const SEPT = Date.UTC(2026, 8, 15, 12);
const OCT = Date.UTC(2026, 9, 2, 12);

const mods = async () => ({
  ...(await import("../../lib/db")),
  ...(await import("../../lib/tenant")),
  ...(await import("../../lib/platform")),
  ...(await import("../../lib/quotedJobs/store")),
  ...(await import("../../lib/providerOutcome")),
  ...(await import("../../lib/draftProject")),
  ...(await import("../../lib/history/read")),
  ...(await import("../../lib/history/flag")),
  ...(await import("../../lib/models")),
});

async function withEnv<T>(values: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const before = Object.fromEntries(Object.keys(values).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(values)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(before)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
}
const ON = { V30_HISTORY: "1", V30_JOBS: "1" };

/** The vendor's failure, naming the engine and a refund in its own words: none of it may reach History. */
const vendorFailure = (): ProviderOutcome => ({
  v: 1, provider: "byteplus", stage: "run", code: "SentinelVendorCode", kind: "content_filter",
  message: `Model ${SENTINEL_ENGINE} refused the request; your credits were refunded.`, billing: { state: "refunded", basis: "hf-ledger" }, funding: "platform", at: 1,
});

type Seeded = { boardA: string; commandId: string; jobs: Record<string, string>; client: Client };
let seeded: Seeded;
let seededB: { client: Client };

async function meterRow(ws: TenantWorkspace, id: string, o: { project: string | null; kind: string; status: string; by: string | null; at: number; credits: number }) {
  const { platformDb } = await mods();
  await platformDb().execute({
    sql: `INSERT INTO meter_events(id,workspace_id,project_id,shot_id,kind,engine,model,status,engine_cost_usd,billed_credits,paid_by_platform,duration_ms,created_by,created_at,updated_at)
          VALUES(?,?,?,NULL,?,?,?,?,?,?,1,NULL,?,?,?)`,
    args: [id, ws.id, o.project, o.kind, SENTINEL_METER_ENGINE, SENTINEL_METER_MODEL, o.status, SYNTHETIC_VENDOR_USD, o.credits, o.by, o.at, o.at],
  });
}

async function team(client: Client) {
  for (const p of PEOPLE)
    await client.execute({ sql: "INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES(?,?,?,'x',?,0)", args: [p.id, p.email, p.name, p.role] });
}

async function approval(client: Client, id: string, productionId: string, totalTenths: number, approvedBy: string) {
  const { PLAN_APPROVAL_SCHEMA, PLAN_APPROVAL_GUARDS } = await import("../../lib/workbench/plan-approval");
  await client.batch([PLAN_APPROVAL_SCHEMA, ...PLAN_APPROVAL_GUARDS], "write");
  const at = Date.now();
  await client.execute({
    sql: `INSERT INTO rig_plan_approvals(id,run_id,production_id,approved_by,approved_at,expires_at,fingerprint,steps,total_tenths,ceiling_tenths,limit_credits,created_at)
          VALUES(?,?,?,?,?,?,'synthetic','[]',?,?,?,?)`,
    args: [id, `run_${id}`, productionId, approvedBy, at, at + 86_400_000, totalTenths, totalTenths, totalTenths / 10, at],
  });
}

const take = (client: Client, id: string, project: string | null, by: string, o: { deleted?: boolean; prompt?: string } = {}) =>
  client.execute({
    sql: "INSERT INTO generations(id,project_id,model,prompt,params,status,created_by,deleted,created_at,updated_at) VALUES(?,?,?,?,?,'succeeded',?,?,1,1)",
    args: [id, project, SENTINEL_MODEL, o.prompt ?? `A synthetic prompt for ${id}`,
      JSON.stringify({ ratio: "16:9", resolution: "720p", duration: 5, model: SENTINEL_MODEL, vendorCostUsd: SYNTHETIC_VENDOR_USD }), by, o.deleted ? 1 : 0],
  });

test.beforeAll(async () => {
  const m = await mods();
  await m.platformReady();
  /* Both workspaces are on the new interface, through the platform owner's list. */
  await m.platformDb().execute({
    sql: `INSERT INTO platform_layer(key,value,updated_at,updated_by) VALUES('site',?,?,'test')
          ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at, updated_by=excluded.updated_by`,
    args: [JSON.stringify({ newInterfaceWorkspaces: [A.id, B.id] }), Date.now()],
  });
  const boardA = m.mappedId(m.DRAFT_PROJECT_PREFIX, A.id, "u_crew", "draft_crew");

  seeded = await m.runInTenant(A, async () => {
    await m.ready();
    const client = m.db();
    await team(client);
    for (const [id, name, production] of [["prj_a1", "Coast film", "prod_a1"], ["prj_a2", "Forest film", "prod_a2"], [boardA, "Crew's board", "prod_board"]])
      await client.execute({ sql: "INSERT INTO projects(id,name,created_at,production_id) VALUES(?,?,1,?)", args: [id, name, production] });
    await client.execute({ sql: "INSERT INTO workbench_projects(key,owner,project_id,name,body,updated_at) VALUES('k_crew','u_crew','draft_crew','Crew board','{}',1)", args: [] });

    /* Takes: made under v30 jobs, and earlier ones. */
    await take(client, "gen_cmd1", "prj_a1", "u_member");
    await take(client, "gen_dir1", "prj_a1", "u_owner", { prompt: "A synthetic prompt about a forest at dusk" });
    await take(client, "gen_loose", "prj_a2", "u_crew");
    await take(client, "gen_old1", "prj_a1", "u_member");
    await take(client, "gen_old_deleted", "prj_a1", "u_member", { deleted: true });
    await take(client, "gen_board_old", boardA, "u_crew");
    await take(client, "gen_dir_board", boardA, "u_crew");
    await client.execute({
      sql: "INSERT INTO take_provenance(take_id,shot_id,recorded,created_at) VALUES('gen_dir1',NULL,?,1)",
      args: [JSON.stringify({ engine: SENTINEL_ENGINE, model: SENTINEL_MODEL, provider: SENTINEL_PROVIDER, ports: ["el_cast:attr_face:ver_1"], cast: ["maya"], setup: { angle: "low" }, rules: [], conditions: {}, by: "u_owner", at: 1 })],
    });

    /* The meter records: the money truth. Three belong to v30 jobs; the rest are earlier work. */
    await meterRow(A, "gen_cmd1", { project: "prj_a1", kind: "video", status: "succeeded", by: "u_member", at: Date.now(), credits: RECEIPT.cmd });
    await meterRow(A, "gen_dir1", { project: "prj_a1", kind: "video", status: "failed", by: "u_owner", at: Date.now(), credits: RECEIPT.dir });
    await meterRow(A, "gen_loose", { project: "prj_a2", kind: "image", status: "succeeded", by: "u_crew", at: Date.now(), credits: RECEIPT.loose });
    await meterRow(A, "gen_old1", { project: "prj_a1", kind: "video", status: "succeeded", by: "u_member", at: SEPT, credits: RECEIPT.old });
    await meterRow(A, "gen_old_deleted", { project: "prj_a1", kind: "image", status: "failed", by: null, at: SEPT + 1000, credits: RECEIPT.oldDeleted });
    await meterRow(A, "gen_board_old", { project: boardA, kind: "image", status: "succeeded", by: "u_crew", at: OCT, credits: RECEIPT.board });
    await meterRow(A, "mtr_text_old", { project: null, kind: "text", status: "succeeded", by: "u_owner", at: OCT + 1000, credits: RECEIPT.text });

    /* v30 jobs and an instruction, through the store's own entry point, flags on. */
    const jobs = await withEnv(ON, async () => {
      const store = await m.quotedJobs();
      const command = await store.createCommand({ productionId: "prj_a1", stepId: "pstep_shots", instruction: "=1+1 Synthetic: three coast shots", quote: { credits: SYNTHETIC_QUOTE * 3 }, by: "u_member" });
      await approval(client, "rpa_hist", "prj_a1", SYNTHETIC_QUOTE * 30, "u_member");
      await store.approveCommand(command.id, "rpa_hist", { user: { id: "u_member" } });
      const agent = await store.createJob({ productionId: "prj_a1", stepId: "pstep_shots", commandId: command.id, decider: "agent", product: "generation", engine: SENTINEL_ENGINE, quote: { credits: SYNTHETIC_QUOTE }, meterId: "gen_cmd1", takeId: "gen_cmd1", by: "u_member" });
      await store.start(agent.id);
      await store.finish(agent.id, "done");
      const plate = await store.createJob({ productionId: "prj_a1", stepId: "pstep_shots", nodeId: "node_plate", commandId: command.id, decider: "agent", product: "generation", engine: SENTINEL_ENGINE, quote: { credits: SYNTHETIC_QUOTE }, by: "u_member" });
      const director = await store.createJob({ productionId: "prj_a1", stepId: "pstep_look", decider: "director", product: "generation", engine: SENTINEL_ENGINE, quote: { credits: SYNTHETIC_QUOTE }, meterId: "gen_dir1", takeId: "gen_dir1", by: "u_owner" });
      await store.start(director.id);
      await store.finish(director.id, "failed", vendorFailure());
      const loose = await store.createJob({ productionId: "prj_a2", decider: "agent", product: "generation", engine: SENTINEL_ENGINE, quote: { credits: SYNTHETIC_QUOTE }, meterId: "gen_loose", takeId: "gen_loose", by: "u_crew" });
      const board = await store.createJob({ productionId: boardA, decider: "director", product: "generation", engine: SENTINEL_ENGINE, quote: { credits: SYNTHETIC_QUOTE }, takeId: "gen_dir_board", by: "u_crew" });
      return { commandId: command.id, ids: { agent: agent.id, plate: plate.id, director: director.id, loose: loose.id, board: board.id } };
    });
    return { boardA, commandId: jobs.commandId, jobs: jobs.ids, client };
  });

  seededB = await m.runInTenant(B, async () => {
    await m.ready();
    const client = m.db();
    await team(client);
    await client.execute({ sql: "INSERT INTO projects(id,name,created_at,production_id) VALUES('prj_b1','B film',1,'prod_b1')", args: [] });
    await take(client, "gen_b_old", "prj_b1", "u_owner");
    await meterRow(B, "gen_b_old", { project: "prj_b1", kind: "video", status: "succeeded", by: "u_owner", at: OCT, credits: RECEIPT.b });
    return { client };
  });
});

/** GET /api/history as `viewer` reads it in `ws`, through the route's own body. */
async function get(ws: TenantWorkspace, viewer: HistoryViewer, query: string): Promise<{ status: number; text: string; type: string | null }> {
  const m = await mods();
  return m.runInTenant(ws, async () => {
    const res = await m.historyResponse(new Request(`http://localhost/api/history?${query}`), viewer);
    return { status: res.status, text: await res.text(), type: res.headers.get("content-type") };
  }, { user: person(viewer.id) });
}
async function json<T>(ws: TenantWorkspace, viewer: HistoryViewer, query: string): Promise<T> {
  const res = await withEnv(ON, () => get(ws, viewer, query));
  expect(res.status, res.text).toBe(200);
  return JSON.parse(res.text) as T;
}
async function csv(ws: TenantWorkspace, viewer: HistoryViewer, query: string): Promise<string> {
  const res = await withEnv(ON, () => get(ws, viewer, `${query}&format=csv`));
  expect(res.status, res.text).toBe(200);
  expect(res.type).toContain("text/csv");
  return res.text;
}
/** Every row of a view, following the cursor. */
async function allRows<R>(ws: TenantWorkspace, viewer: HistoryViewer, query: string, limit = 200): Promise<R[]> {
  const rows: R[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 50; i++) {
    const page: HistoryPage<R> = await json<HistoryPage<R>>(ws, viewer, `${query}&limit=${limit}${cursor ? `&cursor=${cursor}` : ""}`);
    rows.push(...page.rows);
    if (!page.next) return rows;
    cursor = page.next;
  }
  throw new Error("History did not end");
}

/** What no History output may carry, for any decider: a vendor cost, a refund, a provider's own words. */
function expectNoMoneyInternals(wire: string) {
  expect(wire).not.toMatch(/refund/i);
  expect(wire).not.toContain(String(SYNTHETIC_VENDOR_USD));
  expect(wire).not.toMatch(/vendor|engine_cost|cost_usd|margin|SentinelVendorCode/i);
}
/** What no Agent output may carry: any engine, model or provider, the sentinels or a real one. */
async function expectNoEngine(wire: string) {
  const m = await mods();
  for (const word of SENTINEL_WORDS) expect(wire, word).not.toContain(word);
  for (const model of m.MODELS) expect(wire, model.id).not.toContain(model.id);
  expect(wire).not.toContain("byteplus");
}

test("Agent History: one row per instruction, with its words, production, step, date, total and cards, and no engine anywhere", async () => {
  const page = await json<HistoryPage<AgentRow>>(A, OWNER, "view=agent");
  const command = page.rows.find((r) => r.source === "command")!;
  expect(command).toMatchObject({
    id: seeded.commandId, instruction: "=1+1 Synthetic: three coast shots", production: { id: "prj_a1", name: "Coast film" }, step: "pstep_shots",
    member: { id: "u_member", name: "Member Fixture", you: false }, state: "approved", quote: { credits: SYNTHETIC_QUOTE * 3 },
    /* The total is the sum of its jobs' receipts (the meter's), never stored. */
    total: { credits: RECEIPT.cmd },
  });
  expect(command.cards).toEqual([
    { takeId: "gen_cmd1", nodeId: null, href: expect.stringContaining("asset=generation%3Agen_cmd1") },
    { takeId: null, nodeId: "node_plate", href: null },
  ]);
  expect(command.cards[0].href).toContain("production=prod_a1");
  expect(command.cards[0].href).toContain(`ws=${A.id}`);
  expect(command.link).toBe(command.cards[0].href);

  // An Agent job of no instruction is its own row.
  const loose = page.rows.find((r) => r.id === seeded.jobs.loose)!;
  expect(loose).toMatchObject({ source: "job", instruction: null, production: { id: "prj_a2", name: "Forest film" }, total: { credits: RECEIPT.loose }, state: "queued" });
  expect(loose.cards.map((c) => c.takeId)).toEqual(["gen_loose"]);

  // Director jobs are never Agent rows; one meter record is one row, never twice.
  const ids = page.rows.map((r) => r.id);
  for (const id of [seeded.jobs.director, seeded.jobs.board, seeded.jobs.agent, seeded.jobs.plate, "gen_cmd1", "gen_dir1", "gen_loose"]) expect(ids).not.toContain(id);
  expect(new Set(ids).size).toBe(ids.length);

  const wire = JSON.stringify(page);
  await expectNoEngine(wire);
  expectNoMoneyInternals(wire);
});

test("Director History: itemised with the engine it chose, its settings, inputs and prompt; the failure line is ours and never says refund", async () => {
  const page = await json<HistoryPage<DirectorRow>>(A, OWNER, "view=director");
  expect(page.rows.map((r) => r.id).sort()).toEqual([seeded.jobs.board, seeded.jobs.director].sort());
  const row = page.rows.find((r) => r.id === seeded.jobs.director)!;
  expect(row).toMatchObject({
    production: { id: "prj_a1", name: "Coast film" }, step: "pstep_look", member: { id: "u_owner", name: "Owner Fixture", you: true },
    product: "generation", status: "failed", engine: { id: SENTINEL_ENGINE }, prompt: "A synthetic prompt about a forest at dusk",
    settings: { ratio: "16:9", resolution: "720p", duration: 5, "setup.angle": "low" }, inputs: { ports: ["el_cast:attr_face:ver_1"], cast: ["maya"] },
    quote: { credits: SYNTHETIC_QUOTE }, actual: { credits: RECEIPT.dir },
  });
  expect(row.error).toBeTruthy();
  expect(row.card?.takeId).toBe("gen_dir1");
  expect(row.link).toContain("asset=generation%3Agen_dir1");
  const wire = JSON.stringify(page);
  // The Director rows DO name the engine (so the Agent check above is pointed at the right thing).
  expect(wire).toContain(SENTINEL_ENGINE);
  expectNoMoneyInternals(wire);
  // The refund status is stored on the job, and stays internal.
  expect(String((await seeded.client.execute({ sql: "SELECT refund_status FROM quoted_jobs WHERE id=?", args: [seeded.jobs.director] })).rows[0].refund_status)).toBe("refunded");
});

test("earlier work is backfilled from the meter records: 'before History' for what was never recorded, never an engine, never twice", async () => {
  const m = await mods();
  const rows = await allRows<AgentRow>(A, OWNER, "view=agent");
  const earlier = rows.filter((r) => r.source === "earlier");
  expect(earlier.map((r) => r.id)).toEqual(["mtr_text_old", "gen_board_old", "gen_old_deleted", "gen_old1"]);
  const old = earlier.find((r) => r.id === "gen_old1")!;
  expect(old).toEqual({
    source: "earlier", id: "gen_old1", instruction: m.BEFORE_HISTORY, production: { id: "prj_a1", name: "Coast film" }, step: m.BEFORE_HISTORY,
    at: SEPT, member: { id: "u_member", name: "Member Fixture", you: false }, state: "done", quote: null, total: { credits: RECEIPT.old },
    cards: [{ takeId: "gen_old1", nodeId: null, href: expect.stringContaining("asset=generation%3Agen_old1") }], link: expect.stringContaining("gen_old1"),
  });
  // A record that names no person takes its take's; a hidden take is no card; a failed one says so.
  expect(earlier.find((r) => r.id === "gen_old_deleted")).toMatchObject({ member: { id: "u_member" }, state: "failed", cards: [], link: null, total: { credits: RECEIPT.oldDeleted } });
  // A record with no project says "before History" for it.
  expect(earlier.find((r) => r.id === "mtr_text_old")).toMatchObject({ production: { id: null, name: m.BEFORE_HISTORY }, cards: [], total: { credits: RECEIPT.text } });
  // Every meter record of A appears exactly once across History: as its job, or as earlier work.
  const meterIds = (await m.platformDb().execute({ sql: "SELECT id FROM meter_events WHERE workspace_id=?", args: [A.id] })).rows.map((r) => String(r.id));
  const claimed = ["gen_cmd1", "gen_dir1", "gen_loose"];
  expect([...earlier.map((r) => r.id), ...claimed].sort()).toEqual(meterIds.sort());
  // The meter rows carry an engine, a model and a vendor cost: none reaches History.
  const wire = JSON.stringify(earlier);
  await expectNoEngine(wire);
  expectNoMoneyInternals(wire);
  // Paging through the cursor one row at a time gives exactly the same rows, in the same order.
  expect((await allRows<AgentRow>(A, OWNER, "view=agent", 1)).map((r) => r.id)).toEqual(rows.map((r) => r.id));
  // A month narrows every source, earlier work included (calendar month, UTC).
  expect((await allRows<AgentRow>(A, OWNER, "view=agent&month=2026-09")).map((r) => r.id)).toEqual(["gen_old_deleted", "gen_old1"]);
});

test("aggregates by production, member and month: the totals are the receipts' sums, over the same rows History shows", async () => {
  const agentRows = await allRows<AgentRow>(A, OWNER, "view=agent");
  const directorRows = await allRows<DirectorRow>(A, OWNER, "view=director");
  const agg = await json<HistoryAggregates & { unit: string }>(A, OWNER, "view=aggregates");
  const receipts = Object.values({ cmd: RECEIPT.cmd, dir: RECEIPT.dir, loose: RECEIPT.loose, old: RECEIPT.old, oldDeleted: RECEIPT.oldDeleted, board: RECEIPT.board, text: RECEIPT.text });
  const sum = (xs: number[]) => Math.round(xs.reduce((s, x) => s + x, 0) * 10) / 10;
  expect(agg.unit).toBe("credits");
  // Every job (Agent and Director, with or without a receipt) and every earlier record, once.
  expect(agg.total).toEqual({ jobs: 5 + 4, credits: sum(receipts) });
  // The same total as the rows: Agent totals plus Director actuals.
  expect(agg.total.credits).toBe(sum([...agentRows.map((r) => r.total?.credits ?? 0), ...directorRows.map((r) => r.actual?.credits ?? 0)]));
  // And the same as the receipts the workspace holds for its meter records (the meter's replica).
  const replica = (await seeded.client.execute("SELECT COALESCE(SUM(credits),0) AS n FROM credit_receipts")).rows[0].n;
  expect(agg.total.credits).toBe(sum([Number(replica)]));
  const byProduction = Object.fromEntries(agg.byProduction.map((g) => [g.production.id ?? g.production.name, g]));
  expect(byProduction.prj_a1).toMatchObject({ production: { name: "Coast film" }, jobs: 6, credits: sum([RECEIPT.cmd, RECEIPT.dir, RECEIPT.old, RECEIPT.oldDeleted]) });
  expect(byProduction.prj_a2).toMatchObject({ jobs: 1, credits: RECEIPT.loose });
  expect(byProduction[seeded.boardA]).toMatchObject({ jobs: 2, credits: RECEIPT.board });
  expect(byProduction["before History"]).toMatchObject({ jobs: 1, credits: RECEIPT.text });
  const byMember = Object.fromEntries(agg.byMember.map((g) => [g.member.id, g]));
  expect(byMember.u_member).toMatchObject({ member: { name: "Member Fixture" }, jobs: 4, credits: sum([RECEIPT.cmd, RECEIPT.old, RECEIPT.oldDeleted]) });
  expect(byMember.u_crew).toMatchObject({ jobs: 3, credits: sum([RECEIPT.loose, RECEIPT.board]) });
  expect(byMember.u_owner).toMatchObject({ jobs: 2, credits: sum([RECEIPT.dir, RECEIPT.text]) });
  const thisMonth = new Date().toISOString().slice(0, 7);
  const byMonth = Object.fromEntries(agg.byMonth.map((g) => [g.month, g]));
  expect(byMonth["2026-09"]).toEqual({ month: "2026-09", jobs: 2, credits: sum([RECEIPT.old, RECEIPT.oldDeleted]) });
  expect(byMonth[thisMonth].jobs).toBeGreaterThanOrEqual(5);
  expect(agg.byMonth.reduce((s, g) => s + g.jobs, 0)).toBe(agg.total.jobs);
  expect(sum(agg.byProduction.map((g) => g.credits ?? 0))).toBe(agg.total.credits);
  expect(sum(agg.byMember.map((g) => g.credits ?? 0))).toBe(agg.total.credits);
  const wire = JSON.stringify(agg);
  await expectNoEngine(wire);
  expectNoMoneyInternals(wire);
});

test("CSV: Agent rows carry no engine column or name, earlier work says 'before History', cells are defused; Director rows name their engine", async () => {
  const m = await mods();
  const agent = await csv(A, OWNER, "view=agent");
  const [head, ...lines] = agent.trim().split("\r\n");
  expect(head).toBe(m.AGENT_CSV_HEADER.join(","));
  expect(head).not.toMatch(/engine|model|provider|refund|cost|vendor/i);
  expect(lines).toHaveLength((await allRows<AgentRow>(A, OWNER, "view=agent")).length);
  // A typed instruction that starts like a formula is text in the spreadsheet.
  expect(agent).toContain("'=1+1 Synthetic: three coast shots");
  const old = lines.find((l) => l.startsWith("gen_old1,"))!;
  expect(old).toContain(`earlier,${m.BEFORE_HISTORY},prj_a1,Coast film,${m.BEFORE_HISTORY},`);
  expect(old).toContain(`,done,${m.BEFORE_HISTORY},${RECEIPT.old},take:gen_old1,`);
  expect(lines.find((l) => l.startsWith("mtr_text_old,"))).toContain(`earlier,${m.BEFORE_HISTORY},${m.BEFORE_HISTORY},${m.BEFORE_HISTORY},${m.BEFORE_HISTORY},`);
  await expectNoEngine(agent);
  expectNoMoneyInternals(agent);

  const director = await csv(A, OWNER, "view=director");
  expect(director.split("\r\n")[0]).toBe(m.DIRECTOR_CSV_HEADER.join(","));
  expect(director).toContain(`,${SENTINEL_ENGINE},`);
  expect(director).toContain("ratio=16:9");
  expect(director).toContain("el_cast:attr_face:ver_1 @maya");
  expectNoMoneyInternals(director);

  const aggregates = await csv(A, OWNER, "view=aggregates");
  expect(aggregates.split("\r\n")[0]).toBe(m.AGGREGATE_CSV_HEADER.join(","));
  expect(aggregates).toContain("production,prj_a1,Coast film,6,");
  expect(aggregates).toContain("month,2026-09,2026-09,2,");
  await expectNoEngine(aggregates);
  expectNoMoneyInternals(aggregates);
});

test("visibility: a member reads every job and amount, a name only on their own work, nothing of a teammate's private board, and filters only by themselves", async () => {
  const agent = await allRows<AgentRow>(A, MEMBER, "view=agent");
  const director = await allRows<DirectorRow>(A, MEMBER, "view=director");
  const agg = await json<HistoryAggregates>(A, MEMBER, "view=aggregates");
  // The crew member's private board (not shared) is left out: its earlier work, its Director job, its totals.
  expect(agent.map((r) => r.id)).not.toContain("gen_board_old");
  expect(director.map((r) => r.id)).toEqual([seeded.jobs.director]);
  expect(agg.byProduction.map((g) => g.production.id)).not.toContain(seeded.boardA);
  expect(agg.total.jobs).toBe(9 - 2);
  // A teammate's work is "Teammate", with no id; their own carries their name.
  expect(agent.find((r) => r.id === seeded.jobs.loose)?.member).toEqual({ id: null, name: "Teammate", you: false });
  expect(agent.find((r) => r.source === "command")?.member).toEqual({ id: "u_member", name: "Member Fixture", you: true });
  expect(agg.byMember.map((g) => g.member.name).sort()).toEqual(["Member Fixture", "Teammate"]);
  for (const wire of [JSON.stringify(agent), JSON.stringify(director), JSON.stringify(agg), await csv(A, MEMBER, "view=agent"), await csv(A, MEMBER, "view=aggregates")]) {
    for (const word of TEAMMATE_WORDS) expect(wire, word).not.toContain(word);
    expect(wire).not.toContain("u_crew");
    expect(wire).not.toContain("u_owner");
    expectNoMoneyInternals(wire);
  }
  // Only an owner or admin tells one teammate's work apart from the rest.
  const refused = await withEnv(ON, () => get(A, MEMBER, "view=agent&member=u_crew"));
  expect(refused.status).toBe(403);
  const mine = await allRows<AgentRow>(A, MEMBER, "view=agent&member=me");
  expect(mine.length).toBeGreaterThan(0);
  expect(mine.every((r) => r.member.you)).toBe(true);
  expect((await allRows<AgentRow>(A, OWNER, "view=agent&member=u_crew")).map((r) => r.id).sort()).toEqual(["gen_board_old", seeded.jobs.loose].sort());
  // A production named in the query must be one the viewer may read: a teammate's private board is the same 404 as none.
  const board = await withEnv(ON, () => get(A, MEMBER, `view=agent&production=${seeded.boardA}`));
  const none = await withEnv(ON, () => get(A, MEMBER, "view=agent&production=prj_nowhere"));
  expect(board.status).toBe(404);
  expect(board.text).toBe(none.text);
  expect((await allRows<AgentRow>(A, OWNER, "view=agent&production=prj_a2")).map((r) => r.id)).toEqual([seeded.jobs.loose]);
});

test("tenant isolation: workspace B reads none of A's jobs, instructions, earlier work, productions or totals", async () => {
  const agent = await allRows<AgentRow>(B, OWNER, "view=agent");
  const director = await allRows<DirectorRow>(B, OWNER, "view=director");
  const agg = await json<HistoryAggregates>(B, OWNER, "view=aggregates");
  // B's own earlier work, and nothing else.
  expect(agent.map((r) => r.id)).toEqual(["gen_b_old"]);
  expect(agent[0]).toMatchObject({ production: { id: "prj_b1", name: "B film" }, total: { credits: RECEIPT.b } });
  expect(director).toEqual([]);
  expect(agg.total).toEqual({ jobs: 1, credits: RECEIPT.b });
  const wire = [JSON.stringify(agent), JSON.stringify(director), JSON.stringify(agg), await csv(B, OWNER, "view=agent"), await csv(B, OWNER, "view=director")].join("\n");
  for (const a of [seeded.commandId, ...Object.values(seeded.jobs), "gen_cmd1", "gen_dir1", "gen_loose", "gen_old1", "mtr_text_old", "prj_a1", "Coast film", "three coast shots"])
    expect(wire, a).not.toContain(a);
  // A's production, named from B, is the same 404 as one that does not exist.
  const named = await withEnv(ON, () => get(B, OWNER, "view=agent&production=prj_a1"));
  const none = await withEnv(ON, () => get(B, OWNER, "view=agent&production=prj_nowhere"));
  expect(named.status).toBe(404);
  expect(named.text).toBe(none.text);
  // And A never reads B's earlier work.
  expect((await allRows<AgentRow>(A, OWNER, "view=agent")).map((r) => r.id)).not.toContain("gen_b_old");
  // B's database holds no job of A's.
  expect(Number((await seededB.client.execute("SELECT COUNT(*) AS n FROM quoted_jobs")).rows[0].n)).toBe(0);
});

test("the house (no credits) reads History with no amounts", async () => {
  const m = await mods();
  const house = workspace("house", m.HOUSE_WORKSPACE_ID ?? "ws_legacy");
  await m.runInTenant(house, async () => {
    await m.ready();
    await team(m.db());
  });
  await meterRow(house, "gen_house_old", { project: null, kind: "video", status: "succeeded", by: "u_owner", at: OCT, credits: 0 });
  const page = await json<HistoryPage<AgentRow>>(house, OWNER, "view=agent");
  expect(page.unit).toBeNull();
  expect(page.rows.map((r) => [r.id, r.total])).toEqual([["gen_house_old", null]]);
  expect((await json<HistoryAggregates>(house, OWNER, "view=aggregates")).total).toEqual({ jobs: 1, credits: null });
});

test("flag off: the route answers 404 for every query before any database is opened; on, still 404 without V30_JOBS or the new interface", async () => {
  const m = await mods();
  const fresh = workspace("never-opened", A.id);
  fresh.dbUrl = `file:${path.join(dir, "never-opened.db")}`;
  for (const value of [undefined, "", "0", "true", "on", " 1", "1 "])
    await withEnv({ V30_HISTORY: value, V30_JOBS: "1" }, async () => {
      expect(m.historySwitchOn()).toBe(false);
      expect(await m.historyOn(A)).toBe(false);
      for (const query of ["view=agent", "view=director&format=csv", "view=aggregates", "view=nonsense", "cursor=%%%", `production=prj_a1`]) {
        const res = await get(fresh, OWNER, query);
        expect(res.status, query).toBe(404);
        expect(JSON.parse(res.text)).toEqual({ error: "Not found." });
      }
    });
  expect(existsSync(fresh.dbUrl.slice("file:".length))).toBe(false);
  // History on, jobs off: the same 404, and no jobs table is made in a workspace that has none.
  const cold = workspace("jobs-off", `ws_hist_cold_${run}`);
  await m.platformDb().execute({
    sql: "UPDATE platform_layer SET value=? WHERE key='site'",
    args: [JSON.stringify({ newInterfaceWorkspaces: [A.id, B.id, cold.id] })],
  });
  await withEnv({ V30_HISTORY: "1", V30_JOBS: undefined }, async () => {
    expect((await get(cold, OWNER, "view=agent")).status).toBe(404);
  });
  const coldDb = m.tenantClient(cold);
  expect((await coldDb.execute("SELECT name FROM sqlite_master WHERE name IN ('quoted_jobs','agent_commands')")).rows).toEqual([]);
  // Both on, a workspace without the new interface: 404.
  const customer = workspace("customer", `ws_hist_customer_${run}`);
  await withEnv(ON, async () => {
    expect(await m.historyOn(customer)).toBe(false);
    expect((await get(customer, OWNER, "view=agent")).status).toBe(404);
  });
  expect(existsSync(path.join(dir, "customer.db"))).toBe(false);
});

test("the route: a signed-in person of the workspace, through withTenant and requireUser, handed to the read model with their role", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const seen: HistoryViewer[] = [];
  const load = (user: TenantUser | null) => {
    const file = path.resolve("app/api/history/route.ts");
    const compiled = ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
    const mod = { exports: {} as { GET: (req: Request) => Promise<Response> } };
    const deps: Record<string, unknown> = {
      "@/lib/auth": {
        requireUser: async () => (user ? { user } : { response: Response.json({ error: "Not signed in" }, { status: 401 }) }),
        withTenant: (fn: (req: Request) => Promise<Response>) => (req: Request) => runInTenant(A, () => fn(req), { user }),
      },
      "@/lib/history/read": { historyResponse: async (_req: Request, viewer: HistoryViewer) => { seen.push(viewer); return Response.json({ ok: true }); } },
    };
    new Function("require", "module", "exports", compiled)((name: string) => {
      if (name in deps) return deps[name];
      throw new Error(`Unstubbed import ${name}`);
    }, mod, mod.exports);
    return mod.exports.GET;
  };
  expect((await load(null)(new Request("http://localhost/api/history"))).status).toBe(401);
  expect(seen).toEqual([]);
  await load(person("u_member"))(new Request("http://localhost/api/history"));
  await load(person("u_owner"))(new Request("http://localhost/api/history"));
  expect(seen).toEqual([{ id: "u_member", admin: false, role: "member" }, { id: "u_owner", admin: true, role: "admin" }]);
  // The route imports the read model only: never the jobs store or the serializer directly.
  const text = readFileSync("app/api/history/route.ts", "utf8");
  expect([...text.matchAll(/from\s+"([^"]+)"/g)].map((x) => x[1]).sort()).toEqual(["@/lib/auth", "@/lib/history/read"]);
});

test("nothing billed changes: every History read and file leaves the meter, the receipts, the ledger and the workspace's tables exactly as they were", async () => {
  const m = await mods();
  const dump = async (client: Client, skip: string[] = []) => {
    const names = (await client.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")).rows.map((r) => String(r.name)).filter((n) => !skip.includes(n));
    const out: Record<string, unknown[]> = {};
    for (const name of names) out[name] = (await client.execute(`SELECT * FROM "${name}" ORDER BY rowid`)).rows.map((r) => ({ ...r }));
    return JSON.stringify(out);
  };
  // Read once first: the receipts' replica catches up (as Usage and the export already do), then nothing moves.
  await json(A, OWNER, "view=agent");
  /* The platform's sessions and rate counters are not money; everything else is compared. */
  const platformSkip = ["sessions", "rate_limits"];
  const before = { platform: await dump(m.platformDb(), platformSkip), a: await dump(seeded.client), b: await dump(seededB.client) };
  for (const viewer of [OWNER, MEMBER])
    for (const view of ["agent", "director", "aggregates"]) {
      await json(A, viewer, `view=${view}`);
      await csv(A, viewer, `view=${view}`);
      await json(B, viewer, `view=${view}`);
    }
  expect(await dump(m.platformDb(), platformSkip)).toBe(before.platform);
  expect(await dump(seeded.client)).toBe(before.a);
  expect(await dump(seededB.client)).toBe(before.b);
});

test("new source guard (stricter only): earlier work never selects an engine, model, outcome or cost column, and History never writes", () => {
  const literal = (file: string) => {
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const out: string[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) out.push(node.text);
      else if (ts.isTemplateExpression(node)) out.push([node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join(" "));
      ts.forEachChild(node, visit);
    };
    visit(source);
    return out;
  };
  const sql = (s: string) => /\b(select|from|where|join)\b/i.test(s);
  const earlier = literal("lib/history/earlier.ts").filter(sql);
  expect(earlier.some((s) => /meter_events/.test(s))).toBe(true);
  for (const s of earlier) expect(s, s).not.toMatch(/\b(engine|model|provider\w*|\w*cost\w*|\w*usd\w*|overrun\w*|margin\w*|billed_credits|\*)\b|\.\*|\*\s+from/i);
  for (const file of ["lib/history/earlier.ts", "lib/history/read.ts", "lib/history/flag.ts", "app/api/history/route.ts"])
    for (const s of literal(file).filter(sql)) expect(s, `${file}: ${s}`).not.toMatch(/\b(insert|update|delete|replace|create|drop|alter)\b/i);
  // History names no jobs table in its own SQL: it reads jobs through the store alone.
  for (const file of ["lib/history/read.ts", "lib/history/earlier.ts", "app/api/history/route.ts"]) expect(readFileSync(file, "utf8")).not.toMatch(/quoted_jobs|agent_commands/);
  void createRequire;
});
