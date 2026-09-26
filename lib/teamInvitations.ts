import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  accountDbReady,
  accountTransaction,
  AccountError,
  takeAccountLimit,
} from "./accountDb";
import { assertInvitationSession } from "./accountInvitationSession";
import {
  platformDb,
  now,
  newId,
  rowToWorkspace,
  getWorkspace,
  getPlatformLayer,
  mirrorUser,
  isSuperAdmin,
} from "./platform";
import { passwordProblem, hashPassword } from "./auth";
import { ceilingFor, ceilingMessage } from "./planLimits";
import { planById } from "./plans";
import { effectivePlanId, paidPlanEntitlementTx } from "./billingLedger";
import type { WorkspaceRole, TenantWorkspace } from "./tenant";
import type { Transaction } from "@libsql/client";
import type { PlatformLayer } from "./platformLayer";

/** The platform membership is authoritative. Mirror repair survives a tenant
 * connection failure without consuming another seat or reusing an invitation. */
export async function repairPendingMemberships(accountId: string) {
  await accountDbReady();
  const pending = (
    await platformDb().execute({
      sql: "SELECT workspace_id FROM membership_mirrors WHERE account_id=?",
      args: [accountId],
    })
  ).rows;
  for (const item of pending) {
    const workspaceId = String(item.workspace_id),
      ws = await getWorkspace(workspaceId);
    if (!ws || ws.deletedAt) continue;
    const row = (
      await platformDb().execute({
        sql: `SELECT a.id,a.email,a.name,a.disabled AS account_disabled,a.deleted_at,m.role,m.disabled FROM memberships m JOIN accounts a ON a.id=m.account_id WHERE m.workspace_id=? AND m.account_id=?`,
        args: [workspaceId, accountId],
      })
    ).rows[0];
    if (!row) continue;
    await mirrorUser(
      ws,
      { id: accountId, email: String(row.email), name: String(row.name) },
      String(row.role) as WorkspaceRole,
      Boolean(row.disabled || row.account_disabled || row.deleted_at),
    );
    await platformDb().execute({
      sql: "DELETE FROM membership_mirrors WHERE workspace_id=? AND account_id=?",
      args: [workspaceId, accountId],
    });
  }
}
async function memberCeiling(
  tx: Transaction,
  ws: TenantWorkspace,
  layer: PlatformLayer,
) {
  const paid = await paidPlanEntitlementTx(tx, ws.id, now());
  const plan = planById(layer.plans, effectivePlanId(paid, ws.planId));
  return { plan, ceiling: ceilingFor(plan, "members") };
}
/** Called while holding the same platform write lock as membership changes. */
export async function ensureMemberSeat(
  tx: Transaction,
  ws: TenantWorkspace,
  layer: PlatformLayer,
) {
  const { plan, ceiling } = await memberCeiling(tx, ws, layer);
  const members = Number(
    (
      await tx.execute({
        sql: "SELECT COUNT(*) AS n FROM memberships WHERE workspace_id=? AND disabled=0",
        args: [ws.id],
      })
    ).rows[0].n,
  );
  if (ceiling != null && members >= ceiling)
    throw new AccountError(ceilingMessage(plan!, "members", ceiling), 402);
}
/** An open invitation holds a seat until it is used or expires, so the admin
 * hears about the plan's ceiling before anybody is emailed a dead link. A
 * second invitation to the same address shares that address's seat. */
