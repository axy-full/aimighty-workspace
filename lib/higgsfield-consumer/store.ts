import { createHash, randomUUID } from "node:crypto";
import { accountTransaction } from "../accountDb";
import { open, seal } from "../keyring";

export const AUTHORIZATION_TTL = 10 * 60_000;
export const REFRESH_LEASE_TTL = 30_000;
export type ConsumerIdentity = { workspaceId: string; userId: string };
export type ConsumerTokens = {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  scope: string;
  clientId: string;
  redirectUri: string;
};
export type Authorization = ConsumerIdentity & {
  authorizationId: string;
  clientId: string;
  redirectUri: string;
  verifier: string;
};
type StoredSecret = ConsumerIdentity & { tokens: ConsumerTokens };
export const hashConsumerSecret = (value: string) =>
  createHash("sha256").update(value).digest("hex");
let ready: Promise<void> | undefined;
export function consumerStoreReady() {
  return (ready ??= accountTransaction(async (tx) => {
    await tx.execute(`CREATE TABLE IF NOT EXISTS higgsfield_consumer_connections (
      workspace_id TEXT NOT NULL,user_id TEXT NOT NULL,authorization_id TEXT NOT NULL,
      generation TEXT NOT NULL,status TEXT NOT NULL,tokens_enc TEXT,
      connected_at INTEGER,expires_at INTEGER,refresh_lease TEXT,refresh_lease_until INTEGER,
      updated_at INTEGER NOT NULL,PRIMARY KEY(workspace_id,user_id))`);
    await tx.execute(`CREATE TABLE IF NOT EXISTS higgsfield_consumer_authorizations (
      state_hash TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,user_id TEXT NOT NULL,
      session_hash TEXT NOT NULL,authorization_id TEXT NOT NULL,verifier_enc TEXT NOT NULL,
      client_id TEXT NOT NULL,redirect_uri TEXT NOT NULL,expires_at INTEGER NOT NULL,consumed_at INTEGER)`);
    // Which account a grant belongs to (a hash of the issuer and its subject),
    // so the same account signing in again keeps its jobs' grant. Additive.
    const columns = await tx.execute("SELECT name FROM pragma_table_info('higgsfield_consumer_connections')");
    if (!columns.rows.some((row) => String(row.name).toLowerCase() === "subject_hash"))
      await tx.execute("ALTER TABLE higgsfield_consumer_connections ADD COLUMN subject_hash TEXT");
  }).catch((error) => {
    ready = undefined;
    throw error;
  }));
}

function encode(identity: ConsumerIdentity, tokens: ConsumerTokens) {
  return seal(
    JSON.stringify({
      workspaceId: identity.workspaceId,
      userId: identity.userId,
      tokens,
    } satisfies StoredSecret),
  );
}
function decode(identity: ConsumerIdentity, encrypted: string): ConsumerTokens {
  const data = JSON.parse(open(encrypted)) as StoredSecret;
  if (
    data.workspaceId !== identity.workspaceId ||
    data.userId !== identity.userId ||
    !data.tokens ||
    typeof data.tokens.accessToken !== "string" ||
    !data.tokens.accessToken ||
    typeof data.tokens.clientId !== "string" ||
    typeof data.tokens.redirectUri !== "string" ||
    !Number.isFinite(data.tokens.expiresAt) ||
    (data.tokens.refreshToken !== undefined &&
      typeof data.tokens.refreshToken !== "string")
  )
    throw new Error("Unreadable consumer connection.");
  return data.tokens;
}

