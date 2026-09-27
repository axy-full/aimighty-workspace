/**
 * The platform's website account: the super admin's OWN connected account,
 * in a workspace they own, designated on the platform desk to run
 * website-only tools for every managed workspace (design structure A).
 *
 * One row in the platform database pins that connection AND the account it
 * holds (a hash of the issuer and subject, recorded at designation). Anything
 * that changes either one closes the tools for new work: a different account
 * signing in, a disconnect or refused refresh, a paused or released
 * designation, the host workspace deleted or suspended, or its owner gone.
 * While designated, the connection cannot be disconnected or re-signed from
 * Workspace › Engines, and its workspace cannot be deleted.
 *
 * Nothing here spends, and nothing it returns to a route carries a token, a
 * grant generation, an account hash, a wallet or a balance. Tenant data never
 * names this account: it is referenced from the platform level only.
 */
import type { Transaction } from "@libsql/client";
import { accountTransaction } from "../accountDb";
import { securityAuditStatement } from "../securityAudit";
import { websiteAccountCreditUsd, websiteAccountFixedCredits } from "../vendorRates";
import { ConsumerOAuthError, getConsumerAccess, type ConsumerAccess } from "./oauth";
import {
  consumerConnectionIdentityTx,
  consumerStoreReady,
  fenceConsumerAuthorizationsTx,
  type ConsumerIdentity,
} from "./store";
import { WEBSITE_TOOLS, isWebsiteToolId, websiteTool, type WebsiteToolId, type WebsiteToolPricing } from "./website-tools";
import { websiteJobsInFlightTx, websiteJobsReady } from "./platform-jobs";

