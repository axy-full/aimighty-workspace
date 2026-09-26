import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import type { TenantWorkspace } from "../../lib/tenant";

/**
 * One @Name, one member (audit, 25 September): neither a rename nor a
 * workspace-wide add may leave two cast members a production can see under
 * the same name, because a citation then resolves to whichever sorted last.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-cast-names-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";

type Handler = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
async function route(file: string): Promise<Record<string, Handler>> {
  const dependencies: Record<string, unknown> = {
    "next/server": createRequire(path.resolve("package.json"))("next/server"),
    "@/lib/db": await import("../../lib/db"),
    "@/lib/archive": await import("../../lib/archive"),
    "@/lib/tenant": await import("../../lib/tenant"),
    "@/lib/mediaMutation": await import("../../lib/mediaMutation"),
    "@/lib/cast": await import("../../lib/cast"),
    "@/lib/workbench/request-scope": { workbenchScopeProblem: () => null },
    "@/lib/auth": { withTenant: (handler: Handler) => handler, requireUser: async () => ({ user: { id: "owner", name: "Owner" } }) },
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
const send = (handler: Handler, method: string, body: unknown, id = "") => handler(
  new Request("http://localhost/api/cast", { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  { params: Promise.resolve({ id }) },
);

test("a rename or a workspace-wide add cannot give two visible members one @Name", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const ws = { id: "cast", name: "cast", slug: "cast", legacy: false, dbUrl: `file:${path.join(dir, "cast.db")}`, dbToken: null, keys: {}, usesPlatformKeys: false } as TenantWorkspace;
  await runInTenant(ws, async () => {
    const { db, ready } = await import("../../lib/db");
    const { castNameClash } = await import("../../lib/cast");
    await ready();
    for (const id of ["p1", "p2"]) await db().execute({ sql: `INSERT INTO projects (id, name, created_at) VALUES (?,?,0)`, args: [id, id] });
    const cast = await route("app/api/cast/route.ts");
    const castId = await route("app/api/cast/[id]/route.ts");
    const add = async (name: string, projectId: string | null) => send(cast.POST, "POST", { name, projectId });

    const maya = await (await add("Maya", "p1")).json();
    const maya2 = await (await add("Maya2", "p1")).json();
    expect((await add("Maya", "p2")).status).toBe(200); // another production's Maya is its own

    // A rename onto a name this production already cites is refused, and nothing changes.
    const clash = await send(castId.PATCH, "PATCH", { name: "maya" }, maya2.member.id);
    expect(clash.status).toBe(409);
    expect((await clash.json()).error).toContain("already cast");
    const kept = await db().execute({ sql: `SELECT name FROM cast_members WHERE id = ?`, args: [maya2.member.id] });
    expect(kept.rows[0].name).toBe("Maya2");
    // Renaming a member to its own name, in another case, is fine.
    expect((await send(castId.PATCH, "PATCH", { name: "MAYA" }, maya.member.id)).status).toBe(200);
    // Other edits are untouched by the check.
    expect((await send(castId.PATCH, "PATCH", { description: "Lead." }, maya2.member.id)).status).toBe(200);

    // A workspace-wide Maya would be seen by both productions next to their own.
    expect((await add("Maya", null)).status).toBe(409);
    expect((await add("Harbour", null)).status).toBe(200);
    // …and a production can no longer take a name the whole workspace already cites.
    expect((await add("harbour", "p1")).status).toBe(409);

    expect(await castNameClash(db(), "Otto", null)).toBe(false);
    expect(await castNameClash(db(), "maya", "p1", maya.member.id)).toBe(false);
    expect(await castNameClash(db(), "maya", "p1")).toBe(true);
  });
});
