import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TenantWorkspace } from "../../lib/tenant";
import { PRO_PICK_DEFAULT, PRO_PICK_MAX, cleanProPick, type ProPickEntry } from "../../lib/proPick";

/**
 * The Pro pick (lib/proPick.ts, lib/proPick.server.ts): the owner's four engines as config, a site override, and the composer's engines response marking them. Local temporary
 * databases only; no engine is called.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-propick-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";
test.afterEach(() => { delete process.env.KLING4_ENABLED; });

const KLING4 = "fal-ai/kling-video/v4/pro", KLING3_PRO = "fal-ai/kling-video/v3/pro", SEEDANCE = "dreamina-seedance-2-5-260628";
const ws = (id: string): TenantWorkspace => ({ id, slug: id, name: id, legacy: id === "ws_legacy", dbUrl: `file:${path.join(dir, `${id}.db`)}`, dbToken: null, keys: {}, usesPlatformKeys: true, allowanceUsd: null, gatewayKeyId: null, ownerId: "u_test", createdAt: 0, suspendedAt: null, suspendedReason: null, flaggedAt: null, flagNote: null, concurrency: 50, rendersPerHour: 1000, storageQuotaBytes: null, deletedAt: null } as TenantWorkspace);
const OWNER = { user: { id: "owner", email: "o@example.invalid", name: "o", role: "admin", owner: true, disabled: false, createdAt: 0, lastSeen: null } };
async function inHouse(fn: () => Promise<void>) { const { runInTenant } = await import("../../lib/tenant"); await runInTenant(ws("ws_legacy"), fn, OWNER as never); }
async function withSite<T>(value: unknown, fn: () => Promise<T>): Promise<T> {
  const { platformDb, platformReady } = await import("../../lib/platform");
  await platformReady();
  const was = (await platformDb().execute("SELECT value FROM platform_layer WHERE key='site'")).rows[0]?.value;
  await platformDb().execute({ sql: `INSERT INTO platform_layer (key, value, updated_at, updated_by) VALUES ('site', ?, 0, NULL) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, args: [typeof value === "string" ? value : JSON.stringify(value)] });
  try { return await fn(); } finally { if (typeof was === "string") await platformDb().execute({ sql: "UPDATE platform_layer SET value=? WHERE key='site'", args: [was] }); else await platformDb().execute("DELETE FROM platform_layer WHERE key='site'"); }
}

test("the default is the owner's four, in his order, named in config: Seedance 2.5, Veo 3.1, Kling 4.0 (3.0 Pro until then), Runway Gen-4.5", async () => {
  const { findModel, getModel, isOffered } = await import("../../lib/models");
  expect(PRO_PICK_DEFAULT.map((e) => [e.key, e.label])).toEqual([["seedance-2-5", "Seedance 2.5"], ["veo-3-1", "Veo 3.1"], ["kling-4", "Kling 4.0"], ["runway-gen-4-5", "Runway Gen-4.5"]]);
  expect(Object.isFrozen(PRO_PICK_DEFAULT)).toBe(true);
  expect(PRO_PICK_DEFAULT[0].engine).toEqual({ kind: "model", id: SEEDANCE });
  expect(PRO_PICK_DEFAULT[1].engine).toEqual({ kind: "tool", id: "veo_video", model: "veo-3.1-generate-preview" });
  expect(PRO_PICK_DEFAULT[2]).toMatchObject({ engine: { kind: "model", id: KLING4 }, fallback: { kind: "model", id: KLING3_PRO } });
  expect(PRO_PICK_DEFAULT[3].engine).toEqual({ kind: "tool", id: "runway_video", model: "gen4.5" });
  /* The registry holds the model ids it names (Kling 4.0 as a gated model), and offers the fallback and Seedance. */
  expect(isOffered(getModel(SEEDANCE))).toBe(true);
  expect(isOffered(getModel(KLING3_PRO))).toBe(true);
  expect(findModel(KLING4)?.gate).toBe("KLING4_ENABLED");
  expect(cleanProPick(JSON.parse(JSON.stringify(PRO_PICK_DEFAULT)))).toEqual(PRO_PICK_DEFAULT);
});

