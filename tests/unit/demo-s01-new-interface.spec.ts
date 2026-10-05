import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadRoute } from "../helpers/routeModule";
import { INTERFACE_ROW, cleanRollout, rolloutIncludes, withWorkspace } from "../../lib/shell/new-interface-model";

/**
 * The per-workspace "new interface" switch (lib/shell/new-interface*.ts): one row of the platform database's existing
 * key/value table. Off by default; a workspace admin cannot flip it; the list never reaches a browser.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-s01-switch-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";

const read = (...file: string[]) => readFileSync(path.join(process.cwd(), ...file), "utf8");

test("the stored row is cleaned: well-formed ids only, no repeats, at most 500, junk reads as off", () => {
  expect(cleanRollout(null)).toEqual({ everyone: false, workspaces: [] });
  expect(cleanRollout("on")).toEqual({ everyone: false, workspaces: [] });
  expect(cleanRollout({ everyone: "yes", workspaces: "ws_a" })).toEqual({ everyone: false, workspaces: [] });
  expect(cleanRollout({ everyone: true, workspaces: ["ws_a", "ws_a", "", 7, null, "has space", "ws_b"] })).toEqual({ everyone: true, workspaces: ["ws_a", "ws_b"] });
  const many = Array.from({ length: 900 }, (_, i) => `ws_${i}`);
  expect(cleanRollout({ workspaces: many }).workspaces).toHaveLength(500);
  /* Only `everyone: true` counts as everyone, never a truthy value. */
  expect(cleanRollout({ everyone: 1 }).everyone).toBe(false);
});

test("a workspace is on only when listed, or for everyone; never a missing one", () => {
  const some = { everyone: false, workspaces: ["ws_a"] };
  expect(rolloutIncludes(some, "ws_a")).toBe(true);
  expect(rolloutIncludes(some, "ws_b")).toBe(false);
  expect(rolloutIncludes(some, null)).toBe(false);
  expect(rolloutIncludes(some, undefined)).toBe(false);
  expect(rolloutIncludes(some, "")).toBe(false);
  expect(rolloutIncludes({ everyone: true, workspaces: [] }, "ws_any")).toBe(true);
  expect(rolloutIncludes({ everyone: true, workspaces: [] }, null)).toBe(false);
});

test("turning one workspace on or off changes only that workspace, and refuses what is not an id", () => {
  const on = withWorkspace({ everyone: false, workspaces: ["ws_a"] }, "ws_b", true)!;
  expect(on.workspaces.sort()).toEqual(["ws_a", "ws_b"]);
  expect(withWorkspace(on, "ws_b", true)!.workspaces.filter((id) => id === "ws_b")).toHaveLength(1);
  expect(withWorkspace(on, "ws_a", false)).toEqual({ everyone: false, workspaces: ["ws_b"] });
  expect(withWorkspace({ everyone: true, workspaces: [] }, "ws_a", true)!.everyone).toBe(true);
  expect(withWorkspace(on, "not an id", true)).toBeNull();
  const full = { everyone: false, workspaces: Array.from({ length: 500 }, (_, i) => `ws_${i}`) };
  expect(withWorkspace(full, "ws_new", true)).toBeNull();
  expect(withWorkspace(full, "ws_3", true)).not.toBeNull();
});

test("the server reads and writes the one row; off until someone turns it on; a flip shows at once", async () => {
  const { newInterfaceEnabled, readRollout, setNewInterfaceEveryone, setWorkspaceNewInterface } = await import("../../lib/shell/new-interface.server");
  const { platformDb } = await import("../../lib/platform");
  expect(await readRollout()).toEqual({ everyone: false, workspaces: [] });
  expect(await newInterfaceEnabled("ws_a")).toBe(false);
  expect(await newInterfaceEnabled(null)).toBe(false);
  await setWorkspaceNewInterface("ws_a", true, "owner");
  expect(await newInterfaceEnabled("ws_a")).toBe(true);
  expect(await newInterfaceEnabled("ws_b")).toBe(false);
  await setNewInterfaceEveryone(true, "owner");
  expect(await newInterfaceEnabled("ws_b")).toBe(true);
  await setNewInterfaceEveryone(false, "owner");
  expect(await newInterfaceEnabled("ws_b")).toBe(false);
  expect(await newInterfaceEnabled("ws_a")).toBe(true);
  await setWorkspaceNewInterface("ws_a", false, "owner");
  expect(await newInterfaceEnabled("ws_a")).toBe(false);
  /* The existing table, under its own key: nothing else in it moved, and no other table or column was touched. */
  const rows = (await platformDb().execute({ sql: "SELECT key, updated_by FROM platform_layer WHERE key = ?", args: [INTERFACE_ROW] })).rows as unknown as { key: string; updated_by: string }[];
  expect(rows).toEqual([{ key: INTERFACE_ROW, updated_by: "owner" }]);
});

