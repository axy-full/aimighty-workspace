import { test, expect } from "@playwright/test";
import { createClient } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { localPlatformDbUrl, signInLocally } from "./helpers/workbenchLocal";

/**
 * Delete is soft (FINAL_SPEC §1 step 1): PATCH /api/jobs/:id { trashed }
 * hides a render and keeps its bytes for good — nothing is erased (owner,
 * 2026-09-24); { trashed: false } brings it back whole. Through the real
 * route on a local mock server, with the workspace database read directly.
 */
test("a trashed render hides, keeps its bytes indefinitely, and comes back on restore", async ({ request }) => {
  const account = await signInLocally(request);
  const me = await request.get("/api/me").then((r) => r.json());
  const headers = { "X-Workbench-Scope": `particl-active-${account.workspace.id}-${me.id}` };
  const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  const tenantRow = (await platform.execute({ sql: "SELECT db_url FROM workspaces WHERE id=?", args: [account.workspace.id] })).rows[0];
  const tenant = createClient({ url: String(tenantRow.db_url), timeout: 10_000 });
  try {
    /* A settled render with stored bytes, planted as the mock engine would leave it. */
    const id = `gen_trash_${randomUUID().slice(0, 8)}`;
    const now = Date.now();
    await tenant.execute({
      sql: `INSERT INTO generations(id,project_id,kind,model,prompt,params,status,stored_url,bytes,provider,created_by,created_at,updated_at,deleted)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,0)`,
      args: [id, null, "image", "mock/image", "a harbour at dawn", "{}", "succeeded", "https://example.test/mock/" + id, 1234, "mock", me.id, now, now],
    });
    const visible = async () => Number((await tenant.execute({ sql: "SELECT deleted FROM generations WHERE id=?", args: [id] })).rows[0].deleted) === 0;
    expect(await visible()).toBe(true);

    const trashed = await request.patch(`/api/jobs/${id}`, { headers, data: { trashed: true } });
    expect(trashed.ok(), await trashed.text()).toBe(true);
    expect(await visible()).toBe(false);
    const cleanup = (await tenant.execute({ sql: "SELECT lease, lease_until FROM generation_deletions WHERE id=?", args: [id] })).rows[0];
    // No sweeper claims it and no removal is scheduled.
    expect(cleanup.lease).toBeNull();
    expect(cleanup.lease_until).toBeNull();
    const bytes = (await tenant.execute({ sql: "SELECT stored_url, bytes FROM generations WHERE id=?", args: [id] })).rows[0];
    expect(String(bytes.stored_url)).toContain(id);
    expect(Number(bytes.bytes)).toBe(1234);

    const restored = await request.patch(`/api/jobs/${id}`, { headers, data: { trashed: false } });
    expect(restored.ok(), await restored.text()).toBe(true);
    expect(await visible()).toBe(true);
    expect((await tenant.execute({ sql: "SELECT 1 FROM generation_deletions WHERE id=?", args: [id] })).rows).toHaveLength(0);

    /* Restoring something that is not trashed is a no-op; a render still running cannot be trashed. */
    expect((await request.patch(`/api/jobs/${id}`, { headers, data: { trashed: false } })).ok()).toBe(true);
    await tenant.execute({ sql: "UPDATE generations SET status='running' WHERE id=?", args: [id] });
    const active = await request.patch(`/api/jobs/${id}`, { headers, data: { trashed: true } });
    expect(active.status()).toBe(409);
    expect((await active.json()).error).toContain("still active");
    expect((await request.patch("/api/jobs/gen_does_not_exist", { headers, data: { trashed: true } })).status()).toBe(409);
  } finally {
    tenant.close();
    platform.close();
  }
});
