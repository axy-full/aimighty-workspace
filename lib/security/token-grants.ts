import { db } from "../db";

/**
 * What a token may do beyond its stored scope, kept apart from `api_tokens` (review of #558, H1).
 *
 * A "Prepare jobs" token is stored in `api_tokens` with the scope `read`, and its prepare grant lives here, in a
 * table only this build reads. A build from before it (a rollback, or another deployment on the same database) reads
 * `api_tokens` alone, and to it the token is read-only: it can never become a spending token there. The table is
 * additive and made with the workspace's schema (lib/db.ts).
 */
export async function grantPrepare(tokenId: string): Promise<void> {
  await db().execute({ sql: `INSERT OR REPLACE INTO api_token_grants (token_id, kind, created_at) VALUES (?, 'prepare', ?)`, args: [tokenId, Date.now()] });
}

/** The statement that records the grant, for a batch that also inserts the token (one transaction). */
export const grantPrepareStatement = (tokenId: string) => ({ sql: `INSERT OR REPLACE INTO api_token_grants (token_id, kind, created_at) VALUES (?, 'prepare', ?)`, args: [tokenId, Date.now()] });

/** Token ids with the prepare grant, among these. */
export async function preparing(tokenIds: string[]): Promise<Set<string>> {
  if (!tokenIds.length) return new Set();
  const rs = await db().execute({ sql: `SELECT token_id FROM api_token_grants WHERE kind = 'prepare' AND token_id IN (${tokenIds.map(() => "?").join(",")})`, args: tokenIds });
  return new Set(rs.rows.map((r) => String(r.token_id)));
}
