import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { TenantToken, TenantUser, TenantWorkspace } from "../../lib/tenant";
import { loadRouteModule } from "../helpers/vendorCostScan";

/**
 * The build action and its reads (lib/demo/mark.server.ts, board.server.ts, open.server.ts, /api/demo/sample).
 *
 * It marks one of the workspace's OWN finished productions as the explore-only sample: people only, owner or admin
 * only, the caller's own drafts only, workspace-scoped. It writes one `settings` row and nothing else: no take, no
 * ledger row, no meter event, no balance. It is undone by archiving and hiding the row, never by deleting it. The
 * board it feeds carries credits from the ledger's record and no vendor dollar.
 *
 * No paid call: every outbound request fails the test.
 */
const dir = mkdtempSync(path.join(tmpdir(), "demo-s12-mark-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "demo-s12-mark-unit-keyring-not-a-real-secret";
process.env.BLOB_READ_WRITE_TOKEN = "";
process.env.ENGINE_MOCK = "1";

const originalFetch = globalThis.fetch;
const outbound: string[] = [];
test.beforeEach(() => {
  outbound.length = 0;
  globalThis.fetch = async (input: RequestInfo | URL) => {
    outbound.push(String(input instanceof Request ? input.url : input));
    throw new Error("Unexpected external request in test");
  };
});
test.afterEach(() => { globalThis.fetch = originalFetch; });

function workspace(): TenantWorkspace {
  const id = `ws_${randomUUID().slice(0, 8)}`;
  return { id, name: id, slug: id, legacy: false, dbUrl: `file:${path.join(dir, `${id}.db`)}`, dbToken: null, keys: {}, usesPlatformKeys: true,
    allowanceUsd: null, suspendedAt: null, suspendedReason: null, flaggedAt: null, flagNote: null, concurrency: null, rendersPerHour: null,
    storageQuotaBytes: null, deletedAt: null, gatewayKeyId: null, ownerId: "owner", createdAt: 0 } as TenantWorkspace;
}
const person = (id: string, over: Partial<TenantUser> = {}): TenantUser =>
  ({ id, email: `${id}@example.test`, name: id, role: "member", owner: false, disabled: false, lastSeen: null, createdAt: 0, ...over });
const OWNER = person("u_owner", { role: "admin", owner: true });
const ADMIN = person("u_admin", { role: "admin" });
const MEMBER = person("u_member");

async function inTenant<T>(ws: TenantWorkspace, fn: () => Promise<T>, extra: { user?: TenantUser | null; token?: TenantToken } = {}): Promise<T> {
  const { runInTenant } = await import("../../lib/tenant");
  return runInTenant(ws, fn, extra);
}

/** A row with the given values and a placeholder in every other required column. */
async function insertRow(table: string, values: Record<string, unknown>) {
  const { db, ready } = await import("../../lib/db");
  await ready();
  const required = (await db().execute(`PRAGMA table_info(${table})`)).rows
    .filter((c) => Number(c.notnull) && c.dflt_value == null && !Number(c.pk) && !(String(c.name) in values));
  const row = { ...Object.fromEntries(required.map((c) => [String(c.name), /INT|REAL|NUM/i.test(String(c.type)) ? 0 : "x"])), ...values };
  await db().execute({ sql: `INSERT INTO ${table}(${Object.keys(row).join(",")}) VALUES(${Object.keys(row).map(() => "?").join(",")})`, args: Object.values(row) as never[] });
}

async function counts(client: { execute: (sql: string) => Promise<{ rows: unknown[] }> }) {
  const tables = (await client.execute(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)).rows as unknown as { name: string }[];
  const out: Record<string, number> = {};
  for (const { name } of tables) out[name] = Number(((await client.execute(`SELECT COUNT(*) AS n FROM "${name}"`)).rows[0] as { n: number }).n);
  return out;
}
function diff(before: Record<string, number>, after: Record<string, number>) {
  const out: Record<string, number> = {};
  for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const d = (after[name] ?? 0) - (before[name] ?? 0);
    if (d) out[name] = d;
  }
  return out;
}

/** Everything a read or a mark touches, opened first, so a diff is the action's own writes. */
async function warm() {
  const { ready } = await import("../../lib/db");
  const { workbenchReady } = await import("../../lib/workbench/records");
  const { archiveReady } = await import("../../lib/archive");
  const { platformReady } = await import("../../lib/platform");
  await ready(); await workbenchReady(); await archiveReady(); await platformReady();
}

/**
 * A finished production in the current workspace, saved the way the app saves it: three shots, a take on each (rows with
 * the ledger's record behind them), a cut, a cast. `prices` is what the ledger holds per take; null leaves it out.
 */
async function finishedProduction(owner: string, prices: (number | null)[] = [43, 43, 7], at = Date.now()) {
  const { newProject } = await import("../../lib/workbench/studio");
  const { saveDraft } = await import("../../lib/workbench/records");
  const { platformDb } = await import("../../lib/platform");
  const { requireTenant } = await import("../../lib/tenant");
  await warm();
  const draft = newProject("Neutral film");
  draft.id = `project-${randomUUID().slice(0, 8)}`;
  const saved = await saveDraft(owner, draft, 0);
  const productionId = saved.productionProjectId;
  const takes: string[] = [];
  for (const [i, price] of prices.entries()) {
    const shot = `shot_${randomUUID().slice(0, 6)}`, gen = `gen_${randomUUID().slice(0, 6)}`;
    await insertRow("shots", { id: shot, project_id: productionId, code: `S${i}`, title: `Take ${i}`, position: i, created_at: at, updated_at: at });
    await insertRow("generations", {
      id: gen, project_id: productionId, shot_id: shot, kind: "video", model: i < 2 ? "seedance-2-5" : "kling-3-0-standard", prompt: "p", status: "succeeded",
      params: JSON.stringify({ duration: 5, resolution: "1080p" }), cost_usd: 1.234, version: 1, review_state: i < 2 ? "approved" : "", created_at: at + i, updated_at: at + i, deleted: 0,
    });
    if (price !== null)
      await platformDb().execute({
        sql: `INSERT INTO meter_events(id,workspace_id,kind,engine,model,status,engine_cost_usd,billed_credits,paid_by_platform,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,1,?,?)`,
        args: [gen, requireTenant().id, "video", "e", "m", "succeeded", 1.234, price, at, at],
      });
    takes.push(gen);
  }
  const project = {
    ...draft, productionProjectId: productionId,
    assets: takes.map((gen, i) => ({ id: `take-${gen}`, name: `Take ${i + 1}`, kind: "video" as const, category: "Shot", url: `/api/media/${gen}`, description: "", prompt: "", status: i < 2 ? "Selected" as const : "Draft" as const, locked: false, version: 1, refs: [], generationId: gen })),
    shots: takes.map((gen, i) => ({ id: `cut-${i}`, name: `Shot ${i + 1}`, assetId: `take-${gen}`, duration: 120, sourceIn: 0, note: "" })),
    production: { cast: { entries: [{ id: "k1", name: "Lead", kind: "character" as const, description: "ivory suit, short dark bob", prompt: "", takes: [] }] } },
  };
  const again = await saveDraft(owner, project, saved.revision);
  return { draftId: draft.id, productionId, revision: again.revision, takes };
}

test("the owner marks their own finished production: one settings row, nothing in the takes, the ledger or the meter", async () => {
  const mark = await import("../../lib/demo/mark.server");
  const { db } = await import("../../lib/db");
  const { platformDb } = await import("../../lib/platform");
  await inTenant(workspace(), async () => {
    const made = await finishedProduction(OWNER.id);
    const platformBefore = await counts(platformDb()), tenantBefore = await counts(db());
    const generationsBefore = (await db().execute(`SELECT id, status, cost_usd, review_state FROM generations ORDER BY id`)).rows.map((r) => ({ ...r }));

    const marked = await mark.markSampleProduction({ draftId: made.draftId }, OWNER);
    expect(marked).toMatchObject({ version: 1, projectId: made.productionId, draftOwner: OWNER.id, draftId: made.draftId, markedBy: OWNER.id });
    expect(await mark.readSampleMark()).toEqual(marked);

    expect(diff(platformBefore, await counts(platformDb()))).toEqual({});
    expect(diff(tenantBefore, await counts(db()))).toEqual({ settings: 1 });
    expect((await db().execute(`SELECT id, status, cost_usd, review_state FROM generations ORDER BY id`)).rows.map((r) => ({ ...r }))).toEqual(generationsBefore);
    const row = (await db().execute({ sql: `SELECT updated_by FROM settings WHERE key = 'sampleProduction'` })).rows[0];
    expect(String(row.updated_by)).toBe(OWNER.id);
    expect(outbound).toEqual([]);
  }, { user: OWNER });
});

test("the production may be named by its project instead of its draft; it is found among the caller's own drafts", async () => {
  const mark = await import("../../lib/demo/mark.server");
  await inTenant(workspace(), async () => {
    const made = await finishedProduction(OWNER.id);
    const marked = await mark.markSampleProduction({ projectId: made.productionId }, OWNER);
    expect(marked.draftId).toBe(made.draftId);
    expect(marked.name).toBe("Neutral film");
  }, { user: OWNER });
});

test("only a person who owns the workspace or administers it, and never an agent or a disabled account, can build", async () => {
  const mark = await import("../../lib/demo/mark.server");
  const { db } = await import("../../lib/db");
  await inTenant(workspace(), async () => {
    const made = await finishedProduction(MEMBER.id);
    await insertRow("settings", { key: "unrelated", value: "1", updated_at: 1 });
    const before = await counts(db());
    for (const refused of [MEMBER, person("agent:run_1", { role: "admin", owner: true }), person("u_off", { role: "admin", disabled: true })])
      await expect(mark.markSampleProduction({ draftId: made.draftId }, refused)).rejects.toMatchObject({ status: 403 });
    await expect(mark.hideSampleMark(MEMBER)).rejects.toMatchObject({ status: 403 });
    expect(mark.canBuildSample(null)).toBe(false);
    expect(mark.canBuildSample(OWNER)).toBe(true);
    expect(mark.canBuildSample(ADMIN)).toBe(true);
    expect(diff(before, await counts(db()))).toEqual({});
    expect(await mark.readSampleMark()).toBeNull();
  });
});

test("an admin marks only their own drafts: a teammate's private production, a copy of the sample and a missing id are refused", async () => {
  const mark = await import("../../lib/demo/mark.server");
  await inTenant(workspace(), async () => {
    const theirs = await finishedProduction(MEMBER.id);
    await expect(mark.markSampleProduction({ draftId: theirs.draftId }, ADMIN)).rejects.toMatchObject({ status: 404 });
    await expect(mark.markSampleProduction({ projectId: theirs.productionId }, ADMIN)).rejects.toMatchObject({ status: 404 });
    await expect(mark.markSampleProduction({ draftId: "sample-abcdef" }, ADMIN)).rejects.toMatchObject({ status: 404 });
    await expect(mark.markSampleProduction({}, ADMIN)).rejects.toMatchObject({ status: 400 });
    await expect(mark.markSampleProduction({ draftId: { $ne: 1 } }, ADMIN)).rejects.toMatchObject({ status: 400 });
    await expect(mark.markSampleProduction({ draftId: "x".repeat(200) }, ADMIN)).rejects.toMatchObject({ status: 400 });
    expect(await mark.readSampleMark()).toBeNull();
  });
});

test("two workspaces never see each other's sample, and an admin of one cannot mark a production of the other", async () => {
  const mark = await import("../../lib/demo/mark.server");
  const a = workspace(), b = workspace();
  const made = await inTenant(a, async () => {
    const m = await finishedProduction(OWNER.id);
    await mark.markSampleProduction({ draftId: m.draftId }, OWNER);
    return m;
  });
  await inTenant(b, async () => {
    await warm();
    expect(await mark.readSampleMark()).toBeNull();
    /* Same person id, other workspace: the draft is not in this workspace's database. */
    await expect(mark.markSampleProduction({ draftId: made.draftId }, OWNER)).rejects.toMatchObject({ status: 404 });
    await expect(mark.markSampleProduction({ projectId: made.productionId }, OWNER)).rejects.toMatchObject({ status: 404 });
    expect((await import("../../lib/demo/board.server")).readSampleBoard()).resolves.toBeNull();
    expect(await mark.hideSampleMark(OWNER)).toBe(false);
  });
  expect((await inTenant(a, () => mark.readSampleMark()))?.projectId).toBe(made.productionId);
});

test("marking again changes nothing; another production waits until the first is undone; undo hides and archives, never deletes", async () => {
  const mark = await import("../../lib/demo/mark.server");
  const { db } = await import("../../lib/db");
  await inTenant(workspace(), async () => {
    const one = await finishedProduction(OWNER.id), two = await finishedProduction(OWNER.id);
    const first = await mark.markSampleProduction({ draftId: one.draftId }, OWNER);
    const before = await counts(db());
    expect(await mark.markSampleProduction({ draftId: one.draftId }, OWNER)).toEqual(first);
    expect(diff(before, await counts(db()))).toEqual({});
    await expect(mark.markSampleProduction({ draftId: two.draftId }, OWNER)).rejects.toMatchObject({ status: 409 });

    expect(await mark.hideSampleMark(OWNER)).toBe(true);
    expect(await mark.readSampleMark()).toBeNull();
    /* The row is still there, marked hidden, and its earlier form is in the workspace archive. */
    const stored = JSON.parse(String((await db().execute(`SELECT value FROM settings WHERE key = 'sampleProduction'`)).rows[0].value));
    expect(stored).toMatchObject({ projectId: one.productionId, hiddenBy: OWNER.id });
    expect(stored.hiddenAt).toBeGreaterThan(0);
    const archived = (await db().execute(`SELECT reason, archived_by, body FROM archived_rows WHERE table_name = 'settings'`)).rows;
    expect(archived).toHaveLength(1);
    expect(String(archived[0].reason)).toBe("sample undone");
    expect(JSON.parse(String(JSON.parse(String(archived[0].body)).value)).hiddenAt).toBeUndefined();
    expect(await mark.hideSampleMark(OWNER)).toBe(false);

    /* The other production can be the sample now, and the hidden row is archived in turn. */
    const next = await mark.markSampleProduction({ draftId: two.draftId }, OWNER);
    expect(next.projectId).toBe(two.productionId);
    expect((await db().execute(`SELECT COUNT(*) AS n FROM archived_rows WHERE table_name = 'settings'`)).rows[0].n).toBe(2);
  }, { user: OWNER });
});

test("PATCH /api/settings cannot write the mark: it is not one of the settings a workspace may set", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const auth = await import("../../lib/auth");
  const ws = workspace();
  const route = loadRouteModule<{ PATCH: (req: Request) => Promise<Response> }>("app/api/settings/route.ts", {
    "@/lib/auth": { ...auth, withTenant: (fn: (req: Request) => Promise<Response>) => (req: Request) => runInTenant(ws, () => fn(req), { user: OWNER }) },
  });
  await inTenant(ws, async () => {
    await warm();
    const mark = await import("../../lib/demo/mark.server");
    const res = await route.PATCH(new Request("https://studio.test/api/settings", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sampleProduction: JSON.stringify({ version: 1, projectId: "prj_x", draftOwner: "a", draftId: "b" }) }) }));
    expect(res.status).toBe(400);
    expect(await mark.readSampleMark()).toBeNull();
  });
});

