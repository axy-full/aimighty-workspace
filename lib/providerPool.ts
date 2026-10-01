import type { Client, Transaction } from "@libsql/client";
import { platformDb, platformReady, getWorkspace } from "./platform";
import { runInTenant, type TenantWorkspace } from "./tenant";
import { higgsfieldUsesPlatformKey } from "./higgsfield";

/**
 * One shared provider key, many workspaces: the concurrency governor.
 *
 * Every workspace on the platform's Higgsfield key shares one provider
 * account, and the provider limits how many requests that account may have
 * in flight at once. Past it, a submission is refused ("Maximum number of
 * concurrent requests"), with no hint of when to try again. So Particl keeps
 * its own count under that limit: one pool for the platform key, of which
 * each workspace may hold at most its share.
 *
 * A slot is the take's reservation. A take is admitted to the pool inside the
 * same billing transaction that reserves its credits
 * (lib/generationRequests.ts), and it holds its slot exactly while that
 * reservation is `running`. Settling, failing or cancelling the take ends the
 * reservation, whichever path ends it, and so frees the slot: there is no
 * second thing to release, and so nothing to leak. A slot older than
 * SLOT_STALE_MS no longer counts, so a reservation nobody ever closed cannot
 * shut the pool for good.
 *
 * A take that finds the pool, or its workspace's share, full is not refused.
 * It is held the way a take waiting for a workspace slot is (lib/held.ts):
 * nothing reserved, nothing sent, shown as "Queued". It is admitted, slot and
 * reservation together, when a slot frees, and then sent once. The line is
 * served fairly across workspaces: the next slot goes to the waiting take
 * whose workspace has the fewest takes in flight, counting that workspace's
 * own takes ahead of it (so two workspaces alternate), then to the one that
 * has waited longest. One busy workspace cannot starve the others.
 *
 * Own-key workspaces never enter the pool: their requests run on their own
 * provider account, under the workspace's own concurrency limit.
 */

/** The one pool there is today: the platform's Higgsfield key. */
export const SHARED_POOL = "higgsfield";
export { POOL_MARK, POOL_QUEUED, POOL_REASON } from "./sharedKeyTerms";

/**
 * The defaults, from the provider's documented limit as this repo records it
 * (docs/handoff/connected-capability-audit-2026-09-19.md: "Concurrency per
 * account, typically 4"), and the share the native workers already give one
 * workspace (lib/worker-slots.ts: 4 in all, 2 per workspace).
 */
export const POOL_DEFAULTS = { size: 4, share: 2 } as const;
/** A slot held this long no longer counts: whatever the provider did with it, it is not still running. */
export const SLOT_STALE_MS = 2 * 60 * 60_000;

export type PoolConfig = { size: number; share: number };

/**
 * `HF_POOL_SIZE`: how many platform-key requests may be in flight at once
 * (1–1000; `off` or `0` switches the governor off). `HF_POOL_WORKSPACE_SHARE`:
 * how many of those one workspace may hold (1 up to the pool size). A value
 * that does not read falls back to its default, never to "unlimited".
 *
 * Under ENGINE_MOCK there is no provider account to protect, so the governor
 * is off unless HF_POOL_SIZE is set: fixture takes left in flight by one test
 * never queue the next one's.
 */
export function poolConfig(env: Record<string, string | undefined> = process.env): PoolConfig | null {
  const rawSize = (env.HF_POOL_SIZE ?? "").trim().toLowerCase();
  if (rawSize === "off" || rawSize === "0") return null;
  if (!rawSize && env.ENGINE_MOCK === "1") return null;
  const asked = Number(rawSize);
  const size = rawSize && Number.isInteger(asked) && asked >= 1 && asked <= 1000 ? asked : POOL_DEFAULTS.size;
  const rawShare = (env.HF_POOL_WORKSPACE_SHARE ?? "").trim();
  const wanted = Number(rawShare);
  const share = rawShare && Number.isInteger(wanted) && wanted >= 1 ? wanted : POOL_DEFAULTS.share;
  return { size, share: Math.min(share, size) };
}

