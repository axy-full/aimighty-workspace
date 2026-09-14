import { createHash, randomBytes } from "node:crypto";
import type { Transaction, Row } from "@libsql/client";
import {
  accountTransaction,
  AccountError,
  takeAccountLimit,
} from "./accountDb";
import { platformDb, platformReady, now } from "./platform";
import { verifyPassword } from "./auth";
import { open, seal } from "./keyring";
import { matchingTotpCounter, newTotpSecret } from "./totp";
import { securityAuditStatement, type SecurityAction } from "./securityAudit";
import { RECOVERY_AUTHORIZATION_SCHEMA } from "./accountSecuritySchema";

const tokenHash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const recoveryHash = (accountId: string, code: string) =>
  tokenHash(
    `particl-recovery:${accountId}:${code.replace(/-/g, "").toUpperCase()}`,
  );
const sessionId = (hash: string) => tokenHash(`particl-session-list:${hash}`);
const sessionDays = 30;
const recoveryReplacementWindowMs = 10 * 60_000;
function secretFor(accountId: string, encrypted: string) {
  const value = JSON.parse(open(encrypted));
  if (
    value.purpose !== "account-mfa" ||
    value.accountId !== accountId ||
    typeof value.secret !== "string"
  )
    throw new Error("Authenticator secret does not belong to this account");
  return value.secret as string;
}
async function security(tx: Transaction, accountId: string) {
  return (
    await tx.execute({
      sql: "SELECT * FROM account_security WHERE account_id=?",
      args: [accountId],
    })
  ).rows[0];
}
const enabled = (row: Row | undefined) => row?.enabled_at != null;
async function receipt(
  tx: Transaction,
  accountId: string,
  action: SecurityAction,
  workspaceId: string | null = null,
) {
  await tx.execute(
    securityAuditStatement({
      workspaceId,
      actorId: accountId,
      action,
      targetType: "account",
      targetId: accountId,
    }),
  );
}
/** Central session issuance refuses to create a password-only session for an
 * MFA account. Only a verified factor in this same transaction may opt in. */
export async function insertAccountSession(
  tx: Transaction,
  input: {
    accountId: string;
    workspaceId: string | null;
    factorVerified?: boolean;
    deviceLabel?: string;
  },
) {
  const account = (
    await tx.execute({
      sql: "SELECT id FROM accounts WHERE id=? AND disabled=0 AND deleted_at IS NULL",
      args: [input.accountId],
    })
  ).rows[0];
  if (!account)
    throw new AccountError("This account is no longer available.", 403);
  const state = await security(tx, input.accountId);
  if (enabled(state) && !input.factorVerified)
    throw new AccountError("Use two-step sign-in to open this account.", 403);
  const session = randomBytes(32).toString("base64url"),
    hash = tokenHash(session),
    at = now();
  await tx.execute({
    sql: "INSERT INTO p_sessions(token_hash,account_id,workspace_id,created_at,expires_at) VALUES(?,?,?,?,?)",
    args: [
      hash,
      input.accountId,
      input.workspaceId,
      at,
      at + sessionDays * 86400_000,
    ],
  });
  await tx.execute({
    sql: "INSERT INTO session_security(token_hash,factor_at,epoch,device_label) VALUES(?,?,?,?)",
    args: [
      hash,
      input.factorVerified ? at : null,
      Number(state?.epoch ?? 0),
      input.deviceLabel ?? "Browser session",
    ],
  });
  await receipt(tx, input.accountId, "session.created", input.workspaceId);
  return session;
}
/** Use only coarse enumerated labels; raw user-agent and location are not stored. */
export function sessionDeviceLabel(raw: string) {
  const browser = /Edg\//.test(raw)
    ? "Edge"
    : /Firefox\//.test(raw)
      ? "Firefox"
      : /Chrome\//.test(raw)
        ? "Chrome"
        : /Safari\//.test(raw)
          ? "Safari"
          : "Browser";
  const system = /Android/.test(raw)
    ? "Android"
    : /iPhone|iPad/.test(raw)
      ? "iOS"
      : /Windows/.test(raw)
        ? "Windows"
        : /Macintosh/.test(raw)
          ? "macOS"
          : /Linux/.test(raw)
            ? "Linux"
            : "device";
  return `${browser} on ${system}`;
}
async function consumeFactor(
  tx: Transaction,
  accountId: string,
  code: string,
  state: Row,
) {
  const at = now();
  const counter = matchingTotpCounter(
    secretFor(accountId, String(state.secret_enc)),
    code,
    at,
    Number(state.last_counter),
  );
  if (counter != null) {
    await tx.execute({
      sql: "UPDATE account_security SET last_counter=? WHERE account_id=?",
      args: [counter, accountId],
    });
    return "totp" as const;
  }
  if (/^[A-Fa-f0-9-]{20,24}$/.test(code)) {
    const used = await tx.execute({
      sql: "UPDATE account_recovery_codes SET used_at=? WHERE account_id=? AND code_hash=? AND used_at IS NULL",
      args: [at, accountId, recoveryHash(accountId, code)],
    });
    if (used.rowsAffected === 1) {
      await receipt(tx, accountId, "account.recovery_code_used");
      return "recovery" as const;
    }
  }
  throw new AccountError(
    "That code is invalid or already used. Try the next authenticator code or an unused recovery code.",
    401,
  );
}
/** Password validation happens before entry, then the hash is compared again
 * under the write lock to prevent a reset/disable race from issuing a session. */
