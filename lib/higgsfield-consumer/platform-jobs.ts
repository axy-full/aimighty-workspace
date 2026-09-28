/**
 * The platform's registry of website-account jobs (platform database).
 *
 * One row per ADMITTED platform-funded website job of any workspace, naming
 * the connection, account and grant generation it was admitted on. Tenant
 * databases cannot see one another, so what a single shared account needs
 * lives here: which grant each job must be read with, what is in flight
 * across every workspace, and a sweep/drain index. Tenant rows never name the
 * platform's account; a platform job is read only through its row here
 * (lib/higgsfield-consumer/access.ts).
 *
 * The row is keyed by the job's meter id — the reservation's id and the
 * collected original's generation id — so its reservation, receipt and
 * registry entry are one identity. Rows are never deleted; a job leaves the
 * in-flight set by settling or being released.
 *
 * Nothing here calls a provider or moves money.
 */
import type { Transaction } from "@libsql/client";
import { accountTransaction } from "../accountDb";
import type { ConsumerIdentity } from "./store";
import type { ConsumerWorkflow } from "./jobs";
import { isWebsiteToolId, type WebsiteToolId } from "./website-tools";

type Tx = Pick<Transaction, "execute">;
let ready: Promise<void> | undefined;
export function websiteJobsReady() {
  return (ready ??= accountTransaction(async (tx) => {
    for (const sql of [
      `CREATE TABLE IF NOT EXISTS website_account_jobs (
        meter_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL, job_id TEXT NOT NULL, user_id TEXT NOT NULL, workflow TEXT NOT NULL, tool TEXT NOT NULL,
        host_workspace_id TEXT NOT NULL, host_user_id TEXT NOT NULL, subject_hash TEXT NOT NULL, generation TEXT NOT NULL,
        website_credits REAL NOT NULL CHECK(website_credits >= 0), credit_usd REAL NOT NULL CHECK(credit_usd > 0),
        particl_credits INTEGER NOT NULL CHECK(particl_credits >= 1),
        state TEXT NOT NULL CHECK(state IN ('reserved','claimed','accepted','uncertain','settled','released')),
        provider_job_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        UNIQUE(workspace_id, job_id))`,
      `CREATE INDEX IF NOT EXISTS idx_website_account_jobs_state ON website_account_jobs(state, created_at)`,
      `CREATE INDEX IF NOT EXISTS idx_website_account_jobs_host ON website_account_jobs(host_workspace_id, host_user_id, state)`,
      `CREATE TABLE IF NOT EXISTS website_account_leases (name TEXT PRIMARY KEY, holder TEXT NOT NULL, until INTEGER NOT NULL)`,
      // One provider job is one platform job, across every workspace.
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_website_account_jobs_provider ON website_account_jobs(provider_job_id) WHERE provider_job_id IS NOT NULL`,
      // Which workspace made each object on the shared account (a Soul ID, an
      // element, a setup item, an imported file): exactly one, for good.
      `CREATE TABLE IF NOT EXISTS website_account_objects (
        provider_object_id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('soul','element','setup','media')),
        workspace_id TEXT NOT NULL, created_at INTEGER NOT NULL)`,
    ])
      await tx.execute(sql);
  }).catch((error) => {
    ready = undefined;
    throw error;
  }));
}

export class WebsiteRegistryError extends Error {
  readonly paidAttempted = false;
  constructor(readonly code: "registry_conflict" | "invalid_entry" | "provider_job_conflict" | "capacity" | "object_conflict") {
    super(code === "capacity" ? "The shared account is busy with other work. Try again shortly; nothing was charged." : code);
    this.name = "WebsiteRegistryError";
  }
}

/** How long an admitted job may hold the shared account's capacity (as the per-workspace window). */
export const WEBSITE_CAPACITY_WINDOW_MS = 2 * 3_600_000;
/**
 * The shared account's in-flight caps (private runtime configuration): all
 * workspaces together (`HF_ACCOUNT_MAX_ACTIVE`, default 4) and any one
 * workspace (`HF_ACCOUNT_WORKSPACE_SHARE`, default half of that, 1–4). A
 * workspace's own limit of four still applies on top.
 */
export function websiteAccountCapacity(): { maxActive: number; workspaceShare: number } {
  const whole = (value: string | undefined, fallback: number) => {
    const n = Number(value);
    return Number.isSafeInteger(n) && n >= 1 && n <= 1000 ? n : fallback;
  };
  const maxActive = whole(process.env.HF_ACCOUNT_MAX_ACTIVE, 4);
  return { maxActive, workspaceShare: Math.min(maxActive, whole(process.env.HF_ACCOUNT_WORKSPACE_SHARE, Math.min(4, Math.max(1, Math.floor(maxActive / 2))))) };
}

export type WebsiteJobState = "reserved" | "claimed" | "accepted" | "uncertain" | "settled" | "released";
/** Admitted and not yet settled or released: it holds the account's capacity and can still cost money. */
export const WEBSITE_IN_FLIGHT: readonly WebsiteJobState[] = Object.freeze(["reserved", "claimed", "accepted", "uncertain"]);
const IN_FLIGHT_SQL = `('reserved','claimed','accepted','uncertain')`;
export type WebsiteJobEntry = {
  meterId: string;
  workspaceId: string;
  jobId: string;
  userId: string;
  workflow: ConsumerWorkflow;
  tool: WebsiteToolId;
  /** The designated connection the job is admitted on, and its account and grant. Server-only. */
  host: ConsumerIdentity;
  subjectHash: string;
  generation: string;
  /** The account's own price, in its credits, and the private rate it was converted at. Server-only. */
  websiteCredits: number;
  creditUsd: number;
  /** The exact price the client approved. */
  particlCredits: number;
};
export type WebsiteJobPin = WebsiteJobEntry & { state: WebsiteJobState; providerJobId: string | null; createdAt: number; updatedAt: number };

const ID = /^[A-Za-z0-9_.:-]{1,200}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function checkEntry(entry: WebsiteJobEntry) {
  const ids = [entry.meterId, entry.workspaceId, entry.jobId, entry.userId, entry.host.workspaceId, entry.host.userId, entry.generation];
  if (
    ids.some((id) => typeof id !== "string" || !ID.test(id)) ||
    !/^gen_hfc_[a-f0-9]{40}$/.test(entry.meterId) ||
    !/^[a-f0-9]{64}$/.test(entry.subjectHash) ||
    !isWebsiteToolId(entry.tool) ||
    typeof entry.workflow !== "string" ||
    !Number.isFinite(entry.websiteCredits) || entry.websiteCredits < 0 ||
    !Number.isFinite(entry.creditUsd) || entry.creditUsd <= 0 ||
    !Number.isSafeInteger(entry.particlCredits) || entry.particlCredits < 1
  )
    throw new WebsiteRegistryError("invalid_entry");
}
function asPin(row: Record<string, unknown>): WebsiteJobPin {
  return {
    meterId: String(row.meter_id),
    workspaceId: String(row.workspace_id),
    jobId: String(row.job_id),
    userId: String(row.user_id),
    workflow: String(row.workflow) as ConsumerWorkflow,
    tool: String(row.tool) as WebsiteToolId,
    host: { workspaceId: String(row.host_workspace_id), userId: String(row.host_user_id) },
    subjectHash: String(row.subject_hash),
    generation: String(row.generation),
    websiteCredits: Number(row.website_credits),
    creditUsd: Number(row.credit_usd),
    particlCredits: Number(row.particl_credits),
    state: String(row.state) as WebsiteJobState,
    providerJobId: row.provider_job_id == null ? null : String(row.provider_job_id),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}
const same = (pin: WebsiteJobPin, entry: WebsiteJobEntry) =>
  pin.workspaceId === entry.workspaceId && pin.jobId === entry.jobId && pin.userId === entry.userId && pin.workflow === entry.workflow &&
  pin.tool === entry.tool && pin.host.workspaceId === entry.host.workspaceId && pin.host.userId === entry.host.userId &&
  pin.subjectHash === entry.subjectHash && pin.generation === entry.generation && pin.websiteCredits === entry.websiteCredits &&
  pin.creditUsd === entry.creditUsd && pin.particlCredits === entry.particlCredits;

async function pinTx(tx: Tx, where: { meterId: string } | { workspaceId: string; jobId: string }): Promise<WebsiteJobPin | null> {
  const row = (
    "meterId" in where
      ? await tx.execute({ sql: "SELECT * FROM website_account_jobs WHERE meter_id=?", args: [where.meterId] })
      : await tx.execute({ sql: "SELECT * FROM website_account_jobs WHERE workspace_id=? AND job_id=?", args: [where.workspaceId, where.jobId] })
  ).rows[0];
  return row ? asPin(row as Record<string, unknown>) : null;
}

/**
 * Record an admitted job, inside the caller's platform transaction (the one
 * that reserves its credits). The same entry again is a no-op, so a repeated
 * admission never creates a second row; a different entry under the same
 * meter id or job refuses.
 */
export async function registerWebsiteDispatchTx(tx: Tx, entry: WebsiteJobEntry, at = Date.now()): Promise<"registered" | "replayed"> {
  checkEntry(entry);
  const byMeter = await pinTx(tx, { meterId: entry.meterId });
  const byJob = await pinTx(tx, { workspaceId: entry.workspaceId, jobId: entry.jobId });
  if (byMeter || byJob) {
    if (byMeter && byJob && byMeter.meterId === byJob.meterId && same(byMeter, entry)) return "replayed";
    throw new WebsiteRegistryError("registry_conflict");
  }
  // Global capacity and each workspace's share, decided in the same transaction as the reservation.
  const { maxActive, workspaceShare } = websiteAccountCapacity();
  const counts = (
    await tx.execute({
      sql: `SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN workspace_id=? THEN 1 ELSE 0 END),0) AS mine
        FROM website_account_jobs WHERE state IN ${IN_FLIGHT_SQL} AND created_at>?`,
      args: [entry.workspaceId, at - WEBSITE_CAPACITY_WINDOW_MS],
    })
  ).rows[0];
  if (Number(counts?.total ?? 0) >= maxActive || Number(counts?.mine ?? 0) >= workspaceShare) throw new WebsiteRegistryError("capacity");
  await tx.execute({
    sql: `INSERT INTO website_account_jobs(meter_id,workspace_id,job_id,user_id,workflow,tool,host_workspace_id,host_user_id,subject_hash,generation,
      website_credits,credit_usd,particl_credits,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'reserved',?,?)`,
    args: [entry.meterId, entry.workspaceId, entry.jobId, entry.userId, entry.workflow, entry.tool, entry.host.workspaceId, entry.host.userId,
      entry.subjectHash, entry.generation, entry.websiteCredits, entry.creditUsd, entry.particlCredits, at, at],
  });
  return "registered";
}

/** The registry row behind one meter id in this workspace, or null. Server-only. */
export async function websiteJobPinByMeter(workspaceId: string, meterId: string): Promise<WebsiteJobPin | null> {
  await websiteJobsReady();
  const pin = await accountTransaction((tx) => pinTx(tx, { meterId }));
  return pin && pin.workspaceId === workspaceId ? pin : null;
}
/** A workspace's job as the registry pinned it, or null. Server-only; never serialize. */
export async function websiteJobPin(workspaceId: string, jobId: string): Promise<WebsiteJobPin | null> {
  await websiteJobsReady();
  return accountTransaction((tx) => pinTx(tx, { workspaceId, jobId }));
}

/** Which states a job may move to from which. Settled and released are final. */
const MOVES: Record<Exclude<WebsiteJobState, "reserved">, readonly WebsiteJobState[]> = {
  claimed: ["reserved"],
  accepted: ["claimed", "uncertain"],
  uncertain: ["claimed"],
  settled: ["accepted", "uncertain"],
  released: ["reserved", "claimed", "accepted", "uncertain"],
};
/**
 * Move one job along its lifecycle, inside the caller's transaction. An
 * acceptance names exactly one provider job id and never replaces another.
 * True when the row moved (or already stood there with the same id).
 */
export async function moveWebsiteJobTx(
  tx: Tx,
  where: { workspaceId: string; jobId: string },
  to: Exclude<WebsiteJobState, "reserved">,
  options: { providerJobId?: string } = {},
  at = Date.now(),
): Promise<boolean> {
  const pin = await pinTx(tx, where);
  if (!pin) return false;
  let providerJobId: string | null = null;
  if (to === "accepted") {
    if (!options.providerJobId || !UUID.test(options.providerJobId)) throw new WebsiteRegistryError("invalid_entry");
    providerJobId = options.providerJobId.toLowerCase();
    if (pin.providerJobId !== null && pin.providerJobId !== providerJobId) throw new WebsiteRegistryError("provider_job_conflict");
    // A provider job already recorded for any other job, in any workspace, is never adopted.
    const other = (
      await tx.execute({ sql: "SELECT 1 FROM website_account_jobs WHERE provider_job_id=? AND meter_id<>? LIMIT 1", args: [providerJobId, pin.meterId] })
    ).rows[0];
    if (other) throw new WebsiteRegistryError("provider_job_conflict");
  }
  if (pin.state === to && (to !== "accepted" || pin.providerJobId === providerJobId)) return true;
  if (!MOVES[to].includes(pin.state)) return false;
  const changed = await tx.execute({
    sql: `UPDATE website_account_jobs SET state=?,provider_job_id=COALESCE(provider_job_id,?),updated_at=? WHERE meter_id=? AND state=?`,
    args: [to, providerJobId, at, pin.meterId, pin.state],
  });
  return changed.rowsAffected === 1;
}

/** How many jobs admitted on this connection are still in flight (all connections when none is named). */
export async function websiteJobsInFlightTx(tx: Tx, host?: ConsumerIdentity): Promise<number> {
  const result = host
    ? await tx.execute({
        sql: `SELECT COUNT(*) AS n FROM website_account_jobs WHERE host_workspace_id=? AND host_user_id=? AND state IN ${IN_FLIGHT_SQL}`,
        args: [host.workspaceId, host.userId],
      })
    : await tx.execute(`SELECT COUNT(*) AS n FROM website_account_jobs WHERE state IN ${IN_FLIGHT_SQL}`);
  return Number(result.rows[0]?.n ?? 0);
}

/**
 * A short platform lease that serialises the last wallet check and the one
 * paid call across every workspace. A lease is not a correctness guarantee
 * (claims are); it keeps two dispatches from passing the same balance check.
 */
export async function takeWebsiteLease(name: string, holder: string, ttlMs: number, at = Date.now()): Promise<boolean> {
  if (!ID.test(name) || !ID.test(holder) || !Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 600_000) throw new WebsiteRegistryError("invalid_entry");
  await websiteJobsReady();
  return accountTransaction(async (tx) => {
    const row = (await tx.execute({ sql: "SELECT holder,until FROM website_account_leases WHERE name=?", args: [name] })).rows[0];
    if (row && String(row.holder) !== holder && Number(row.until) > at) return false;
    await tx.execute({
      sql: "INSERT INTO website_account_leases(name,holder,until) VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET holder=excluded.holder,until=excluded.until",
      args: [name, holder, at + ttlMs],
    });
    return true;
  });
}
export async function releaseWebsiteLease(name: string, holder: string): Promise<boolean> {
  await websiteJobsReady();
  return accountTransaction(async (tx) =>
    (await tx.execute({ sql: "UPDATE website_account_leases SET until=0 WHERE name=? AND holder=?", args: [name, holder] })).rowsAffected === 1,
  );
}

/* ── Objects on the shared account ────────────────────────────────────── */

export type WebsiteObjectKind = "soul" | "element" | "setup" | "media";
const OBJECT_ID = /^[A-Za-z0-9_.:-]{1,200}$/;
/**
 * Record which workspace made an object on the shared account, inside the
 * caller's transaction. The same workspace again is a no-op; another
 * workspace refuses — an upstream object belongs to exactly one workspace.
 */
export async function registerWebsiteObjectTx(tx: Tx, object: { id: string; kind: WebsiteObjectKind; workspaceId: string }, at = Date.now()) {
  if (!OBJECT_ID.test(object.id) || !ID.test(object.workspaceId) || !["soul", "element", "setup", "media"].includes(object.kind))
    throw new WebsiteRegistryError("invalid_entry");
  const row = (await tx.execute({ sql: "SELECT kind,workspace_id FROM website_account_objects WHERE provider_object_id=?", args: [object.id] })).rows[0];
  if (row) {
    if (String(row.workspace_id) === object.workspaceId && String(row.kind) === object.kind) return;
    throw new WebsiteRegistryError("object_conflict");
  }
  await tx.execute({
    sql: "INSERT INTO website_account_objects(provider_object_id,kind,workspace_id,created_at) VALUES(?,?,?,?)",
    args: [object.id, object.kind, object.workspaceId, at],
  });
}
/** Which workspace made each of these objects on the shared account; ids no workspace made are absent. */
export async function websiteObjectOwners(ids: readonly string[]): Promise<Map<string, { kind: WebsiteObjectKind; workspaceId: string }>> {
  const wanted = [...new Set(ids.filter((id) => typeof id === "string" && OBJECT_ID.test(id)))].slice(0, 500);
  const out = new Map<string, { kind: WebsiteObjectKind; workspaceId: string }>();
  if (!wanted.length) return out;
  await websiteJobsReady();
  const rows = await accountTransaction((tx) =>
    tx.execute({ sql: `SELECT provider_object_id,kind,workspace_id FROM website_account_objects WHERE provider_object_id IN (${wanted.map(() => "?").join(",")})`, args: wanted }),
  );
  for (const row of rows.rows) out.set(String(row.provider_object_id), { kind: String(row.kind) as WebsiteObjectKind, workspaceId: String(row.workspace_id) });
  return out;
}
