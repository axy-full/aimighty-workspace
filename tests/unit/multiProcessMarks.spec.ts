import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import { createClient, type Client } from "@libsql/client";

/*
 * Several server processes (WEB_CONCURRENCY, ops/selfhost/cluster.mjs) share one database and nothing else. The
 * ten-minute "ask an admin" count (lib/control-room/ask-admin.ts) and the ten-minute "presets are stale" attempt
 * (lib/atomikLibrary.ts) used to live in a Map in each process, so every process let its own ask (or provider read)
 * through. Here each "process" is its own compiled copy of the module, with its own module state and its own
 * connection to one local database file: what one marks, the other honours. Local temporary files only.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-multi-process-"));
process.env.ENGINE_MOCK = "1";
const file = (name: string) => `file:${path.join(dir, `${name}.db`)}`;

/** A lib module compiled as CommonJS, as a fresh instance (another process holds its own), with chosen dependencies replaced. */
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

test("a once-per-window mark is one across processes: taken by the first, refused with when it was taken, free again when the window ends", async () => {
  const { takeOncePerWindow, windowTakenAt } = await import("../../lib/operationLease");
  const a = createClient({ url: file("window") }), b = createClient({ url: file("window") });
  expect(await takeOncePerWindow(a, "mark", 1000, 5000)).toEqual({ taken: true });
  expect(await takeOncePerWindow(b, "mark", 1000, 5400)).toEqual({ taken: false, since: 5000 });
  /* A refused attempt does not move the window. */
  expect(await windowTakenAt(b, "mark", 5999)).toBe(5000);
  expect(await windowTakenAt(a, "mark", 6000)).toBeNull();
  expect(await takeOncePerWindow(b, "mark", 1000, 6000)).toEqual({ taken: true });
  expect(await takeOncePerWindow(a, "mark", 1000, 6999)).toEqual({ taken: false, since: 6000 });
  /* Names are their own windows. */
  expect(await takeOncePerWindow(a, "other", 1000, 6999)).toEqual({ taken: true });
  a.close(); b.close();
});

test("Ask an admin counts one ask per person and subject every ten minutes across processes", async () => {
  type AskAdmin = typeof import("../../lib/control-room/ask-admin");
  const a = createClient({ url: file("ask") }), b = createClient({ url: file("ask") });
  const process = (client: Client) => load<AskAdmin>("lib/control-room/ask-admin.ts", {
    "../db": { db: () => client },
    "../tenant": { requireTenant: () => ({ id: "ws_multi" }) },
    "../platform": { workspaceAdmins: async () => [] },
    "../push": { notify: async () => { throw new Error("not in this test"); } },
    "../settings": { getSetting: async () => "" },
    "../workbench/rig-agent-runs": { priceRender: async () => ({ ok: false }), stepTitle: () => "" },
    "../shotCap": { shotCreditsSoFar: async () => 0 },
    "../workbench/rig-agent-store": { rigAgentExists: async () => false, runOfProduction: async () => null, stepsOf: async () => [] },
  });
  const one = process(a), two = process(b);
  const told: string[][] = [];
  const at = (now: number) => ({ admins: async () => [{ id: "boss" }], tell: async (ids: string[]) => { told.push(ids); }, now: () => now });
  const me = { id: "mem", name: "Member", admin: false };
  const rules = { about: "rules" as const };
  const T = 2_000_000_000_000;

  expect(await one.askAdmin(me, rules, at(T))).toMatchObject({ asked: 1 });
  /* The same person through the other process three minutes later: refused, and told when they asked. */
  await expect(two.askAdmin(me, rules, at(T + 3 * 60_000))).rejects.toMatchObject({ status: 429, message: two.askedRecently(3) });
  expect(told).toHaveLength(1);
  /* Another person is their own count. */
  expect(await two.askAdmin({ ...me, id: "mem2" }, rules, at(T + 3 * 60_000))).toMatchObject({ asked: 1 });
  expect(told).toHaveLength(2);
  /* Just short of ten minutes, on either process: refused. At ten minutes: asked once more, on one process only. */
  await expect(one.askAdmin(me, rules, at(T + one.ASK_AGAIN_MS - 1))).rejects.toMatchObject({ status: 429 });
  expect(await two.askAdmin(me, rules, at(T + one.ASK_AGAIN_MS))).toMatchObject({ asked: 1 });
  await expect(one.askAdmin(me, rules, at(T + one.ASK_AGAIN_MS + 1))).rejects.toMatchObject({ status: 429, message: one.askedRecently(1) });
  expect(told).toHaveLength(3);
  /* Kept in the workspace's own database, by ids only. */
  const marks = (await a.execute("SELECT name FROM operation_leases WHERE name GLOB 'ask-admin:*' ORDER BY name")).rows.map((r) => String(r.name));
  expect(marks).toEqual(["ask-admin:ws_multi|mem2|rules|", "ask-admin:ws_multi|mem|rules|"]);
  a.close(); b.close();
});

test("the presets-stale attempt is one per workspace and key every ten minutes across processes, and never marked while presets are fresh", async () => {
  type Library = typeof import("../../lib/atomikLibrary");
  const a = createClient({ url: file("presets") }), b = createClient({ url: file("presets") });
  const never = async () => { throw new Error("not in this test"); };
  const process = (client: Client) => load<Library>("lib/atomikLibrary.ts", {
    "./db": { db: () => client, ready: async () => {} },
    "./tenant": { requireTenant: () => ({ id: "ws_multi" }) },
    "./mock": { engineMock: () => false },
    "./higgsfield": { higgsfieldConfigured: () => true, higgsfieldCredentials: () => ({ fingerprint: "fp_test" }) },
    "./higgsfieldMarketing": { listMarketingPresets: never },
    "./generationAdmission": { prepareGeneration: never },
    "./workbench/records": { workbenchReady: never },
    "./workbench/project-library": { projectLibraryReady: never, resolveProjectLibrary: never },
  });
  const one = process(a), two = process(b);
  const NAME = "presets-stale:ws_multi:fp_test";
  /* Ten minutes pass, for the mark: its window ends now. */
  const age = () => a.execute({ sql: "UPDATE operation_leases SET lease_until=? WHERE name=?", args: [Date.now(), NAME] });

  /* No presets kept: stale, once. Neither process asks again inside the window. */
  expect(await one.plannerPresetsStale()).toBe(true);
  expect(await two.plannerPresetsStale()).toBe(false);
  expect(await one.plannerPresetsStale()).toBe(false);
  await age();
  expect(await two.plannerPresetsStale()).toBe(true);
  expect(await one.plannerPresetsStale()).toBe(false);

  /* Presets seen within the hour: not stale, and the attempt is not spent. */
  await a.execute(`CREATE TABLE higgsfield_marketing_presets(id TEXT PRIMARY KEY, name TEXT, credential_fingerprint TEXT, seen_at INTEGER)`);
  await a.execute({ sql: `INSERT INTO higgsfield_marketing_presets VALUES('p1','Bold','fp_test',?)`, args: [Date.now()] });
  await age();
  expect(await one.plannerPresetsStale()).toBe(false);
  expect(await two.plannerPresetsStale()).toBe(false);
  const { windowTakenAt } = await import("../../lib/operationLease");
  expect(await windowTakenAt(a, NAME)).toBeNull();
  a.close(); b.close();
});
