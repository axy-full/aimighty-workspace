import { db, ready, now } from "./db";
import { currentTenant, type TenantWorkspace } from "./tenant";
import { getPlatformLayer } from "./platform";
import type { PlatformCaps } from "./platformLayer";

/**
 * What a workspace may run at once, start in an hour, and keep.
 *
 * The platform layer sets the defaults; the desk can give one workspace its
 * own numbers. A batch past the concurrency limit is not refused: the take
 * waits for a slot and starts the moment one lands (lib/held.ts). The rate
 * limit and the storage quota do refuse, and say what the limit is.
 */
export type Limits = { concurrency: number; rendersPerHour: number; storageBytes: number };
export type Standing = { running: number; startedLastHour: number; usedBytes: number };
export type LimitVerdict = { allow: true } | { allow: false; why: "slots" | "rate"; error: string };
export type QuotaVerdict = { allow: boolean; error?: string; pct: number };

/** Decimal gigabytes, the way the rest of the product counts storage. */
export const GB = 1e9;
export const MB = 1e6;

export function limitsFor(ws: Pick<TenantWorkspace, "concurrency" | "rendersPerHour" | "storageQuotaBytes"> | null | undefined, caps: PlatformCaps): Limits {
  return {
    concurrency: ws?.concurrency ?? caps.concurrency,
    rendersPerHour: ws?.rendersPerHour ?? caps.rendersPerHour,
    storageBytes: ws?.storageQuotaBytes ?? Math.round(caps.storageGb * GB),
  };
}

export function limitVerdict(o: { running: number; startedLastHour: number; limits: Limits }): LimitVerdict {
  if (o.startedLastHour >= o.limits.rendersPerHour) {
    return { allow: false, why: "rate", error: `This workspace has started ${o.startedLastHour} renders in the last hour, its limit. Try again in a little while, or ask the platform for a higher rate.` };
  }
  if (o.running >= o.limits.concurrency) {
    return { allow: false, why: "slots", error: slotsMessage(o.running, o.limits.concurrency) };
  }
  return { allow: true };
}

export const slotsMessage = (running: number, limit: number): string =>
  `Waiting for a slot: ${running} render${running === 1 ? " is" : "s are"} going, and ${limit} at once is this workspace's limit. It starts the moment one lands.`;

export function quotaVerdict(o: { usedBytes: number; quotaBytes: number; incomingBytes: number }): QuotaVerdict {
  const after = o.usedBytes + Math.max(0, o.incomingBytes);
  const pct = o.quotaBytes > 0 ? Math.round((after / o.quotaBytes) * 100) : 0;
  if (o.quotaBytes > 0 && after > o.quotaBytes) {
    const g = (n: number) => (n < GB ? `${Math.max(1, Math.round(n / MB))} MB` : `${(n / GB).toFixed(1)} GB`);
    return { allow: false, pct, error: `Storage is full: ${g(o.usedBytes)} of ${g(o.quotaBytes)}. Delete takes you no longer need, or ask the platform for more room.` };
  }
  return { allow: true, pct };
}

/** This workspace's limits: its own numbers, or the platform's. */
export async function workspaceLimits(): Promise<Limits> {
  const ws = currentTenant()?.workspace;
  const layer = await getPlatformLayer();
  return limitsFor(ws, layer.caps);
}

/** Where the workspace stands right now. */
export async function standing(): Promise<Standing> {
  await ready();
  const [live, hour, gens, ups, reserved] = await Promise.all([
    db().execute(`SELECT COUNT(*) AS n FROM generations WHERE status IN ('queued','running') AND deleted = 0`),
    db().execute({ sql: `SELECT COUNT(*) AS n FROM generations WHERE created_at >= ? AND status <> 'held'`, args: [now() - 3_600_000] }),
    db().execute(`SELECT COALESCE(SUM(bytes), 0) AS b FROM generations`),
    db().execute(`SELECT COALESCE(SUM(COALESCE(bytes, 0) + COALESCE(derivative_bytes, 0)), 0) AS b FROM uploads`),
    import("./uploadReservations").then(module => module.reservedUploadBytes()),
  ]);
  const n = (rs: { rows: unknown[] }, k: string) => Number((rs.rows[0] as Record<string, unknown>)?.[k] ?? 0);
  return { running: n(live, "n"), startedLastHour: n(hour, "n"), usedBytes: n(gens, "b") + n(ups, "b") + reserved };
}

/** The check at every submit: rate first (a refusal), then slots (a wait). */
export async function checkLimits(): Promise<LimitVerdict & { limits: Limits; standing: Standing }> {
  const [limits, st] = await Promise.all([workspaceLimits(), standing()]);
  return { ...limitVerdict({ running: st.running, startedLastHour: st.startedLastHour, limits }), limits, standing: st };
}

/** The check before anything is stored. */
export async function checkQuota(incomingBytes: number): Promise<QuotaVerdict & { limits: Limits; standing: Standing }> {
  const [limits, st] = await Promise.all([workspaceLimits(), standing()]);
  return { ...quotaVerdict({ usedBytes: st.usedBytes, quotaBytes: limits.storageBytes, incomingBytes }), limits, standing: st };
}
