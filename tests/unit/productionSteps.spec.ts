import { test, expect } from "@playwright/test";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Client } from "@libsql/client";
import type { TenantWorkspace } from "../../lib/tenant";

/*
 * v30 PR A1 (docs/plans/v30-data-model.md § 2.1, 2.2, 8): a production's steps and the frame of each canvas step.
 * Every film type below is SYNTHETIC, built in the test; none is the owner's list (plan Q1).
 */

const dir = mkdtempSync(path.join(tmpdir(), "particl-production-steps-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
/* The new-interface list is read afresh under the mock (lib/newInterface.server.ts), as in every lane run. */
process.env.ENGINE_MOCK = "1";

const HOUSE = "ws_legacy";
const workspace = (id: string, file = id) =>
  ({ id, name: id, slug: id, dbUrl: `file:${path.join(dir, file + ".db")}`, legacy: false, dbToken: null, keys: {}, usesPlatformKeys: true }) as unknown as TenantWorkspace;

const SYNTHETIC_TYPES = {
  filmTypes: [
    {
      id: "synthetic_spot",
      label: "Synthetic spot",
      steps: [
        { kind: "brief", label: "Synthetic brief", surface: "document" },
        { kind: "frames_a", label: "Synthetic frames A", surface: "canvas" },
        { kind: "frames_b", label: "Synthetic frames B", surface: "canvas" },
      ],
    },
  ],
};
const SYNTHETIC_ENV = { V30_FILM_TYPES: JSON.stringify(SYNTHETIC_TYPES) };

const mods = async () => ({
  ...(await import("../../lib/db")),
  ...(await import("../../lib/tenant")),
  ...(await import("../../lib/productionModel/steps")),
  ...(await import("../../lib/productionModel/filmTypes")),
  ...(await import("../../lib/productionModel/flag")),
  ...(await import("../../lib/localDatabaseClient")),
});

/** A bootstrapped workspace database (today's schema) holding one production from before v30. */
async function existingDatabase(ws: TenantWorkspace, productionId = "prj_one") {
  const { runInTenant, ready, db } = await mods();
  return runInTenant(ws, async () => {
    await ready();
    await db().execute({ sql: "INSERT OR IGNORE INTO projects(id,name,created_at) VALUES(?,?,?)", args: [productionId, "Existing", 1] });
    return db();
  });
}

const columns = async (client: Client, table: string) =>
  (await client.execute({ sql: "SELECT name FROM pragma_table_info(?)", args: [table] })).rows.map((r) => String(r.name));
const tables = async (client: Client) =>
  (await client.execute("SELECT name FROM sqlite_master WHERE type IN ('table','trigger','index')")).rows.map((r) => String(r.name));

async function withFlag<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const before = process.env.V30_PRODUCTION_MODEL;
  if (value === undefined) delete process.env.V30_PRODUCTION_MODEL;
  else process.env.V30_PRODUCTION_MODEL = value;
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env.V30_PRODUCTION_MODEL;
    else process.env.V30_PRODUCTION_MODEL = before;
  }
}

test("creation is idempotent on an existing database: run twice, and again from a new connection", async () => {
  const m = await mods();
  const ws = workspace("idempotent");
  const client = await existingDatabase(ws);
  expect(await columns(client, "projects")).not.toContain("film_type");

  const store = new m.ProductionStepStore(client, ws.id, SYNTHETIC_ENV);
  await store.ready();
  await store.ready();
  // A second process: its own connection to the same file, so nothing is memoised.
  const again = new m.ProductionStepStore(m.createPlatformDatabaseClient({ url: ws.dbUrl }), ws.id, SYNTHETIC_ENV);
  await again.ready();

  const projectColumns = await columns(client, "projects");
  expect(projectColumns.filter((c) => c === "film_type" || c === "canvas_store")).toEqual(["film_type", "canvas_store"]);
  expect(await tables(client)).toEqual(expect.arrayContaining(["production_steps", "idx_production_steps_order", "production_steps_page_id_fixed"]));
  const before = (await client.execute("SELECT id,name,film_type,canvas_store FROM projects WHERE id='prj_one'")).rows[0];
  expect(before).toMatchObject({ id: "prj_one", name: "Existing", film_type: null, canvas_store: null });
  expect(m.canvasStoreOf(before.canvas_store)).toBe("team");
  await expect(client.execute("UPDATE projects SET canvas_store='other' WHERE id='prj_one'")).rejects.toThrow(/CHECK/i);

  // Giving a production its steps twice, or from two connections, makes one set.
  const first = await store.ensureSteps("prj_one", "synthetic_spot", "person_a");
  const second = await again.ensureSteps("prj_one", "synthetic_spot", "person_b");
  expect(second.map((s) => s.id)).toEqual(first.map((s) => s.id));
  expect(Number((await client.execute("SELECT COUNT(*) AS n FROM production_steps")).rows[0].n)).toBe(3);
  expect((await client.execute("SELECT film_type FROM projects WHERE id='prj_one'")).rows[0].film_type).toBe("synthetic_spot");
  await expect(store.ensureSteps("prj_one", "other_type", "person_a")).rejects.toMatchObject({ status: 400 });
  await expect(store.ensureSteps("prj_missing", "synthetic_spot", "person_a")).rejects.toMatchObject({ status: 404 });
});