/**
 * The pool a reservation takes a slot of: a still or a video sent on the
 * platform's Higgsfield key, in the workspace this code runs for. Null for
 * anything else — other engines, identity training, a workspace on its own
 * key, or the governor switched off.
 */
export function sharedPoolOf(event: { engine: string; kind: string }): string | null {
  if (event.engine !== "higgsfield" || (event.kind !== "image" && event.kind !== "video")) return null;
  if (!poolConfig()) return null;
  return higgsfieldUsesPlatformKey() ? SHARED_POOL : null;
}

/* ── The arithmetic (pure) ─────────────────────────────────────────── */

export type PoolWaiter = { id: string; workspaceId: string; queuedAt: number };
/** `running`: takes in flight per workspace. `waiters`: takes waiting for a slot, any order. */
export type PoolState = { running: Readonly<Record<string, number>>; waiters: readonly PoolWaiter[] };
/** A take asking for a slot: one already waiting (its `id`), or a new one (no id; it joins the end of its workspace's line). */
export type PoolCandidate = { id?: string; workspaceId: string; queuedAt: number };
export type PoolVerdict =
  | { admit: true; free: number }
  /* `pool`: no free slot. `share`: its workspace holds (or its own earlier takes will hold) its whole share.
     `line`: slots are free, but as many takes are ahead of it in the line. */
  | { admit: false; why: "pool" | "share" | "line"; free: number; ahead: number };
type Place = PoolWaiter & { place: number; candidate: boolean };

const inFlight = (state: PoolState, workspaceId: string) => Math.max(0, Math.floor(Number(state.running[workspaceId] ?? 0)) || 0);
const LAST = "\uffff";
const before = (a: Place, b: Place) =>
  a.place !== b.place ? a.place < b.place : a.queuedAt !== b.queuedAt ? a.queuedAt < b.queuedAt : a.id < b.id;

/**
 * The line in the order it is served. Each waiting take's place is its
 * workspace's takes in flight plus that workspace's takes waiting ahead of it:
 * a workspace's second waiting take is served after every other workspace's
 * first. Ties go to whoever waited longest.
 */
