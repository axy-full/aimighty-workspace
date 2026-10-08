import type { AsyncLocalStorage } from "node:async_hooks";

/**
 * Whether the request a piece of server work runs for has already been
 * answered.
 *
 * A paid request that opts in to an early answer (answerAfterMs,
 * lib/generationRequests.ts) replies "pending" while its run goes on after the
 * reply. From then on the request's cookies and headers belong to a request
 * that is over: the run must already hold everything it needs (the person,
 * the workspace, the body), and anything that would read the session from the
 * request (lib/auth.ts currentContext, callerFromBearer) refuses instead of
 * reading whatever is there by then.
 *
 * AsyncLocalStorage is reached through process.getBuiltinModule, as
 * lib/tenant.ts does, so this module can sit in a shared chunk; one store is
 * kept on globalThis so every route bundle reads the same one.
 */
type Attachment = { answered: boolean };
type Store = AsyncLocalStorage<Attachment>;
const shared = globalThis as typeof globalThis & { particlRequestAttachment?: Store | null };
function storage(): Store | null {
  if (shared.particlRequestAttachment !== undefined) return shared.particlRequestAttachment;
  const proc = (globalThis as { process?: { getBuiltinModule?: (id: string) => { AsyncLocalStorage: new () => Store } } }).process;
  const mod = proc?.getBuiltinModule?.("node:async_hooks");
  shared.particlRequestAttachment = mod ? new mod.AsyncLocalStorage() : null;
  return shared.particlRequestAttachment;
}

export class RequestDetachedError extends Error {
  constructor(what: string) {
    super(`${what} was read after this request was answered. A run that finishes after its reply must take what it needs before.`);
    this.name = "RequestDetachedError";
  }
}

/**
 * Runs `work` so that the code it calls can tell when its request has been
 * answered: `detach()` marks it so, and assertRequestAttached throws inside it
 * from then on.
 */
export function detachable<T>(work: () => Promise<T>): { result: Promise<T>; detach: () => void } {
  const state: Attachment = { answered: false };
  const store = storage();
  const result = store ? store.run(state, work) : work();
  return { result, detach: () => { state.answered = true; } };
}

/** Throws RequestDetachedError when the request this runs for has already been answered. */
export function assertRequestAttached(what: string): void {
  if (storage()?.getStore()?.answered) throw new RequestDetachedError(what);
}
