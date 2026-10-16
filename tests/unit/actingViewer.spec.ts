import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TenantWorkspace } from "../../lib/tenant";

/**
 * Who a request acts for (lib/actingViewer.ts): the signed-in person, an Atomik run's owner as a member, or nobody. Local temporary databases only.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-acting-viewer-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
const ws = { id: "ws_legacy", slug: "ws_legacy", name: "ws_legacy", legacy: true, dbUrl: `file:${path.join(dir, "ws_legacy.db")}`, dbToken: null, keys: {}, usesPlatformKeys: true, allowanceUsd: null, gatewayKeyId: null, ownerId: "u_test", createdAt: 0, suspendedAt: null, suspendedReason: null, flaggedAt: null, flagNote: null, concurrency: 50, rendersPerHour: 1000, storageQuotaBytes: null, deletedAt: null } as TenantWorkspace;
const person = (id: string, role = "member") => ({ id, email: `${id}@example.invalid`, name: id, role, owner: false, disabled: false, createdAt: 0, lastSeen: null });

test("the signed-in person, an Atomik run's owner as a member, and nobody", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { actingViewer } = await import("../../lib/actingViewer");
  const { rigAgentReady } = await import("../../lib/workbench/rig-agent-store");
  const { db } = await import("../../lib/db");
  await runInTenant(ws, async () => {
    await rigAgentReady();
    await db().execute({ sql: "INSERT INTO rig_agent_runs(id,production_id,draft_id,owner,request_id,goal,model,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,0,0)", args: ["run_owned", "prod_x", "draft_x", "u_runner", "req_1", "goal", "auto", "finished"] });
    await db().execute({ sql: "INSERT INTO rig_agent_runs(id,production_id,draft_id,owner,request_id,goal,model,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,0,0)", args: ["run_by_agent", "prod_x", "draft_x", "agent:run_owned", "req_2", "goal", "auto", "finished"] });
  }, { user: person("u_runner") } as never);
  /* A person at the keyboard (an admin too) is themselves. */
  await runInTenant(ws, async () => { expect(await actingViewer()).toEqual({ id: "u_admin", role: "admin" }); }, { user: person("u_admin", "admin") } as never);
  /* An Atomik run is the person who started it, as a member (never the run's own role). */
  await runInTenant(ws, async () => { expect(await actingViewer()).toEqual({ id: "u_runner", role: "member" }); }, { user: person("agent:run_owned", "admin") } as never);
  /* Nobody: no user, an unknown run, a run whose owner is another agent, a malformed agent id. */
  await runInTenant(ws, async () => { expect(await actingViewer()).toBeNull(); }, {} as never);
  for (const id of ["agent:run_missing", "agent:run_by_agent", "agent:", "agent:run_owned' OR 1=1 --"]) await runInTenant(ws, async () => { expect(await actingViewer(), id).toBeNull(); }, { user: person(id) } as never);
});
