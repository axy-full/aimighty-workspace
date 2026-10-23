import { expect } from "@playwright/test";
import type { Client } from "@libsql/client";

/**
 * The house workspace's id is fixed (ws_legacy), so every unit file in a worker shares its job slots and its hourly count in the one platform
 * database. A file that reserves jobs in the house takes a snapshot first and gives back exactly what it reserved afterwards, so a spec that
 * runs after it (houseWorkspace.spec.ts) finds the slots it expects.
 */
const HOUSE = "ws_legacy";

async function houseEventIds(): Promise<Set<string>> {
  const { platformDb, platformReady } = await import("../../lib/platform");
  await platformReady();
  const rows = (await platformDb().execute({ sql: "SELECT id FROM meter_events WHERE workspace_id=?", args: [HOUSE] })).rows;
  return new Set(rows.map((r) => String(r.id)));
}

/** Run `work`, then delete the house's meter events, reservations and debits it created (and nothing that was there before). */
export async function keepingHouseJobsClean<T>(work: () => Promise<T>): Promise<T> {
  const before = await houseEventIds();
  try { return await work(); }
  finally {
    const { platformDb } = await import("../../lib/platform");
    for (const id of await houseEventIds()) {
      if (before.has(id)) continue;
      for (const table of ["generation_reservations", "billing_debits"]) {
        const column = table === "billing_debits" ? "event_id" : "id";
        await platformDb().execute({ sql: `DELETE FROM ${table} WHERE ${column}=?`, args: [id] }).catch(() => undefined);
      }
      await platformDb().execute({ sql: "DELETE FROM meter_events WHERE id=? AND workspace_id=?", args: [id, HOUSE] });
    }
  }
}

/**
 * The browser specs' form, on the local platform database: the jobs one person ran in the house, once they have settled, and their rows
 * keyed by the same job. A browser spec that makes the house for a test person and runs paid work in it (a take, an enhancement, Atomik's
 * planning turn) removes these before it removes the house: left behind, they count against the house's monthly cap (lib/houseCap.ts) in
 * the next spec on the same database that reads it (tests/house-cap-workbench.spec.ts). Only this person's rows in the house, by their
 * ids; nobody else's.
 */
export async function removeHouseJobsOf(db: Client, userId: string) {
  const mine = async () => (await db.execute({ sql: "SELECT id, status FROM meter_events WHERE workspace_id = ? AND created_by = ?", args: [HOUSE, userId] })).rows;
  await expect.poll(async () => (await mine()).filter((row) => row.status === "running").length, { timeout: 60_000, message: "the house's jobs settle before they are removed" }).toBe(0);
  const ids = (await mine()).map((row) => String(row.id));
  if (!ids.length) return;
  const marks = ids.map(() => "?").join(",");
  for (const [table, column] of [["meter_credit_receipts", "event_id"], ["billing_debits", "event_id"], ["generation_reservations", "id"], ["recovery_intents", "id"], ["meter_events", "id"]] as const)
    await db.execute({ sql: `DELETE FROM ${table} WHERE workspace_id = ? AND ${column} IN (${marks})`, args: [HOUSE, ...ids] });
}