export async function ensureInviteSeat(
  tx: Transaction,
  ws: TenantWorkspace,
  layer: PlatformLayer,
  email: string,
) {
  const { plan, ceiling } = await memberCeiling(tx, ws, layer);
  if (ceiling == null) return;
  const taken = Number(
    (
      await tx.execute({
        sql: `SELECT
  (SELECT COUNT(*) FROM memberships WHERE workspace_id=? AND disabled=0)+
  (SELECT COUNT(DISTINCT i.email) FROM workspace_invites i
     WHERE i.workspace_id=? AND i.used_at IS NULL AND i.expires_at>? AND i.email<>?
       AND NOT EXISTS (SELECT 1 FROM memberships m JOIN accounts a ON a.id=m.account_id
         WHERE m.workspace_id=i.workspace_id AND m.disabled=0 AND a.email=i.email)) AS n`,
        args: [ws.id, ws.id, now(), email],
      })
    ).rows[0].n,
  );
  if (taken >= ceiling)
    throw new AccountError(
      `The ${plan!.label} plan allows ${ceiling} member${ceiling === 1 ? "" : "s"}, counting open invitations. Revoke one or move to a larger plan.`,
      402,
    );
}
/** Record a workspace invitation once its seat is known to exist. */
export async function createWorkspaceInvite(input: {
  ws: TenantWorkspace;
  code: string;
  email: string;
  name: string;
  role: "admin" | "member";
  createdBy: string;
  expiresAt: number;
}) {
  const layer = await getPlatformLayer();
  await accountTransaction(async (tx) => {
    await ensureInviteSeat(tx, input.ws, layer, input.email);
    await tx.execute({
      sql: `INSERT INTO workspace_invites (code, workspace_id, email, name, role, created_by, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?)`,
      args: [
        input.code,
        input.ws.id,
        input.email,
        input.name.slice(0, 80),
        input.role,
        input.createdBy,
        now(),
        input.expiresAt,
      ],
    });
  });
}
/** A re-send only helps while the plan still has a seat for the invitee. */
export async function assertInviteSeat(ws: TenantWorkspace) {
  const layer = await getPlatformLayer();
  await accountTransaction((tx) => ensureMemberSeat(tx, ws, layer));
}
/** A new account from an invitation link that did not come from its email. */
export class MailboxProofNeeded extends AccountError {
  constructor() {
    super("Open this invitation from its email to choose a password.", 403);
    this.name = "MailboxProofNeeded";
  }
}
/* Invitation emails carry a workspace's own words from Particl's sending
   domain, so each workspace, each address within a workspace, and each
   address across the platform gets a small fixed number. The per-address
   count is kept per workspace so one workspace can never use up another's;
   the platform-wide count is only a harassment ceiling above that. */
export const INVITE_MAIL_LIMITS = {
  perWorkspaceHour: 20,
  perAddressDay: 3,
  perAddressPlatformDay: 20,
  perInvitation: 5,
} as const;
type LimitSlot = { key: string; bucket: number };
async function giveBackSlots(slots: LimitSlot[]) {
  if (!slots.length) return;
  await accountTransaction(async (tx) => {
    for (const slot of slots)
      await tx.execute({
        sql: "UPDATE account_action_limits SET n=n-1 WHERE key=? AND bucket=? AND n>0",
        args: [slot.key, slot.bucket],
      });
  });
}
const addressKey = (email: string) =>
  createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
/** One email's worth of every invitation bucket, or none of them: a refused
 * bucket gives back what this call took. `release` returns the slots when the
 * email never left. */
export async function takeInviteMailSlot(
  workspaceId: string,
  email: string,
): Promise<{ release: () => Promise<void> }> {
  const address = addressKey(email);
  const buckets = [
    {
      key: `team-invite-mail:${workspaceId}`,
      limit: INVITE_MAIL_LIMITS.perWorkspaceHour,
      windowMs: 3600_000,
      message: `This workspace has sent ${INVITE_MAIL_LIMITS.perWorkspaceHour} invitations this hour. Try again later.`,
    },
    {
      key: `team-invite-mail-to:${workspaceId}:${address}`,
      limit: INVITE_MAIL_LIMITS.perAddressDay,
      windowMs: 86400_000,
      message: `That address has been sent ${INVITE_MAIL_LIMITS.perAddressDay} invitations from this workspace today. Copy the invitation link instead.`,
    },
    {
      key: `team-invite-mail-to:${address}`,
      limit: INVITE_MAIL_LIMITS.perAddressPlatformDay,
      windowMs: 86400_000,
      message:
        "That address has had too many invitations today. Copy the invitation link instead.",
    },
  ];
  const taken: LimitSlot[] = [];
  for (const bucket of buckets) {
    const slot = {
      key: bucket.key,
      bucket: Math.floor(now() / bucket.windowMs),
    };
    try {
      await takeAccountLimit(bucket.key, bucket.limit, bucket.windowMs);
      taken.push(slot);
    } catch (error) {
      // A refusal is still counted by takeAccountLimit; this call sent nothing.
      const refused = error instanceof AccountError && error.status === 429;
      await giveBackSlots(refused ? [...taken, slot] : taken).catch(() => {});
      if (refused) throw new AccountError(bucket.message, 429);
      throw error;
    }
  }
  let released = false;
  return {
    release: async () => {
      if (released) return;
      released = true;
      await giveBackSlots(taken);
    },
  };
}
function mailboxKey() {
  const secret = process.env.KEYRING_SECRET;
  if (!secret && process.env.NODE_ENV === "production")
    throw new Error("KEYRING_SECRET is not set.");
  return createHash("sha256")
    .update("particl-invite-mailbox:" + (secret ?? "particl-dev-keyring"))
    .digest();
}
/** Proof that someone opened the invitation from its email. It is derived
 * from the code with a server secret, so the inviter, who can read the code,
 * cannot make it: it only ever travels in the email to the invited address. */
