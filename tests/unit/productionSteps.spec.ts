import { test, expect } from "@playwright/test";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
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
const fileOf = (name: string) => path.join(dir, name + ".db");
const workspace = (id: string, file = id) =>
  ({ id, name: id, slug: id, dbUrl: `file:${fileOf(file)}`, legacy: false, dbToken: null, keys: {}, usesPlatformKeys: true }) as unknown as TenantWorkspace;

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
    {
      id: "synthetic_short",
      label: "Synthetic short",
      steps: [
        { kind: "script", label: "Synthetic script", surface: "document" },
        { kind: "board", label: "Synthetic board", surface: "canvas" },
        { kind: "sheet", label: "Synthetic table", surface: "table" },
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
const count = async (client: Client, where = "1") =>
  Number((await client.execute(`SELECT COUNT(*) AS n FROM production_steps WHERE ${where}`)).rows[0].n);

/** Source files under a root. Never follows a symbolic link; node_modules and .git are skipped at any depth, and
 *  `skipHere` names directories skipped directly under this root only. */
const ALWAYS_SKIP = new Set(["node_modules", ".git"]);
const SOURCE = /\.(ts|tsx|mts|cts|mjs|cjs|js|jsx)$/;
const walk = (root: string, skipHere: ReadonlySet<string> = new Set()): string[] =>
  readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isSymbolicLink()) return [];
    const full = root === "." ? entry.name : path.join(root, entry.name);
    if (entry.isDirectory()) return ALWAYS_SKIP.has(entry.name) || skipHere.has(entry.name) ? [] : walk(full);
    return entry.isFile() && SOURCE.test(entry.name) ? [full] : [];
  });

async function withEnv<T>(name: string, value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const before = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env[name];
    else process.env[name] = before;
  }
}
const withFlag = <T>(value: string | undefined, fn: () => Promise<T>) => withEnv("V30_PRODUCTION_MODEL", value, fn);

test("creation is idempotent on an existing database: run twice, again through a second client object, and three at once", async () => {
  const m = await mods();
  const ws = workspace("idempotent");
  const client = await existingDatabase(ws);
  expect(await columns(client, "projects")).not.toContain("film_type");
  // A second client object on the same in-process connection (the local client is cached per file): ready()'s memo is
  // per client object, so through it every statement runs again on a database that already has them.
  const otherConnection = m.createPlatformDatabaseClient({ url: ws.dbUrl });
  try {
    await m.runInTenant(ws, async () => {
      const store = m.stepStoreForTests(client, ws.id, SYNTHETIC_ENV);
      const again = m.stepStoreForTests(otherConnection, ws.id, SYNTHETIC_ENV);
      await store.ready();
      await store.ready();
      await again.ready();

      const projectColumns = await columns(client, "projects");
      expect(projectColumns.filter((c) => c === "film_type" || c === "canvas_store")).toEqual(["film_type", "canvas_store"]);
      expect(await tables(client)).toEqual(expect.arrayContaining(["production_steps", "idx_production_steps_order", "production_steps_page_id_fixed"]));
      const before = (await client.execute("SELECT id,name,film_type,canvas_store FROM projects WHERE id='prj_one'")).rows[0];
      expect(before).toMatchObject({ id: "prj_one", name: "Existing", film_type: null, canvas_store: null });
      expect(m.canvasStoreOf(before.canvas_store)).toBe("team");
      await expect(client.execute("UPDATE projects SET canvas_store='other' WHERE id='prj_one'")).rejects.toThrow(/CHECK/i);

      // Three at once (two through one client object, one through the other), then once more: one set.
      const settled = await Promise.all([
        store.ensureSteps("prj_one", "synthetic_spot", "person_a"),
        store.ensureSteps("prj_one", "synthetic_spot", "person_b"),
        again.ensureSteps("prj_one", "synthetic_spot", "person_c"),
      ]);
      const ids = settled[0].map((s) => s.id);
      for (const result of settled) expect(result.map((s) => s.id)).toEqual(ids);
      expect((await store.ensureSteps("prj_one", "synthetic_spot", "person_a")).map((s) => s.id)).toEqual(ids);
      expect(await count(client)).toBe(3);
      expect((await client.execute("SELECT film_type FROM projects WHERE id='prj_one'")).rows[0].film_type).toBe("synthetic_spot");

      // Another film type on the list, for a production that already has one: refused, nothing written.
      await expect(store.ensureSteps("prj_one", "synthetic_short", "person_a")).rejects.toMatchObject({ status: 409 });
      expect(await count(client)).toBe(3);
      expect((await client.execute("SELECT film_type FROM projects WHERE id='prj_one'")).rows[0].film_type).toBe("synthetic_spot");
      await expect(store.ensureSteps("prj_one", "not_on_list", "person_a")).rejects.toMatchObject({ status: 400 });
      await expect(store.ensureSteps("prj_missing", "synthetic_spot", "person_a")).rejects.toMatchObject({ status: 404 });
    });
  } finally {
    otherConnection.close();
  }
});

