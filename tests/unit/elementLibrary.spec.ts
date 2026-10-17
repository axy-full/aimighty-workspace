import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import { createClient, type Client, type InStatement } from "@libsql/client";
import type { TenantWorkspace } from "../../lib/tenant";
import {
  HANDLE_PATTERN, LOOK_LIBRARY_KIND, assignHandles, compatKindOf, cropDerivation, handleBase, isHandle,
  isReservedHandle, libraryKindOf, originOf, withSuffix,
} from "../../lib/elementLibrary";

/**
 * v30 Library columns and @handles (docs/plans/v30-data-model.md § 6, PR A5).
 *
 * The hard rule: how `@Name` resolves in a prompt does not change at all. The same prompts over the same rosters expand
 * to byte-identical output before and after the backfill, and Rig reads every element exactly as before.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-element-library-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";

const workspace = (id: string): TenantWorkspace =>
  ({ id, name: id, slug: id, legacy: false, dbUrl: `file:${path.join(dir, `${id}.db`)}`, dbToken: null, keys: {}, usesPlatformKeys: false }) as TenantWorkspace;

/** The cast token grammar, copied from lib/cast.ts › expandCast. */
const CAST_TOKEN = /@([A-Za-z][A-Za-z0-9_]{0,31})/g;
const readWhole = (handle: string) => [...`@${handle} next`.matchAll(CAST_TOKEN)].map((m) => m[1]);

test.describe.configure({ mode: "serial" });

test("handles fit the cast's token grammar, whatever the name", () => {
  expect(handleBase("Maya", "character")).toBe("maya");
  expect(handleBase("Zoë Saldaña", "character")).toBe("zoe_saldana");
  expect(handleBase("  Zoë's   Car!! ", "prop")).toBe("zoe_s_car");
  expect(handleBase("1920s Radio", "prop")).toBe("prop_1920s_radio");
  expect(handleBase("माया", "character")).toBe("character");
  expect(handleBase("!!!", "environment")).toBe("environment");
  expect(handleBase("", "audio")).toBe("audio");
  expect(handleBase("maya-2", "character")).toBe("maya_2");
  expect(handleBase("The Extraordinarily Long Character Name Of Doom", "character")).toBe("the_extraordinarily_long_charact");
  // A cut never leaves an underscore at the end.
  expect(handleBase("abcdefghijklmnopqrstuvwxyz abcde fgh", "character")).toBe("abcdefghijklmnopqrstuvwxyz_abcde");
  expect(handleBase("abcdefghijklmnopqrstuvwxyz_abcd efgh", "character")).toBe("abcdefghijklmnopqrstuvwxyz_abcd");

  // The 32-character limit holds with the suffix on.
  const long = "a".repeat(32);
  expect(withSuffix(long, 2)).toBe("a".repeat(30) + "_2");
  expect(withSuffix(long, 10)).toBe("a".repeat(29) + "_10");
  expect(withSuffix(long, 123)).toBe("a".repeat(28) + "_123");
  expect(withSuffix("a".repeat(29) + "_bc", 2)).toBe("a".repeat(29) + "_2");

  // The engines' own citations are never handles.
  for (const h of ["image", "image1", "video12", "audio", "audio3", "IMAGE2"]) expect(isReservedHandle(h)).toBe(true);
  for (const h of ["imagery", "image_2", "videos", "audio_2", "maya"]) expect(isReservedHandle(h)).toBe(false);

  const names = ["Maya", "Zoë's Car", "1920s Radio", "माया", "!!!", "x".repeat(80), "Image2", "Video", "Audio1", "maya_2", "MAYA", "9", "_lead_"];
  const handles = assignHandles(names.map((name, i) => ({ id: `e${i}`, name, libraryKind: "character" as const })), []);
  for (const h of handles.values()) {
    expect(h.length).toBeLessThanOrEqual(32);
    expect(h).toMatch(HANDLE_PATTERN);
    expect(isHandle(h)).toBe(true);
    // Read whole as one @token by the cast's own grammar: nothing is left over for a second token.
    expect(readWhole(h)).toEqual([h]);
  }
  expect(new Set(handles.values()).size).toBe(names.length);
  expect(handles.get("e6")).toBe("image2_2");
  expect(handles.get("e7")).toBe("video_2");
  expect(handles.get("e8")).toBe("audio1_2");
  expect(handles.get("e11")).toBe("character_9");
  expect(handles.get("e12")).toBe("lead");
});

