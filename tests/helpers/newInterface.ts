import type { APIRequestContext } from "@playwright/test";
import { createClient } from "@libsql/client";
import { signInLocally, localPlatformDbUrl } from "./workbenchLocal";

/**
 * A signed-in local session. The name predates the redesign switch and is kept for the demo streams' specs: their
 * session sees today's screens.
 */
export async function signInWithNewInterface(api: APIRequestContext, name = "Workbench Tester") {
  return signInLocally(api, name);
}

/**
 * A signed-in local session whose fresh workspace sees the interface being built from design/particl-prototype-12
 * (lib/newInterface.ts): the workspace is added to the site setting `newInterfaceWorkspaces` in the local platform
 * database, as the platform owner would from /admin. Local servers only (signInLocally checks).
 */
export async function signInToRedesign(api: APIRequestContext, name = "Redesign Tester") {
  const signed = await signInLocally(api, name);
  const db = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try {
    const row = await db.execute({ sql: "SELECT value FROM platform_layer WHERE key = 'site'", args: [] });
    const site = row.rows.length ? JSON.parse(String(row.rows[0].value)) as Record<string, unknown> : {};
    const listed = Array.isArray(site.newInterfaceWorkspaces) ? (site.newInterfaceWorkspaces as string[]) : [];
    /* Newest first and capped, so a long local run never pushes the list past the setting's limit. */
    site.newInterfaceWorkspaces = [signed.workspace.id, ...listed.filter((id) => id !== signed.workspace.id)].slice(0, 40);
    await db.execute({
      sql: `INSERT INTO platform_layer (key, value, updated_at, updated_by) VALUES ('site', ?, ?, 'test')
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      args: [JSON.stringify(site), Date.now()],
    });
  } finally {
    db.close();
  }
  return signed;
}