test("page_id is stable across rename, reorder and removal, is never reused, and cannot be rewritten", async () => {
  const m = await mods();
  const ws = workspace("stable");
  const client = await existingDatabase(ws);
  await m.runInTenant(ws, async () => {
    const store = m.stepStoreForTests(client, ws.id, SYNTHETIC_ENV);
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
  });

  // The database itself refuses to move a page id, a kind or a step's production, and a second step with a used page id.
  const [first] = (await client.execute("SELECT id FROM production_steps WHERE page_id='brief'")).rows.map((r) => String(r.id));
  for (const set of ["page_id='moved'", "kind='script'", "production_id='prj_other'"])
    await expect(client.execute({ sql: `UPDATE production_steps SET ${set} WHERE id=?`, args: [first] })).rejects.toThrow(/keeps its page id/);
  await expect(client.execute({ sql: "INSERT INTO production_steps(workspace_id,id,production_id,page_id,kind,surface,label,position,frame_x,frame_y,frame_w,frame_h,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)", args: [ws.id, "dup", "prj_one", "brief", "brief", "document", "Again", 9, null, null, null, null, 1, 1] })).rejects.toThrow(/UNIQUE/i);
});

test("one frame per canvas step, none on a document or table step", async () => {
  const m = await mods();
  const ws = workspace("frames");
  const client = await existingDatabase(ws);
  await existingDatabase(ws, "prj_two");
  const canvas = await m.runInTenant(ws, async () => {
    const store = m.stepStoreForTests(client, ws.id, SYNTHETIC_ENV);
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

    // A table step (Deliver's surface) has no frame either.
    const short = await store.ensureSteps("prj_two", "synthetic_short", "person_a");
    expect(short.map((s) => [s.surface, s.frame === null])).toEqual([["document", true], ["canvas", false], ["table", true]]);
    await expect(store.moveFrame(short[2].id, { x: 0, y: 0, w: 10, h: 10 })).rejects.toMatchObject({ status: 409, message: "Only a canvas step has a frame." });
    return canvas;
  });

  // The table holds it too: a canvas step without a frame, or a document or table step with one, is refused.
  const insert = (pageId: string, surface: string, frame: (number | null)[]) =>
    client.execute({ sql: "INSERT INTO production_steps(workspace_id,id,production_id,page_id,kind,surface,label,position,frame_x,frame_y,frame_w,frame_h,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)", args: [ws.id, pageId, "prj_one", pageId, "brief", surface, "x", 9, ...frame, 1, 1] });
  await expect(insert("canvas_no_frame", "canvas", [null, null, null, null])).rejects.toThrow(/CHECK/i);
  await expect(insert("document_framed", "document", [0, 0, 10, 10])).rejects.toThrow(/CHECK/i);
  await expect(insert("table_framed", "table", [0, 0, 10, 10])).rejects.toThrow(/CHECK/i);
  await expect(insert("table_half_framed", "table", [0, null, null, null])).rejects.toThrow(/CHECK/i);
  await expect(insert("other_surface", "wall", [null, null, null, null])).rejects.toThrow(/CHECK/i);
  await expect(client.execute({ sql: "UPDATE production_steps SET frame_w=NULL WHERE id=?", args: [canvas[1].id] })).rejects.toThrow(/CHECK/i);
});

