/**
 * A database of its own for every workspace.
 *
 * On Turso, through the Platform API: TURSO_API_TOKEN (an org token) and
 * TURSO_ORG name the organisation, TURSO_GROUP the group (default
 * "default"). The database is created, a full-access token is minted for
 * it, and both go into the workspace record — the token sealed. Locally,
 * with none of that set, each workspace is a SQLite file under .data.
 *
 * Fail closed in production: without the API a workspace cannot be given a
 * database, so it cannot be created, and sign-up says so.
 */

const API = () => process.env.TURSO_API_URL?.replace(/\/$/, "") ?? "https://api.turso.tech";

export function provisioningConfigured(): boolean {
  if (process.env.NODE_ENV !== "production") return true;
  return Boolean(process.env.TURSO_API_TOKEN && process.env.TURSO_ORG);
}

export async function provisionTenantDatabase(slug: string): Promise<{ url: string; token: string | null; name: string }> {
  const apiToken = process.env.TURSO_API_TOKEN;
  const org = process.env.TURSO_ORG;
  if (!apiToken || !org) {
    if (process.env.NODE_ENV !== "production") {
      return { url: `file:.data/ws_${slug}.db`, token: null, name: `ws_${slug}` };
    }
    throw new Error("Workspace databases aren't provisioned on this deployment yet — set TURSO_API_TOKEN and TURSO_ORG in Vercel.");
  }
  const name = `particl-${slug}-${Math.random().toString(36).slice(2, 6)}`.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 60);
  const headers = { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" };
  const created = await fetch(`${API()}/v1/organizations/${encodeURIComponent(org)}/databases`, {
    method: "POST", headers,
    body: JSON.stringify({ name, group: process.env.TURSO_GROUP ?? "default" }),
    signal: AbortSignal.timeout(30_000),
  });
  const createdText = await created.text();
  if (!created.ok) throw new Error(`Turso would not create the database (${created.status}): ${createdText.slice(0, 200)}`);
  const hostname = (JSON.parse(createdText) as { database?: { Hostname?: string } }).database?.Hostname;
  if (!hostname) throw new Error("Turso created the database but returned no hostname.");
  const minted = await fetch(
    `${API()}/v1/organizations/${encodeURIComponent(org)}/databases/${encodeURIComponent(name)}/auth/tokens?expiration=never&authorization=full-access`,
    { method: "POST", headers, signal: AbortSignal.timeout(30_000) },
  );
  const mintedText = await minted.text();
  if (!minted.ok) throw new Error(`Turso would not mint a token for the database (${minted.status}): ${mintedText.slice(0, 200)}`);
  const jwt = (JSON.parse(mintedText) as { jwt?: string }).jwt;
  if (!jwt) throw new Error("Turso minted no token for the database.");
  return { url: `libsql://${hostname}`, token: jwt, name };
}

/** Drop a workspace's database at Turso, by the name it was created under. Locally there is no API; the caller removes the file. */
export async function deleteTenantDatabase(ws: { dbUrl: string; slug: string }): Promise<void> {
  const apiToken = process.env.TURSO_API_TOKEN;
  const org = process.env.TURSO_ORG;
  if (!apiToken || !org) throw new Error("no Turso API on this deployment");
  const rs = await import("./platform").then((m) => m.platformDb().execute({ sql: `SELECT db_name FROM workspaces WHERE slug = ?`, args: [ws.slug] }));
  const name = (rs.rows[0] as { db_name?: string } | undefined)?.db_name;
  if (!name) throw new Error("the database's name is not on the record");
  const res = await fetch(`${API()}/v1/organizations/${encodeURIComponent(org)}/databases/${encodeURIComponent(name)}`, {
    method: "DELETE", headers: { Authorization: `Bearer ${apiToken}` }, signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok && res.status !== 404) throw new Error(`Turso would not delete the database (${res.status}): ${(await res.text()).slice(0, 200)}`);
}
