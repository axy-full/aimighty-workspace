/**
 * Particl's durable ledger of the paid builds it sends to the connected
 * account — Soul ID trainings and reference elements — the way the job ledger
 * records paid jobs:
 *
 * - A build is claimed in this tenant's database BEFORE the paid create is
 *   sent, keyed by what it is (kind, name, type, sources). While a claim is
 *   unresolved the same build is refused, so a lost answer can never invite a
 *   second charge.
 * - A build the account refused, or that was never sent, is closed and may be
 *   tried again.
 * - A build the account accepted without naming its id, or whose answer was
 *   lost, stays pending. It is matched to the account's list later by its exact
 *   name and type among entries Particl has not recorded, created inside a
 *   short window after it was sent — and only when exactly one entry fits, so
 *   an identity made on the account itself is never adopted as Particl's.
 *
 * Nothing here calls a provider. Rows are never deleted.
 */
import { createHash, randomUUID } from "node:crypto";
import { db, ready } from "@/lib/db";

export type BuildKind = "character" | "element";
export type BuildState = "sending" | "uncertain" | "pending" | "recorded" | "refused" | "not_sent" | "unmatched";
export type PendingBuild = {
  id: string; kind: BuildKind; name: string; type: string; state: "sending" | "uncertain" | "pending"; createdAt: number;
  /** Past the matching day: the account never named it, and Particl cannot list it. */
  stale: boolean;
};
/** An account entry created this long before the send (clock skew) or after it (training queue) may be the build. */
export const BUILD_MATCH_WINDOW = { beforeMs: 2 * 60_000, afterMs: 30 * 60_000 } as const;
/** After this long an open build the account never named is closed as
 * `unmatched`: Particl cannot list it, and the same request may be sent again. */
export const BUILD_MATCH_GIVE_UP_MS = 24 * 3_600_000;