test("steps come back in rail order; a reorder must name each live step once; a restored step goes to the end", async () => {
  const m = await mods();
  const ws = workspace("ordering");
  const client = await existingDatabase(ws);
  await existingDatabase(ws, "prj_two");
  await m.runInTenant(ws, async () => {
    const store = m.stepStoreForTests(client, ws.id, SYNTHETIC_ENV);
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

    // Remove a, reorder [c, b], restore a: a comes back after every live step, never tied with one.
    const [a2, b2, c2] = (await store.ensureSteps("prj_two", "synthetic_spot", "person_a")).map((s) => s.id);
    await store.remove(a2, "person_a");
    await store.reorder("prj_two", [c2, b2]);
    expect((await store.restore(a2)).position).toBe(2);
    expect((await store.list("prj_two")).map((s) => [s.id, s.position])).toEqual([[c2, 0], [b2, 1], [a2, 2]]);
    // Restoring a step that is not removed changes nothing.
    expect((await store.restore(c2)).position).toBe(0);
  });
});

test("the step list comes from config: the setting when set, else the owner's default; the default's ids and the setting's name appear only in the config file, and only the store writes step rows", async () => {
  const m = await mods();
  // Unset: the owner's default.
  const fallback = m.filmTypeConfig({});
  expect(fallback.source).toBe("default");
  expect(fallback.filmTypes.map((t) => t.id)).toEqual(m.FILM_TYPES_DEFAULT.filmTypes.map((t) => t.id));
  // Set: exactly the setting's list, and the store makes exactly those steps.
  expect(m.filmTypeConfig(SYNTHETIC_ENV).source).toBe("setting");
  expect(m.filmTypeSteps("ad_film", SYNTHETIC_ENV)).toBeNull();
  expect(m.filmTypeSteps("synthetic_spot", {})).toBeNull();
  const spaced = { filmTypes: [{ id: "spaced", label: "  Two   words ", steps: [{ kind: "brief", label: " A \n brief ", surface: "document" }] }] };
  expect(m.filmTypeConfig({ V30_FILM_TYPES: JSON.stringify(spaced) }).filmTypes[0]).toMatchObject({ label: "Two words", steps: [{ label: "A brief" }] });
  const ws = workspace("config");
  const client = await existingDatabase(ws);
  await existingDatabase(ws, "prj_two");
  await m.runInTenant(ws, async () => {
    const steps = await m.stepStoreForTests(client, ws.id, SYNTHETIC_ENV).ensureSteps("prj_one", "synthetic_spot", "person_a");
    expect(steps.map((s) => ({ kind: s.kind, label: s.label, surface: s.surface }))).toEqual(SYNTHETIC_TYPES.filmTypes[0].steps);

    // A setting that is set but unreadable is refused, never swapped for the default, and nothing is written.
    // The error says where (the issue's path), never what the setting holds.
    const SECRET = "synthetic-value-never-echoed";
    const one = SYNTHETIC_TYPES.filmTypes[0];
    const cases: [string, string | null][] = [
      [SECRET, null],
      [JSON.stringify({ filmTypes: [] }), "filmTypes"],
      [JSON.stringify({ filmTypes: [{ id: SECRET, label: "x", steps: [] }] }), "filmTypes.0.id"],
      [JSON.stringify({ filmTypes: [{ ...one, steps: [{ kind: "brief", label: "x", surface: SECRET }] }] }), "filmTypes.0.steps.0.surface"],
      [JSON.stringify({ filmTypes: [one], [SECRET]: true }), "(root)"],
      [JSON.stringify({ filmTypes: [{ ...one, [SECRET]: 1 }] }), "filmTypes.0"],
      [JSON.stringify({ filmTypes: [one, one] }), "filmTypes.1"],
      [JSON.stringify({ filmTypes: [{ ...one, steps: [one.steps[0], { ...one.steps[1], kind: one.steps[0].kind }] }] }), "filmTypes.0.steps.1.kind"],
      // The retired placeholder flag is not part of the shape any more.
      [JSON.stringify({ placeholder: true, filmTypes: [one] }), "(root)"],
    ];
    for (const [bad, where] of cases) {
      let error: unknown = null;
      try {
        m.filmTypeConfig({ V30_FILM_TYPES: bad });
      } catch (e) {
        error = e;
      }
      expect(error, bad).toBeInstanceOf(m.FilmTypeConfigError);
      expect((error as InstanceType<typeof m.FilmTypeConfigError>).path, bad).toBe(where);
      expect((error as Error).message).not.toContain(SECRET);
      await expect(m.stepStoreForTests(client, ws.id, { V30_FILM_TYPES: bad }).ensureSteps("prj_two", "synthetic_spot", "p")).rejects.toThrow(m.FilmTypeConfigError);
    }
  });
  expect(await count(client, "production_id='prj_two'")).toBe(0);

  const sources = ["lib", "app", "components"].flatMap((root) => walk(root));
  const naming = (needle: string) => sources.filter((f) => readFileSync(f, "utf8").includes(needle));
  const config = path.join("lib", "productionModel", "filmTypes.ts");
  // The default's distinctive ids (the plain-word ones, such as feature or social, are ordinary words elsewhere).
  for (const id of ["ad_film", "short_film", "music_video", "microdrama", "pre_vis", "trend_clip"]) expect(naming(id), id).toEqual([config]);
  expect(naming(`"${m.FILM_TYPES_SETTING}"`)).toEqual([config]);
  expect(naming("INSERT INTO production_steps")).toEqual([path.join("lib", "productionModel", "steps.ts")]);
});

