import { AsyncLocalStorage } from "node:async_hooks";
import type { Transaction } from "@libsql/client";
import { createPlatformDatabaseClient } from "./localDatabaseClient";
import { RecoveryFence, RecoveryFenceError } from "./recovery/control.mjs";
export { RecoveryFenceError } from "./recovery/control.mjs";

const global = globalThis as typeof globalThis & {
  particlRecoveryContext?: AsyncLocalStorage<{ id: string }>;
  particlRecoveryFences?: Map<string, RecoveryFence>;
};
const context = (global.particlRecoveryContext ??= new AsyncLocalStorage<{
  id: string;
}>());
export function recoveryFence(): RecoveryFence {
  const config = {
    url:
      process.env.PLATFORM_DATABASE_URL ??
      process.env.TURSO_DATABASE_URL ??
      "file:.data/ark.db",
    authToken: process.env.PLATFORM_AUTH_TOKEN ?? process.env.TURSO_AUTH_TOKEN,
  };
  const key = JSON.stringify(config);
  const cache = (global.particlRecoveryFences ??= new Map());
  let fence = cache.get(key);
  if (!fence) {
    fence = new RecoveryFence(
      createPlatformDatabaseClient(config),
      process.env.VERCEL_DEPLOYMENT_ID ?? process.env.VERCEL_URL ?? "local",
    );
    cache.set(key, fence);
  }
  return fence;
}
export async function withRecoveryActivity<T>(
  kind: string,
  run: () => Promise<T>,
  options: {
    workspaceId?: string;
    intentId?: string;
    uncertainOnError?: boolean | ((error: unknown) => boolean);
  } = {},
): Promise<T> {
  const fence = recoveryFence();
  const id = await fence.admit({
    kind,
    parentId: context.getStore()?.id,
    workspaceId: options.workspaceId,
    intentId: options.intentId,
  });
  let uncertain = false;
  try {
    return await context.run({ id }, run);
  } catch (error) {
    uncertain =
      typeof options.uncertainOnError === "function"
        ? options.uncertainOnError(error)
        : options.uncertainOnError === true;
    throw error;
  } finally {
    await fence.finish(id, uncertain);
  }
}
export const recoveryOperation =
  <A extends unknown[], T>(
    kind: string,
    fn: (...args: A) => Promise<T>,
    uncertainOnError = false,
  ) =>
  (...args: A): Promise<T> =>
    withRecoveryActivity(kind, () => fn(...args), { uncertainOnError });
export const withRecoveryJob = <T>(
  workspaceId: string,
  intentId: string,
  run: () => Promise<T>,
) => withRecoveryActivity("accepted-job", run, { workspaceId, intentId });
export const acceptRecoveryJobTx = (
  tx: Transaction,
  workspaceId: string,
  id: string,
  kind: string,
) => recoveryFence().acceptJobTx(tx, workspaceId, id, kind);
export const resolveRecoveryJobTx = (
  tx: Transaction,
  workspaceId: string,
  id: string,
) => recoveryFence().resolveJobTx(tx, workspaceId, id);
export async function assertRecoveryOpen(): Promise<void> {
  if ((await recoveryFence().status()).state !== "open")
    throw new RecoveryFenceError();
}
/** Whole requests are admitted before authentication, whose session lookup writes.
 * Response streaming/after callbacks require their own reserved child or job intent. */
export function recoveryRoute<A extends unknown[]>(
  handler: (...args: A) => Promise<Response>,
) {
  return async (...args: A): Promise<Response> => {
    try {
      return await withRecoveryActivity("request", () => handler(...args));
    } catch (error) {
      // Next route bundles share the cached controller but not class identity.
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "RECOVERY_FENCED"
      )
        return Response.json(
          { error: new RecoveryFenceError().message },
          {
            status: 503,
            headers: { "Retry-After": "60", "Cache-Control": "no-store" },
          },
        );
      throw error;
    }
  };
}
export async function recoveryAdmission(kind: string) {
  const fence = recoveryFence();
  const id = await fence.admit({ kind, parentId: context.getStore()?.id });
  let finished = false;
  return {
    async finish(uncertain = false) {
      if (!finished) {
        await fence.finish(id, uncertain);
        finished = true;
      }
    },
  };
}
/** A lost response never proves that the remote mutation did not happen. The
 * request is not replayed here; its durable uncertainty blocks a checkpoint. */
export async function recoveryFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const mutation = !["GET", "HEAD", "OPTIONS"].includes(
    (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase(),
  );
  const fence = recoveryFence();
  const id = await fence.admit({
    kind: mutation ? "external-mutation" : "external-read",
    parentId: context.getStore()?.id,
  });
  let uncertain = false;
  try {
    const response = await fetch(input, init);
    uncertain = mutation && (response.status === 408 || response.status >= 500);
    return response;
  } catch (error) {
    uncertain = mutation;
    throw error;
  } finally {
    await fence.finish(id, uncertain);
  }
}
/** Reserve before handing a continuation to Next.after. If the process dies
 * before it runs, the durable child remains a blocker instead of vanishing. */
export async function reserveRecoveryContinuation<T>(
  kind: string,
  run: () => Promise<T>,
): Promise<() => Promise<T>> {
  const fence = recoveryFence();
  const id = await fence.admit({ kind, parentId: context.getStore()?.id });
  let invoked = false;
  return async () => {
    if (invoked)
      throw new RecoveryFenceError("This continuation already started.");
    invoked = true;
    try {
      return await context.run({ id }, run);
    } finally {
      await fence.finish(id);
    }
  };
}