test("collisions: the first holder keeps the base, later ones count up, and taken handles are never reissued", () => {
  const c = (id: string, name: string) => ({ id, name, libraryKind: "character" as const });
  const first = assignHandles([c("a", "Maya"), c("b", "maya"), c("c", "MAYA"), c("d", "Maya!")], []);
  expect([...first.values()]).toEqual(["maya", "maya_2", "maya_3", "maya_4"]);

  // A name that is already a suffixed handle takes its own base; the counter steps over it.
  const mixed = assignHandles([c("a", "Maya"), c("b", "maya_2"), c("c", "Maya")], []);
  expect([...mixed.values()]).toEqual(["maya", "maya_2", "maya_3"]);

  // Handles already in the workspace are taken, case-blind, and assignHandles changes none of them.
  const taken = ["MAYA", "maya_2"];
  const later = assignHandles([c("x", "Maya")], taken);
  expect(later.get("x")).toBe("maya_3");
  expect(taken).toEqual(["MAYA", "maya_2"]);

  // Long names that share their first 32 characters stay distinct and within 32.
  const longName = "The Extraordinarily Long Character Name Of Doom";
  const longs = assignHandles(Array.from({ length: 12 }, (_, i) => c(`l${i}`, longName)), []);
  const values = [...longs.values()];
  expect(values[0]).toBe("the_extraordinarily_long_charact");
  expect(values[1]).toBe("the_extraordinarily_long_chara_2");
  expect(values[9]).toBe("the_extraordinarily_long_char_10");
  expect(new Set(values).size).toBe(12);
  for (const v of values) expect(v.length).toBeLessThanOrEqual(32);
});

test("kinds: today's kinds map to the v30 kinds; the look target is the one named value", () => {
  expect(libraryKindOf("character")).toBe("character");
  expect(libraryKindOf("location")).toBe("environment");
  expect(libraryKindOf("prop")).toBe("prop");
  expect(libraryKindOf("voice")).toBe("audio");
  expect(libraryKindOf("look")).toBe(LOOK_LIBRARY_KIND);
  expect(libraryKindOf("style")).toBe(LOOK_LIBRARY_KIND);
  // Owner question Q8: reference (the plan's proposal) or wardrobe.
  expect(["reference", "wardrobe"]).toContain(LOOK_LIBRARY_KIND);
  // A kind nobody knows reads as a character, as Rig reads it.
  expect(libraryKindOf("spaceship")).toBe("character");
  // Back to today's kinds, for anything a v30 writer makes.
  for (const k of ["character", "location", "prop", "voice"]) expect(compatKindOf(libraryKindOf(k))).toBe(k);
  expect(compatKindOf("reference")).toBe("look");
  for (const k of ["wardrobe", "brand", "product"] as const) expect(compatKindOf(k)).toBe("prop");
});

test("origin and the crop columns", () => {
  expect(originOf("gen_1", { uploadId: "u", genId: null, identityId: null })).toBe("generated");
  expect(originOf(null, { uploadId: "u", genId: null, identityId: null })).toBe("uploaded");
  expect(originOf(null, { uploadId: null, genId: "g", identityId: null })).toBe("generated");
  expect(originOf(null, { uploadId: null, genId: null, identityId: "i" })).toBe("generated");
  expect(originOf(null, null)).toBe("uploaded");

  const sha = "ab".repeat(32);
  const crop = cropDerivation({ fromUpload: "up_1", x: 10, y: 20, w: 300, h: 200, sourceSha256: sha });
  expect(crop).toEqual({ derived_from_upload: "up_1", derived_from_gen: null, derivation: JSON.stringify({ op: "crop", x: 10, y: 20, w: 300, h: 200, source_sha256: sha }) });
  expect(cropDerivation({ fromGen: "gen_1", x: 0, y: 0, w: 1, h: 1, sourceSha256: sha }).derived_from_gen).toBe("gen_1");
  expect(() => cropDerivation({ fromUpload: "up_1", fromGen: "gen_1", x: 0, y: 0, w: 1, h: 1, sourceSha256: sha })).toThrow(/exactly one/);
  expect(() => cropDerivation({ x: 0, y: 0, w: 1, h: 1, sourceSha256: sha })).toThrow(/exactly one/);
  expect(() => cropDerivation({ fromUpload: "up_1", x: 0, y: 0, w: 0, h: 1, sourceSha256: sha })).toThrow(/whole pixels/);
  expect(() => cropDerivation({ fromUpload: "up_1", x: 1.5, y: 0, w: 1, h: 1, sourceSha256: sha })).toThrow(/whole pixels/);
  expect(() => cropDerivation({ fromUpload: "up_1", x: 0, y: 0, w: 1, h: 1, sourceSha256: "nope" })).toThrow(/SHA-256/);
});

