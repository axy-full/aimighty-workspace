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