export async function completePasswordLogin(input: {
  accountId: string;
  passwordHash: string;
  code: string;
  deviceLabel: string;
}) {
  if (input.code)
    await takeAccountLimit(`mfa-login:${input.accountId}`, 8, 5 * 60_000);
  return accountTransaction(async (tx) => {
    const account = (
      await tx.execute({
        sql: "SELECT password_hash FROM accounts WHERE id=? AND disabled=0 AND deleted_at IS NULL",
        args: [input.accountId],
      })
    ).rows[0];
    if (!account || account.password_hash !== input.passwordHash)
      throw new AccountError("Your credentials changed. Sign in again.", 401);
    const state = await security(tx, input.accountId);
    if (enabled(state) && !input.code) return { mfaRequired: true as const };
    const factor = enabled(state)
      ? await consumeFactor(tx, input.accountId, input.code, state!)
      : null;
    const member = (
      await tx.execute({
        sql: "SELECT m.workspace_id FROM memberships m JOIN workspaces w ON w.id=m.workspace_id WHERE m.account_id=? AND m.disabled=0 AND w.deleted_at IS NULL ORDER BY m.created_at,m.workspace_id LIMIT 1",
        args: [input.accountId],
      })
    ).rows[0];
    const session = await insertAccountSession(tx, {
      accountId: input.accountId,
      workspaceId: member ? String(member.workspace_id) : null,
      factorVerified: enabled(state),
      deviceLabel: input.deviceLabel,
    });
    if (factor === "recovery") {
      await tx.execute(RECOVERY_AUTHORIZATION_SCHEMA);
      // A final recovery code must still permit replacing the lost factor's
      // backup codes. This proof is server-only, narrowly scoped and single-use.
      await tx.execute({
        sql: "INSERT INTO account_recovery_authorizations(session_hash,account_id,password_fingerprint,epoch,expires_at) VALUES(?,?,?,?,?)",
        args: [
          tokenHash(session),
          input.accountId,
          tokenHash(input.passwordHash),
          Number(state!.epoch),
          now() + recoveryReplacementWindowMs,
        ],
      });
    }
    return { session, mfaRequired: false as const };
  });
}
async function passwordProof(accountId: string, password: string) {
  if (!password || password.length > 200)
    throw new AccountError("Enter your current password.", 401);
  await takeAccountLimit(`account-security:${accountId}`, 12, 10 * 60_000);
  const account = (
    await platformDb().execute({
      sql: "SELECT password_hash FROM accounts WHERE id=? AND disabled=0 AND deleted_at IS NULL",
      args: [accountId],
    })
  ).rows[0];
  if (!account || !verifyPassword(password, String(account.password_hash)))
    throw new AccountError("The current password is incorrect.", 401);
  return String(account.password_hash);
}
export async function assertLiveAccountSession(
  tx: Transaction,
  accountId: string,
  session: string,
  passwordHash?: string,
  requestScope?: string,
) {
  const row = (
    await tx.execute({
      sql: `SELECT a.password_hash,s.workspace_id FROM p_sessions s JOIN accounts a ON a.id=s.account_id
    LEFT JOIN account_security asec ON asec.account_id=a.id LEFT JOIN session_security ss ON ss.token_hash=s.token_hash
    WHERE s.account_id=? AND s.token_hash=? AND s.expires_at>? AND a.disabled=0 AND a.deleted_at IS NULL
      AND (asec.enabled_at IS NULL OR (ss.factor_at IS NOT NULL AND ss.epoch=asec.epoch))`,
      args: [accountId, tokenHash(session), now()],
    })
  ).rows[0];
  if (!row || (passwordHash != null && row.password_hash !== passwordHash))
    throw new AccountError(
      "Your session or password changed. Sign in again.",
      401,
    );
  const selected = (
    await tx.execute({
      sql: `SELECT w.id FROM memberships m JOIN workspaces w ON w.id=m.workspace_id
    WHERE m.account_id=? AND m.disabled=0 AND w.deleted_at IS NULL ORDER BY CASE WHEN w.id=? THEN 0 ELSE 1 END,w.created_at LIMIT 1`,
      args: [accountId, row.workspace_id],
    })
  ).rows[0];
  const workspaceId = selected ? String(selected.id) : null;
  if (
    requestScope &&
    requestScope !==
      (workspaceId
        ? `particl-active-${workspaceId}-${accountId}`
        : `particl-account-${accountId}`)
  )
    throw new AccountError(
      "Your account or workspace changed. Reload security settings.",
      409,
    );
  return workspaceId;
}
async function replaceRecoveryCodes(tx: Transaction, accountId: string) {
  await tx.execute(RECOVERY_AUTHORIZATION_SCHEMA);
  await tx.execute({
    sql: "DELETE FROM account_recovery_authorizations WHERE account_id=?",
    args: [accountId],
  });
  const codes = Array.from({ length: 10 }, () =>
    randomBytes(10).toString("hex").toUpperCase().match(/.{4}/g)!.join("-"),
  );
  await tx.execute({
    sql: "DELETE FROM account_recovery_codes WHERE account_id=?",
    args: [accountId],
  });
  for (const code of codes)
    await tx.execute({
      sql: "INSERT INTO account_recovery_codes(account_id,code_hash,created_at) VALUES(?,?,?)",
      args: [accountId, recoveryHash(accountId, code), now()],
    });
  return codes;
}
async function rotateCurrentSession(
  tx: Transaction,
  accountId: string,
  session: string,
  factor: boolean,
) {
  const current = (
    await tx.execute({
      sql: "SELECT s.workspace_id,ss.device_label FROM p_sessions s LEFT JOIN session_security ss ON ss.token_hash=s.token_hash WHERE s.token_hash=? AND s.account_id=?",
      args: [tokenHash(session), accountId],
    })
  ).rows[0];
  if (!current)
    throw new AccountError("Your session ended. Sign in again.", 401);
  await tx.execute(RECOVERY_AUTHORIZATION_SCHEMA);
  await tx.execute({
    sql: "DELETE FROM account_recovery_authorizations WHERE account_id=?",
    args: [accountId],
  });
  await tx.execute({
    sql: "DELETE FROM session_security WHERE token_hash IN (SELECT token_hash FROM p_sessions WHERE account_id=?)",
    args: [accountId],
  });
  await tx.execute({
    sql: "DELETE FROM p_sessions WHERE account_id=?",
    args: [accountId],
  });
  return insertAccountSession(tx, {
    accountId,
    workspaceId:
      current.workspace_id == null ? null : String(current.workspace_id),
    factorVerified: factor,
    deviceLabel: String(current.device_label ?? "Browser session"),
  });
}