/* ── The database ─────────────────────────────────────────────────────── */

type Seed = { id: string; project: string | null; kind: string; name: string; at: number; castId?: string; fromGen?: string; first?: { upload?: string; gen?: string; identity?: string } };

const SEEDS: Seed[] = [
  { id: "el_maya1", project: "p1", kind: "character", name: "Maya", at: 10, castId: "c_maya1" },
  { id: "el_rex", project: "p1", kind: "character", name: "Rex", at: 11, castId: "c_rex" },
  { id: "el_maya2", project: "p2", kind: "character", name: "Maya", at: 12, castId: "c_maya2" },
  { id: "el_car", project: "p1", kind: "prop", name: "Zoë's Car", at: 13, fromGen: "gen_car" },
  { id: "el_radio", project: "p2", kind: "prop", name: "1920s Radio", at: 14, first: { upload: "up_radio" } },
  { id: "el_maya3", project: "p3", kind: "character", name: "Maya", at: 15, first: { identity: "id_maya" } },
  { id: "el_long1", project: "p1", kind: "look", name: "The Extraordinarily Long Character Name Of Doom", at: 16, first: { gen: "gen_long" } },
  { id: "el_long2", project: "p2", kind: "look", name: "The Extraordinarily Long Character Name Of Doom", at: 17 },
  { id: "el_image2", project: "p1", kind: "prop", name: "Image2", at: 18 },
  { id: "el_hindi", project: "p3", kind: "character", name: "माया", at: 19 },
  { id: "el_odd", project: "p3", kind: "spaceship", name: "Ship", at: 20 },
  // Workspace-wide, made later than the production ones, and still first in line for a handle.
  { id: "el_harbour", project: null, kind: "location", name: "Harbour", at: 50, castId: "c_harbour" },
  { id: "el_noir", project: null, kind: "look", name: "Noir", at: 60, castId: "c_noir" },
  { id: "el_narrator", project: null, kind: "voice", name: "Narrator", at: 70 },
  { id: "el_rexprop", project: null, kind: "prop", name: "Rex", at: 80 },
];

const EXPECTED: Record<string, { handle: string; library_kind: string; origin: string }> = {
  el_harbour: { handle: "harbour", library_kind: "environment", origin: "uploaded" },
  el_noir: { handle: "noir", library_kind: LOOK_LIBRARY_KIND, origin: "uploaded" },
  el_narrator: { handle: "narrator", library_kind: "audio", origin: "uploaded" },
  el_rexprop: { handle: "rex", library_kind: "prop", origin: "uploaded" },
  el_maya1: { handle: "maya", library_kind: "character", origin: "uploaded" },
  el_rex: { handle: "rex_2", library_kind: "character", origin: "uploaded" },
  el_maya2: { handle: "maya_2", library_kind: "character", origin: "uploaded" },
  el_car: { handle: "zoe_s_car", library_kind: "prop", origin: "generated" },
  el_radio: { handle: "prop_1920s_radio", library_kind: "prop", origin: "uploaded" },
  el_maya3: { handle: "maya_3", library_kind: "character", origin: "generated" },
  el_long1: { handle: "the_extraordinarily_long_charact", library_kind: LOOK_LIBRARY_KIND, origin: "generated" },
  el_long2: { handle: "the_extraordinarily_long_chara_2", library_kind: LOOK_LIBRARY_KIND, origin: "uploaded" },
  el_image2: { handle: "image2_2", library_kind: "prop", origin: "uploaded" },
  el_hindi: { handle: "character", library_kind: "character", origin: "uploaded" },
  el_odd: { handle: "ship", library_kind: "character", origin: "uploaded" },
};