/* ── the board it feeds ──────────────────────────────────────────────── */

test("the board's plan is the ledger's recorded credits per shot, the cast and cut are the owner's, and no vendor dollar is in it", async () => {
  const mark = await import("../../lib/demo/mark.server");
  const { readSampleBoard } = await import("../../lib/demo/board.server");
  const { db } = await import("../../lib/db");
  const { platformDb } = await import("../../lib/platform");
  await inTenant(workspace(), async () => {
    const made = await finishedProduction(OWNER.id, [43, 43, 7]);
    await mark.markSampleProduction({ draftId: made.draftId }, OWNER);
    const platformBefore = await counts(platformDb()), tenantBefore = await counts(db());
    const board = await readSampleBoard();
    expect(board).not.toBeNull();
    expect(board!.line).toBe("Sample production · nothing here spends credits");
    expect(board!.plan.steps.map((s) => [s.title, s.credits])).toEqual([["Shot 1", 43], ["Shot 2", 43], ["Shot 3", 7]]);
    expect(board!.plan.steps[0].meta).toBe("Seedance 2.5 · 5 s · 1080p");
    expect(board!.plan.unpriced).toEqual([]);
    expect(board!.plan.recorded).toEqual({ settled: 93, quoted: 0 });
    expect(board!.cast.map((c) => c.line)).toEqual(["Lead · ivory suit, short dark bob"]);
    expect(board!.cut).toMatchObject({ approved: 2, seconds: 15, approvedSeconds: 10, waiting: 1 });
    /* The vendor's dollars sit on the ledger row and the take row; neither figure reaches the board. */
    expect(JSON.stringify(board)).not.toMatch(/1\.234|cost|usd|margin/i);
    /* Reading wrote nothing anywhere. */
    expect(diff(platformBefore, await counts(platformDb()))).toEqual({});
    expect(diff(tenantBefore, await counts(db()))).toEqual({});
  }, { user: OWNER });
});

