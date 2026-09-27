/** Only a capability locator lives in the platform database. Project text stays in its tenant. */
export const CREW_MCP_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS crew_mcp_capabilities (
    token_hash TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, owner TEXT NOT NULL,
    session_id TEXT NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS crew_mcp_expiry ON crew_mcp_capabilities(expires_at)`,
];
export const CREW_CONTEXT_SCHEMA = `CREATE TABLE IF NOT EXISTS crew_mcp_context (
  token_hash TEXT PRIMARY KEY, owner TEXT NOT NULL, session_id TEXT NOT NULL,
  context TEXT NOT NULL, expires_at INTEGER NOT NULL
)`;

export const CREW_DISPATCH_SCHEMA = `CREATE TABLE IF NOT EXISTS crew_round_dispatches (
  session_id TEXT NOT NULL, round INTEGER NOT NULL, started_at INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'started', PRIMARY KEY(session_id, round)
)`;