/* The owner's film types and steps, exactly as he gave them (17 Oct 2026). */
const OWNER_TABLE: [string, string, string[]][] = [
  ["ad_film", "Ad film", ["Pitch deck", "Brief", "Script", "Breakdown", "Look", "Elements", "Storyboard", "Shots", "Edit", "Deliver"]],
  ["feature", "Feature", ["Brief", "Script", "Breakdown", "Look", "Elements", "Storyboard", "Shots", "Edit", "Deliver"]],
  ["short_film", "Short film", ["Brief", "Script", "Breakdown", "Look", "Elements", "Storyboard", "Sound", "Shots", "Edit", "Deliver"]],
  ["ugc", "UGC", ["Brief", "Creator", "Hook", "Script", "Shots", "Captions", "Deliver"]],
  ["product_video", "Product video", ["Brief", "Product", "Look", "Storyboard", "Shots", "Edit", "Deliver"]],
  ["music_video", "Music video", ["Track", "Beat map", "Look", "Elements", "Storyboard", "Animatic", "Shots", "Edit", "Deliver"]],
  ["microdrama", "Microdrama", ["Series bible", "Episodes", "Elements", "Storyboard", "Shots", "Edit", "Deliver"]],
  ["pre_vis", "Pre-vis", ["Brief", "Breakdown", "Set map", "Elements", "Storyboard", "Animatic", "Shots", "Handoff"]],
  ["trend_clip", "Trend clip", ["Source", "Format breakdown", "Swap-ins", "Copy", "Shots", "Captions", "Deliver"]],
  ["social", "Social", ["Deliverables", "Hook", "Copy", "Design", "Visuals", "Captions", "Deliver"]],
];
/* Written out here, not derived, so a change to how the config makes kinds is caught. */
const KINDS: Record<string, string> = {
  "Pitch deck": "pitch_deck", "Beat map": "beat_map", "Series bible": "series_bible", "Set map": "set_map",
  "Format breakdown": "format_breakdown", "Swap-ins": "swap_ins",
};
const SURFACES: Record<string, string> = { Brief: "document", Script: "document", Deliver: "table" };