async function seed(seeds: Seed[] = SEEDS) {
  const { db, ready } = await import("../../lib/db");
  await ready();
  for (const p of ["p1", "p2", "p3"]) await db().execute({ sql: `INSERT OR IGNORE INTO projects (id, name, created_at) VALUES (?,?,0)`, args: [p, p] });
  /* The cast @Name resolves against (lib/cast.ts), with stills and descriptions. */
  const cast: [string, string | null, string, string, string, string | null][] = [
    ["c_maya1", "p1", "Maya", "character", "Lead, red coat.", "up_maya1"],
    ["c_rex", "p1", "Rex", "character", "A grey dog.", null],
    ["c_maya2", "p2", "Maya", "character", "", "up_maya2"],
    ["c_harbour", null, "Harbour", "location", "Wet cobbles at dusk.", "up_harbour"],
    ["c_noir", null, "Noir", "style", "Hard shadows, one key light.", null],
  ];
  for (const [id, project, name, kind, description, upload] of cast) {
    await db().execute({
      sql: `INSERT OR IGNORE INTO cast_members (id, project_id, name, kind, description, upload_id, created_at) VALUES (?,?,?,?,?,?,?)`,
      args: [id, project, name, kind, description, upload, 1],
    });
  }
  for (const s of seeds) {
    await db().execute({
      sql: `INSERT INTO elements (id, project_id, cast_id, kind, name, from_gen_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`,
      args: [s.id, s.project, s.castId ?? null, s.kind, s.name, s.fromGen ?? null, s.at, s.at],
    });
    if (s.first) {
      await db().execute({ sql: `INSERT INTO element_attributes (id, element_id, kind, created_at, updated_at) VALUES (?,?,?,?,?)`, args: [`a_${s.id}`, s.id, "face", s.at, s.at] });
      await db().execute({
        sql: `INSERT INTO attribute_versions (id, attribute_id, element_id, upload_id, gen_id, identity_id, created_at) VALUES (?,?,?,?,?,?,?)`,
        args: [`v1_${s.id}`, `a_${s.id}`, s.id, s.first.upload ?? null, s.first.gen ?? null, s.first.identity ?? null, s.at],
      });
      // A later version from the other kind of source never changes the origin.
      await db().execute({
        sql: `INSERT INTO attribute_versions (id, attribute_id, element_id, upload_id, gen_id, created_at) VALUES (?,?,?,?,?,?)`,
        args: [`v2_${s.id}`, `a_${s.id}`, s.id, s.first.upload ? null : "up_later", s.first.upload ? "gen_later" : null, s.at + 1],
      });
    }
  }
}

const PROMPTS = [
  "@Maya walks past @Harbour at dusk; @maya looks back.",
  "@Rex and @Unknown meet @Image1 under @Noir light.",
  "@Video2 plays. @Maya_2 is nobody, @maya2 neither, @rex_2 is not Rex.",
  "No citations at all.",
  "@harbour@Maya@HARBOUR @noir, @Narrator, @zoe_s_car, @prop_1920s_radio",
  "e-mail@Maya.com and @@Rex",
];

async function expansions() {
  const { listCast, expandCast } = await import("../../lib/cast");
  const out: unknown[] = [];
  for (const project of ["p1", "p2", "p3", null]) {
    const roster = await listCast(project);
    for (const prompt of PROMPTS) for (const start of [0, 2]) out.push(expandCast(prompt, roster, start));
  }
  return JSON.stringify(out);
}

async function rigReads() {
  const { listElements } = await import("../../lib/elements");
  return JSON.stringify([await listElements(), await listElements("p1"), await listElements("p2"), await listElements("p3")]);
}

async function rows() {
  const { db } = await import("../../lib/db");
  return (await db().execute(`SELECT * FROM elements ORDER BY id`)).rows.map((r) => ({ ...r }));
}

