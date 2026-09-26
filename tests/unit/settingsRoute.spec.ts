import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import ts from "typescript";
import * as enhancer from "../../lib/shell/enhancer";
import * as settingValues from "../../lib/settingValues";

/*
 * PATCH /api/settings refuses a value its readers do not understand, and
 * checks every value before it writes any. The old Suites select saved
 * approvalRule "always", which cleanRule read back as "anyone": approvals
 * silently off. The route itself is run here, with the settings store and
 * auth stubbed, so deleting the check (or writing before it) fails a test.
 */

const DEFAULTS = { approvalRule: "anyone", shotCapCredits: "50", capWarnPct: "80", atCap: "producer", defaultVideoModel: "", defaultImageModel: "", editOutputFormat: "mp4", promptWriter: "claude", promptEnhancer: "higgsfield" };

function load(role: "admin" | "member" = "admin") {
  const writes: [string, string, string][] = [];
  const mocks: Record<string, unknown> = {
    "next/server": createRequire(path.resolve("package.json"))("next/server"),
    "@/lib/shell/enhancer": enhancer,
    "@/lib/settingValues": settingValues,
    "@/lib/auth": {
      withTenant: (handler: unknown) => handler,
      requireUser: async () => ({ user: { id: "u1", role } }),
      requireAdmin: async () => (role === "admin" ? { user: { id: "u1", role } } : { response: Response.json({ error: "Admins only" }, { status: 403 }) }),
    },
    "@/lib/settings": {
      DEFAULTS,
      allSettings: async () => Object.fromEntries(writes.map(([k, v]) => [k, v])),
      setSetting: async (key: string, value: string, by: string) => { writes.push([key, value, by]); },
    },
    "@/lib/platform": { getPlatformLayer: async () => ({ models: {} }) },
    "@/lib/platformLayer": {
      resolveModels: () => ({}),
      modelOfKind: (id: string, kind: string) => (id === "video-engine" && kind === "video") || (id === "still-engine" && kind === "image"),
    },
  };
  const compiled = ts.transpileModule(readFileSync("app/api/settings/route.ts", "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const mod = { exports: {} as { PATCH: (req: Request) => Promise<Response> } };
  new Function("require", "module", "exports", compiled)((name: string) => {
    if (!(name in mocks)) throw new Error("Unexpected route dependency " + name);
    return mocks[name];
  }, mod, mod.exports);
  const patch = (body: unknown) => mod.exports.PATCH(new Request("http://localhost/api/settings", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
  return { writes, patch };
}

test("an unknown approval rule is refused with a 400, and nothing in the same save is written", async () => {
  const { writes, patch } = load();
  const response = await patch({ approvalRule: "always", promptEnhancer: "claude" });
  expect(response.status).toBe(400);
  expect((await response.json()).error).toBe("Choose anyone, cap or producer.");
  expect(writes).toEqual([]);
  /* The refused key may come last: still nothing written. */
  const later = await patch({ promptEnhancer: "claude", atCap: "pause" });
  expect(later.status).toBe(400);
  expect(writes).toEqual([]);
  for (const bad of [{ editOutputFormat: "webm" }, { capWarnPct: "0" }, { capWarnPct: "eighty" }, { defaultVideoModel: "still-engine" }]) {
    expect((await patch(bad)).status, JSON.stringify(bad)).toBe(400);
  }
  expect(writes).toEqual([]);
});

test("every rule the gate enforces is stored as sent, with the rest of the save", async () => {
  for (const rule of ["anyone", "cap", "producer"]) {
    const { writes, patch } = load();
    const response = await patch({ approvalRule: rule, shotCapCredits: "120", capWarnPct: "70", atCap: "stop", editOutputFormat: "mov", defaultVideoModel: "video-engine", notASetting: "x" });
    expect(response.status, rule).toBe(200);
    expect(writes).toEqual([
      ["approvalRule", rule, "u1"], ["shotCapCredits", "120", "u1"], ["capWarnPct", "70", "u1"], ["atCap", "stop", "u1"], ["editOutputFormat", "mov", "u1"], ["defaultVideoModel", "video-engine", "u1"],
    ]);
    expect((await response.json()).changed).toEqual(["approvalRule", "shotCapCredits", "capWarnPct", "atCap", "editOutputFormat", "defaultVideoModel"]);
  }
});

test("a member cannot change workspace settings", async () => {
  const { writes, patch } = load("member");
  expect((await patch({ approvalRule: "producer" })).status).toBe(403);
  expect(writes).toEqual([]);
});