test("page_id is stable across rename, reorder and removal, is never reused, and cannot be rewritten", async () => {
  const m = await mods();
  const ws = workspace("stable");
  const client = await existingDatabase(ws);
  const store = new m.ProductionStepStore(client, ws.id, SYNTHETIC_ENV);
  const steps = await store.ensureSteps("prj_one", "synthetic_spot", "person_a");
  expect(steps.map((s) => s.pageId)).toEqual(["brief", "frames_a", "frames_b"]);
  const pageOf = new Map(steps.map((s) => [s.id, s.pageId]));

  const renamed = await store.rename(steps[1].id, "  Renamed   frames  ");
  expect(renamed).toMatchObject({ label: "Renamed frames", pageId: "frames_a" });
  await expect(store.rename(steps[1].id, "")).rejects.toMatchObject({ status: 400 });

  const reordered = await store.reorder("prj_one", [steps[2].id, steps[0].id, steps[1].id]);
  for (const s of reordered) expect(s.pageId).toBe(pageOf.get(s.id));

  const removed = await store.remove(steps[2].id, "person_a");
  expect(removed).toMatchObject({ pageId: "frames_b", removedBy: "person_a" });
  expect((await store.list("prj_one")).map((s) => s.pageId)).toEqual(["brief", "frames_a"]);
  // A new step of a removed step's kind gets the next number, never the removed page id.
  const added = await store.add("prj_one", "frames_b", "person_a");
  expect(added.pageId).toBe("frames_b-2");
  await store.remove(added.id, "person_a");
  expect((await store.add("prj_one", "frames_b", "person_a")).pageId).toBe("frames_b-3");
  const restored = await store.restore(steps[2].id);
  expect(restored).toMatchObject({ pageId: "frames_b", removedAt: null, removedBy: null });
  expect(await store.byPageId("prj_one", "frames_a")).toMatchObject({ id: steps[1].id, label: "Renamed frames" });
  await expect(store.add("prj_one", "not_in_type", "person_a")).rejects.toMatchObject({ status: 400 });

  // The database itself refuses to move a page id, a kind or a step's production.
  await expect(client.execute({ sql: "UPDATE production_steps SET page_id='moved' WHERE id=?", args: [steps[0].id] })).rejects.toThrow(/keeps its page id/);
  await expect(client.execute({ sql: "UPDATE production_steps SET kind='script' WHERE id=?", args: [steps[0].id] })).rejects.toThrow(/keeps its page id/);
  await expect(client.execute({ sql: "UPDATE production_steps SET production_id='prj_other' WHERE id=?", args: [steps[0].id] })).rejects.toThrow(/keeps its page id/);
  await expect(client.execute({ sql: "INSERT INTO production_steps(workspace_id,id,production_id,page_id,kind,surface,label,position,frame_x,frame_y,frame_w,frame_h,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)", args: [ws.id, "dup", "prj_one", "brief", "brief", "document", "Again", 9, null, null, null, null, 1, 1] })).rejects.toThrow(/UNIQUE/i);
});