test("an override is used whole or not at all: every entry well formed, distinct keys, one to eight entries, no extra fields; anything else is the default", () => {
  const good: ProPickEntry = { key: "a-1", label: "Engine One 2.5", engine: { kind: "model", id: "some/model-id_1" } };
  expect(cleanProPick([good])).toEqual([good]);
  expect(cleanProPick([{ ...good, engine: { kind: "tool", id: "runway_video", model: "gen4.5" }, fallback: { kind: "model", id: KLING3_PRO } }])).toEqual([{ ...good, engine: { kind: "tool", id: "runway_video", model: "gen4.5" }, fallback: { kind: "model", id: KLING3_PRO } }]);
  expect(cleanProPick(Array.from({ length: PRO_PICK_MAX }, (_, i) => ({ ...good, key: `k${i}` })))).toHaveLength(PRO_PICK_MAX);
  const bad: unknown[] = [
    undefined, null, "list", {}, [], Array.from({ length: PRO_PICK_MAX + 1 }, (_, i) => ({ ...good, key: `k${i}` })),
    [good, good], [{ ...good, key: "Upper" }], [{ ...good, key: "-lead" }], [{ ...good, key: "x".repeat(42) }], [{ ...good, key: 5 }],
    [{ ...good, label: "" }], [{ ...good, label: "<b>Hi</b>" }], [{ ...good, label: "x".repeat(41) }], [{ ...good, label: "Seedance\n2" }], [{ ...good, label: 5 }],
    [{ ...good, extra: 1 }], [{ ...good, engine: null }], [{ ...good, engine: { kind: "url", id: "https://evil.example" } }], [{ ...good, engine: { kind: "model", id: "bad id" } }],
    [{ ...good, engine: { kind: "model", id: "../x" } }], [{ ...good, engine: { kind: "model", id: "ok", extra: 1 } }], [{ ...good, engine: { kind: "tool", id: "Bad-Tool" } }],
    [{ ...good, engine: { kind: "tool", id: "veo_video", model: "has space" } }], [{ ...good, engine: { kind: "tool", id: "veo_video", model: 5 } }],
    [{ ...good, fallback: { kind: "tool", id: "veo_video" } }], [{ ...good, fallback: { kind: "model", id: "bad id" } }], [{ ...good, fallback: "x" }], [good, "x"],
  ];
  for (const value of bad) expect(cleanProPick(value), JSON.stringify(value)?.slice(0, 80)).toBeNull();
});

test("resolving: each entry is there when its engine is; an entry whose engine is not there stands in its fallback under the fallback's own name; one with none is left out; the order is the list's", async () => {
  const { resolveProPick } = await import("../../lib/proPick.server");
  const all = { models: new Set([SEEDANCE, KLING4, KLING3_PRO]), tools: new Set(["veo_video", "runway_video"]) };
  const full = await resolveProPick(all);
  expect(full.map((r) => [r.key, r.label, r.kind, r.id, r.fellBack])).toEqual([
    ["seedance-2-5", "Seedance 2.5", "model", SEEDANCE, false], ["veo-3-1", "Veo 3.1", "tool", "veo_video", false], ["kling-4", "Kling 4.0", "model", KLING4, false], ["runway-gen-4-5", "Runway Gen-4.5", "tool", "runway_video", false],
  ]);
  expect(full[1]).toMatchObject({ model: "veo-3.1-generate-preview" });
  /* Kling 4.0 inert (not listed): Kling 3.0 Pro stands in, under its own name. */
  const inert = await resolveProPick({ ...all, models: new Set([SEEDANCE, KLING3_PRO]) });
  expect(inert.map((r) => [r.label, r.id, r.fellBack])).toEqual([["Seedance 2.5", SEEDANCE, false], ["Veo 3.1", "veo_video", false], ["Kling 3.0 Pro", KLING3_PRO, true], ["Runway Gen-4.5", "runway_video", false]]);
  /* A tool that is not there (the engine is off for the workspace) is left out; no fallback was named. */
  const noTools = await resolveProPick({ ...all, tools: new Set() });
  expect(noTools.map((r) => r.id)).toEqual([SEEDANCE, KLING4]);
  /* Neither the engine nor its fallback: left out. */
  expect((await resolveProPick({ ...all, models: new Set([SEEDANCE]) })).map((r) => r.id)).toEqual([SEEDANCE, "veo_video", "runway_video"]);
  /* A fallback the registry does not hold is no fallback. */
  const config = cleanProPick([{ key: "x", label: "Engine X", engine: { kind: "model", id: "no/such-model" }, fallback: { kind: "model", id: "no/such-fallback" } }])!;
  expect(await resolveProPick({ config, models: new Set(["no/such-fallback"]) })).toEqual([]);
});

