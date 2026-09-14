import type { Transaction } from "@libsql/client";
import { db, ready } from "./db";
import { MediaSourceError, referencedMedia } from "./mediaBindings";

/** Validate and attach in the same write transaction used by guarded deletion. */
export async function validateMediaSources(
  tx: Transaction,
  value: unknown,
): Promise<void> {
  const refs = referencedMedia(value);
  for (const [table, ids] of [
    ["uploads", refs.uploads],
    ["generations", refs.generations],
  ] as const) {
    // Bound SQL parameters even for a large saved board or reference list.
    const wanted = [...ids];
    for (let start = 0; start < wanted.length; start += 100) {
      const chunk = wanted.slice(start, start + 100);
      const rows = await tx.execute({
        sql: `SELECT id FROM ${table} WHERE id IN (${chunk.map(() => "?").join(",")})${table === "generations" ? " AND deleted=0" : ""}`,
        args: chunk,
      });
      if (rows.rows.length !== chunk.length)
        throw new MediaSourceError(
          `A referenced ${table === "uploads" ? "upload" : "generation"} is no longer available. Remove or replace it before saving.`,
        );
    }
  }
}

/** Database work only: callbacks must use tx, never db(), storage or a provider. */
export async function mediaMutation<T>(
  write: (tx: Transaction) => Promise<T>,
): Promise<T> {
  await ready();
  const tx = await db().transaction("write");
  try {
    const result = await write(tx);
    await tx.commit();
    return result;
  } catch (error) {
    await tx.rollback().catch(() => {});
    throw error;
  } finally {
    tx.close();
  }
}

export async function withMediaSources<T>(
  value: unknown,
  write: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return mediaMutation(async (tx) => {
    await validateMediaSources(tx, value);
    return write(tx);
  });
}