test("one frame per canvas step, none on a document step", async () => {
  const m = await mods();
  const ws = workspace("frames");
  const client = await existingDatabase(ws);
  const store = new m.ProductionStepStore(client, ws.id, SYNTHETIC_ENV);
  const steps = await store.ensureSteps("prj_one", "synthetic_spot", "person_a");
  expect(steps[0]).toMatchObject({ surface: "document", frame: null });
  const canvas = steps.filter((s) => s.surface === "canvas");
  expect(canvas).toHaveLength(2);
  for (const s of canvas) expect(s.frame && s.frame.w > 0 && s.frame.h > 0).toBe(true);
  expect(canvas[1].frame!.x).toBeGreaterThanOrEqual(canvas[0].frame!.x + canvas[0].frame!.w);

  const moved = await store.moveFrame(canvas[0].id, { x: -50, y: 25.5, w: 800, h: 450 });
  expect(moved.frame).toEqual({ x: -50, y: 25.5, w: 800, h: 450 });
  await expect(store.moveFrame(steps[0].id, { x: 0, y: 0, w: 10, h: 10 })).rejects.toMatchObject({ status: 409 });
  await expect(store.moveFrame(canvas[0].id, { x: 0, y: 0, w: 0, h: 10 })).rejects.toMatchObject({ status: 400 });
  await expect(store.moveFrame(canvas[0].id, { x: Number.NaN, y: 0, w: 10, h: 10 })).rejects.toMatchObject({ status: 400 });

  // The table holds it too: a canvas step without a frame, or a document step with one, is refused.
  const insert = (pageId: string, surface: string, frame: (number | null)[]) =>
    client.execute({ sql: "INSERT INTO production_steps(workspace_id,id,production_id,page_id,kind,surface,label,position,frame_x,frame_y,frame_w,frame_h,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)", args: [ws.id, pageId, "prj_one", pageId, "brief", surface, "x", 9, ...frame, 1, 1] });
  await expect(insert("canvas_no_frame", "canvas", [null, null, null, null])).rejects.toThrow(/CHECK/i);
  await expect(insert("document_framed", "document", [0, 0, 10, 10])).rejects.toThrow(/CHECK/i);
  await expect(client.execute({ sql: "UPDATE production_steps SET frame_w=NULL WHERE id=?", args: [canvas[1].id] })).rejects.toThrow(/CHECK/i);
});

test("steps come back in rail order; a reorder must name each live step once", async () => {
  const m = await mods();
  const ws = workspace("ordering");
  const client = await existingDatabase(ws);
  const store = new m.ProductionStepStore(client, ws.id, SYNTHETIC_ENV);
  const steps = await store.ensureSteps("prj_one", "synthetic_spot", "person_a");
  expect(steps.map((s) => [s.kind, s.position])).toEqual([["brief", 0], ["frames_a", 1], ["frames_b", 2]]);
  const [a, b, c] = steps.map((s) => s.id);

  expect((await store.reorder("prj_one", [c, a, b])).map((s) => s.id)).toEqual([c, a, b]);
  expect((await store.list("prj_one")).map((s) => [s.id, s.position])).toEqual([[c, 0], [a, 1], [b, 2]]);
  for (const bad of [[c, a], [c, a, a], [c, a, b, "pstep_other"], [c, a, "pstep_other"]])
    await expect(store.reorder("prj_one", bad)).rejects.toMatchObject({ status: 409 });
  expect((await store.list("prj_one")).map((s) => s.id)).toEqual([c, a, b]);

  // An added step goes to the end; a removed one leaves the order and is not in a reorder.
  const added = await store.add("prj_one", "frames_a", "person_a", "Second frames");
  expect((await store.list("prj_one")).map((s) => s.id)).toEqual([c, a, b, added.id]);
  await store.remove(a, "person_a");
  await expect(store.reorder("prj_one", [added.id, c, a, b])).rejects.toMatchObject({ status: 409 });
  expect((await store.reorder("prj_one", [added.id, c, b])).map((s) => s.id)).toEqual([added.id, c, b]);
  expect((await store.list("prj_one", { removed: true })).map((s) => s.id)).toContain(a);
});

