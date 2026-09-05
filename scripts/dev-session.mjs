/**
 * Local development only: open a platform session for an account and, if
 * asked, plant a sign-up invitation — the things that in production come
 * from a password and from the platform owner. Never used on a deployment.
 */
import { createClient } from "@libsql/client";
import { createHash, randomBytes } from "node:crypto";

if (process.env.NODE_ENV === "production" || process.env.VERCEL) { console.error("dev only"); process.exit(1); }
const db = createClient({ url: "file:.data/ark.db" });
const [,, cmd, arg] = process.argv;
const sha = (t) => createHash("sha256").update(t).digest("hex");

if (cmd === "session") {
  const rs = await db.execute({ sql: `SELECT id, email FROM accounts WHERE email = ? OR ? = '' ORDER BY created_at LIMIT 1`, args: [arg ?? "", arg ?? ""] });
  const a = rs.rows[0]; if (!a) { console.error("no such account"); process.exit(1); }
  const ws = await db.execute({ sql: `SELECT workspace_id FROM memberships WHERE account_id = ? ORDER BY created_at LIMIT 1`, args: [a.id] });
  const token = randomBytes(32).toString("base64url");
  await db.execute({ sql: `INSERT INTO p_sessions (token_hash, account_id, workspace_id, created_at, expires_at) VALUES (?,?,?,?,?)`, args: [sha(token), a.id, ws.rows[0]?.workspace_id ?? null, Date.now(), Date.now() + 86400000] });
  console.log(JSON.stringify({ account: a.email, workspace: ws.rows[0]?.workspace_id ?? null, token }));
} else if (cmd === "invite") {
  const code = randomBytes(18).toString("base64url");
  await db.execute({ sql: `INSERT INTO signup_invites (code, email, name, note, created_by, created_at, expires_at) VALUES (?,?,?,?,?,?,?)`, args: [code, arg, "Test Person", "local test", "dev", Date.now(), Date.now() + 7 * 86400000] });
  console.log(JSON.stringify({ email: arg, code }));
} else {
  console.log("usage: node scripts/dev-session.mjs session [email] | invite <email>");
}
