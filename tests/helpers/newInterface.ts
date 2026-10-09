import type { APIRequestContext } from "@playwright/test";
import { createClient } from "@libsql/client";
import { INTERFACE_ROW, cleanRollout, withWorkspace } from "../../lib/shell/new-interface-model";
import { localPlatformDbUrl, signInLocally } from "./workbenchLocal";

/**
 * Test helpers for the per-workspace "new interface" switch (lib/shell/new-interface.ts). Every switch-on spec of every
 * stream turns it on through these. They write the row in the LOCAL platform database the spec's own server uses
 * (`PW_PLATFORM_DATABASE_URL`, refused unless it is a file), the way `signInLocally` files its invitations. They never call
 * an admin endpoint: the real route is the platform owner's, and tests never touch a deployed one.
 */

/** Turns the switch on or off for one workspace of the local server. Takes effect on that workspace's next page load. */
export async function setNewInterface(workspaceId: string, on = true): Promise<void> {
  const db = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try {
    const rs = await db.execute({ sql: "SELECT value FROM platform_layer WHERE key = ?", args: [INTERFACE_ROW] });
    const raw = (rs.rows[0] as { value?: unknown } | undefined)?.value;
    let stored: unknown = null;
    try { stored = typeof raw === "string" ? JSON.parse(raw) : null; } catch { /* unreadable: starts again from off */ }
    const next = withWorkspace(cleanRollout(stored), workspaceId, on);
    if (!next) throw new Error(`Cannot switch ${workspaceId}: not a workspace id.`);
    await db.execute({
      sql: `INSERT INTO platform_layer (key, value, updated_at, updated_by) VALUES (?,?,?,?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      args: [INTERFACE_ROW, JSON.stringify(next), Date.now(), "test"],
    });
  } finally {
    db.close();
  }
}

/** Turns it on for every workspace of the local server, or off again. */
export async function setNewInterfaceEveryone(everyone: boolean): Promise<void> {
  const db = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try {
    const rs = await db.execute({ sql: "SELECT value FROM platform_layer WHERE key = ?", args: [INTERFACE_ROW] });
    const raw = (rs.rows[0] as { value?: unknown } | undefined)?.value;
    let stored: unknown = null;
    try { stored = typeof raw === "string" ? JSON.parse(raw) : null; } catch { /* as above */ }
    const next = { ...cleanRollout(stored), everyone };
    await db.execute({
      sql: `INSERT INTO platform_layer (key, value, updated_at, updated_by) VALUES (?,?,?,?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      args: [INTERFACE_ROW, JSON.stringify(next), Date.now(), "test"],
    });
  } finally {
    db.close();
  }
}

/** `signInLocally`, then the switch turned on for the workspace it made: a signed-in session that sees the new interface. */
export async function signInWithNewInterface(api: APIRequestContext, name = "Workbench Tester") {
  const signed = await signInLocally(api, name);
  await setNewInterface(signed.workspace.id, true);
  return signed;
}
