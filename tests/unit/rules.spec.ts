import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import ts from "typescript";
import { mergeRules, rulesBlock, DEFAULT_RULES } from "../../lib/platformLayer";

/** The rule library per workspace: platform rules inherited and switchable off, the team's own after them, every rule with its source. */
test("a workspace inherits the platform's rules, switches one off, and adds its own", () => {
  const own = [{ id: "rule_a", text: "Our brand never shows logos in the first frame.", scope: "video" as const, apply: "prompt" as const, on: true }];
  const merged = mergeRules(DEFAULT_RULES, own, ["one-move", "not-a-rule"]);
  expect(merged.length).toBe(DEFAULT_RULES.length + 1);
  expect(merged.filter((r) => r.source === "platform").length).toBe(DEFAULT_RULES.length);
  expect(merged.find((r) => r.id === "one-move")).toMatchObject({ on: false, source: "platform" });
  expect(merged.find((r) => r.id === "positive")).toMatchObject({ on: true, source: "platform" });
  expect(merged[merged.length - 1]).toMatchObject({ id: "rule_a", source: "workspace", on: true });
  // A switched-off rule is listed but not applied; the workspace's own is appended in scope.
  expect(rulesBlock(merged, "video", "writer", "seedance-2")).not.toContain("One camera move");
  expect(rulesBlock(merged, "video", "prompt", "seedance-2")).toContain("Our brand never shows logos");
  expect(rulesBlock(merged, "image", "prompt", "nano-banana")).not.toContain("Our brand never shows logos");
  expect(mergeRules(DEFAULT_RULES, [], []).every((r) => r.on === DEFAULT_RULES.find((d) => d.id === r.id)!.on)).toBe(true);
});

/* ── Who may change them (audit, 25 September) ─────────────────────────── */

type Handler = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
function rulesRoute(file: string, admin: boolean, writes: string[]): Record<string, Handler> {
  const refuse = { response: Response.json({ error: "Admins only" }, { status: 403 }) };
  const dependencies: Record<string, unknown> = {
    "next/server": createRequire(path.resolve("package.json"))("next/server"),
    "@/lib/auth": {
      withTenant: (handler: Handler) => handler,
      requireUser: async () => ({ user: { id: "member", role: "member" } }),
      requireAdmin: async () => (admin ? { user: { id: "admin", role: "admin" } } : refuse),
    },
    "@/lib/rules": {
      effectiveRules: async () => mergeRules(DEFAULT_RULES, [], []),
      ruleProblem: () => null,
      addRule: async (input: { text: string }) => { writes.push(`add:${input.text}`); return { id: "rule_x", text: input.text, scope: "all", apply: "prompt", on: true }; },
      patchRule: async (id: string) => { writes.push(`patch:${id}`); return { id, text: "x", scope: "all", apply: "prompt", on: true }; },
      deleteRule: async (id: string) => { writes.push(`delete:${id}`); return true; },
      setPlatformRuleOff: async (id: string) => { writes.push(`off:${id}`); return [id]; },
    },
    "@/lib/platform": { getPlatformLayer: async () => ({ rules: DEFAULT_RULES }) },
  };
  const compiled = ts.transpileModule(readFileSync(path.resolve(file), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const mod = { exports: {} as Record<string, Handler> };
  new Function("require", "module", "exports", compiled)((name: string) => {
    if (!(name in dependencies)) throw new Error("Unexpected import " + name);
    return dependencies[name];
  }, mod, mod.exports);
  return mod.exports;
}
const call = (handler: Handler, method: string, body?: unknown, id = "one-move") => handler(
  new Request("http://localhost/api/rules", { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }),
  { params: Promise.resolve({ id }) },
);

test("anyone signed in reads the rules; only an admin writes, switches or removes one", async () => {
  for (const admin of [false, true]) {
    const writes: string[] = [];
    const list = rulesRoute("app/api/rules/route.ts", admin, writes);
    const one = rulesRoute("app/api/rules/[id]/route.ts", admin, writes);
    expect((await call(list.GET, "GET")).status).toBe(200);
    const statuses = [
      (await call(list.POST, "POST", { text: "No logos in the first frame." })).status,
      (await call(one.PATCH, "PATCH", { on: false }, "one-move")).status,
      (await call(one.PATCH, "PATCH", { on: false }, "rule_x")).status,
      (await call(one.DELETE, "DELETE", undefined, "rule_x")).status,
    ];
    if (admin) {
      expect(statuses).toEqual([200, 200, 200, 200]);
      expect(writes).toEqual(["add:No logos in the first frame.", "off:one-move", "patch:rule_x", "delete:rule_x"]);
    } else {
      expect(statuses).toEqual([403, 403, 403, 403]);
      expect(writes).toEqual([]);
    }
  }
});