export type SecurityChange =
  | "begin"
  | "enable"
  | "disable"
  | "rotate_codes"
  | "activate_codes"
  | "revoke_session"
  | "revoke_others";
export async function changeAccountSecurity(input: {
  accountId: string;
  session: string;
  password: string;
  code?: string;
  action: SecurityChange;
  sessionId?: string;
  requestScope?: string;
  batchId?: string;
}) {
  const passwordHash = await passwordProof(input.accountId, input.password);
  return accountTransaction(async (tx) => {
    const workspaceId = await assertLiveAccountSession(
      tx,
      input.accountId,
      input.session,
      passwordHash,
      input.requestScope,
    );
    const state = await security(tx, input.accountId),
      at = now(),
      code = String(input.code ?? "").trim();
    if (input.action === "begin") {
      if (enabled(state))
        throw new AccountError("Two-step sign-in is already enabled.", 409);
      const secret = newTotpSecret(),
        encrypted = seal(
          JSON.stringify({
            purpose: "account-mfa",
            accountId: input.accountId,
            secret,
          }),
        );
      await tx.execute({
        sql: `INSERT INTO account_security(account_id,pending_enc,pending_session_hash,pending_expires_at) VALUES(?,?,?,?)
        ON CONFLICT(account_id) DO UPDATE SET pending_enc=excluded.pending_enc,pending_session_hash=excluded.pending_session_hash,pending_expires_at=excluded.pending_expires_at`,
        args: [
          input.accountId,
          encrypted,
          tokenHash(input.session),
          at + 10 * 60_000,
        ],
      });
      const account = (
        await tx.execute({
          sql: "SELECT email FROM accounts WHERE id=?",
          args: [input.accountId],
        })
      ).rows[0];
      return {
        setup: {
          secret,
          uri: `otpauth://totp/${encodeURIComponent(`Particl:${String(account.email)}`)}?secret=${secret}&issuer=Particl&algorithm=SHA1&digits=6&period=30`,
          expiresAt: at + 10 * 60_000,
        },
      };
    }
    if (input.action === "enable") {
      if (
        enabled(state) ||
        !state?.pending_enc ||
        state.pending_session_hash !== tokenHash(input.session) ||
        Number(state.pending_expires_at) <= at
      )
        throw new AccountError(
          "Authenticator setup expired or changed. Start setup again.",
          409,
        );
      const counter = matchingTotpCounter(
        secretFor(input.accountId, String(state.pending_enc)),
        code,
        at,
        -1,
      );
      if (counter == null)
        throw new AccountError(
          "Enter the current six-digit code from your authenticator.",
          401,
        );
      const epoch = Number(state.epoch) + 1;
      await tx.execute({
        sql: "UPDATE account_security SET secret_enc=pending_enc,enabled_at=?,last_counter=?,epoch=?,pending_enc=NULL,pending_session_hash=NULL,pending_expires_at=NULL WHERE account_id=?",
        args: [at, counter, epoch, input.accountId],
      });
      const recoveryCodes = await replaceRecoveryCodes(tx, input.accountId);
      const session = await rotateCurrentSession(
        tx,
        input.accountId,
        input.session,
        true,
      );
      await receipt(tx, input.accountId, "account.mfa_enabled", workspaceId);
      return { recoveryCodes, session };
    }
    if (input.action === "rotate_codes" || input.action === "activate_codes") {
      if (!enabled(state))
        throw new AccountError("Enable two-step sign-in first.", 409);
      const batch = (
        await tx.execute({
          sql: "SELECT * FROM account_recovery_batches WHERE account_id=?",
          args: [input.accountId],
        })
      ).rows[0];
      const sameSession = batch?.session_hash === tokenHash(input.session);
      if (input.action === "activate_codes") {
        if (!batch || !sameSession || batch.id !== input.batchId)
          throw new AccountError(
            "This recovery-code set changed. Refresh security settings.",
            409,
          );
        if (batch.state === "active") return { ok: true };
        const saved = JSON.parse(open(String(batch.codes_enc)));
        if (
          saved.accountId !== input.accountId ||
          saved.batchId !== batch.id ||
          !Array.isArray(saved.codes)
        )
          throw new Error("Invalid recovery-code receipt");
        await tx.execute({
          sql: "DELETE FROM account_recovery_codes WHERE account_id=?",
          args: [input.accountId],
        });
        for (const value of saved.codes)
          await tx.execute({
            sql: "INSERT INTO account_recovery_codes(account_id,code_hash,created_at) VALUES(?,?,?)",
            args: [
              input.accountId,
              recoveryHash(input.accountId, String(value)),
              at,
            ],
          });
        await tx.execute({
          sql: "UPDATE account_recovery_batches SET state='active',codes_enc='' WHERE account_id=? AND id=?",
          args: [input.accountId, input.batchId],
        });
        await tx.execute(RECOVERY_AUTHORIZATION_SCHEMA);
        await tx.execute({
          sql: "DELETE FROM account_recovery_authorizations WHERE account_id=?",
          args: [input.accountId],
        });
        await receipt(
          tx,
          input.accountId,
          "account.recovery_codes_rotated",
          workspaceId,
        );
        return { ok: true };
      }
      if (batch && sameSession && batch.state === "prepared") {
        const saved = JSON.parse(open(String(batch.codes_enc)));
        if (
          saved.accountId !== input.accountId ||
          saved.batchId !== batch.id ||
          !Array.isArray(saved.codes)
        )
          throw new Error("Invalid recovery-code receipt");
        return {
          recoveryCodes: saved.codes as string[],
          batchId: String(batch.id),
        };
      }
    }
    let recoveryReplacementAuthorized = false;
    if (input.action === "rotate_codes") {
      await tx.execute(RECOVERY_AUTHORIZATION_SCHEMA);
      const consumed = await tx.execute({
        sql: `DELETE FROM account_recovery_authorizations
          WHERE account_id=? AND session_hash=? AND password_fingerprint=? AND epoch=? AND expires_at>?`,
        args: [
          input.accountId,
          tokenHash(input.session),
          tokenHash(passwordHash),
          Number(state!.epoch),
          at,
        ],
      });
      recoveryReplacementAuthorized = consumed.rowsAffected === 1;
    }
    if (enabled(state) && !recoveryReplacementAuthorized) {
      const factor = await consumeFactor(tx, input.accountId, code, state!);
      if (
        factor === "recovery" &&
        (input.action === "revoke_others" || input.action === "revoke_session")
      ) {
        const remaining = (
          await tx.execute({
            sql: "SELECT count(*) n FROM account_recovery_codes WHERE account_id=? AND used_at IS NULL",
            args: [input.accountId],
          })
        ).rows[0];
        if (Number(remaining.n) === 0)
          // Roll back the factor use too. A lost rotated-cookie response must
          // not leave the account with neither a usable session nor a factor.
          throw new AccountError(
            "Save and activate replacement recovery codes before using your last code to revoke sessions.",
            409,
          );
      }
    }
    if (input.action === "disable") {
      if (!enabled(state))
        throw new AccountError("Two-step sign-in is already off.", 409);
      if ((await requiredWorkspaces(tx, input.accountId)).length)
        throw new AccountError(
          "A workspace you belong to requires two-step sign-in. Its owner must remove that requirement, or remove your membership, before you can turn it off.",
          409,
        );
      const epoch = Number(state!.epoch) + 1;
      await tx.execute({
        sql: "UPDATE account_security SET secret_enc=NULL,enabled_at=NULL,last_counter=-1,epoch=?,pending_enc=NULL,pending_session_hash=NULL,pending_expires_at=NULL WHERE account_id=?",
        args: [epoch, input.accountId],
      });
      await tx.execute({
        sql: "DELETE FROM account_recovery_codes WHERE account_id=?",
        args: [input.accountId],
      });
      await tx.execute({
        sql: "DELETE FROM account_recovery_batches WHERE account_id=?",
        args: [input.accountId],
      });
      const session = await rotateCurrentSession(
        tx,
        input.accountId,
        input.session,
        false,
      );
      await receipt(tx, input.accountId, "account.mfa_disabled", workspaceId);
      return { ok: true, session };
    }
    if (input.action === "rotate_codes") {
      const recoveryCodes = Array.from({ length: 10 }, () =>
        randomBytes(10).toString("hex").toUpperCase().match(/.{4}/g)!.join("-"),
      );
      const batchId = randomBytes(24).toString("hex");
      const encrypted = seal(
        JSON.stringify({
          accountId: input.accountId,
          batchId,
          codes: recoveryCodes,
        }),
      );
      await tx.execute({
        sql: `INSERT INTO account_recovery_batches(account_id,id,session_hash,codes_enc,state,created_at) VALUES(?,?,?,?,'prepared',?)
        ON CONFLICT(account_id) DO UPDATE SET id=excluded.id,session_hash=excluded.session_hash,codes_enc=excluded.codes_enc,state=excluded.state,created_at=excluded.created_at`,
        args: [
          input.accountId,
          batchId,
          tokenHash(input.session),
          encrypted,
          at,
        ],
      });
      return { recoveryCodes, batchId };
    }
    if (input.action === "revoke_others") {
      const session = await rotateCurrentSession(
        tx,
        input.accountId,
        input.session,
        enabled(state),
      );
      // Only this browser's exact prepared set follows its newly verified
      // cookie. Never transfer another browser's batch or an active receipt.
      await tx.execute({
        sql: "UPDATE account_recovery_batches SET session_hash=? WHERE account_id=? AND session_hash=? AND state='prepared'",
        args: [tokenHash(session), input.accountId, tokenHash(input.session)],
      });
      await receipt(
        tx,
        input.accountId,
        "account.sessions_revoked",
        workspaceId,
      );
      return { ok: true, session };
    }
    if (input.action === "revoke_session") {
      const sessions = await tx.execute({
        sql: "SELECT token_hash FROM p_sessions WHERE account_id=? AND expires_at>?",
        args: [input.accountId, at],
      });
      const target = sessions.rows.find(
        (row) => sessionId(String(row.token_hash)) === input.sessionId,
      );
      if (!target)
        throw new AccountError(
          "That session has ended or belongs to another account.",
          404,
        );
      if (target.token_hash === tokenHash(input.session))
        throw new AccountError("Use Sign out to end the current session.", 409);
      await tx.execute({
        sql: "DELETE FROM session_security WHERE token_hash=?",
        args: [target.token_hash],
      });
      await tx.execute({
        sql: "DELETE FROM p_sessions WHERE token_hash=? AND account_id=?",
        args: [target.token_hash, input.accountId],
      });
      await receipt(
        tx,
        input.accountId,
        "account.sessions_revoked",
        workspaceId,
      );
      return { ok: true };
    }
    throw new AccountError("Choose a valid security action.");
  });
}
export async function readAccountSecurity(
  accountId: string,
  session: string,
  requestScope?: string,
) {
  await platformReady();
  // A transaction gives the page one consistent account/session view.
  return accountTransaction(async (tx) => {
    await assertLiveAccountSession(
      tx,
      accountId,
      session,
      undefined,
      requestScope,
    );
    const state = await security(tx, accountId);
    await tx.execute(RECOVERY_AUTHORIZATION_SCHEMA);
    const authorization = (
      await tx.execute({
        sql: `SELECT r.expires_at,r.password_fingerprint,a.password_hash FROM account_recovery_authorizations r
          JOIN accounts a ON a.id=r.account_id
          WHERE r.account_id=? AND r.session_hash=? AND r.epoch=? AND r.expires_at>?`,
        args: [accountId, tokenHash(session), Number(state?.epoch ?? 0), now()],
      })
    ).rows[0];
    const replacementAuthorized =
      authorization &&
      enabled(state) &&
      authorization.password_fingerprint ===
        tokenHash(String(authorization.password_hash));
    const rows = await tx.execute({
      sql: `SELECT s.token_hash,s.created_at,s.expires_at,ss.device_label FROM p_sessions s LEFT JOIN session_security ss ON ss.token_hash=s.token_hash
      WHERE s.account_id=? AND s.expires_at>? ORDER BY s.created_at DESC,s.token_hash LIMIT 100`,
      args: [accountId, now()],
    });
    const codes = (
      await tx.execute({
        sql: "SELECT count(*) n FROM account_recovery_codes WHERE account_id=? AND used_at IS NULL",
        args: [accountId],
      })
    ).rows[0];
    const pending = (
      await tx.execute({
        sql: "SELECT id FROM account_recovery_batches WHERE account_id=? AND session_hash=? AND state='prepared'",
        args: [accountId, tokenHash(session)],
      })
    ).rows[0];
    return {
      enabled: enabled(state),
      requiredWorkspaces: await requiredWorkspaces(tx, accountId),
      pendingRecoveryBatch: pending ? String(pending.id) : null,
      recoveryReplacementAuthorizedUntil: replacementAuthorized
        ? Number(authorization.expires_at)
        : null,
      enabledAt: state?.enabled_at == null ? null : Number(state.enabled_at),
      recoveryCodesRemaining: Number(codes.n),
      sessions: rows.rows.map((row) => ({
        id: sessionId(String(row.token_hash)),
        current: row.token_hash === tokenHash(session),
        label: String(row.device_label ?? "Browser session"),
        createdAt: Number(row.created_at),
        expiresAt: Number(row.expires_at),
      })),
    };
  });
}