test("the step list comes from config: the setting when set, else the flagged placeholder; no other file names a step list", async () => {
  const m = await mods();
  // Unset: the placeholder, flagged as one.
  const fallback = m.filmTypeConfig({});
  expect(fallback).toMatchObject({ source: "placeholder", placeholder: true });
  expect(fallback.filmTypes.map((t) => t.id)).toEqual(m.FILM_TYPES_PLACEHOLDER.filmTypes.map((t) => t.id));
  // Set: exactly the setting's list, and the store makes exactly those steps.
  expect(m.filmTypeConfig(SYNTHETIC_ENV)).toMatchObject({ source: "setting", placeholder: false });
  expect(m.filmTypeSteps(m.FILM_TYPES_PLACEHOLDER.filmTypes[0].id, SYNTHETIC_ENV)).toBeNull();
  const ws = workspace("config");
  const client = await existingDatabase(ws);
  const steps = await new m.ProductionStepStore(client, ws.id, SYNTHETIC_ENV).ensureSteps("prj_one", "synthetic_spot", "person_a");
  expect(steps.map((s) => ({ kind: s.kind, label: s.label, surface: s.surface }))).toEqual(SYNTHETIC_TYPES.filmTypes[0].steps);
  // A setting that is set but unreadable is refused, never swapped for the placeholder, and nothing is written.
  for (const bad of ["not json", JSON.stringify({ filmTypes: [] }), JSON.stringify({ filmTypes: [{ id: "Bad Id", label: "x", steps: [] }] }),
    JSON.stringify({ filmTypes: [SYNTHETIC_TYPES.filmTypes[0], SYNTHETIC_TYPES.filmTypes[0]] })]) {
    expect(() => m.filmTypeConfig({ V30_FILM_TYPES: bad })).toThrow(m.FilmTypeConfigError);
    await existingDatabase(ws, "prj_two");
    await expect(new m.ProductionStepStore(client, ws.id, { V30_FILM_TYPES: bad }).ensureSteps("prj_two", "synthetic_spot", "p")).rejects.toThrow(m.FilmTypeConfigError);
  }
  expect(Number((await client.execute("SELECT COUNT(*) AS n FROM production_steps WHERE production_id='prj_two'")).rows[0].n)).toBe(0);

  // The placeholder's id, and the list's setting name, live in the config file alone.
  const walk = (root: string): string[] =>
    readdirSync(root).flatMap((name) => {
      const full = path.join(root, name);
      if (statSync(full).isDirectory()) return name === "node_modules" ? [] : walk(full);
      return /\.(ts|tsx|mjs|js)$/.test(name) ? [full] : [];
    });
  const sources = ["lib", "app", "components"].flatMap(walk);
  const naming = (needle: string) => sources.filter((f) => readFileSync(f, "utf8").includes(needle));
  const config = path.join("lib", "productionModel", "filmTypes.ts");
  expect(naming(m.FILM_TYPES_PLACEHOLDER.filmTypes[0].id)).toEqual([config]);
  expect(naming(`"${m.FILM_TYPES_SETTING}"`)).toEqual([config]);
  // Nothing writes a step row but the store.
  expect(naming("INSERT INTO production_steps")).toEqual([path.join("lib", "productionModel", "steps.ts")]);
});

