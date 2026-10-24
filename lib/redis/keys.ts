import { z } from "zod";
import { STEPS } from "../copy";
import { requireTenant } from "../tenant";

/**
 * Every key Particl writes to Redis, by kind, each with its shape checked by Zod before a byte is sent.
 *
 * Redis is fast shared state, never a source of truth (SOW v2 §6, §8): what is in it is rebuilt from Turso, and Atomik never reads from it.
 * A key always starts with the workspace it belongs to, taken from the request's own tenant (lib/tenant.ts › requireTenant), never from an
 * argument: code that forgot whose data it is gets no key at all, as db() gets no client. Nothing in a key is a person's words: ids only.
 *
 * Each kind has an expiry class:
 * - "sliding": renewed on every read, kept 30 days past the last one, and evictable beyond that (under the eviction policy in docs/redis.md);
 * - "short": a hot-read cache entry with a fixed short life;
 * - "lease": a lock, with a life the caller states (capped);
 * - "kept": a counter or limit, written without an expiry (rebuilt from the ledger on any disagreement).
 */

/** A row id as Particl writes them: letters, digits, "_" and "-", at most 64 (never words, never a path). */
export const RedisId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "an id of letters, digits, _ or -");

export const RedisStep = z.enum(Object.keys(STEPS) as [keyof typeof STEPS, ...(keyof typeof STEPS)[]]);

/** The hot reads the UI may cache: the board, the Library wall, the Activity pill. */
export const RedisSurface = z.enum(["board", "library", "activity"]);

/** 30 days, the sliding life of a working set and a preview (owner, 24 Oct 2026). */
export const SLIDING_TTL_S = 30 * 24 * 60 * 60;
/** A hot read's life: long enough to spare a burst of reads, short enough that a change shows. */
export const SHORT_TTL_S = 60;
/** The longest a lock may be held before it lapses by itself. */
export const MAX_LEASE_MS = 10 * 60 * 1000;

export const RedisKeyParts = z.discriminatedUnion("kind", [
  /** The working-set prefix for one (production, step, branch). */
  z.object({ kind: z.literal("working-set"), productionId: RedisId, step: RedisStep, branchId: RedisId }).strict(),
  /** A Library item's preview, made once on landing; the file is the source. */
  z.object({ kind: z.literal("preview"), itemId: RedisId }).strict(),
  z.object({ kind: z.literal("hot"), surface: RedisSurface, id: RedisId }).strict(),
  z.object({ kind: z.literal("lock"), name: RedisId }).strict(),
  z.object({ kind: z.literal("counter"), name: RedisId }).strict(),
]);
export type RedisKeyParts = z.infer<typeof RedisKeyParts>;
export type RedisKeyKind = RedisKeyParts["kind"];

export type ExpiryClass = "sliding" | "short" | "lease" | "kept";
export const EXPIRY: Record<RedisKeyKind, ExpiryClass> = {
  "working-set": "sliding",
  preview: "sliding",
  hot: "short",
  lock: "lease",
  counter: "kept",
};

declare const built: unique symbol;
/** A built key: the string Redis sees, and the kind it was built as (so the client applies the kind's expiry). Only redisKey makes one. */
export type RedisKey = { readonly key: string; readonly kind: RedisKeyKind; readonly [built]: true };

/** The key for `parts` in `workspaceId`; throws on any shape Zod refuses. Not exported: a key's workspace is always the request's own. */
function keyFor(workspaceId: string, parts: RedisKeyParts): RedisKey {
  const ws = RedisId.parse(workspaceId);
  const p = RedisKeyParts.parse(parts);
  const tail = p.kind === "working-set" ? [p.productionId, p.step, p.branchId]
    : p.kind === "preview" ? [p.itemId]
    : p.kind === "hot" ? [p.surface, p.id]
    : [p.name];
  return { key: ["ws", ws, p.kind, ...tail].join(":"), kind: p.kind } as RedisKey;
}

/** The key for `parts` in the request's own workspace (fails closed without one). */
export function redisKey(parts: RedisKeyParts): RedisKey {
  return keyFor(requireTenant().id, parts);
}