type Tx = Pick<Transaction, "execute">;
let ready: Promise<void> | undefined;
export function platformAccountReady() {
  return (ready ??= consumerStoreReady()
    .then(() =>
      accountTransaction(async (tx) => {
        await tx.execute(`CREATE TABLE IF NOT EXISTS higgsfield_platform_account (
          id INTEGER PRIMARY KEY CHECK(id=1), workspace_id TEXT NOT NULL, user_id TEXT NOT NULL,
          subject_hash TEXT NOT NULL, enabled_tools TEXT NOT NULL DEFAULT '[]', paused_at INTEGER, released_at INTEGER,
          designated_by TEXT NOT NULL, designated_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
      }),
    )
    .catch((error) => {
      ready = undefined;
      throw error;
    }));
}

export type PlatformDesignation = ConsumerIdentity & {
  /** Server-only. Never serialized. */
  subjectHash: string;
  enabledTools: WebsiteToolId[];
  pausedAt: number | null;
  designatedBy: string;
  designatedAt: number;
};
function toolsOf(value: unknown): WebsiteToolId[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(value ?? "[]"));
  } catch {
    return [];
  }
  const wanted = new Set(Array.isArray(parsed) ? parsed.filter(isWebsiteToolId) : []);
  return WEBSITE_TOOLS.map((tool) => tool.id).filter((id) => wanted.has(id));
}
/** The live designation, or null when there is none (never made, or released). */
async function designationTx(tx: Tx): Promise<PlatformDesignation | null> {
  const row = (await tx.execute("SELECT * FROM higgsfield_platform_account WHERE id=1 AND released_at IS NULL")).rows[0];
  if (!row) return null;
  return {
    workspaceId: String(row.workspace_id),
    userId: String(row.user_id),
    subjectHash: String(row.subject_hash),
    enabledTools: toolsOf(row.enabled_tools),
    pausedAt: row.paused_at == null ? null : Number(row.paused_at),
    designatedBy: String(row.designated_by),
    designatedAt: Number(row.designated_at),
  };
}
export async function readPlatformDesignation(): Promise<PlatformDesignation | null> {
  await platformAccountReady();
  return accountTransaction((tx) => designationTx(tx));
}

export type PlatformAccountErrorCode =
  | "not_connected"
  | "account_unknown"
  | "not_owner"
  | "not_designated"
  | "tool_unknown"
  | "tool_unpriced"
  | "jobs_in_flight"
  | "platform_account_locked";
export class PlatformAccountError extends Error {
  readonly paidAttempted = false;
  constructor(
    readonly code: PlatformAccountErrorCode,
    message: string,
    readonly status = 409,
  ) {
    super(message);
    this.name = "PlatformAccountError";
  }
}
export const PLATFORM_ACCOUNT_LOCKED =
  "This account runs website tools for every workspace. Release or move it on the platform desk before changing it.";

/** Why new website work cannot run through the designation right now. Server-side detail only. */
export type WebsiteAccountReason = "unset" | "paused" | "disconnected" | "reconnect" | "account_changed" | "workspace_unavailable";
/**
 * The neutral refusal every client sees when the account cannot serve new
 * work: nothing was sent and nothing was charged. The reason stays on the
 * server (logs, the platform desk); it is never serialized to a workspace.
 */
export class WebsiteToolsUnavailableError extends Error {
  readonly code = "website_unavailable";
  readonly status = 503;
  readonly paidAttempted = false;
  constructor(readonly reason: WebsiteAccountReason | "busy" | "unavailable") {
    super("Website tools are temporarily unavailable. Nothing was charged.");
    this.name = "WebsiteToolsUnavailableError";
  }
}

/** The host workspace is live, and the designated person still owns it. */
async function hostStandingTx(tx: Tx, identity: ConsumerIdentity): Promise<boolean> {
  const row = (
    await tx.execute({
      sql: `SELECT w.deleted_at,w.suspended_at,m.role FROM workspaces w LEFT JOIN memberships m
        ON m.workspace_id=w.id AND m.account_id=? AND m.disabled=0 WHERE w.id=?`,
      args: [identity.userId, identity.workspaceId],
    })
  ).rows[0];
  return Boolean(row && row.deleted_at == null && row.suspended_at == null && row.role === "owner");
}
/**
 * Whether the designation can serve NEW work, from the ledger alone: no token
 * is decoded and nothing is read from the account. A pause is reported as
 * such even while healthy; the first failing check names the reason.
 */
async function healthTx(tx: Tx, designation: PlatformDesignation | null): Promise<WebsiteAccountReason | null> {
  if (!designation) return "unset";
  if (!(await hostStandingTx(tx, designation))) return "workspace_unavailable";
  const connection = await consumerConnectionIdentityTx(tx, designation);
  if (!connection || connection.status === "disconnected") return "disconnected";
  if (connection.status !== "connected") return "reconnect";
  if (connection.subjectHash !== designation.subjectHash) return "account_changed";
  if (designation.pausedAt !== null) return "paused";
  return null;
}
export async function platformAccountHealth(): Promise<{ designation: PlatformDesignation | null; reason: WebsiteAccountReason | null }> {
  await platformAccountReady();
  return accountTransaction(async (tx) => {
    const designation = await designationTx(tx);
    return { designation, reason: await healthTx(tx, designation) };
  });
}

/** True while this exact connection is the designated one (its disconnect and re-sign-in are locked). */
export async function isDesignatedIdentity(identity: ConsumerIdentity): Promise<boolean> {
  const designation = await readPlatformDesignation();
  return Boolean(designation && designation.workspaceId === identity.workspaceId && designation.userId === identity.userId);
}
/** True while the workspace hosts the designated connection (it cannot be deleted). */
export async function isDesignatedWorkspace(workspaceId: string): Promise<boolean> {
  const designation = await readPlatformDesignation();
  return designation?.workspaceId === workspaceId;
}

/** A price source for each tool: `get_cost` tools price themselves; a fixed tool needs its private price. */
export function websiteToolPriced(id: WebsiteToolId, pricing: WebsiteToolPricing = websiteTool(id).pricing): boolean {
  return pricing === "get_cost" || websiteAccountFixedCredits()[id] !== undefined;
}

export type WebsiteAccountStatus = {
  state: "unset" | "ready" | "paused" | "unavailable";
  /** Why it cannot serve new work, in the desk's words; null when ready or unset. */
  reason: string | null;
  designatedAt: number | null;
  pausedAt: number | null;
  /** The host workspace's name, for the desk only; `yours` when it is the caller's current workspace connection. */
  host: { workspaceName: string | null; yours: boolean } | null;
  /** Whether the caller's current workspace connection could be designated now. */
  candidate: { eligible: boolean; reason: string | null } | null;
  /** Whether the private credit rate is configured (never its value). */
  rateSet: boolean;
  tools: { id: WebsiteToolId; label: string; pricing: WebsiteToolPricing; enabled: boolean; priceSet: boolean }[];
};
const REASON_TEXT: Record<WebsiteAccountReason, string | null> = {
  unset: null,
  paused: null,
  disconnected: "The connection was removed. Reconnect it in the host workspace.",
  reconnect: "The account asks for a new sign-in in the host workspace.",
  account_changed: "A different account is connected there now. Designate a connection again.",
  workspace_unavailable: "The host workspace is deleted, suspended or no longer yours.",
};
/** The platform desk's view: no token, generation, account hash, wallet or balance. */
export async function platformAccountStatus(caller: ConsumerIdentity | null): Promise<WebsiteAccountStatus> {
  await platformAccountReady();
  return accountTransaction(async (tx) => {
    const designation = await designationTx(tx);
    const reason = await healthTx(tx, designation);
    let candidate: WebsiteAccountStatus["candidate"] = null;
    if (caller) {
      const connection = await consumerConnectionIdentityTx(tx, caller);
      candidate = !(await hostStandingTx(tx, caller))
        ? { eligible: false, reason: "Designate from a workspace you own." }
        : !connection || connection.status !== "connected"
          ? { eligible: false, reason: "Connect the account in this workspace's Engines first." }
          : !connection.subjectHash
            ? { eligible: false, reason: "Open Workspace › Engines once so Particl learns which account this is." }
            : { eligible: true, reason: null };
    }
    const hostName = designation
      ? (await tx.execute({ sql: "SELECT name FROM workspaces WHERE id=?", args: [designation.workspaceId] })).rows[0]?.name
      : undefined;
    const fixed = websiteAccountFixedCredits();
    return {
      state: !designation ? "unset" : reason === null ? "ready" : designation.pausedAt !== null ? "paused" : "unavailable",
      reason: reason === null ? null : REASON_TEXT[reason],
      designatedAt: designation?.designatedAt ?? null,
      pausedAt: designation?.pausedAt ?? null,
      host: designation
        ? {
            workspaceName: hostName == null ? null : String(hostName).slice(0, 120),
            yours: Boolean(caller && caller.workspaceId === designation.workspaceId && caller.userId === designation.userId),
          }
        : null,
      candidate,
      rateSet: websiteAccountCreditUsd() !== null,
      tools: WEBSITE_TOOLS.map((tool) => ({
        id: tool.id,
        label: tool.label,
        pricing: tool.pricing,
        enabled: Boolean(designation?.enabledTools.includes(tool.id)),
        priceSet: tool.pricing === "get_cost" || fixed[tool.id] !== undefined,
      })),
    };
  });
}

/**
 * Jobs admitted on the current designation keep collecting only while its
 * connection stays connected. Moving or releasing the designation unlocks that
 * connection, so while any of them is still in flight it needs an explicit
 * acknowledgement.
 */
async function refuseWhileInFlight(tx: Tx, current: PlatformDesignation | null, acknowledged: boolean) {
  if (!current || acknowledged) return;
  const running = await websiteJobsInFlightTx(tx, current);
  if (running > 0)
    throw new PlatformAccountError(
      "jobs_in_flight",
      `${running} job${running === 1 ? " is" : "s are"} still running on the current account. They keep collecting only while it stays connected. Confirm to continue.`,
    );
}

/**
 * Designate the caller's OWN connection in a workspace they own. It must be
 * connected and its account known; that account is pinned here. Sign-ins
 * started earlier for this connection are fenced, so none can replace its
 * grant after this. The same connection again keeps its tools and pause;
 * another one starts with every tool off.
 */
export async function designatePlatformAccount(identity: ConsumerIdentity, actorId: string, at = Date.now(), options: { acknowledgeInFlight?: boolean } = {}) {
  if (identity.userId !== actorId) throw new PlatformAccountError("not_owner", "Designate your own connection.", 403);
  await platformAccountReady();
  await websiteJobsReady();
  await accountTransaction(async (tx) => {
    if (!(await hostStandingTx(tx, identity)))
      throw new PlatformAccountError("not_owner", "Designate from a workspace you own.", 403);
    const connection = await consumerConnectionIdentityTx(tx, identity);
    if (!connection || connection.status !== "connected")
      throw new PlatformAccountError("not_connected", "Connect the account in this workspace's Engines first.");
    if (!connection.subjectHash)
      throw new PlatformAccountError("account_unknown", "Open Workspace › Engines once so Particl learns which account this is.");
    const current = await designationTx(tx);
    const same = Boolean(
      current && current.workspaceId === identity.workspaceId && current.userId === identity.userId && current.subjectHash === connection.subjectHash,
    );
    if (!same) await refuseWhileInFlight(tx, current, options.acknowledgeInFlight === true);
    await fenceConsumerAuthorizationsTx(tx, identity, at);
    await tx.execute({
      sql: `INSERT INTO higgsfield_platform_account(id,workspace_id,user_id,subject_hash,enabled_tools,paused_at,released_at,designated_by,designated_at,updated_at)
        VALUES(1,?,?,?,'[]',NULL,NULL,?,?,?) ON CONFLICT(id) DO UPDATE SET
        workspace_id=excluded.workspace_id,user_id=excluded.user_id,subject_hash=excluded.subject_hash,
        enabled_tools=CASE WHEN ? THEN higgsfield_platform_account.enabled_tools ELSE '[]' END,
        paused_at=CASE WHEN ? THEN higgsfield_platform_account.paused_at ELSE NULL END,
        released_at=NULL,designated_by=excluded.designated_by,
        designated_at=CASE WHEN ? THEN higgsfield_platform_account.designated_at ELSE excluded.designated_at END,
        updated_at=excluded.updated_at`,
      args: [identity.workspaceId, identity.userId, connection.subjectHash, actorId, at, at, same ? 1 : 0, same ? 1 : 0, same ? 1 : 0],
    });
    await tx.execute(
      securityAuditStatement({ workspaceId: identity.workspaceId, actorId, action: "website_account.designated", targetType: "connection", targetId: null }),
    );
  });
}

async function changeDesignation(
  actorId: string,
  change: (tx: Tx, designation: PlatformDesignation, at: number) => Promise<void>,
  action: "website_account.paused" | "website_account.resumed" | "website_account.tools_changed" | "website_account.released",
  at = Date.now(),
) {
  await platformAccountReady();
  await accountTransaction(async (tx) => {
    const designation = await designationTx(tx);
    if (!designation) throw new PlatformAccountError("not_designated", "Designate a connection first.");
    await change(tx, designation, at);
    await tx.execute(
      securityAuditStatement({ workspaceId: designation.workspaceId, actorId, action, targetType: "connection", targetId: null }),
    );
  });
}
/** Pausing closes new work at once; jobs already accepted keep collecting. */
export const setPlatformAccountPaused = (paused: boolean, actorId: string) =>
  changeDesignation(
    actorId,
    async (tx, _designation, at) => {
      await tx.execute({
        sql: `UPDATE higgsfield_platform_account SET paused_at=${paused ? "COALESCE(paused_at,?)" : "NULL"},updated_at=? WHERE id=1 AND released_at IS NULL`,
        args: paused ? [at, at] : [at],
      });
    },
    paused ? "website_account.paused" : "website_account.resumed",
  );
/**
 * The per-tool allowlist. A fixed-price tool may be switched on only once
 * its private price is set; an unknown tool refuses the whole change.
 */
export const setPlatformAccountTools = async (tools: readonly unknown[], actorId: string) => {
  if (!Array.isArray(tools) || tools.length > WEBSITE_TOOLS.length * 2)
    throw new PlatformAccountError("tool_unknown", "Choose tools from the list.", 400);
  for (const tool of tools) if (!isWebsiteToolId(tool)) throw new PlatformAccountError("tool_unknown", "Choose tools from the list.", 400);
  const wanted = new Set(tools as WebsiteToolId[]);
  const unpriced = WEBSITE_TOOLS.find((tool) => wanted.has(tool.id) && !websiteToolPriced(tool.id, tool.pricing));
  if (unpriced) throw new PlatformAccountError("tool_unpriced", `${unpriced.label} needs its private price before it can be switched on.`);
  const ordered = WEBSITE_TOOLS.map((tool) => tool.id).filter((id) => wanted.has(id));
  return changeDesignation(
    actorId,
    async (tx, _designation, at) => {
      await tx.execute({
        sql: "UPDATE higgsfield_platform_account SET enabled_tools=?,updated_at=? WHERE id=1 AND released_at IS NULL",
        args: [JSON.stringify(ordered), at],
      });
    },
    "website_account.tools_changed",
  );
};
/** Stop designating: new work closes, and the connection and its workspace are unlocked. Nothing is deleted. */
export const releasePlatformAccount = async (actorId: string, options: { acknowledgeInFlight?: boolean } = {}) => {
  await websiteJobsReady();
  return changeDesignation(
    actorId,
    async (tx, designation, at) => {
      await refuseWhileInFlight(tx, designation, options.acknowledgeInFlight === true);
      await tx.execute({ sql: "UPDATE higgsfield_platform_account SET released_at=?,updated_at=? WHERE id=1 AND released_at IS NULL", args: [at, at] });
    },
    "website_account.released",
  );
};

/**
 * Server-only access for NEW work through the designation: the designation
 * must be healthy and not paused, and the token is claimed pinned to the
 * designated account in the same transaction that reads it (a replaced
 * account, or a changed grant when `expectedGeneration` is given, refuses).
 * Every failure is the same neutral refusal; nothing is sent or charged.
 * Never serialize the result.
 */
export async function platformAccountAccess(options: { expectedGeneration?: string; fetch?: typeof fetch } = {}): Promise<ConsumerAccess & { host: ConsumerIdentity }> {
  const { designation, reason } = await platformAccountHealth();
  if (!designation || reason !== null) throw new WebsiteToolsUnavailableError(reason ?? "unset");
  const host = { workspaceId: designation.workspaceId, userId: designation.userId };
  let access: ConsumerAccess | null;
  try {
    access = await getConsumerAccess(host.workspaceId, host.userId, {
      expectedSubjectHash: designation.subjectHash,
      ...(options.expectedGeneration === undefined ? {} : { expectedGeneration: options.expectedGeneration }),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
  } catch (error) {
    if (error instanceof ConsumerOAuthError)
      throw new WebsiteToolsUnavailableError(
        error.code === "connection_busy" ? "busy" : error.code === "connection_changed" ? "account_changed" : error.code === "reconnect_required" ? "reconnect" : "unavailable",
      );
    throw new WebsiteToolsUnavailableError("unavailable");
  }
  if (!access) throw new WebsiteToolsUnavailableError("disconnected");
  return { ...access, host };
}