test("for the house workspace today: Seedance 2.5 and, while Kling 4.0 is inert, Kling 3.0 Pro in its place; a tool's entry only where the tool is present; Kling 4.0 itself never, switch or no switch, while its row is unconfirmed", async () => inHouse(async () => {
  const { resolveProPick } = await import("../../lib/proPick.server");
  delete process.env.KLING4_ENABLED;
  const off = await resolveProPick();
  expect(off.filter((r) => r.kind === "model").map((r) => [r.id, r.fellBack])).toEqual([[SEEDANCE, false], [KLING3_PRO, true]]);
  process.env.KLING4_ENABLED = "1";
  const on = await resolveProPick();
  expect(on.filter((r) => r.kind === "model").map((r) => [r.id, r.fellBack])).toEqual([[SEEDANCE, false], [KLING3_PRO, true]]);
  expect(on.map((r) => r.id)).not.toContain(KLING4);
  /* Once the row is confirmed (the lead's flip) and the switch is on, Kling 4.0 is there for the house and the fallback is not used. */
  const { GATED_VENDOR_RATES } = await import("../../lib/vendorRates");
  const was = GATED_VENDOR_RATES[KLING4].confirmed;
  GATED_VENDOR_RATES[KLING4].confirmed = true;
  try {
    const live = await resolveProPick();
    expect(live.filter((r) => r.kind === "model").map((r) => [r.id, r.label, r.fellBack])).toEqual([[SEEDANCE, "Seedance 2.5", false], [KLING4, "Kling 4.0", false]]);
  } finally { GATED_VENDOR_RATES[KLING4].confirmed = was; }
}));

test("the site override: a well-formed proPick in the site row replaces the list; a bad one, a missing one and an unreadable row are the default", async () => inHouse(async () => {
  const { proPickConfig } = await import("../../lib/proPick.server");
  const custom = [{ key: "only-seedance", label: "Seedance 2.5 Pro", engine: { kind: "model", id: SEEDANCE } }];
  expect(await withSite({ proPick: custom }, proPickConfig)).toEqual(custom);
  expect(await withSite({ proPick: [...custom, { ...custom[0] }] }, proPickConfig)).toEqual(PRO_PICK_DEFAULT);
  expect(await withSite({ proPick: [{ key: "BAD", label: "x", engine: { kind: "model", id: SEEDANCE } }] }, proPickConfig)).toEqual(PRO_PICK_DEFAULT);
  expect(await withSite({ openSignup: true }, proPickConfig)).toEqual(PRO_PICK_DEFAULT);
  expect(await withSite("not json{", proPickConfig)).toEqual(PRO_PICK_DEFAULT);
  expect(await withSite({ proPick: "x" }, proPickConfig)).toEqual(PRO_PICK_DEFAULT);
  const { resolveProPick } = await import("../../lib/proPick.server");
  expect((await withSite({ proPick: custom }, resolveProPick)).map((r) => [r.key, r.label])).toEqual([["only-seedance", "Seedance 2.5 Pro"]]);
}));