test("flag off: refused before the database is touched; nothing in the app reaches the store", async () => {
  const m = await mods();
  const house = workspace(HOUSE, "house-off");
  await existingDatabase(house);
  for (const value of [undefined, "", "0", "true", "on", " 1"]) {
    await withFlag(value, async () => {
      expect(m.productionModelSwitchOn()).toBe(false);
      expect(await m.productionModelOn(house)).toBe(false);
      await m.runInTenant(house, async () => {
        await expect(m.productionSteps()).rejects.toBeInstanceOf(m.ProductionModelOffError);
      });
    });
  }
  const client = m.tenantClient(house);
  expect(await columns(client, "projects")).not.toContain("film_type");
  expect(await columns(client, "projects")).not.toContain("canvas_store");
  expect((await tables(client)).filter((t) => t.includes("production_steps"))).toEqual([]);

  // Switch on: still off for a workspace without the new interface.
  await withFlag("1", async () => {
    expect(await m.productionModelOn(workspace("customer"))).toBe(false);
    expect(await m.productionModelOn(null)).toBe(false);
    expect(await m.productionModelOn(house)).toBe(true);
  });

  // No route, screen or component imports the production model yet (A1 adds no route and no behaviour).
  const walk = (root: string): string[] =>
    readdirSync(root).flatMap((name) => {
      const full = path.join(root, name);
      if (statSync(full).isDirectory()) return name === "node_modules" ? [] : walk(full);
      return /\.(ts|tsx|mjs|js)$/.test(name) ? [full] : [];
    });
  const importers = [...walk("app"), ...walk("components"), ...walk("lib").filter((f) => !f.startsWith(path.join("lib", "productionModel")))]
    .filter((f) => /productionModel\//.test(readFileSync(f, "utf8")));
  expect(importers).toEqual([]);
});

test("tenant isolation: workspace B cannot read or write workspace A's steps by id", async () => {
  const m = await mods();
  const a = workspace(HOUSE, "iso-a");
  const b = workspace("ws_b", "iso-b");
  const clientA = await existingDatabase(a, "prj_a");
  const clientB = await existingDatabase(b, "prj_b");
  // B is on the new interface too, through the platform owner's list, so both run through the real entry point.
  const { platformDb, platformReady } = await import("../../lib/platform");
  await platformReady();
  await platformDb().execute({ sql: "INSERT OR REPLACE INTO platform_layer(key,value,updated_at) VALUES('site',?,1)", args: [JSON.stringify({ newInterfaceWorkspaces: [b.id] })] });

  await withFlag("1", async () => {
    const prev = process.env.V30_FILM_TYPES;
    process.env.V30_FILM_TYPES = SYNTHETIC_ENV.V30_FILM_TYPES;
    try {
      const stepsA = await m.runInTenant(a, async () => {
        const store = await m.productionSteps();
        expect(store.workspaceId).toBe(a.id);
        return store.ensureSteps("prj_a", "synthetic_spot", "person_a");
      });
      const target = stepsA[1];
      await m.runInTenant(b, async () => {
        const store = await m.productionSteps();
        expect(store.workspaceId).toBe(b.id);
        // Written in A, invisible from B: the same answer as for a step or production that does not exist.
        expect(await store.get(target.id)).toBeNull();
        expect(await store.list("prj_a")).toEqual([]);
        expect(await store.byPageId("prj_a", target.pageId)).toBeNull();
        await expect(store.rename(target.id, "Taken")).rejects.toMatchObject({ status: 404, message: "That step is not in this workspace." });
        await expect(store.moveFrame(target.id, { x: 1, y: 1, w: 1, h: 1 })).rejects.toMatchObject({ status: 404 });
        await expect(store.remove(target.id, "person_b")).rejects.toMatchObject({ status: 404 });
        await expect(store.restore(target.id)).rejects.toMatchObject({ status: 404 });
        await expect(store.reorder("prj_a", stepsA.map((s) => s.id))).rejects.toMatchObject({ status: 404, message: "That project is not in this workspace." });
        await expect(store.ensureSteps("prj_a", "synthetic_spot", "person_b")).rejects.toMatchObject({ status: 404, message: "That project is not in this workspace." });
        await expect(store.add("prj_a", "frames_a", "person_b")).rejects.toMatchObject({ status: 404 });
        // B's own production works, in B's own database.
        expect(await store.ensureSteps("prj_b", "synthetic_spot", "person_b")).toHaveLength(3);
      });
    } finally {
      if (prev === undefined) delete process.env.V30_FILM_TYPES;
      else process.env.V30_FILM_TYPES = prev;
    }
  });
  expect(Number((await clientB.execute("SELECT COUNT(*) AS n FROM production_steps WHERE production_id='prj_a'")).rows[0].n)).toBe(0);

  // A store built for B but pointed at A's database still sees none of A's rows (every query filters on workspace_id).
  const crossed = new m.ProductionStepStore(clientA, b.id, SYNTHETIC_ENV);
  const [firstA] = (await clientA.execute("SELECT id FROM production_steps ORDER BY position LIMIT 1")).rows.map((r) => String(r.id));
  expect(await crossed.get(firstA)).toBeNull();
  expect(await crossed.list("prj_a")).toEqual([]);
  await expect(crossed.rename(firstA, "Crossed")).rejects.toMatchObject({ status: 404 });
  await expect(crossed.remove(firstA, "person_b")).rejects.toMatchObject({ status: 404 });
  const untouched = (await clientA.execute("SELECT label, removed_at, workspace_id FROM production_steps ORDER BY position")).rows;
  expect(untouched.map((r) => r.workspace_id)).toEqual([a.id, a.id, a.id]);
  expect(untouched.map((r) => r.removed_at)).toEqual([null, null, null]);
  expect(untouched.map((r) => r.label)).toEqual(SYNTHETIC_TYPES.filmTypes[0].steps.map((s) => s.label));
});