test("the default is the owner's ten film types, each with exactly his steps in his order: Brief and Script documents, Deliver a table, the rest canvas", async () => {
  const m = await mods();
  const config = m.filmTypeConfig({});
  expect(config.filmTypes).toHaveLength(10);
  expect(config.filmTypes.map((t) => ({ id: t.id, label: t.label, steps: t.steps }))).toEqual(
    OWNER_TABLE.map(([id, label, steps]) => ({
      id,
      label,
      steps: steps.map((step) => ({ kind: KINDS[step] ?? step.toLowerCase(), label: step, surface: SURFACES[step] ?? "canvas" })),
    })),
  );
  for (const type of config.filmTypes) {
    expect(new Set(type.steps.map((s) => s.kind)).size, type.id).toBe(type.steps.length);
    for (const s of type.steps) expect(s.kind).toMatch(m.STEP_KIND);
  }
  // Through the store, with no setting: one type's steps, frames only on its canvas steps, page ids from the kinds.
  const ws = workspace("owner-default");
  const client = await existingDatabase(ws);
  await m.runInTenant(ws, async () => {
    const steps = await m.stepStoreForTests(client, ws.id, {}).ensureSteps("prj_one", "ad_film", "person_a");
    expect(steps.map((s) => s.pageId)).toEqual(["pitch_deck", "brief", "script", "breakdown", "look", "elements", "storyboard", "shots", "edit", "deliver"]);
    expect(steps.filter((s) => s.frame === null).map((s) => [s.label, s.surface])).toEqual([["Brief", "document"], ["Script", "document"], ["Deliver", "table"]]);
    expect(steps.filter((s) => s.frame !== null)).toHaveLength(7);
  });
});

