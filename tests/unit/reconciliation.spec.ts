import { test, expect } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { acquireOperationLease, checkpointOperation, finishOperation, operationStatus } from "../../lib/operationLease";
import { reconcileWorkspaces, RECONCILIATION_OPERATION } from "../../lib/reconciliation";

async function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "particl-reconciliation-"));
  const url = `file:${path.join(dir, "platform.db")}`;
  const client = createClient({ url });
  const other = createClient({ url });
  await client.execute("CREATE TABLE workspaces(id TEXT PRIMARY KEY, deleted_at INTEGER)");
  await client.execute("INSERT INTO workspaces VALUES('a',NULL),('b',NULL),('c',NULL),('deleted',1)");
  return { client, other, close() { client.close(); other.close(); rmSync(dir, { recursive: true, force: true }); } };
}

const success = { attempted: 1, failed: 0, completed: 1, deferred: false };

test("deferred final-tenant work and skipped cleanup never produce a healthy cycle", async () => {
  for (const reason of ["tenant", "cleanup", "earlier-page"] as const) {
    const f = await fixture();
    let clock = 1000;
    try {
      const deps = { client: f.client, clock: () => clock, budgetMs: 100, maxWorkspaces: reason === "earlier-page" ? 2 : 25,
        visit: async (id: string) => {
          if (id === "c" && reason === "cleanup") clock += 150;
          return { failed: false, completed: 0, deferred: reason === "tenant" ? id === "c" : reason === "earlier-page" && id === "a" };
        }, cleanup: async () => ({ failed: 0 }) };
      await reconcileWorkspaces(deps);
      if (reason === "earlier-page") { clock += 600_000; await reconcileWorkspaces(deps); }
      const status = await operationStatus(f.client, RECONCILIATION_OPERATION, clock);
      expect(status.lastCycleAt, reason).toBeNull();
      expect(status.healthy, reason).toBe(false);
      expect(status.status, reason).toBe("partial");
    } finally { f.close(); }
  }
});

test("independent connections elect one lease owner and fence an expired owner's writes", async () => {
  const f = await fixture();
  try {
    const claims = await Promise.all([
      acquireOperationLease(f.client, "test", 100, 1000),
      acquireOperationLease(f.other, "test", 100, 1000),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const original = claims.find(Boolean)!;
    await checkpointOperation(f.client, original, "a", false, 1010);
    const successor = (await acquireOperationLease(f.other, "test", 100, 1101))!;
    expect(successor.cursor).toBe("a");
    await expect(checkpointOperation(f.client, original, "WRONG", false, 1102)).rejects.toThrow("OPERATION_LEASE_LOST");
    await expect(finishOperation(f.client, original, success, true, 1102)).rejects.toThrow("OPERATION_LEASE_LOST");
    await finishOperation(f.other, successor, success, true, 1110);
    const interruptedCycle = await operationStatus(f.client, "test", 1111);
    expect(interruptedCycle.healthy).toBe(false);
    expect(interruptedCycle.status).toBe("failed");
  } finally { f.close(); }
});

test("fair cursor continues beyond a broken tenant, then a full clean cycle restores health", async () => {
  const f = await fixture();
  const visits: string[] = [];
  let failB = true;
  let clock = 1000;
  const deps = {
    client: f.client, maxWorkspaces: 2, clock: () => clock,
    visit: async (id: string) => { visits.push(id); if (id === "b" && failB) throw new Error("provider secret"); return { failed: false, completed: 1 }; },
    cleanup: async () => ({ failed: 0 }),
  };
  try {
    expect(await reconcileWorkspaces(deps)).toMatchObject({ ok: false, attempted: 2, failed: 1, deferred: true });
    clock += 600_000;
    expect(await reconcileWorkspaces(deps)).toMatchObject({ ok: true, attempted: 1, cycleComplete: true });
    expect(visits).toEqual(["a", "b", "c"]);
    expect((await operationStatus(f.client, RECONCILIATION_OPERATION, clock)).healthy).toBe(false);
    failB = false;
    clock += 600_000;
    await reconcileWorkspaces(deps);
    clock += 600_000;
    await reconcileWorkspaces(deps);
    expect((await operationStatus(f.client, RECONCILIATION_OPERATION, clock)).healthy).toBe(true);
    expect(JSON.stringify(await operationStatus(f.client, RECONCILIATION_OPERATION, clock))).not.toContain("secret");
  } finally { f.close(); }
});

test("execution budget checkpoints completed tenants and resumes without repeating them", async () => {
  const f = await fixture();
  let clock = 1000;
  const visited: string[] = [];
  const deps = {
    client: f.client, clock: () => clock, budgetMs: 100,
    visit: async (id: string) => { visited.push(id); clock += 150; return { failed: false, completed: 0 }; },
    cleanup: async () => ({ failed: 0 }),
  };
  try {
    expect(await reconcileWorkspaces(deps)).toMatchObject({ attempted: 1, deferred: true, cycleComplete: false });
    expect(await reconcileWorkspaces(deps)).toMatchObject({ attempted: 1, deferred: true });
    expect(visited).toEqual(["a", "b"]);
  } finally { f.close(); }
});

test("overlapping sweep performs no tenant work, and stale or failed maintenance is unhealthy", async () => {
  const f = await fixture();
  let visits = 0;
  try {
    const lease = (await acquireOperationLease(f.other, RECONCILIATION_OPERATION, 330_000, 1000))!;
    const result = await reconcileWorkspaces({ client: f.client, clock: () => 1001,
      visit: async () => { visits++; return { failed: false, completed: 0 }; }, cleanup: async () => ({ failed: 0 }) });
    expect(result).toEqual({ ok: true, skipped: "already_running" });
    expect(visits).toBe(0);
    await finishOperation(f.other, lease, success, true, 1010);
    expect((await operationStatus(f.client, RECONCILIATION_OPERATION, 1020)).healthy).toBe(true);
    expect((await operationStatus(f.client, RECONCILIATION_OPERATION, 1_900_000)).healthy).toBe(false);
    const failed = await reconcileWorkspaces({ client: f.client, clock: () => 1_901_000,
      visit: async () => ({ failed: false, completed: 0 }), cleanup: async () => ({ failed: 1 }) });
    expect(failed.ok).toBe(false);
    expect((await operationStatus(f.client, RECONCILIATION_OPERATION, 1_901_001)).healthy).toBe(false);
  } finally { f.close(); }
});