test("saving a site switch keeps the engine list and the Pro pick that other parts of the platform own", async () => {
  const { writeSite } = await import("../../lib/site/settings.server");
  const { platformDb } = await import("../../lib/platform");
  const custom = [{ key: "only-seedance", label: "Seedance 2.5", engine: { kind: "model", id: SEEDANCE } }];
  await withSite({ openSignup: false, enginesOnWorkspaces: ["ws_a"], proPick: custom }, async () => {
    const next = await writeSite({ openSignup: true }, null);
    expect(next.openSignup).toBe(true);
    const stored = JSON.parse(String((await platformDb().execute("SELECT value FROM platform_layer WHERE key='site'")).rows[0].value));
    expect(stored).toMatchObject({ openSignup: true, enginesOnWorkspaces: ["ws_a"], proPick: custom });
  });
  /* With none stored, none appears. */
  await withSite({ openSignup: false }, async () => {
    await writeSite({ guestHome: true }, null);
    const stored = JSON.parse(String((await platformDb().execute("SELECT value FROM platform_layer WHERE key='site'")).rows[0].value));
    expect(Object.keys(stored)).not.toContain("proPick");
    expect(Object.keys(stored)).not.toContain("enginesOnWorkspaces");
  });
});

test("the composer's rows: a model entry marks its row with its place; a tool entry marks none; a row that is not a Pro entry is untouched", async () => {
  const { markPro } = await import("../../lib/proPick.server");
  const { workspaceModels } = await import("../../lib/workspace/composer");
  const pro = [
    { key: "a", label: "A", kind: "model" as const, id: "m2", fellBack: false },
    { key: "b", label: "B", kind: "tool" as const, id: "veo_video", fellBack: false },
    { key: "c", label: "C", kind: "model" as const, id: "m1", fellBack: true },
    { key: "d", label: "D", kind: "model" as const, id: "m2", fellBack: false },
  ];
  expect(markPro([{ id: "m1" }, { id: "m2" }, { id: "m3" }, { id: "veo_video" }], pro)).toEqual([{ id: "m1", pro: 3 }, { id: "m2", pro: 1 }, { id: "m3" }, { id: "veo_video" }]);
  /* The composer reads the place off the row and carries it on its model. */
  const rows = [{ id: SEEDANCE, kind: "video" as const, resolutions: ["720p"], ratios: ["16:9"], durations: [5], pro: 1 }, { id: KLING3_PRO, kind: "video" as const, resolutions: ["1080p"], ratios: ["16:9"], durations: [5] }];
  const models = workspaceModels(rows, null);
  expect(models.find((m) => m.id === SEEDANCE)?.pro).toBe(1);
  expect(models.find((m) => m.id === KLING3_PRO)?.pro).toBeUndefined();
});

test("structure: the config file is pure and has no settings of its own; the route marks the rows and carries the list; the design names no engine", () => {
  const pure = readFileSync("lib/proPick.ts", "utf8");
  expect(pure).not.toMatch(/^import /m);
  for (const file of ["lib/proPick.ts", "lib/proPick.server.ts"]) expect(readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ""), file).not.toMatch(/process\.env/);
  const route = readFileSync("app/api/workbench/engines/route.ts", "utf8");
  expect(route).toContain("const pro = await resolveProPick({ models: new Set(configured.map(model => model.id)) });");
  expect(route).toContain("models: markPro(listed(at, refs), pro), pro,");
  expect(route).toContain("const models = markPro(listed({}, NO_REFERENCES), pro);");
  expect(readFileSync("lib/workbench/media-quote.ts", "utf8")).toContain("export { markPro, resolveProPick } from '../proPick.server';");
  /* No component spells an engine of the pick: the names live in the config. */
  const walk = (d: string): string[] => readdirSync(d).flatMap((f) => { const p = `${d}/${f}`; return statSync(p).isDirectory() ? walk(p) : /\.tsx$/.test(f) ? [p] : []; });
  for (const file of walk("components")) expect(readFileSync(file, "utf8"), file).not.toMatch(/Runway Gen-4\.5|Veo 3\.1 /);
});