test("the backfill fills every element once, and @Name resolves byte-for-byte as before", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  await runInTenant(workspace("ws_lib_a"), async () => {
    const { fillLibraryForTests: fillLibrary } = await import("../../lib/elementLibrary.server");
    await seed();
    /* Golden: the roster is real, so "before equals after" cannot pass on an empty one. */
    const { listCast, expandCast } = await import("../../lib/cast");
    const golden = expandCast(PROMPTS[0], await listCast("p1"), 0);
    expect(golden.prompt).toBe("@Image1 walks past @Image2 at dusk; @Image1 looks back.\n\n@Image1 is Maya: Lead, red coat. @Image2 is Harbour: Wet cobbles at dusk.");
    expect(golden.attach).toEqual(["up_maya1", "up_harbour"]);
    expect(golden.used.map((m) => m.id)).toEqual(["c_maya1", "c_harbour"]);
    expect(golden.missing).toEqual([]);
    const castBefore = await expansions();
    const rigBefore = await rigReads();
    const before = await rows();
    for (const r of before) expect([r.handle, r.library_kind, r.origin, r.library_status]).toEqual([null, null, null, null]);

    const filled = await fillLibrary();
    expect(filled).toEqual({ handles: SEEDS.length, kinds: SEEDS.length, origins: SEEDS.length, statuses: SEEDS.length });
    const after = await rows();
    for (const r of after) {
      expect({ handle: r.handle, library_kind: r.library_kind, origin: r.origin }).toEqual(EXPECTED[String(r.id)]);
      expect(r.library_status).toBe("active");
    }

    // The resolution path admission uses (lib/generationAdmission.ts: listCast, then expandCast) is untouched.
    expect(await expansions()).toBe(castBefore);
    // Rig reads the same kind, the same rows, in the same order.
    expect(await rigReads()).toBe(rigBefore);
    // Nothing but the four new columns moved: not kind, not updated_at, not anything else.
    const untouched = (r: Record<string, unknown>) => { const { handle, library_kind, origin, library_status, ...rest } = r; void handle; void library_kind; void origin; void library_status; return rest; };
    expect(after.map(untouched)).toEqual(before.map(untouched));

    // Twice: the second run finds nothing to do and changes nothing.
    expect(await fillLibrary()).toEqual({ handles: 0, kinds: 0, origins: 0, statuses: 0 });
    expect(await rows()).toEqual(after);
    expect(await expansions()).toBe(castBefore);
  });
});

test("handles are unique per workspace, case-blind; elements made since are caught up without moving anyone", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  await runInTenant(workspace("ws_lib_a"), async () => {
    const { db } = await import("../../lib/db");
    const { fillLibraryForTests: fillLibrary } = await import("../../lib/elementLibrary.server");
    // The index the fill created refuses a second @maya in this workspace, in any case.
    await expect(db().execute(`UPDATE elements SET handle = 'MAYA' WHERE id = 'el_rex'`)).rejects.toThrow(/unique|constraint/i);

    const settled = await rows();
    // Made while people work: a workspace-wide Maya after the fill does not take @maya from the one that has it.
    await db().execute({ sql: `INSERT INTO elements (id, project_id, kind, name, created_at, updated_at) VALUES ('el_late', NULL, 'character', 'Maya', 99, 99)`, args: [] });
    await db().execute({ sql: `INSERT INTO elements (id, project_id, kind, name, created_at, updated_at) VALUES ('el_late2', 'p1', 'location', 'Harbour', 98, 98)`, args: [] });
    // Two fills at once, beside the person's own edits, finish together.
    const [a, b] = await Promise.all([
      fillLibrary(),
      fillLibrary(),
      db().execute(`UPDATE elements SET description = 'edited' WHERE id = 'el_maya1'`),
    ]);
    // The counts are what was written: the two late handles, once between the two fills.
    expect(a.handles + b.handles).toBe(2);
    const now = await rows();
    const late = now.find((r) => r.id === "el_late")!;
    const late2 = now.find((r) => r.id === "el_late2")!;
    expect(late.handle).toBe("maya_4");
    expect(late2.handle).toBe("harbour_2");
    expect(late2.library_kind).toBe("environment");
    for (const r of settled) expect(now.find((n) => n.id === r.id)!.handle).toBe(r.handle);
    expect(new Set(now.map((r) => String(r.handle).toLowerCase())).size).toBe(now.length);
  });
});

test("a fill that dies leaves nothing half-written, and the next run finishes it", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  await runInTenant(workspace("ws_lib_crash"), async () => {
    const { db } = await import("../../lib/db");
    const { fillLibraryForTests: fillLibrary } = await import("../../lib/elementLibrary.server");
    await seed([...SEEDS, { id: "el_crash", project: "p1", kind: "prop", name: "Crash Here", at: 30 }]);
    // A simulated crash part-way through the write.
    await db().execute(`CREATE TRIGGER fill_crash BEFORE UPDATE OF handle ON elements WHEN NEW.handle = 'crash_here'
                        BEGIN SELECT RAISE(ABORT, 'simulated crash'); END`);
    await expect(fillLibrary()).rejects.toThrow(/simulated crash/);
    for (const r of await rows()) expect([r.handle, r.library_kind, r.origin, r.library_status]).toEqual([null, null, null, null]);
    const indexes = await db().execute(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_elements_handle'`);
    expect(indexes.rows).toHaveLength(0);

    await db().execute(`DROP TRIGGER fill_crash`);
    expect((await fillLibrary()).handles).toBe(SEEDS.length + 1);
    const after = await rows();
    for (const r of after) if (r.id !== "el_crash") expect(r.handle).toBe(EXPECTED[String(r.id)].handle);
    expect(after.find((r) => r.id === "el_crash")!.handle).toBe("crash_here");
  });
});