test("a take the ledger holds no row for has no price on the plan, and another workspace's ledger row of the same id is never read", async () => {
  const mark = await import("../../lib/demo/mark.server");
  const { readSampleBoard } = await import("../../lib/demo/board.server");
  const { platformDb } = await import("../../lib/platform");
  await inTenant(workspace(), async () => {
    const made = await finishedProduction(OWNER.id, [43, null, null]);
    await mark.markSampleProduction({ draftId: made.draftId }, OWNER);
    /* A row under the same job id, but another workspace's: not this one's charge. */
    await platformDb().execute({
      sql: `INSERT INTO meter_events(id,workspace_id,kind,engine,model,status,engine_cost_usd,billed_credits,paid_by_platform,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,1,1,1)`,
      args: [made.takes[1], "ws_someone_else", "video", "e", "m", "succeeded", 9, 99],
    });
    /* A reserved job (still running) is a quote, not a charge. */
    await platformDb().execute({
      sql: `INSERT INTO meter_events(id,workspace_id,kind,engine,model,status,engine_cost_usd,billed_credits,paid_by_platform,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,1,1,1)`,
      args: [made.takes[2], (await import("../../lib/tenant")).requireTenant().id, "video", "e", "m", "running", 1, 7],
    });
    const board = (await readSampleBoard())!;
    expect(board.plan.steps.map((s) => [s.title, s.credits])).toEqual([["Shot 1", 43], ["Shot 3", 7]]);
    expect(board.plan.unpriced).toEqual(["Shot 2"]);
    /* The 43 is a settled charge; the 7 is a reservation still open, so it counts as a quote; the other workspace's 99 is in neither. */
    expect(board.plan.recorded).toEqual({ settled: 43, quoted: 7 });
  }, { user: OWNER });
});