export function servingOrder(state: PoolState, candidate?: PoolCandidate): Place[] {
  const entries: PoolWaiter[] = state.waiters.filter((w) => w.id !== candidate?.id);
  const mine: PoolWaiter | null = candidate ? { id: candidate.id ?? LAST, workspaceId: candidate.workspaceId, queuedAt: candidate.queuedAt } : null;
  if (mine) entries.push(mine);
  const byWorkspace = new Map<string, PoolWaiter[]>();
  for (const w of entries) byWorkspace.set(w.workspaceId, [...(byWorkspace.get(w.workspaceId) ?? []), w]);
  const placed: Place[] = [];
  for (const [workspaceId, line] of byWorkspace) {
    line.sort((a, b) => a.queuedAt - b.queuedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    line.forEach((w, index) => placed.push({ ...w, place: inFlight(state, workspaceId) + index, candidate: w === mine }));
  }
  return placed.sort((a, b) => (before(a, b) ? -1 : before(b, a) ? 1 : 0));
}

/** Whether `candidate` may take a slot now. The one rule every admission and every release goes through. */
export function poolVerdict(config: PoolConfig, state: PoolState, candidate: PoolCandidate): PoolVerdict {
  const total = Object.keys(state.running).reduce((sum, w) => sum + inFlight(state, w), 0);
  const free = Math.max(0, config.size - total);
  const order = servingOrder(state, candidate);
  const me = order.find((p) => p.candidate)!;
  /* Only a take whose workspace has room left can be served before it. */
  const ahead = order.filter((p) => !p.candidate && p.place < config.share && before(p, me)).length;
  if (me.place >= config.share) return { admit: false, why: "share", free, ahead };
  if (free <= 0) return { admit: false, why: "pool", free, ahead };
  return ahead < free ? { admit: true, free } : { admit: false, why: "line", free, ahead };
}

/** The workspaces with a take waiting, in the order the line serves their first one. */
export function servingWorkspaces(config: PoolConfig, state: PoolState): string[] {
  const seen = new Set<string>();
  for (const p of servingOrder(state)) if (p.place < config.share) seen.add(p.workspaceId);
  return [...seen];
}

/* ── The durable pool (platform database) ──────────────────────────── */

type Executor = Pick<Client, "execute"> | Pick<Transaction, "execute">;
const boot = new WeakMap<Client, Promise<void>>();
/**
 * One row per take that has asked the shared pool: waiting (`admitted_at`
 * null), admitted (with the time), or no longer waiting (`left_at`: taken out
 * of the line, discarded or ended). Rows are kept, never deleted.
 */
export async function providerPoolReady(): Promise<void> {
  await platformReady();
  const client = platformDb();
  if (!boot.has(client))
    boot.set(client, client.batch([
      `CREATE TABLE IF NOT EXISTS provider_pool (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, pool TEXT NOT NULL,
        queued_at INTEGER NOT NULL, admitted_at INTEGER, left_at INTEGER
      )`,
      `CREATE INDEX IF NOT EXISTS idx_provider_pool_line ON provider_pool(pool, admitted_at, left_at, queued_at)`,
    ], "write").then(() => undefined).catch((error) => { boot.delete(client); throw error; }));
  await boot.get(client);
}

/** Who holds a slot, and who waits, as the database has it now. `except`: the take asking (it never counts against itself). */
export async function readPoolState(ex: Executor, pool: string, at: number, except = ""): Promise<PoolState> {
  /* One statement after the other: inside a transaction they share its one stream. */
  const held = await ex.execute({
    sql: `SELECT p.workspace_id AS w, COUNT(*) AS n FROM provider_pool p
          JOIN meter_events m ON m.id = p.id AND m.workspace_id = p.workspace_id
          WHERE p.pool = ? AND p.admitted_at IS NOT NULL AND p.admitted_at > ? AND m.status = 'running' AND p.id <> ?
          GROUP BY p.workspace_id`,
    args: [pool, at - SLOT_STALE_MS, except],
  });
  const waiting = await ex.execute({
    sql: `SELECT id, workspace_id, queued_at FROM provider_pool
          WHERE pool = ? AND admitted_at IS NULL AND left_at IS NULL AND id <> ?
          ORDER BY queued_at, id LIMIT 1000`,
    args: [pool, except],
  });
  const running: Record<string, number> = {};
  for (const r of held.rows) running[String(r.w)] = Number(r.n);
  return {
    running,
    waiters: waiting.rows.map((r) => ({ id: String(r.id), workspaceId: String(r.workspace_id), queuedAt: Number(r.queued_at) })),
  };
}

/** A take's own row: where it stands in the line, if it has asked before. */
async function ownRow(ex: Executor, id: string) {
  return (await ex.execute({ sql: "SELECT workspace_id, pool, queued_at, admitted_at, left_at FROM provider_pool WHERE id = ?", args: [id] })).rows[0];
}

/**
 * Inside the reservation's own transaction: take a slot for this job, or say
 * why it waits. The slot is written in the same commit as the reservation, so
 * a take holds a slot exactly when it holds reserved credits. A reservation
 * made again for a take already admitted (a repeated release) is admitted
 * again without counting itself twice.
 */
export async function admitToPoolTx(tx: Transaction, pool: string, candidate: { id: string; workspaceId: string; at: number; queuedAt?: number },
  config: PoolConfig | null = poolConfig()): Promise<PoolVerdict> {
  if (!config) return { admit: true, free: Number.POSITIVE_INFINITY };
  const own = await ownRow(tx, candidate.id);
  if (own && String(own.workspace_id) !== candidate.workspaceId) throw new Error("This take belongs to another workspace.");
  if (own?.admitted_at != null) return { admit: true, free: 0 };
  const state = await readPoolState(tx, pool, candidate.at, candidate.id);
  /* A take that waited keeps its place in the line (from when it was first held); a new one joins it now. */
  const queuedAt = own ? Number(own.queued_at) : candidate.queuedAt ?? candidate.at;
  const verdict = poolVerdict(config, state, { id: candidate.id, workspaceId: candidate.workspaceId, queuedAt });
  if (verdict.admit)
    await tx.execute({
      sql: `INSERT INTO provider_pool(id, workspace_id, pool, queued_at, admitted_at) VALUES(?,?,?,?,?)
            ON CONFLICT(id) DO UPDATE SET admitted_at = excluded.admitted_at, left_at = NULL`,
      args: [candidate.id, candidate.workspaceId, pool, queuedAt, candidate.at],
    });
  return verdict;
}

/**
 * The same question outside any transaction, for Generate and for a release
 * that should not reserve at all when the line would not admit it. Read-only:
 * the reservation asks again, and only its answer counts.
 */
export async function poolPrecheck(pool: string, candidate: { id?: string; workspaceId: string; at: number; queuedAt?: number },
  config: PoolConfig | null = poolConfig()): Promise<PoolVerdict> {
  if (!config) return { admit: true, free: Number.POSITIVE_INFINITY };
  await providerPoolReady();
  const own = candidate.id ? await ownRow(platformDb(), candidate.id) : undefined;
  if (own?.admitted_at != null) return { admit: true, free: 0 };
  const state = await readPoolState(platformDb(), pool, candidate.at, candidate.id ?? "");
  const queuedAt = own ? Number(own.queued_at) : candidate.queuedAt ?? candidate.at;
  return poolVerdict(config, state, { id: candidate.id, workspaceId: candidate.workspaceId, queuedAt });
}

/**
 * At Generate, before anything is written: would a take for this engine and
 * kind wait for the shared pool? Null when it does not use the pool (or the
 * line cannot be read: the reservation still asks, and a take it refuses is
 * held then instead).
 */
export async function poolAdmission(engine: string, kind: string, workspaceId: string, at = Date.now()): Promise<PoolVerdict | null> {
  const pool = sharedPoolOf({ engine, kind });
  if (!pool) return null;
  return poolPrecheck(pool, { workspaceId, at }).catch(() => null);
}

/** Put a held take in the line (or back in it, keeping its first place). Never touches a take already admitted. */
export async function queueForPool(pool: string, take: { id: string; workspaceId: string; queuedAt: number }): Promise<void> {
  await providerPoolReady();
  await platformDb().execute({
    sql: `INSERT INTO provider_pool(id, workspace_id, pool, queued_at) VALUES(?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET left_at = NULL
          WHERE provider_pool.admitted_at IS NULL AND provider_pool.workspace_id = excluded.workspace_id`,
    args: [take.id, take.workspaceId, pool, take.queuedAt],
  });
}

/**
 * Take a waiting take out of the line: discarded, or waiting now on something
 * else (credits, a cap, a person). It held no slot, so no slot is released,
 * and nothing else about anyone's take changes.
 */
export async function leavePool(id: string, workspaceId: string, at = Date.now()): Promise<boolean> {
  await providerPoolReady();
  const out = await platformDb().execute({
    sql: "UPDATE provider_pool SET left_at = ? WHERE id = ? AND workspace_id = ? AND admitted_at IS NULL AND left_at IS NULL",
    args: [at, id, workspaceId],
  });
  return out.rowsAffected > 0;
}

/** This workspace's takes in the line. */
export async function waitingIn(workspaceId: string, pool = SHARED_POOL): Promise<string[]> {
  await providerPoolReady();
  const rs = await platformDb().execute({
    sql: "SELECT id FROM provider_pool WHERE pool = ? AND workspace_id = ? AND admitted_at IS NULL AND left_at IS NULL ORDER BY queued_at, id LIMIT 200",
    args: [pool, workspaceId],
  });
  return rs.rows.map((r) => String(r.id));
}

export type PoolPassDeps = {
  /** The workspace to visit, as the platform has it (tests pass their own). */
  workspace?: (id: string) => Promise<TenantWorkspace | null>;
  /** Start what this workspace may start; runs inside its tenant. By default lib/held.ts releaseHeldJobs. */
  release?: () => Promise<unknown>;
  clock?: () => number;
};

let passing = false;
let askedAgain = false;
/**
 * A slot came back somewhere: visit the workspaces with a take waiting, in
 * the order the line serves them, and let each start what it may. Each
 * workspace's own release asks the line again for every take, so the order
 * here only saves work; fairness is decided in the reservation. A workspace
 * gone or paused leaves the line. Cheap when nobody waits (one indexed read),
 * best-effort, and never re-entered: asked while one runs, that pass goes
 * round once more instead.
 */
export async function releasePoolWaiters(deps: PoolPassDeps = {}): Promise<{ visited: string[] }> {
  const config = poolConfig();
  const visited: string[] = [];
  if (!config) return { visited };
  if (passing) { askedAgain = true; return { visited }; }
  passing = true;
  try {
    await providerPoolReady();
    const clock = deps.clock ?? Date.now;
    for (let round = 0; round < 3; round++) {
      askedAgain = false;
      const waiting = await platformDb().execute({
        sql: "SELECT 1 FROM provider_pool WHERE pool = ? AND admitted_at IS NULL AND left_at IS NULL LIMIT 1", args: [SHARED_POOL],
      });
      if (!waiting.rows.length) break;
      const state = await readPoolState(platformDb(), SHARED_POOL, clock());
      for (const workspaceId of servingWorkspaces(config, state)) {
        const ws = await (deps.workspace ?? getWorkspace)(workspaceId).catch(() => null);
        if (!ws || ws.deletedAt || ws.suspendedAt) {
          await platformDb().execute({
            sql: "UPDATE provider_pool SET left_at = ? WHERE pool = ? AND workspace_id = ? AND admitted_at IS NULL AND left_at IS NULL",
            args: [clock(), SHARED_POOL, workspaceId],
          });
          continue;
        }
        visited.push(workspaceId);
        const failed = await runInTenant(ws, async () => {
          await (deps.release ?? (async () => (await import("./held")).releaseHeldJobs()))();
        }).then(() => false, (error) => { console.error("shared pool release:", (error as Error).message); return true; });
        /* A workspace that cannot be reached right now steps out of the line, so its takes never hold a free
           slot away from the others. Nothing of theirs changes: its own next release asks again, and they keep
           the place they were first given (queued_at). */
        if (failed)
          await platformDb().execute({
            sql: "UPDATE provider_pool SET left_at = ? WHERE pool = ? AND workspace_id = ? AND admitted_at IS NULL AND left_at IS NULL",
            args: [clock(), SHARED_POOL, workspaceId],
          }).catch(() => {});
      }
      if (!askedAgain) break;
    }
    return { visited };
  } finally {
    passing = false;
  }
}

/* ── The platform owner's view ─────────────────────────────────────── */

export type PoolDesk = {
  config: PoolConfig | null;
  inFlight: number;
  waiting: number;
  workspaces: { workspaceId: string; inFlight: number; waiting: number }[];
};

/** Where the shared pool stands, for the platform desk: counts only, no takes' contents. */
export async function poolDesk(at = Date.now()): Promise<PoolDesk> {
  const config = poolConfig();
  await providerPoolReady();
  const state = await readPoolState(platformDb(), SHARED_POOL, at);
  const ids = new Set([...Object.keys(state.running), ...state.waiters.map((w) => w.workspaceId)]);
  const workspaces = [...ids].map((workspaceId) => ({
    workspaceId,
    inFlight: inFlight(state, workspaceId),
    waiting: state.waiters.filter((w) => w.workspaceId === workspaceId).length,
  })).sort((a, b) => b.inFlight - a.inFlight || b.waiting - a.waiting || a.workspaceId.localeCompare(b.workspaceId));
  return {
    config,
    inFlight: workspaces.reduce((sum, w) => sum + w.inFlight, 0),
    waiting: state.waiters.length,
    workspaces,
  };
}