const initialized = new WeakMap<ReturnType<typeof db>, Promise<void>>();
async function buildsReady() {
  await ready();
  const client = db();
  if (!initialized.has(client))
    initialized.set(
      client,
      client
        .batch(
          [
            `CREATE TABLE IF NOT EXISTS higgsfield_consumer_builds (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL, fingerprint TEXT NOT NULL, project_id TEXT,
 name TEXT NOT NULL, type TEXT NOT NULL, state TEXT NOT NULL, provider_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
            // One open build per identical request: a second click or a retry after a lost answer is refused.
            `CREATE UNIQUE INDEX IF NOT EXISTS idx_consumer_builds_open ON higgsfield_consumer_builds(user_id,kind,fingerprint) WHERE state IN ('sending','uncertain','pending')`,
            `CREATE INDEX IF NOT EXISTS idx_consumer_builds_kind ON higgsfield_consumer_builds(kind,state,created_at)`,
          ],
          "write",
        )
        .then(() => {})
        .catch((error) => {
          initialized.delete(client);
          throw error;
        }),
    );
  await initialized.get(client);
}

export function buildFingerprint(kind: BuildKind, name: string, type: string, sources: readonly unknown[]) {
  return createHash("sha256").update(JSON.stringify([kind, name.trim(), type, sources])).digest("hex");
}

export class BuildInFlightError extends Error {
  readonly code = "build_in_flight";
  readonly status = 409;
  constructor() {
    super("This build was already sent and may have been accepted. It is not sent again; it appears here once the account lists it.");
    this.name = "BuildInFlightError";
  }
}

/** Open builds the account never named within a day are closed, never deleted. */
async function closeStaleBuilds(userId: string, kind: BuildKind, now = Date.now()) {
  await db().execute({
    sql: "UPDATE higgsfield_consumer_builds SET state='unmatched',updated_at=? WHERE user_id=? AND kind=? AND state IN ('sending','uncertain','pending') AND created_at<=?",
    args: [now, userId, kind, now - BUILD_MATCH_GIVE_UP_MS],
  });
}
/** The durable claim, taken just before the paid create is sent. */
export async function claimBuild(input: { userId: string; kind: BuildKind; fingerprint: string; projectId: string | null; name: string; type: string }): Promise<string> {
  await buildsReady();
  const id = randomUUID(), now = Date.now();
  await closeStaleBuilds(input.userId, input.kind, now);
  try {
    await db().execute({
      sql: "INSERT INTO higgsfield_consumer_builds(id,user_id,kind,fingerprint,project_id,name,type,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'sending',?,?)",
      args: [id, input.userId, input.kind, input.fingerprint, input.projectId, input.name.trim(), input.type, now, now],
    });
  } catch (error) {
    if (/unique/i.test(error instanceof Error ? error.message : String(error))) throw new BuildInFlightError();
    throw error;
  }
  return id;
}
/** Refuse up front when the same build is already open (before any import). */
export async function assertNoOpenBuild(input: { userId: string; kind: BuildKind; fingerprint: string }) {
  await buildsReady();
  await closeStaleBuilds(input.userId, input.kind);
  const open = await db().execute({
    sql: "SELECT 1 FROM higgsfield_consumer_builds WHERE user_id=? AND kind=? AND fingerprint=? AND state IN ('sending','uncertain','pending') LIMIT 1",
    args: [input.userId, input.kind, input.fingerprint],
  });
  if (open.rows.length) throw new BuildInFlightError();
}
/** Record how the claimed build ended. Only an open build moves. */
export async function settleBuild(id: string, state: Exclude<BuildState, "sending">, providerId: string | null = null) {
  await buildsReady();
  await db().execute({
    sql: "UPDATE higgsfield_consumer_builds SET state=?,provider_id=COALESCE(?,provider_id),updated_at=? WHERE id=? AND state IN ('sending','uncertain','pending')",
    args: [state, providerId, Date.now(), id],
  });
}

/** One owner's open builds of one kind in this tenant, oldest first: each was
 * sent with that owner's connected account, so only its list can resolve them. */
export async function openBuilds(kind: BuildKind, userId: string): Promise<(PendingBuild & { projectId: string | null; userId: string })[]> {
  await buildsReady();
  const rows = (await db().execute({
    sql: "SELECT id,user_id,kind,project_id,name,type,state,created_at FROM higgsfield_consumer_builds WHERE kind=? AND user_id=? AND state IN ('sending','uncertain','pending') ORDER BY created_at ASC LIMIT 50",
    args: [kind, userId],
  })).rows;
  const now = Date.now();
  return rows.map((row) => ({
    id: String(row.id), userId: String(row.user_id), kind: row.kind as BuildKind, projectId: row.project_id == null ? null : String(row.project_id),
    name: String(row.name), type: String(row.type), state: row.state as PendingBuild["state"], createdAt: Number(row.created_at),
    stale: Number(row.created_at) <= now - BUILD_MATCH_GIVE_UP_MS,
  }));
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
/** When the account says an entry was created, in epoch ms; null when it does not say. */
export function accountCreatedAt(entry: unknown): number | null {
  if (!record(entry)) return null;
  for (const key of ["created_at", "createdAt", "created"]) {
    const value = entry[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value < 1e12 ? value * 1000 : value;
    if (typeof value === "string" && value.length <= 64) {
      const parsed = /^\d{9,13}$/.test(value) ? Number(value) * (value.length <= 10 ? 1000 : 1) : Date.parse(value);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
  }
  return null;
}

/**
 * Pure: which unrecorded account entry, if exactly one, is this open build —
 * the same trimmed name, the same type (when the entry names one), created
 * inside the window after the build was sent. Otherwise null (no guess).
 */
export function matchBuild(
  build: Pick<PendingBuild, "name" | "type" | "createdAt">,
  entries: readonly { id: string; name: string; type: string | null; createdAt: number | null }[],
): string | null {
  const fits = entries.filter((entry) =>
    entry.name.trim() === build.name.trim() &&
    (entry.type === null || entry.type === build.type) &&
    entry.createdAt !== null &&
    entry.createdAt >= build.createdAt - BUILD_MATCH_WINDOW.beforeMs &&
    entry.createdAt <= build.createdAt + BUILD_MATCH_WINDOW.afterMs);
  return fits.length === 1 ? fits[0].id : null;
}
