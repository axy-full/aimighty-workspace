import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import { createClient } from "@libsql/client";
import * as archive from "../../lib/archive";

/*
 * Workspace › People › Revoke calls DELETE /api/team/invites/[code]. The link
 * stops working, but the invitation is archived whole, never erased (owner,
 * 2026-09-24: deletes hide or archive only). The route runs against its own
 * scratch database here; the invite table is the route's, the archive is
 * lib/archive's.
 */

const dir = mkdtempSync(path.join(tmpdir(), "particl-invite-revoke-"));
const platform = createClient({ url: `file:${path.join(dir, "platform.db")}` });

function load(workspaceId: string) {
  const mocks: Record<string, unknown> = {
    "next/server": createRequire(path.resolve("package.json"))("next/server"),
    "@/lib/auth": { withTenant: (handler: unknown) => handler, requireAdmin: async () => ({ user: { id: "admin-1", role: "admin" } }) },
    "@/lib/tenant": { requireTenant: () => ({ id: workspaceId }) },
    "@/lib/platform": { platformDb: () => platform, platformReady: async () => {} },
    "@/lib/archive": archive,
  };
  const compiled = ts.transpileModule(readFileSync("app/api/team/invites/[code]/route.ts", "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const mod = { exports: {} as { DELETE: (req: Request, ctx: { params: Promise<{ code: string }> }) => Promise<Response> } };
  new Function("require", "module", "exports", compiled)((name: string) => {
    if (!(name in mocks)) throw new Error("Unexpected route dependency " + name);
    return mocks[name];
  }, mod, mod.exports);
  return (code: string) => mod.exports.DELETE(new Request(`http://localhost/api/team/invites/${code}`, { method: "DELETE" }), { params: Promise.resolve({ code }) });
}

test.beforeAll(async () => {
  await platform.execute("CREATE TABLE workspace_invites(code TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, email TEXT, name TEXT, role TEXT, created_by TEXT, expires_at INTEGER, used_at INTEGER)");
  await platform.execute({
    sql: "INSERT INTO workspace_invites VALUES(?,?,?,?,?,?,?,?),(?,?,?,?,?,?,?,?),(?,?,?,?,?,?,?,?)",
    args: [
      "open-1", "ws-a", "new@example.test", "New Person", "member", "owner-1", 2_000_000_000_000, null,
      "used-1", "ws-a", "joined@example.test", "Joined", "member", "owner-1", 2_000_000_000_000, 1_700_000_000_000,
      "other-1", "ws-b", "else@example.test", "Elsewhere", "admin", "owner-2", 2_000_000_000_000, null,
    ],
  });
});

test("revoking an unused invitation archives the whole row, then the link stops working", async () => {
  const revoke = load("ws-a");
  const response = await revoke("open-1");
  expect(response.status).toBe(200);
  expect((await platform.execute("SELECT code FROM workspace_invites ORDER BY code")).rows.map((r) => r.code)).toEqual(["other-1", "used-1"]);
  const kept = (await platform.execute("SELECT * FROM archived_rows WHERE table_name='workspace_invites'")).rows;
  expect(kept).toHaveLength(1);
  expect(kept[0]).toMatchObject({ reason: "invite revoked", archived_by: "admin-1" });
  expect(JSON.parse(String(kept[0].body))).toEqual({
    code: "open-1", workspace_id: "ws-a", email: "new@example.test", name: "New Person", role: "member", created_by: "owner-1", expires_at: 2_000_000_000_000, used_at: null,
  });
});

test("a used invitation and another workspace's invitation are neither archived nor removed", async () => {
  expect((await load("ws-a")("used-1")).status).toBe(200);
  /* Scoped to the caller's workspace: ws-a cannot reach ws-b's invitation by its code. */
  expect((await load("ws-a")("other-1")).status).toBe(200);
  expect((await platform.execute("SELECT code FROM workspace_invites ORDER BY code")).rows.map((r) => r.code)).toEqual(["other-1", "used-1"]);
  expect((await platform.execute("SELECT count(*) AS n FROM archived_rows")).rows[0].n).toBe(1);
});
