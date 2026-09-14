import { now } from "./platform";
import type { Transaction } from "@libsql/client";
import { billingTransaction } from "./billingLedger";
import { readBoundedText, RequestBodyError } from "./requestBody";

export class AccountError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
    this.name = "AccountError";
  }
}
let initialized: Promise<void> | undefined;
export function accountDbReady() {
  return (initialized ??= (async () => {
    await billingTransaction(async (tx) => {
      for (const sql of [
        `CREATE TABLE IF NOT EXISTS workspace_provisioning (
        request_id TEXT PRIMARY KEY, request_key TEXT NOT NULL UNIQUE, owner_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
        db_name TEXT NOT NULL UNIQUE, db_url TEXT, db_token_enc TEXT,
        state TEXT NOT NULL DEFAULT 'pending', lease_token TEXT, lease_until INTEGER,
        attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT,
        welcome_source TEXT UNIQUE, welcome_credits INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      )`,
        `CREATE TABLE IF NOT EXISTS signup_registrations (
        email TEXT PRIMARY KEY,name TEXT NOT NULL,password_hash TEXT NOT NULL,workspace_name TEXT NOT NULL,
        plan_id TEXT NOT NULL,cadence TEXT NOT NULL,token_hash TEXT UNIQUE,expires_at INTEGER NOT NULL,
        verified_at INTEGER,account_id TEXT,request_id TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL
      )`,
        `CREATE TABLE IF NOT EXISTS account_action_limits (key TEXT NOT NULL,bucket INTEGER NOT NULL,n INTEGER NOT NULL,PRIMARY KEY(key,bucket))`,
        `CREATE TABLE IF NOT EXISTS membership_mirrors (workspace_id TEXT NOT NULL,account_id TEXT NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(workspace_id,account_id))`,
      ])
        await tx.execute(sql);
    });
  })().catch((error) => {
    initialized = undefined;
    throw error;
  }));
}
/** Account and billing changes share the same local transaction queue. */
export async function accountTransaction<T>(
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  await accountDbReady();
  return billingTransaction((tx) => fn(tx));
}
export async function takeAccountLimit(
  key: string,
  limit: number,
  windowMs: number,
): Promise<void> {
  const allowed = await accountTransaction(async (tx) => {
    const bucket = Math.floor(now() / windowMs);
    await tx.execute({
      sql: "INSERT INTO account_action_limits(key,bucket,n) VALUES(?,?,1) ON CONFLICT(key,bucket) DO UPDATE SET n=n+1",
      args: [key, bucket],
    });
    const n = Number(
      (
        await tx.execute({
          sql: "SELECT n FROM account_action_limits WHERE key=? AND bucket=?",
          args: [key, bucket],
        })
      ).rows[0].n,
    );
    return n <= limit;
  });
  if (!allowed)
    throw new AccountError(
      "Too many requests. Wait a while before trying again.",
      429,
    );
}
/** Bound auth payloads even when the caller omits Content-Length. */
export async function accountJson(
  req: Request,
): Promise<Record<string, unknown>> {
  try {
    const value: unknown = JSON.parse(await readBoundedText(req, 8192));
    if (value && typeof value === "object" && !Array.isArray(value))
      return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof RequestBodyError && error.status === 413)
      throw new AccountError("The account request is too large.", 413);
  }
  throw new AccountError("Send a valid account form.");
}
export function sameOriginProblem(req: Request): boolean {
  const origin = req.headers.get("origin");
  return Boolean(origin && origin !== new URL(req.url).origin);
}
export function accountFailure(error: unknown): Response {
  if (error instanceof AccountError)
    return Response.json({ error: error.message }, { status: error.status });
  console.error(JSON.stringify({ event: "account_operation_failed" }));
  return Response.json(
    {
      error:
        "The account service could not finish this request. Your existing account and workspace have been kept.",
    },
    { status: 503 },
  );
}
