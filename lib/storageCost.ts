import { db, ready, now } from "./db";
import { originalSize } from "./storage";
import { originalKindOf } from "./originalMedia";
import { DEMO_FIXTURE_CLIP_URL, DEMO_PREVIEW_URL_PREFIX } from "./demoProduction";

/**
 * What it costs to KEEP what we have made.
 *
 * Every other figure in this app is paid once, at the moment of the render.
 * Storage is rent: charged every month for as long as a render is kept, and
 * the only line on the ledger that grows while nobody is doing anything.
 *
 * The surprise, once measured: holding a render is nearly free and SERVING
 * it is not. In Mumbai a gigabyte costs 2.5 cents a month to store and 6.7
 * cents every time it travels. A fifteen-megabyte clip therefore costs about
 * a third of a cent a year to keep, and a tenth of a cent every time someone
 * watches it — so a single view costs roughly what a month of storage does,
 * and a clip watched weekly costs far more to deliver than to hold.
 *
 * Rates are bom1's, read from Vercel's regional pricing on 4 Sep 2026. They
 * are NOT the headline numbers: those are iad1's, and Mumbai is dearer on
 * both storage and transfer.
 */

/** USD per GB-month at rest, bom1. */
export const STORAGE_USD_PER_GB_MONTH =
  Number(process.env.BLOB_USD_PER_GB_MONTH ?? 0.025);

/** USD per GB delivered, bom1. Downloads only; uploads are free. */
export const TRANSFER_USD_PER_GB =
  Number(process.env.BLOB_USD_PER_GB_TRANSFER ?? 0.067);

const GB = 1_000_000_000;

export const monthlyUsd = (bytes: number) => (bytes / GB) * STORAGE_USD_PER_GB_MONTH;
export const perViewUsd = (bytes: number) => (bytes / GB) * TRANSFER_USD_PER_GB;

export type StorageLedger = {
  /** Bytes we know about, and how many renders we do NOT know the size of. */
  bytes: number;
  counted: number;
  unmeasured: number;
  /** Removed from the library but still occupying storage until confirmed deletion. */
  pendingDeletionBytes: number;
  monthlyUsd: number;
  yearlyUsd: number;
  byKind: { kind: string; n: number; bytes: number; monthlyUsd: number }[];
  /** The heaviest few, since a handful of long clips dominate the total. */
  largest: { id: string; title: string | null; kind: string; bytes: number }[];
  perGbMonthUsd: number;
  perGbTransferUsd: number;
};

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function storageLedger(): Promise<StorageLedger> {
  await ready();
  const [tot, kinds, big] = await Promise.all([
    db().execute(`
      SELECT COALESCE(SUM(bytes),0) AS bytes,
             SUM(bytes IS NOT NULL) AS counted,
             SUM(bytes IS NULL AND stored_url IS NOT NULL) AS unmeasured,
             COALESCE(SUM(CASE WHEN deleted=1 THEN bytes ELSE 0 END),0) AS pending_deletion_bytes
      FROM generations WHERE deleted = 0 OR bytes>0 OR stored_url IS NOT NULL`),
    db().execute(`
      SELECT COALESCE(kind,'video') AS kind, COUNT(*) AS n, COALESCE(SUM(bytes),0) AS bytes
      FROM generations WHERE bytes IS NOT NULL
      GROUP BY kind ORDER BY bytes DESC`),
    db().execute(`
      SELECT id, title, COALESCE(kind,'video') AS kind, bytes
      FROM generations WHERE deleted = 0 AND bytes IS NOT NULL
      ORDER BY bytes DESC LIMIT 5`),
  ]);
  const t: any = tot.rows[0];
  const bytes = Number(t?.bytes ?? 0);
  return {
    bytes,
    counted: Number(t?.counted ?? 0),
    unmeasured: Number(t?.unmeasured ?? 0),
    pendingDeletionBytes: Number(t?.pending_deletion_bytes ?? 0),
    monthlyUsd: monthlyUsd(bytes),
    yearlyUsd: monthlyUsd(bytes) * 12,
    byKind: kinds.rows.map((r: any) => ({
      kind: r.kind, n: Number(r.n), bytes: Number(r.bytes),
      monthlyUsd: monthlyUsd(Number(r.bytes)),
    })),
    largest: big.rows.map((r: any) => ({
      id: r.id, title: r.title ?? null, kind: r.kind, bytes: Number(r.bytes),
    })),
    perGbMonthUsd: STORAGE_USD_PER_GB_MONTH,
    perGbTransferUsd: TRANSFER_USD_PER_GB,
  };
}

/** A size lookup that found no object is not retried for this long. */
export const SIZE_MISS_RETRY_MS = 7 * 86_400_000;

/**
 * Fill in the size of renders made before anyone was recording it.
 *
 * Look up only the tenant's missing objects. A bucket-wide listing could
 * scan every customer's files and never find a non-legacy tenant's prefix.
 *
 * Demo takes are never looked up: their picture is shared sample media, not
 * an object this workspace keeps, so there is nothing to measure. A take
 * whose object is simply not there is recorded as unmeasurable and skipped
 * for a week rather than failing the run, so it can neither mark every
 * cron visit failed nor hold the batch's place ahead of renders that can be
 * measured. Only a lookup that could not answer (storage unreachable) fails.
 */
export async function backfillSizes(limit = 20, at = now()): Promise<number> {
  await ready();
  await db().execute(`CREATE TABLE IF NOT EXISTS storage_size_misses (gen_id TEXT PRIMARY KEY, checked_at INTEGER NOT NULL)`);
  const missing = await db().execute({
    sql: `SELECT id, COALESCE(kind,'video') AS kind FROM generations
          WHERE deleted = 0 AND bytes IS NULL AND stored_url IS NOT NULL
            AND stored_url <> ? AND stored_url NOT LIKE ?
            AND id NOT IN (SELECT gen_id FROM storage_size_misses WHERE checked_at > ?)
          ORDER BY created_at DESC, id LIMIT ?`,
    args: [DEMO_FIXTURE_CLIP_URL, `${DEMO_PREVIEW_URL_PREFIX}%`, at - SIZE_MISS_RETRY_MS, Math.max(1, Math.min(100, limit))],
  });
  if (!missing.rows.length) return 0;

  const want = new Map((missing.rows as any[]).map((r) => [r.id as string, originalKindOf(r.kind)]));
  const sizes = new Map<string, number>();
  const absent: string[] = [];
  let failures = 0;

  const entries = [...want];
  for (let offset = 0; offset < entries.length; offset += 4) {
    const results = await Promise.allSettled(entries.slice(offset, offset + 4).map(async ([id, kind]) => {
      const size = await withTimeout(originalSize(kind, id), 15_000);
      if (size == null) absent.push(id);
      else sizes.set(id, size);
    }));
    failures += results.filter((result) => result.status === "rejected").length;
  }

  let done = 0;
  for (const [id, bytes] of sizes) {
    await db().execute({
      sql: `UPDATE generations SET bytes=?, updated_at=? WHERE id=? AND bytes IS NULL`,
      args: [bytes, now(), id],
    });
    done++;
  }
  for (const id of absent) {
    await db().execute({
      sql: `INSERT INTO storage_size_misses (gen_id, checked_at) VALUES (?, ?) ON CONFLICT(gen_id) DO UPDATE SET checked_at = excluded.checked_at`,
      args: [id, at],
    });
  }
  if (failures) throw new Error("STORAGE_SIZE_LOOKUP_FAILED");
  return done;
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("STORAGE_SIZE_LOOKUP_TIMEOUT")), ms); }),
  ]).finally(() => clearTimeout(timer));
}