test("tenant isolation: the same handle lives in two workspaces, and neither reads the other", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  await runInTenant(workspace("ws_lib_b"), async () => {
    const { fillLibraryForTests: fillLibrary } = await import("../../lib/elementLibrary.server");
    await seed([{ id: "el_b_maya", project: "p1", kind: "character", name: "Maya", at: 1 }]);
    await fillLibrary();
    const b = await rows();
    expect(b.map((r) => [r.id, r.handle])).toEqual([["el_b_maya", "maya"]]);
  });
  await runInTenant(workspace("ws_lib_a"), async () => {
    const a = await rows();
    expect(a.find((r) => r.id === "el_maya1")!.handle).toBe("maya");
    expect(a.some((r) => r.id === "el_b_maya")).toBe(false);
  });
  await runInTenant(workspace("ws_lib_b"), async () => {
    expect((await rows()).map((r) => r.id)).toEqual(["el_b_maya"]);
  });
  // No workspace in scope: no data.
  const { fillLibraryForTests: fillLibrary } = await import("../../lib/elementLibrary.server");
  await expect(fillLibrary()).rejects.toThrow();
});

test("the switch: off writes and reads nothing; on, only the house workspace (or a listed one) sees the Library", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { HOUSE_WORKSPACE_ID } = await import("../../lib/houseWorkspace");
  const { fillLibrary, listLibrary, v30LibraryOn } = await import("../../lib/elementLibrary.server");
  const prior = process.env.V30_LIBRARY;
  try {
    delete process.env.V30_LIBRARY;
    await runInTenant(workspace(HOUSE_WORKSPACE_ID), async () => {
      await seed([{ id: "el_h_maya", project: "p1", kind: "character", name: "Maya", at: 1 }, { id: "el_h_dock", project: null, kind: "location", name: "Dock", at: 2 }]);
      expect(await v30LibraryOn()).toBe(false);
      expect(await listLibrary("p1")).toBeNull();
      expect(await fillLibrary()).toBeNull();
      for (const r of await rows()) expect([r.handle, r.library_kind, r.origin, r.library_status]).toEqual([null, null, null, null]);
    });

    process.env.V30_LIBRARY = "1";
    await runInTenant(workspace("ws_lib_customer"), async () => {
      await seed([{ id: "el_c_maya", project: "p1", kind: "character", name: "Maya", at: 1 }]);
      expect(await v30LibraryOn()).toBe(false);
      expect(await listLibrary()).toBeNull();
      expect(await fillLibrary()).toBeNull();
      for (const r of await rows()) expect([r.handle, r.library_kind, r.origin, r.library_status]).toEqual([null, null, null, null]);
    });
    await runInTenant(workspace(HOUSE_WORKSPACE_ID), async () => {
      expect(await v30LibraryOn()).toBe(true);
      expect(await listLibrary("p1")).toEqual([
        { id: "el_h_maya", projectId: "p1", name: "Maya", handle: "maya", libraryKind: "character", origin: "uploaded", status: "active" },
        { id: "el_h_dock", projectId: null, name: "Dock", handle: "dock", libraryKind: "environment", origin: "uploaded", status: "active" },
      ]);
    });
  } finally {
    if (prior === undefined) delete process.env.V30_LIBRARY;
    else process.env.V30_LIBRARY = prior;
  }
});

