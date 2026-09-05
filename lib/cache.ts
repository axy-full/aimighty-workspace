import { now } from "./db";
import { currentTenant } from "./tenant";

/**
 * A memo with a short life, for answers the whole app polls but nobody edits
 * often. Per serverless instance, so it is a cost reducer and never a source
 * of truth: anything that writes must invalidate, and a stale read can only
 * ever be as old as its TTL.
 */
const store = new Map<string, { at: number; value: unknown }>();

/** The project listing with its per-project counts and spend. */
export const PROJECTS_KEY = "projects";

/* Keyed by workspace: one instance serves many, and a memo is a leak otherwise. */
const scoped = (key: string) => `${currentTenant()?.workspace?.id ?? "-"}:${key}`;

export function cached<T>(key: string, ttlMs: number): T | null {
  const hit = store.get(scoped(key));
  if (!hit || now() - hit.at >= ttlMs) return null;
  return hit.value as T;
}

export function putCache(key: string, value: unknown): void {
  store.set(scoped(key), { at: now(), value });
}

export function invalidate(key: string): void {
  store.delete(scoped(key));
}