export async function storeAuthorization(
  input: ConsumerIdentity & {
    state: string;
    sessionHash: string;
    verifier: string;
    clientId: string;
    redirectUri: string;
  },
  at = Date.now(),
) {
  await consumerStoreReady();
  const authorizationId = randomUUID(),
    stateHash = hashConsumerSecret(input.state);
  const verifier = seal(
    JSON.stringify({ ...input, state: undefined, stateHash, authorizationId }),
  );
  await accountTransaction(async (tx) => {
    await tx.execute({
      sql: "DELETE FROM higgsfield_consumer_authorizations WHERE expires_at<=?",
      args: [at],
    });
    await tx.execute({
      sql: `INSERT INTO higgsfield_consumer_connections(workspace_id,user_id,authorization_id,generation,status,updated_at)
        VALUES(?,?,?,?,'disconnected',?) ON CONFLICT(workspace_id,user_id)
        DO UPDATE SET authorization_id=excluded.authorization_id,updated_at=excluded.updated_at`,
      args: [
        input.workspaceId,
        input.userId,
        authorizationId,
        randomUUID(),
        at,
      ],
    });
    await tx.execute({
      sql: `INSERT INTO higgsfield_consumer_authorizations(state_hash,workspace_id,user_id,session_hash,authorization_id,verifier_enc,client_id,redirect_uri,expires_at)
        VALUES(?,?,?,?,?,?,?,?,?)`,
      args: [
        stateHash,
        input.workspaceId,
        input.userId,
        input.sessionHash,
        authorizationId,
        verifier,
        input.clientId,
        input.redirectUri,
        at + AUTHORIZATION_TTL,
      ],
    });
  });
}

/** Session/account/workspace validation and one-use claim happen in one DB transaction. */
export async function consumeAuthorization(
  state: string,
  identity: ConsumerIdentity & { sessionHash: string },
  at = Date.now(),
): Promise<Authorization | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(state)) return null;
  await consumerStoreReady();
  return accountTransaction(async (tx) => {
    const stateHash = hashConsumerSecret(state);
    const row = (
      await tx.execute({
        sql: `SELECT a.* FROM higgsfield_consumer_authorizations a JOIN higgsfield_consumer_connections c
        ON c.workspace_id=a.workspace_id AND c.user_id=a.user_id AND c.authorization_id=a.authorization_id
        WHERE a.state_hash=? AND a.workspace_id=? AND a.user_id=? AND a.session_hash=? AND a.consumed_at IS NULL AND a.expires_at>?`,
        args: [
          stateHash,
          identity.workspaceId,
          identity.userId,
          identity.sessionHash,
          at,
        ],
      })
    ).rows[0];
    if (!row) return null;
    const data = JSON.parse(open(String(row.verifier_enc)));
    if (
      data.workspaceId !== identity.workspaceId ||
      data.userId !== identity.userId ||
      data.sessionHash !== identity.sessionHash ||
      data.stateHash !== stateHash ||
      data.authorizationId !== row.authorization_id ||
      data.clientId !== row.client_id ||
      data.redirectUri !== row.redirect_uri ||
      !/^[A-Za-z0-9_-]{43}$/.test(data.verifier)
    )
      throw new Error("Unreadable authorization.");
    await tx.execute({
      sql: "UPDATE higgsfield_consumer_authorizations SET consumed_at=?,verifier_enc='' WHERE state_hash=? AND consumed_at IS NULL",
      args: [at, stateHash],
    });
    return {
      workspaceId: identity.workspaceId,
      userId: identity.userId,
      authorizationId: String(row.authorization_id),
      clientId: String(row.client_id),
      redirectUri: String(row.redirect_uri),
      verifier: data.verifier,
    };
  });
}

/**
 * A disconnect or newer login invalidates this CAS, including while a code is exchanging.
 *
 * The grant generation that quotes and jobs pin is kept when the SAME account
 * (same issuer subject) signs in again — a reconnect after a failed refresh, or
 * after a disconnect — so its accepted jobs can still be read and collected. A
 * different account, or one whose subject is unknown, gets a new generation and
 * can never read or spend under an earlier account's jobs.
 */
export async function completeAuthorization(
  authorization: Authorization,
  tokens: ConsumerTokens,
  at = Date.now(),
  subjectHash: string | null = null,
) {
  await consumerStoreReady();
  return accountTransaction(
    async (tx) =>
      (
        await tx.execute({
          sql: `UPDATE higgsfield_consumer_connections SET
      generation=CASE WHEN ? IS NOT NULL AND subject_hash=? THEN generation ELSE ? END,subject_hash=?,
      status='connected',tokens_enc=?,connected_at=?,expires_at=?,
      refresh_lease=NULL,refresh_lease_until=NULL,updated_at=? WHERE workspace_id=? AND user_id=? AND authorization_id=?`,
          args: [
            subjectHash,
            subjectHash,
            randomUUID(),
            subjectHash,
            encode(authorization, tokens),
            at,
            tokens.expiresAt,
            at,
            authorization.workspaceId,
            authorization.userId,
            authorization.authorizationId,
          ],
        })
      ).rowsAffected === 1,
  );
}

