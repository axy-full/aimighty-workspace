import { currentTenant } from "./tenant";

/**
 * A short-lived memo that knows which workspace it belongs to.
 *
 * One serverless instance answers many workspaces, so a plain module-level
 * cache is a leak: the second workspace to ask would be handed the first
 * one's answer. Every entry here is keyed by the workspace in scope.
 */
const store = new Map<string, { at: number; value: unknown }>();
const key = (name: string) => `${currentTenant()?.workspace?.id ?? "-"}:${name}`;

export function memoGet<T>(name: string, ttlMs: number): T | null {
  const hit = store.get(key(name));
  if (!hit || Date.now() - hit.at >= ttlMs) return null;
  return hit.value as T;
}
export function memoPut(name: string, value: unknown): void {
  store.set(key(name), { at: Date.now(), value });
}
export function memoDrop(name: string): void {
  store.delete(key(name));
}