test("a stored row that cannot be read is off, never on", async () => {
  const { newInterfaceEnabled } = await import("../../lib/shell/new-interface.server");
  const { platformDb } = await import("../../lib/platform");
  await platformDb().execute({ sql: "UPDATE platform_layer SET value = ? WHERE key = ?", args: ["{not json", INTERFACE_ROW] });
  expect(await newInterfaceEnabled("ws_a")).toBe(false);
  await platformDb().execute({ sql: "UPDATE platform_layer SET value = ? WHERE key = ?", args: ["[]", INTERFACE_ROW] });
  expect(await newInterfaceEnabled("ws_a")).toBe(false);
});

test("the platform layer's own reader ignores the row: plans, caps and defaults are untouched", async () => {
  const { getPlatformLayer, platformLayerState } = await import("../../lib/platform");
  const { setNewInterfaceEveryone } = await import("../../lib/shell/new-interface.server");
  await setNewInterfaceEveryone(true, "owner");
  const state = await platformLayerState();
  expect(state.stored).not.toContain(INTERFACE_ROW);
  expect(JSON.stringify(await getPlatformLayer())).not.toContain(INTERFACE_ROW);
  await setNewInterfaceEveryone(false, "owner");
});

test("only the platform owner flips it: the admin routes answer 403 to anyone else and never write", async () => {
  const calls: unknown[] = [];
  const forbidden = { response: new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 }) };
  const allowed = { response: null, user: { id: "owner_1" } };
  let session: typeof forbidden | typeof allowed = forbidden;
  const everyone = loadRoute<{ PATCH: (req: Request) => Promise<Response>; GET: () => Promise<Response> }>("app/api/admin/interface/route.ts", {
    "@/lib/recovery": { recoveryRoute: (fn: unknown) => fn },
    "@/lib/auth": { requireSuperAdmin: async () => session },
    "@/lib/shell/new-interface.server": {
      readRollout: async () => ({ everyone: false, workspaces: ["ws_a"] }),
      setNewInterfaceEveryone: async (value: boolean, by: string) => { calls.push([value, by]); return { everyone: value, workspaces: [] }; },
    },
  });
  const patch = (body: unknown) => everyone.PATCH(new Request("http://localhost/api/admin/interface", { method: "PATCH", body: JSON.stringify(body) }));
  expect((await patch({ everyone: true })).status).toBe(403);
  expect((await everyone.GET()).status).toBe(403);
  expect(calls).toEqual([]);
  session = allowed;
  expect((await patch({ everyone: "yes" })).status).toBe(400);
  expect((await patch({ everyone: true })).status).toBe(200);
  expect(calls).toEqual([[true, "owner_1"]]);
  /* The list of workspaces is a count to the desk, never the ids. */
  expect(await (await everyone.GET()).json()).toEqual({ everyone: false, workspaces: 1 });
});

test("the workspace route takes `newInterface` only after the owner check, only as a boolean, and not for a deleted workspace", () => {
  const route = read("app", "api", "admin", "workspaces", "[id]", "route.ts");
  expect(route.indexOf("requireSuperAdmin()")).toBeGreaterThan(-1);
  expect(route.indexOf("requireSuperAdmin()")).toBeLessThan(route.indexOf("newInterface"));
  expect(route).toMatch(/typeof body\.newInterface !== "boolean"/);
  /* A deleted workspace may only be marked: `newInterface` is not one of the mark keys. */
  expect(route).toMatch(/const markKeys = \["suspended", "reason", "flagged", "note"\]/);
});

test("the list of workspaces never reaches a browser: the session carries one boolean, and no customer route returns the row", () => {
  const bootstrap = read("lib", "shell", "bootstrap.server.ts");
  expect(bootstrap).toMatch(/newInterface: await newInterfaceEnabled\(ctx\.workspace\.id\)/);
  expect(bootstrap).not.toContain("readRollout");
  const session = read("lib", "session.tsx");
  expect(session).toMatch(/newInterface\?: boolean;/);
  for (const file of [["app", "api", "settings", "route.ts"], ["app", "api", "me", "route.ts"]]) {
    const source = read(...file);
    expect(source, file.join("/")).not.toMatch(/new-interface|INTERFACE_ROW|platform_layer/);
  }
  /* The only readers of the server module are the shell's bootstrap and the three admin routes. */
  for (const reader of [["lib", "shell", "bootstrap.server.ts"], ["app", "api", "admin", "interface", "route.ts"], ["app", "api", "admin", "workspaces", "[id]", "route.ts"], ["app", "api", "admin", "invites", "route.ts"]]) {
    expect(read(...reader), reader.join("/")).toContain("new-interface.server");
  }
});

test("a member's own settings route cannot set the switch: nothing there knows the key", () => {
  const settings = read("app", "api", "settings", "route.ts");
  expect(settings).not.toMatch(/newInterface/);
});