export async function consumerConnectionStatus(identity: ConsumerIdentity) {
  await consumerStoreReady();
  return accountTransaction(async (tx) => {
    const row = (
      await tx.execute({
        sql: "SELECT status,connected_at,expires_at,subject_hash FROM higgsfield_consumer_connections WHERE workspace_id=? AND user_id=?",
        args: [identity.workspaceId, identity.userId],
      })
    ).rows[0];
    // A refresh interrupted mid-flight is retried on the next access with the
    // saved refresh token; only the account's own refusal requires a reconnect.
    return {
      connected: row?.status === "connected",
      requiresReconnect: row?.status === "reconnect_required",
      ...(row?.connected_at ? { connectedAt: Number(row.connected_at) } : {}),
      ...(row?.expires_at ? { expiresAt: Number(row.expires_at) } : {}),
      // Whether Particl knows which account this grant belongs to. Only then
      // does the same account signing in again keep its running jobs.
      ...(row ? { subjectKnown: row.subject_hash != null } : {}),
    };
  });
}

export type RefreshClaim = ConsumerIdentity & {
  generation: string;
  lease: string;
  tokens: ConsumerTokens;
};
export type AccessClaim =
  | { kind: "missing" | "reconnect" | "busy" | "changed" }
  | { kind: "ready"; token: string; generation: string }
  | { kind: "refresh"; claim: RefreshClaim };
export async function claimConsumerAccess(
  identity: ConsumerIdentity & { expectedGeneration?: string },
  at = Date.now(),
): Promise<AccessClaim> {
  await consumerStoreReady();
  return accountTransaction(async (tx) => {
    const row = (
      await tx.execute({
        sql: "SELECT * FROM higgsfield_consumer_connections WHERE workspace_id=? AND user_id=?",
        args: [identity.workspaceId, identity.userId],
      })
    ).rows[0];
    // Compare the quote/job's grant in the same transaction as token access or
    // refresh admission. A mismatch must never refresh the replacement account.
    if (
      identity.expectedGeneration !== undefined &&
      (!row || row.generation !== identity.expectedGeneration)
    )
      return { kind: "changed" };
    if (!row || row.status === "disconnected") return { kind: "missing" };
    if (row.status !== "connected") return { kind: "reconnect" };
    if (row.refresh_lease && Number(row.refresh_lease_until) > at)
      return { kind: "busy" };
    let tokens: ConsumerTokens | null = null;
    try {
      tokens = decode(identity, String(row.tokens_enc));
    } catch {
      /* Fail closed below without exposing ciphertext. */
    }
    // A lease whose holder died (function killed mid-refresh) is taken over:
    // the saved refresh token is tried again, and the account's answer decides.
    if (!tokens || (tokens.expiresAt <= at + 60_000 && !tokens.refreshToken)) {
      await tx.execute({
        sql: "UPDATE higgsfield_consumer_connections SET status='reconnect_required',tokens_enc=NULL,refresh_lease=NULL,refresh_lease_until=NULL,updated_at=? WHERE workspace_id=? AND user_id=?",
        args: [at, identity.workspaceId, identity.userId],
      });
      return { kind: "reconnect" };
    }
    if (tokens.expiresAt > at + 60_000)
      return {
        kind: "ready",
        token: tokens.accessToken,
        generation: String(row.generation),
      };
    const lease = randomUUID();
    await tx.execute({
      sql: "UPDATE higgsfield_consumer_connections SET refresh_lease=?,refresh_lease_until=?,updated_at=? WHERE workspace_id=? AND user_id=?",
      args: [
        lease,
        at + REFRESH_LEASE_TTL,
        at,
        identity.workspaceId,
        identity.userId,
      ],
    });
    return {
      kind: "refresh",
      claim: { ...identity, generation: String(row.generation), lease, tokens },
    };
  });
}

/** A refresh the account never answered (network failure, timeout, 5xx): the
 * lease is released and the saved grant kept, so the next access tries again. */