async function requiredWorkspaces(tx: Transaction, accountId: string) {
  const rows = await tx.execute({
    sql: `SELECT w.id,w.name FROM memberships m JOIN workspaces w ON w.id=m.workspace_id
      WHERE m.account_id=? AND m.disabled=0 AND w.deleted_at IS NULL AND w.requires_mfa=1 ORDER BY w.name,w.id`,
    args: [accountId],
  });
  return rows.rows.map((row) => ({
    id: String(row.id),
    name: String(row.name),
  }));
}

async function ownedSecurityWorkspace(
  tx: Transaction,
  workspaceId: string | null,
  accountId: string,
) {
  const row = (
    await tx.execute({
      sql: `SELECT w.requires_mfa FROM workspaces w JOIN memberships m ON m.workspace_id=w.id
      WHERE w.id=? AND w.owner_id=? AND m.account_id=? AND m.role='owner' AND m.disabled=0 AND w.deleted_at IS NULL`,
      args: [workspaceId, accountId, accountId],
    })
  ).rows[0];
  if (!row)
    throw new AccountError(
      "Only this workspace's owner can manage its sign-in policy.",
      403,
    );
  return row;
}

export async function readWorkspaceSecurity(
  accountId: string,
  session: string,
  requestScope: string,
) {
  await platformReady();
  // One statement provides a coherent authorization/count snapshot without
  // queuing a read behind the account/billing write transaction lock.
  const hash = tokenHash(session);
  const row = (await platformDb().execute({
    sql: `SELECT chosen.id AS workspace_id,chosen.owner_id,chosen.role,chosen.requires_mfa,
      asec.enabled_at AS owner_mfa,
      (SELECT count(*) FROM memberships m JOIN accounts member ON member.id=m.account_id
        WHERE m.workspace_id=chosen.id AND m.disabled=0 AND member.disabled=0 AND member.deleted_at IS NULL) AS members,
      (SELECT count(*) FROM memberships m JOIN accounts member ON member.id=m.account_id
        LEFT JOIN account_security factor ON factor.account_id=member.id
        WHERE m.workspace_id=chosen.id AND m.disabled=0 AND member.disabled=0 AND member.deleted_at IS NULL AND factor.enabled_at IS NULL) AS unenrolled
      FROM p_sessions s JOIN accounts a ON a.id=s.account_id
      LEFT JOIN account_security asec ON asec.account_id=a.id
      LEFT JOIN session_security ss ON ss.token_hash=s.token_hash
      LEFT JOIN (
        SELECT w.id,w.owner_id,w.requires_mfa,m.role FROM memberships m JOIN workspaces w ON w.id=m.workspace_id
        WHERE m.account_id=? AND m.disabled=0 AND w.deleted_at IS NULL
        ORDER BY CASE WHEN w.id=(SELECT workspace_id FROM p_sessions WHERE account_id=? AND token_hash=?) THEN 0 ELSE 1 END,w.created_at LIMIT 1
      ) chosen ON 1=1
      WHERE s.account_id=? AND s.token_hash=? AND s.expires_at>? AND a.disabled=0 AND a.deleted_at IS NULL
        AND (asec.enabled_at IS NULL OR (ss.factor_at IS NOT NULL AND ss.epoch=asec.epoch))`,
    args:[accountId,accountId,hash,accountId,hash,now()],
  })).rows[0];
  if(!row)throw new AccountError('Your session or password changed. Sign in again.',401);
  const workspaceId=row.workspace_id==null?null:String(row.workspace_id);
  if(requestScope!==(workspaceId?`particl-active-${workspaceId}-${accountId}`:`particl-account-${accountId}`))
    throw new AccountError('Your account or workspace changed. Reload security settings.',409);
  if(!workspaceId||row.owner_id!==accountId||row.role!=='owner')
    throw new AccountError("Only this workspace's owner can manage its sign-in policy.",403);
  return {requiresMfa:Number(row.requires_mfa)===1,ownerEnrolled:row.owner_mfa!=null,members:Number(row.members),unenrolled:Number(row.unenrolled)};
}

