import type { AsyncLocalStorage } from "node:async_hooks";

/**
 * Which workspace this code is running for.
 *
 * Every workspace has its own database, so isolation is not a WHERE clause
 * that every query has to remember — it is which database the query goes
 * to at all. This store says which. It is set once per request by the
 * route wrapper (lib/auth withTenant) from the session or the token, and
 * once per unit of background work by runInTenant; db() reads it and
 * refuses to hand out a client when it is missing. Fail closed: code that
 * forgot to say whose data it wants gets no data.
 */

export type WorkspaceRole = "owner" | "admin" | "member";

export type TenantWorkspace = {
  id: string;
  slug: string;
  name: string;
  /** The studio's original database — the deployment's own keys and blob paths apply. */
  legacy: boolean;
  dbUrl: string;
  dbToken: string | null;
  /** Vendor keys this workspace brought, decrypted for this process only. */
  keys: Record<string, string>;
  /** May the deployment's own keys pay for this workspace? True for the
   *  platform's workspace and, by default, for every workspace that signs
   *  up — with a monthly allowance (lib/allowance.ts). */
  usesPlatformKeys: boolean;
  /** Dollars a month on the platform's keys; null means the deployment's default. */
  allowanceUsd: number | null;
  /** Set while the platform has paused this workspace's rendering; the reason is shown to it. */
  suspendedAt: number | null;
  suspendedReason: string | null;
  /** A content-policy flag for the platform's own review; the workspace does not see it. */
  flaggedAt: number | null;
  flagNote: string | null;
  /** This workspace's own limits; null means the platform's default (lib/limits.ts). */
  concurrency: number | null;
  rendersPerHour: number | null;
  storageQuotaBytes: number | null;
  /** The Vercel AI Gateway key minted for this workspace, by id, so it can be revoked. */
  gatewayKeyId: string | null;
  ownerId: string;
  createdAt: number;
};

export type TenantUser = {
  id: string; email: string; name: string;
  role: "admin" | "member"; owner: boolean; disabled: boolean;
  lastSeen: number | null; createdAt: number;
};

export type TenantToken = { id: string; name: string; scope: "read" | "render"; capUsd: number | null };

export type TenantStore = {
  workspace: TenantWorkspace | null;
  user: TenantUser | null;
  token?: TenantToken;
  /** Every workspace the signed-in account belongs to, for the switcher. */
  workspaces?: { id: string; slug: string; name: string; role: WorkspaceRole }[];
};

export class NoTenantError extends Error {
  constructor() { super("No workspace in scope for this request."); this.name = "NoTenantError"; }
}

/*
 * AsyncLocalStorage is reached through process.getBuiltinModule rather than
 * an import: bundlers do not trace it, so this module can sit in a client
 * chunk (some shared code reaches it through lib/cache and lib/storage)
 * without dragging a Node builtin into the browser, where it is simply
 * absent and every function here answers "no workspace".
 */
type Store = AsyncLocalStorage<TenantStore>;
let als: Store | null | undefined;
function storage(): Store | null {
  if (als !== undefined) return als;
  const proc = (globalThis as { process?: { getBuiltinModule?: (id: string) => { AsyncLocalStorage: new () => Store } } }).process;
  const mod = proc?.getBuiltinModule?.("node:async_hooks");
  als = mod ? new mod.AsyncLocalStorage() : null;
  return als;
}

export function currentTenant(): TenantStore | null {
  return storage()?.getStore() ?? null;
}

/** The workspace in scope, or a NoTenantError — never a guess. */
export function requireTenant(): TenantWorkspace {
  const ws = storage()?.getStore()?.workspace;
  if (!ws) throw new NoTenantError();
  return ws;
}

function must(): Store {
  const s = storage();
  if (!s) throw new Error("Workspace scope needs Node's AsyncLocalStorage, which this runtime lacks.");
  return s;
}

/** Run `fn` for a workspace: background jobs, provisioning, cross-tenant loops. */
export function runInTenant<T>(workspace: TenantWorkspace, fn: () => Promise<T>, extra: Partial<TenantStore> = {}): Promise<T> {
  return must().run({ workspace, user: null, ...extra }, fn);
}

/** Run `fn` with an explicit store (the route wrapper). */
export function runWithStore<T>(store: TenantStore, fn: () => Promise<T>): Promise<T> {
  return must().run(store, fn);
}