test("source: the Library writer never writes kind, the cast, or anything a price reads", () => {
  const source = readFileSync(path.resolve("lib/elementLibrary.server.ts"), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  expect(code).not.toMatch(/cast_members/);
  expect(code).not.toMatch(/\bSET\s+kind\b|,\s*kind\s*=/i);
  expect(code).not.toMatch(/INSERT|DELETE/i);
  // One update, on elements, whose column comes from the closed list of the four new columns.
  const writes = [...code.matchAll(/UPDATE\s+(\w+)\s+SET\s+([^`]*)`/gi)];
  expect(writes.map((w) => w[1])).toEqual(["elements"]);
  expect(writes[0][2]).toBe("${column} = ? WHERE id = ? AND ${column} IS NULL");
  expect(code).toContain(`const COLUMNS = ["handle", "library_kind", "origin", "library_status"] as const;`);
});

test("source: the unchecked fill is for tests only", () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) { if (name !== "node_modules") walk(full); } else if (/\.(ts|tsx|mjs|js)$/.test(name)) files.push(full);
    }
  };
  for (const root of ["lib", "app", "components"]) walk(path.resolve(root));
  const users = files.filter((f) => readFileSync(f, "utf8").includes("fillLibraryForTests"));
  expect(users.map((f) => path.relative(process.cwd(), f))).toEqual(["lib/elementLibrary.server.ts"]);
});

/* ── A real conflict between the fill's read and its write ──────────────── */

function load<T>(source: string, deps: Record<string, unknown>): T {
  const filename = path.resolve(source), req = createRequire(filename);
  const compiled = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const mod = { exports: {} };
  new Function("require", "module", "exports", compiled)(
    (name: string) => (Object.hasOwn(deps, name) ? deps[name] : req(name)),
    mod, mod.exports,
  );
  return mod.exports as T;
}

const sqlOf = (stmt: InStatement | string) => (typeof stmt === "string" ? stmt : stmt.sql);

test("a handle another fill commits between this fill's read and its write: the write rolls back, and the late row takes the next suffix", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const ws = workspace("ws_lib_race");
  await runInTenant(ws, async () => {
    const { fillLibraryForTests } = await import("../../lib/elementLibrary.server");
    await seed([{ id: "el_r_maya", project: "p1", kind: "character", name: "Maya", at: 1 }]);
    await fillLibraryForTests();   // @maya, and the unique handle index
  });

  /* Two connections to one database: this fill's, and the "other process". Both late Mayas are unfilled. */
  const mine = createClient({ url: ws.dbUrl }), other = createClient({ url: ws.dbUrl });
  await mine.batch([
    `INSERT INTO elements (id, project_id, kind, name, created_at, updated_at) VALUES ('el_r_late', 'p1', 'character', 'Maya', 2, 2)`,
    `INSERT INTO elements (id, project_id, kind, name, created_at, updated_at) VALUES ('el_r_later', 'p1', 'character', 'Maya', 3, 3)`,
  ], "write");
  let raced = 0;
  const batches: string[][] = [];
  const client = new Proxy(mine, {
    get(target, prop) {
      if (prop === "batch") return async (stmts: (InStatement | string)[], mode?: never) => {
        batches.push(stmts.map(sqlOf));
        /* The first write only: just before it lands, another fill gives @maya_2 to the later Maya, the handle this
           fill read as free and planned for the earlier one. */
        if (!raced && stmts.some((s) => /UPDATE elements SET handle/i.test(sqlOf(s)))) {
          raced++;
          await other.execute(`UPDATE elements SET handle = 'maya_2' WHERE id = 'el_r_later' AND handle IS NULL`);
        }
        return target.batch(stmts as never, mode);
      };
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Client;

  const library = load<typeof import("../../lib/elementLibrary.server")>("lib/elementLibrary.server.ts", {
    "./db": { db: () => client, ready: async () => {} },
    "./newInterface.server": { newInterfaceFor: async () => true },
    "./tenant": await import("../../lib/tenant"),
    "./elementLibrary": await import("../../lib/elementLibrary"),
  });
  const filled = await library.fillLibraryForTests();

  expect(raced).toBe(1);
  // The first write was refused whole, and the fill read again and wrote once more.
  expect(batches.filter((b) => b.some((s) => /UPDATE elements/i.test(s)))).toHaveLength(2);
  const handles = Object.fromEntries((await mine.execute(`SELECT id, handle FROM elements ORDER BY id`)).rows.map((r) => [String(r.id), r.handle]));
  expect(handles).toEqual({ el_r_maya: "maya", el_r_later: "maya_2", el_r_late: "maya_3" });
  // Only what this fill wrote is counted: the late Maya's handle, not the one the other fill wrote.
  expect(filled.handles).toBe(1);
  expect(filled.kinds).toBe(2);
  mine.close(); other.close();
});