/** Password, fresh factor, ownership, policy and audit commit under the same
 * platform write lock as factor disablement. No cross-database mirror decides access. */
export async function changeWorkspaceSecurity(input: {
  accountId: string;
  session: string;
  requestScope: string;
  password: string;
  code: string;
  requiresMfa: boolean;
}) {
  const passwordHash = await passwordProof(input.accountId, input.password);
  return accountTransaction(async (tx) => {
    const workspaceId = await assertLiveAccountSession(
      tx,
      input.accountId,
      input.session,
      passwordHash,
      input.requestScope,
    );
    await ownedSecurityWorkspace(tx, workspaceId, input.accountId);
    const state = await security(tx, input.accountId);
    if (!enabled(state))
      throw new AccountError(
        "Set up your own authenticator before changing the workspace sign-in policy.",
        409,
      );
    const factor = await consumeFactor(
      tx,
      input.accountId,
      input.code.trim(),
      state!,
    );
    if (factor === "recovery") {
      const remaining = (
        await tx.execute({
          sql: "SELECT count(*) n FROM account_recovery_codes WHERE account_id=? AND used_at IS NULL",
          args: [input.accountId],
        })
      ).rows[0];
      if (!Number(remaining.n))
        throw new AccountError(
          "Save and activate replacement recovery codes before using your last code to change workspace policy.",
          409,
        );
    }
    await tx.execute({
      sql: "UPDATE workspaces SET requires_mfa=?,updated_at=? WHERE id=?",
      args: [input.requiresMfa ? 1 : 0, now(), workspaceId],
    });
    await tx.execute(
      securityAuditStatement({
        workspaceId,
        actorId: input.accountId,
        action: input.requiresMfa
          ? "workspace.mfa_required"
          : "workspace.mfa_optional",
        targetType: "workspace",
        targetId: workspaceId,
      }),
    );
    return { requiresMfa: input.requiresMfa };
  });
}