test("flag off: refused before the workspace database is opened; nothing in the app reaches the store or the test-only builder", async () => {
  const m = await mods();
  // A workspace whose database file does not exist yet: with the flag off, the entry point never creates or opens it.
  const fresh = workspace(HOUSE, "house-never-opened");
  // One that exists already: it gains no column, table, index or trigger.
  const existing = workspace(HOUSE, "house-off");
  await existingDatabase(existing);
  for (const value of [undefined, "", "0", "true", "on", " 1"]) {
    await withFlag(value, async () => {
      expect(m.productionModelSwitchOn()).toBe(false);
      expect(await m.productionModelOn(fresh)).toBe(false);
      for (const ws of [fresh, existing])
        await m.runInTenant(ws, async () => {
          await expect(m.productionSteps()).rejects.toBeInstanceOf(m.ProductionModelOffError);
        });
    });
  }
  expect(existsSync(fileOf("house-never-opened"))).toBe(false);
  const client = m.tenantClient(existing);
  expect(await columns(client, "projects")).not.toContain("film_type");
  expect(await columns(client, "projects")).not.toContain("canvas_store");
  expect((await tables(client)).filter((t) => t.includes("production_steps"))).toEqual([]);

  // Switch on: still off for a workspace without the new interface.
  await withFlag("1", async () => {
    expect(await m.productionModelOn(workspace("customer"))).toBe(false);
    expect(await m.productionModelOn(null)).toBe(false);
    expect(await m.productionModelOn(fresh)).toBe(true);
  });

  // The test-only builder: no source file in the repository, outside tests/ and build output, names it but the store's own
  // (lib/, app/, components/, scripts/, mcp/, ops/, remotion/, proxy.ts, instrumentation.ts, configs: everything).
  const ROOT_SKIP = new Set([".next", ".claude", "tests", "test-results", "coverage", "out", "build", "dist", ".vercel", ".data"]);
  const vendor = path.join("public", "vendor") + path.sep;
  const scanned = walk(".", ROOT_SKIP).filter((f) => !f.startsWith(vendor));
  for (const covered of ["proxy.ts", "instrumentation.ts", path.join("scripts", "ci-select.mjs")]) expect(scanned).toContain(covered);
  expect(scanned.some((f) => f.startsWith("mcp" + path.sep))).toBe(true);
  const builder = scanned.filter((f) => readFileSync(f, "utf8").includes("stepStoreForTests"));
  expect(builder).toEqual([path.join("lib", "productionModel", "steps.ts")]);
  // The store class itself is not exported under any name: the factory (db() with requireTenant().id) is the only way in.
  // By identity, so a rename, an alias or a default export is caught; then, as a second layer, by the file's text.
  const StoreClass = m.stepStoreForTests(client, "ws_identity_probe").constructor;
  const stepsModule: Record<string, unknown> = await import("../../lib/productionModel/steps");
  expect(Object.values(stepsModule)).not.toContain(StoreClass);
  const stepsSource = readFileSync(path.join("lib", "productionModel", "steps.ts"), "utf8");
  // The only class the file exports is its error; the store's class is never on the list.
  expect([...stepsSource.matchAll(/export\s+(?:default\s+)?(?:abstract\s+)?class\s+(\w+)/g)].map((x) => x[1])).toEqual(["ProductionStepError"]);
  expect(stepsSource).not.toMatch(/export\s*\{[^}]*\bStepStore\b/);
  expect(stepsSource).not.toMatch(/export\s+default\b/);

  // No route, screen or component imports the production model yet (A1 adds no route and no behaviour).
  const importers = [...walk("app"), ...walk("components"), ...walk("lib").filter((f) => !f.startsWith(path.join("lib", "productionModel")))]
    .filter((f) => /productionModel/.test(readFileSync(f, "utf8")));
  expect(importers).toEqual([]);
});

