import type { Transaction } from "@libsql/client";
import { db, ready } from "./db";
import { MediaSourceError, referencedMedia } from "./mediaBindings";
import { assertUploadsOpenable, warmOpenable } from "./uploadAccess";

/** What the record this write replaces already holds (read inside the same transaction), so only what the write adds is asked. */
export type PriorOf = (tx: Transaction) => Promise<unknown>;

/** Validate and attach in the same write transaction used by guarded deletion. */
export async function validateMediaSources(
  tx: Transaction,
  value: unknown,
  priorOf?: PriorOf,
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
  /* The writer must be able to open every upload it ADDS (lib/uploadAccess.ts): attaching someone's private upload to shared work is not a way to open it.
     What the record already holds is not asked again, so saving never fails over what is already there and costs nothing under the write lock. */
  if (refs.uploads.size) {
    const held = priorOf ? referencedMedia(await priorOf(tx)).uploads : new Set<string>();
    await assertUploadsOpenable(tx, [...refs.uploads].filter((id) => !held.has(id)));
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
  priorOf?: PriorOf,
): Promise<T> {
  /* The check for who may open what the write adds is asked here, outside the write lock, and remembered; inside the lock it answers from memory. */
  await warmOpenable(value, undefined, priorOf ? await priorOf(db() as unknown as Transaction).catch(() => undefined) : undefined);
  return mediaMutation(async (tx) => {
    await validateMediaSources(tx, value, priorOf);
    return write(tx);
  });
}
