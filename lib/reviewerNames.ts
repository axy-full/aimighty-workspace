import { db } from "./db";
import { storedActorMaskHere } from "./platformOwnerPrivacy";

/**
 * Who marked a take, as a reader may be told. `review_by`, `picked_by` and `approved_by` hold a display name; a few rows hold an account id instead (the starter's
 * demo take once did). An account id is never output: it is read through this workspace's own `users` row to the name, and the name through the owner mask (the
 * platform owner reads "Particl support" outside the house, lib/platformOwnerPrivacy.ts). An id that names no one here reads as nothing.
 */
export const isAccountId = (value: unknown): value is string => typeof value === "string" && /^usr_/.test(value);

/** A lookup for these stored values: built with one read of this workspace's users (only when an account id is among them) and one of its members for the mask. */
export async function readableActors(values: Iterable<unknown>): Promise<(value: unknown) => string | null> {
  const present = [...new Set([...values].filter((v): v is string => typeof v === "string" && v !== ""))];
  if (!present.length) return () => null;
  const ids = present.filter(isAccountId);
  const names = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const rows = (await db().execute({ sql: `SELECT id, name FROM users WHERE id IN (${chunk.map(() => "?").join(",")})`, args: chunk }).catch(() => ({ rows: [] as { id?: unknown; name?: unknown }[] }))).rows;
    for (const row of rows) if (row.name) names.set(String(row.id), String(row.name));
  }
  const shown = await storedActorMaskHere();
  return (value) => {
    if (typeof value !== "string" || value === "") return null;
    if (isAccountId(value)) { const name = names.get(value); return name ? String(shown(name)) : null; }
    return String(shown(value));
  };
}
