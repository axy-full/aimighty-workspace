/** Kept separate so an already-running development process can repair its
 * memoised platform schema before using a newly deployed security feature. */
export const RECOVERY_AUTHORIZATION_SCHEMA = `CREATE TABLE IF NOT EXISTS account_recovery_authorizations (
  session_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL,
  password_fingerprint TEXT NOT NULL, epoch INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
)`;

/** Additive account-wide security state in the platform database. */
export const ACCOUNT_SECURITY_SCHEMA = [
  RECOVERY_AUTHORIZATION_SCHEMA,
  `CREATE TABLE IF NOT EXISTS account_security (
    account_id TEXT PRIMARY KEY, secret_enc TEXT, enabled_at INTEGER,
    last_counter INTEGER NOT NULL DEFAULT -1, epoch INTEGER NOT NULL DEFAULT 0,
    pending_enc TEXT, pending_session_hash TEXT, pending_expires_at INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS account_recovery_codes (
    account_id TEXT NOT NULL, code_hash TEXT NOT NULL, created_at INTEGER NOT NULL,
    used_at INTEGER, PRIMARY KEY(account_id,code_hash)
  )`,
  `CREATE TABLE IF NOT EXISTS account_recovery_batches (
    account_id TEXT PRIMARY KEY, id TEXT NOT NULL UNIQUE, session_hash TEXT NOT NULL,
    codes_enc TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS session_security (
    token_hash TEXT PRIMARY KEY, factor_at INTEGER, epoch INTEGER NOT NULL DEFAULT 0,
    device_label TEXT NOT NULL DEFAULT 'Browser session'
  )`,
];