export async function releaseConsumerRefresh(claim: RefreshClaim) {
  await consumerStoreReady();
  return accountTransaction(
    async (tx) =>
      (
        await tx.execute({
          sql: "UPDATE higgsfield_consumer_connections SET refresh_lease=NULL,refresh_lease_until=NULL WHERE workspace_id=? AND user_id=? AND generation=? AND refresh_lease=? AND status='connected'",
          args: [claim.workspaceId, claim.userId, claim.generation, claim.lease],
        })
      ).rowsAffected === 1,
  );
}

export async function finishConsumerRefresh(
  claim: RefreshClaim,
  tokens: ConsumerTokens | null,
  at = Date.now(),
  subjectHash: string | null = null,
) {
  await consumerStoreReady();
  return accountTransaction(
    async (tx) =>
      (
        await tx.execute({
          // A refresh answer that names the account (its ID token) fills in a
          // subject the grant never recorded; it never replaces a known one.
          sql: `UPDATE higgsfield_consumer_connections SET tokens_enc=?,expires_at=?,status=?,refresh_lease=NULL,refresh_lease_until=NULL,updated_at=?,
      subject_hash=COALESCE(subject_hash,?)
      WHERE workspace_id=? AND user_id=? AND generation=? AND refresh_lease=? AND status='connected'${tokens ? " AND refresh_lease_until>?" : ""}`,
          args: [
            tokens ? encode(claim, tokens) : null,
            tokens?.expiresAt ?? null,
            tokens ? "connected" : "reconnect_required",
            at,
            tokens ? subjectHash : null,
            claim.workspaceId,
            claim.userId,
            claim.generation,
            claim.lease,
            ...(tokens ? [at] : []),
          ],
        })
      ).rowsAffected === 1,
  );
}

/**
 * Record which account the CURRENT grant belongs to, when it was never
 * recorded (connections made before subjects were kept, or a sign-in whose
 * answer named no account). Only a connected grant of this exact generation,
 * and only a missing subject: a known one is never replaced.
 */
export async function recordConsumerSubject(
  identity: ConsumerIdentity,
  generation: string,
  subjectHash: string,
) {
  if (!/^[a-f0-9]{64}$/.test(subjectHash)) return false;
  await consumerStoreReady();
  return accountTransaction(
    async (tx) =>
      (
        await tx.execute({
          sql: "UPDATE higgsfield_consumer_connections SET subject_hash=?,updated_at=? WHERE workspace_id=? AND user_id=? AND generation=? AND status='connected' AND subject_hash IS NULL",
          args: [subjectHash, Date.now(), identity.workspaceId, identity.userId, generation],
        })
      ).rowsAffected === 1,
  );
}

/** Local removal completes before any optional upstream revocation. The grant
 * generation and account subject stay, so jobs already running on this account
 * resume if the same account connects again; while disconnected nothing can
 * read or spend, and another account gets a new generation. */
export async function disconnectConsumer(
  identity: ConsumerIdentity,
): Promise<ConsumerTokens | null> {
  await consumerStoreReady();
  return accountTransaction(async (tx) => {
    const row = (
      await tx.execute({
        sql: "SELECT tokens_enc FROM higgsfield_consumer_connections WHERE workspace_id=? AND user_id=?",
        args: [identity.workspaceId, identity.userId],
      })
    ).rows[0];
    let tokens: ConsumerTokens | null = null;
    try {
      if (row?.tokens_enc) tokens = decode(identity, String(row.tokens_enc));
    } catch {
      /* An unreadable secret still disconnects. */
    }
    await tx.execute({
      sql: `UPDATE higgsfield_consumer_connections SET authorization_id=?,status='disconnected',tokens_enc=NULL,
      connected_at=NULL,expires_at=NULL,refresh_lease=NULL,refresh_lease_until=NULL,updated_at=? WHERE workspace_id=? AND user_id=?`,
      args: [
        randomUUID(),
        Date.now(),
        identity.workspaceId,
        identity.userId,
      ],
    });
    await tx.execute({
      sql: "DELETE FROM higgsfield_consumer_authorizations WHERE workspace_id=? AND user_id=?",
      args: [identity.workspaceId, identity.userId],
    });
    return tokens;
  });
}