export function mailboxProof(code: string) {
  return createHmac("sha256", mailboxKey()).update(code).digest("base64url");
}
export function mailboxProven(code: string, proof: unknown) {
  if (typeof proof !== "string" || !proof || proof.length > 128) return false;
  const want = Buffer.from(mailboxProof(code)),
    got = Buffer.from(proof);
  return want.length === got.length && timingSafeEqual(want, got);
}
/** The link the invited address receives, carrying its mailbox proof. */
export function invitationMailLink(origin: string, code: string) {
  return `${origin}/invite/${encodeURIComponent(code)}?m=${mailboxProof(code)}`;
}
/** Email one open invitation of this workspace: its seat (for a re-send), the
 * per-invitation cap and the mail slots are all checked before anything is
 * sent, and the slots come back when the email never left. */
export async function mailWorkspaceInvite(input: {
  ws: TenantWorkspace;
  code: string;
  origin: string;
  deliver: (to: string, link: string) => Promise<unknown>;
  checkSeat?: boolean;
}) {
  await accountDbReady();
  const iv = (
    await platformDb().execute({
      sql: "SELECT email,send_count,used_at,expires_at FROM workspace_invites WHERE code=? AND workspace_id=?",
      args: [input.code, input.ws.id],
    })
  ).rows[0];
  if (!iv || iv.used_at) throw new AccountError("No such invitation.", 404);
  if (Number(iv.expires_at) <= now())
    throw new AccountError(
      "That invitation has expired — create a new one.",
      400,
    );
  if (Number(iv.send_count ?? 0) >= INVITE_MAIL_LIMITS.perInvitation)
    throw new AccountError(
      `This invitation has been emailed ${INVITE_MAIL_LIMITS.perInvitation} times. Copy its link instead.`,
      429,
    );
  if (input.checkSeat) await assertInviteSeat(input.ws);
  const email = String(iv.email),
    slot = await takeInviteMailSlot(input.ws.id, email);
  try {
    await input.deliver(email, invitationMailLink(input.origin, input.code));
  } catch (error) {
    await slot.release().catch(() => {});
    throw error;
  }
  await platformDb().execute({
    sql: "UPDATE workspace_invites SET sent_at=?,send_count=send_count+1 WHERE code=? AND workspace_id=?",
    args: [now(), input.code, input.ws.id],
  });
}
export async function acceptWorkspaceInvitation(input: {
  code: string;
  password?: string;
  name?: string;
  acceptedPolicy?: boolean;
  signedInAccountId?: string;
  signedInSession?: string;
  /** From the emailed link; see mailboxProof. */
  mailboxProof?: string;
  /** Wherever invitations can be emailed, a new account needs the proof. */
  requireMailboxProof?: boolean;
}) {
  const layer = await getPlatformLayer();
  const joined = await accountTransaction(async (tx) => {
    const inv = (
      await tx.execute({
        sql: "SELECT * FROM workspace_invites WHERE code=?",
        args: [input.code],
      })
    ).rows[0];
    if (!inv) throw new AccountError("This invitation is not valid.", 404);
    const row = (
      await tx.execute({
        sql: "SELECT * FROM workspaces WHERE id=? AND deleted_at IS NULL",
        args: [String(inv.workspace_id)],
      })
    ).rows[0];
    if (!row) throw new AccountError("This workspace no longer exists.", 410);
    const ws = rowToWorkspace(row),
      email = String(inv.email).toLowerCase();
    const existing = (
      await tx.execute({
        sql: "SELECT * FROM accounts WHERE email=?",
        args: [email],
      })
    ).rows[0];
    if (existing && (existing.disabled || existing.deleted_at))
      throw new AccountError("This account is not available.", 403);
    if (existing && String(existing.id) !== input.signedInAccountId)
      throw new AccountError(
        "This email already has an account. Sign in as that account to accept the invitation.",
        409,
      );
    if (existing)
      await assertInvitationSession(
        tx,
        String(existing.id),
        input.signedInSession,
      );
    const membership = existing
      ? (
          await tx.execute({
            sql: "SELECT role,disabled FROM memberships WHERE workspace_id=? AND account_id=?",
            args: [ws.id, String(existing.id)],
          })
        ).rows[0]
      : undefined;
    if (inv.used_at) {
      if (!existing || !membership || membership.disabled)
        throw new AccountError("This invitation has already been used.", 409);
      return { workspace: ws, accountId: String(existing.id) };
    }
    if (Number(inv.expires_at) < now())
      throw new AccountError(
        "This invitation has expired. Ask for a new one.",
        410,
      );
    const alreadyMember = membership && !membership.disabled;
    if (!alreadyMember) {
      await ensureMemberSeat(tx, ws, layer);
    }
    let accountId = existing ? String(existing.id) : "";
    if (!existing) {
      /* An inviter can read this link, so opening it proves nothing about the
         mailbox. The platform owner's address therefore never gets its account
         here: it must come from a verified sign-up or a password reset. */
      if (isSuperAdmin(email))
        throw new AccountError(
          "This address must create its account from the sign-up page first.",
          403,
        );
      /* Nor does the link alone make an account for an address its opener may
         not own. Where mail works, the password is chosen from the email. */
      if (
        input.requireMailboxProof &&
        !mailboxProven(input.code, input.mailboxProof)
      )
        throw new MailboxProofNeeded();
      if (!input.acceptedPolicy)
        throw new AccountError(
          "Read the content policy and terms, and tick the box.",
        );
      const password = String(input.password ?? ""),
        problem = passwordProblem(password);
      if (problem) throw new AccountError(problem);
      const name = String(inv.name || input.name || email.split("@")[0])
        .trim()
        .slice(0, 80);
      accountId = newId("usr");
      await tx.execute({
        sql: "INSERT INTO accounts(id,email,name,password_hash,created_at,accepted_policy_at) VALUES(?,?,?,?,?,?)",
        args: [accountId, email, name, hashPassword(password), now(), now()],
      });
    }
    // A second pending invite never demotes an existing owner/admin.
    if (!alreadyMember)
      await tx.execute({
        sql: `INSERT INTO memberships(workspace_id,account_id,role,disabled,created_at) VALUES(?,?,?,0,?) ON CONFLICT(workspace_id,account_id) DO UPDATE SET role=excluded.role,disabled=0`,
        args: [
          ws.id,
          accountId,
          inv.role === "admin" ? "admin" : "member",
          now(),
        ],
      });
    await tx.execute({
      sql: "UPDATE workspace_invites SET used_at=? WHERE code=? AND used_at IS NULL",
      args: [now(), input.code],
    });
    await tx.execute({
      sql: "INSERT INTO membership_mirrors(workspace_id,account_id,updated_at) VALUES(?,?,?) ON CONFLICT(workspace_id,account_id) DO UPDATE SET updated_at=excluded.updated_at",
      args: [ws.id, accountId, now()],
    });
    return { workspace: ws, accountId };
  });
  await repairPendingMemberships(joined.accountId).catch(() => {});
  return joined;
}
