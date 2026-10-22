import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import ts from "typescript";
import * as enhancer from "../../lib/shell/enhancer";
import * as settingValues from "../../lib/settingValues";
import { cleanBudget } from "../../lib/budgetPause";
import { RETIRED_SETTING, RETIRED_SETTING_KEYS } from "../../lib/settings";

/*
 * PATCH /api/settings refuses a value its readers do not understand, and
 * checks every value before it writes any. The old Suites select saved
 * approvalRule "always", which cleanRule read back as "anyone": approvals
 * silently off. Since 21 Oct 2026 the approval rule and its per-shot cap are
 * retired (owner: "every member approves their own spend with their own tap
 * on the quote"): a save that names either is refused whole (410, "retired"),
 * and the rows a workspace stored stay as they are. The route itself is run
 * here, with the settings store and auth stubbed, so deleting the check (or
 * writing before it) fails a test.
 */

const DEFAULTS = { capWarnPct: "80", atCap: "producer", defaultVideoModel: "", defaultImageModel: "", editOutputFormat: "mp4", promptWriter: "claude", promptEnhancer: "higgsfield", productionBudgetCredits: "" };

function load(role: "admin" | "member" = "admin") {
  const writes: [string, string, string][] = [];
  const relocks: unknown[] = [];
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
      DEFAULTS, RETIRED_SETTING, RETIRED_SETTING_KEYS,
      allSettings: async () => Object.fromEntries(writes.map(([k, v]) => [k, v])),
      setSetting: async (key: string, value: string, by: string) => { writes.push([key, value, by]); },
      getSetting: async (key: string) => writes.filter(([k]) => k === key).at(-1)?.[1] ?? "",
    },
    /* The budget and its re-lock go through one transactional writer (its own behaviour: tests/unit/demo-gaps-l4-people-only.spec.ts). */
    "@/lib/caps": {
      setWorkspaceBudget: async (value: string, by: string, inCredits: boolean) => {
        const was = cleanBudget(writes.filter(([k]) => k === "productionBudgetCredits").at(-1)?.[1] ?? "");
        writes.push(["productionBudgetCredits", value, by]);
        const changed = was !== cleanBudget(value);
        if (changed && inCredits) relocks.push({ budget: true });
        return changed;
      },
    },
    "@/lib/credits": { creditsApply: () => true },
    "@/lib/tenant": { requireTenant: () => ({ id: "ws_settings" }) },
    "@/lib/cache": { invalidate: () => {}, PROJECTS_KEY: "projects" },
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
  return { writes, patch, relocks };
}

test("the retired approval rule and per-shot cap are refused whole (410, retired), whatever their value, and nothing in the same save is written", async () => {
  const { writes, patch } = load();
  expect(RETIRED_SETTING_KEYS).toEqual(["approvalRule", "shotCapCredits"]);
  for (const body of [{ approvalRule: "always", promptEnhancer: "claude" }, { approvalRule: "cap" }, { approvalRule: "anyone" }, { promptEnhancer: "claude", shotCapCredits: "50" }, { capWarnPct: "70", approvalRule: "producer", shotCapCredits: "120" }]) {
    const response = await patch(body);
    expect(response.status, JSON.stringify(body)).toBe(410);
    expect(await response.json()).toEqual({ error: RETIRED_SETTING, code: "retired" });
  }
  expect(writes).toEqual([]);
});

test("a value its reader does not understand is refused with a 400, and nothing in the same save is written", async () => {
  const { writes, patch } = load();
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
  for (const atCap of ["producer", "stop", "warn"]) {
    const { writes, patch } = load();
    const response = await patch({ capWarnPct: "70", atCap, editOutputFormat: "mov", defaultVideoModel: "video-engine", notASetting: "x" });
    expect(response.status, atCap).toBe(200);
    expect(writes).toEqual([
      ["capWarnPct", "70", "u1"], ["atCap", atCap, "u1"], ["editOutputFormat", "mov", "u1"], ["defaultVideoModel", "video-engine", "u1"],
    ]);
    expect((await response.json()).changed).toEqual(["capWarnPct", "atCap", "editOutputFormat", "defaultVideoModel"]);
  }
});

test("a member cannot change workspace settings", async () => {
  const { writes, patch } = load("member");
  expect((await patch({ atCap: "stop" })).status).toBe(403);
  expect((await patch({ approvalRule: "producer" })).status, "an admin's route first: a member is refused as before").toBe(403);
  expect(writes).toEqual([]);
});

test("a new budget per production re-locks every production that follows it; the same budget again does not", async () => {
  const { patch, relocks } = load();
  expect((await patch({ productionBudgetCredits: "400" })).status).toBe(200);
  expect(relocks).toEqual([{ budget: true }]);
  expect((await patch({ productionBudgetCredits: "400" })).status).toBe(200);
  expect(relocks).toHaveLength(1);
  expect((await patch({ capWarnPct: "90" })).status).toBe(200);
  expect(relocks).toHaveLength(1);
  expect((await patch({ productionBudgetCredits: "" })).status).toBe(200);
  expect(relocks).toHaveLength(2);
});
