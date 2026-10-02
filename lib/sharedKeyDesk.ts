import { platformDb, platformReady } from "./platform";
import { poolDesk } from "./providerPool";
import { openKeyAlerts, keyPrefix } from "./higgsfieldKeyAlerts";
import { platformHiggsfieldCredentials, previousHiggsfieldCredentials, correlationHeaderOn } from "./higgsfield";
import { receiptsReady } from "./higgsfieldGenerationReceipts";
import type { RenderHandle } from "./engines/types";

/**
 * The platform owner's view of the shared provider key (app/(app)/admin):
 * how full its pool is and who waits, which takes wait on a key that is
 * gone, and the latest requests with their request_id and correlation id —
 * the two handles the provider's support asks for. Counts, ids and one-way
 * key prefixes only: no prompts, no media, no key, no figure in dollars.
 * The route in front of it answers to the platform owner alone.
 */
export type SharedKeyDesk = {
  pool: { on: boolean; size: number | null; share: number | null; inFlight: number; waiting: number;
    workspaces: { id: string; name: string; inFlight: number; waiting: number }[] };
  keyChanges: { take: string; workspace: string; key: string; since: number; lastAt: number }[];
  requests: { take: string; workspace: string; model: string; requestId: string; correlationId: string | null;
    key: "platform" | "previous" | "other"; keyPrefix: string; at: number; settled: boolean }[];
  /** Whether our own correlation id goes out on the production API (HF_CORRELATION_HEADER), or only the provider's is kept. */
  correlationSent: boolean;
};

async function workspaceNames(ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)].filter(Boolean);
  if (!unique.length) return new Map();
  const rs = await platformDb().execute({
    sql: `SELECT id, name, slug FROM workspaces WHERE id IN (${unique.map(() => "?").join(",")})`,
    args: unique,
  });
  return new Map(rs.rows.map((r) => [String(r.id), String(r.name || r.slug || r.id)]));
}

export async function sharedKeyDesk(limit = 20): Promise<SharedKeyDesk> {
  await platformReady();
  await receiptsReady();
  const [pool, alerts, receipts] = await Promise.all([
    poolDesk(),
    openKeyAlerts(),
    platformDb().execute({
      sql: "SELECT id, workspace_id, handle_json, credential_fingerprint, updated_at, settled_at FROM higgsfield_generation_receipts ORDER BY updated_at DESC, id LIMIT ?",
      args: [Math.max(1, Math.min(100, limit))],
    }),
  ]);
  const names = await workspaceNames([
    ...pool.workspaces.map((w) => w.workspaceId), ...alerts.map((a) => a.workspaceId), ...receipts.rows.map((r) => String(r.workspace_id)),
  ]);
  const name = (id: string) => names.get(id) ?? id;
  const platform = platformHiggsfieldCredentials()?.fingerprint ?? null;
  const previous = new Set(previousHiggsfieldCredentials().map((c) => c.fingerprint));
  return {
    pool: {
      on: pool.config !== null, size: pool.config?.size ?? null, share: pool.config?.share ?? null,
      inFlight: pool.inFlight, waiting: pool.waiting,
      workspaces: pool.workspaces.map((w) => ({ id: w.workspaceId, name: name(w.workspaceId), inFlight: w.inFlight, waiting: w.waiting })),
    },
    keyChanges: alerts.map((a) => ({ take: a.id, workspace: name(a.workspaceId), key: a.keyPrefix, since: a.firstAt, lastAt: a.lastAt })),
    requests: receipts.rows.flatMap((r) => {
      let handle: Partial<RenderHandle> = {};
      try { handle = JSON.parse(String(r.handle_json)) as RenderHandle; } catch { return []; }
      if (typeof handle.ref !== "string" || !handle.ref) return [];
      const fingerprint = String(r.credential_fingerprint);
      return [{
        take: String(r.id), workspace: name(String(r.workspace_id)), model: String(handle.model ?? ""),
        requestId: handle.ref, correlationId: typeof handle.correlationId === "string" && handle.correlationId ? handle.correlationId : null,
        key: fingerprint === platform ? "platform" as const : previous.has(fingerprint) ? "previous" as const : "other" as const,
        keyPrefix: keyPrefix(fingerprint), at: Number(r.updated_at), settled: r.settled_at != null,
      }];
    }),
    correlationSent: correlationHeaderOn(),
  };
}