test("tenant isolation: workspace B cannot read or write workspace A's steps by id, even through a store pointed at A's database", async () => {
  const m = await mods();
  const a = workspace(HOUSE, "iso-a");
  const b = workspace("ws_b", "iso-b");
  const clientA = await existingDatabase(a, "prj_a");
  const clientB = await existingDatabase(b, "prj_b");

  // B is on the new interface too, through the platform owner's list: merged into the site row, restored afterwards.
  const { platformDb, platformReady } = await import("../../lib/platform");
  await platformReady();
  const previous = (await platformDb().execute("SELECT value, updated_at, updated_by FROM platform_layer WHERE key='site'")).rows[0];
  const site = previous ? (JSON.parse(String(previous.value)) as Record<string, unknown>) : {};
  const listed = Array.isArray(site.newInterfaceWorkspaces) ? (site.newInterfaceWorkspaces as string[]) : [];
  await platformDb().execute({
    sql: `INSERT INTO platform_layer(key,value,updated_at,updated_by) VALUES('site',?,?,'test')
          ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at, updated_by=excluded.updated_by`,
    args: [JSON.stringify({ ...site, newInterfaceWorkspaces: [b.id, ...listed.filter((id) => id !== b.id)] }), Date.now()],
  });

  try {
    await withFlag("1", () =>
      withEnv("V30_FILM_TYPES", SYNTHETIC_ENV.V30_FILM_TYPES, async () => {
        const stepsA = await m.runInTenant(a, async () => {
          const store = await m.productionSteps();
          expect(store.workspaceId).toBe(a.id);
          const made = await store.ensureSteps("prj_a", "synthetic_spot", "person_a");
          await store.remove(made[2].id, "person_a");
          return made;
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
          await expect(store.restore(stepsA[2].id)).rejects.toMatchObject({ status: 404 });
          await expect(store.reorder("prj_a", stepsA.map((s) => s.id))).rejects.toMatchObject({ status: 404, message: "That project is not in this workspace." });
          await expect(store.ensureSteps("prj_a", "synthetic_spot", "person_b")).rejects.toMatchObject({ status: 404, message: "That project is not in this workspace." });
          await expect(store.add("prj_a", "frames_a", "person_b")).rejects.toMatchObject({ status: 404 });
          // B's own production works, in B's own database.
          expect(await store.ensureSteps("prj_b", "synthetic_spot", "person_b")).toHaveLength(3);
        });
      }),
    );
  } finally {
    if (previous)
      await platformDb().execute({ sql: "UPDATE platform_layer SET value=?, updated_at=?, updated_by=? WHERE key='site'", args: [previous.value, previous.updated_at, previous.updated_by] });
    else await platformDb().execute("DELETE FROM platform_layer WHERE key='site'");
  }
  expect(await count(clientB, "production_id='prj_a'")).toBe(0);

  const snapshot = async () => ({
    steps: (await clientA.execute("SELECT * FROM production_steps ORDER BY id")).rows.map((r) => ({ ...r })),
    project: (await clientA.execute("SELECT film_type, canvas_store FROM projects WHERE id='prj_a'")).rows.map((r) => ({ ...r })),
  });
  const before = await snapshot();
  expect(before.project).toEqual([{ film_type: "synthetic_spot", canvas_store: null }]);
  const [live, , removed] = (await clientA.execute("SELECT id, page_id FROM production_steps ORDER BY position")).rows.map((r) => ({ id: String(r.id), pageId: String(r.page_id) }));

  // A store built for B but pointed at A's database: in B's scope it sees none of A's rows and writes nothing.
  const crossed = m.stepStoreForTests(clientA, b.id, SYNTHETIC_ENV);
  await m.runInTenant(b, async () => {
    expect(await crossed.get(live.id)).toBeNull();
    expect(await crossed.list("prj_a")).toEqual([]);
    expect(await crossed.byPageId("prj_a", live.pageId)).toBeNull();
    await expect(crossed.rename(live.id, "Crossed")).rejects.toMatchObject({ status: 404 });
    await expect(crossed.remove(live.id, "person_b")).rejects.toMatchObject({ status: 404 });
    await expect(crossed.moveFrame(live.id, { x: 9, y: 9, w: 9, h: 9 })).rejects.toMatchObject({ status: 404 });
    await expect(crossed.restore(removed.id)).rejects.toMatchObject({ status: 404 });
    await expect(crossed.ensureSteps("prj_a", "synthetic_spot", "person_b")).rejects.toMatchObject({ status: 404, message: "That project is not in this workspace." });
    await expect(crossed.ensureSteps("prj_a", "synthetic_short", "person_b")).rejects.toMatchObject({ status: 404 });
    await expect(crossed.add("prj_a", "frames_a", "person_b")).rejects.toMatchObject({ status: 404 });
    await expect(crossed.reorder("prj_a", [])).rejects.toMatchObject({ status: 404 });
  });
  // In A's scope, a store for B answers nothing at all: its workspace is not the one in scope.
  await m.runInTenant(a, async () => {
    await expect(crossed.list("prj_a")).rejects.toMatchObject({ status: 403 });
    await expect(crossed.get(live.id)).rejects.toMatchObject({ status: 403 });
    await expect(crossed.ensureSteps("prj_a", "synthetic_spot", "person_b")).rejects.toMatchObject({ status: 403 });
  });
  // Outside any workspace, nothing runs.
  await expect(crossed.list("prj_a")).rejects.toBeInstanceOf(m.NoTenantError);
  // A's steps and A's production, film type included, are exactly as they were.
  expect(await snapshot()).toEqual(before);
});
