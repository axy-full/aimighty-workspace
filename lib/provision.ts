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

export async function provisionTenantDatabase(slug: string, stableName?:string): Promise<{ url: string; token: string | null; name: string }> {
  const apiToken=process.env.TURSO_API_TOKEN,org=process.env.TURSO_ORG;
  const name=stableName??`particl-${slug}-${Math.random().toString(36).slice(2,6)}`.slice(0,60);
  if(!/^[a-z0-9-]{1,64}$/.test(name))throw new Error('Invalid workspace database name.');
  if(!apiToken||!org){
    if(process.env.NODE_ENV==='production')throw new Error('Workspace provisioning is not available on this deployment.');
    const path=await import('node:path');
    const folder=process.env.WORKSPACE_DB_DIRECTORY||'.data';
    await import('node:fs/promises').then(fs=>fs.mkdir(folder,{recursive:true}));
    return {url:`file:${path.join(folder,name+'.db')}`,token:null,name};
  }
  const headers={Authorization:`Bearer ${apiToken}`,'Content-Type':'application/json'};
  const base=`${API()}/v1/organizations/${encodeURIComponent(org)}/databases`;
  const resource=base+'/'+encodeURIComponent(name);
  // A durable name was recorded BEFORE this call. A timeout after database
  // creation is recovered by GET on the next run, never by creating another.
  let response=await fetch(resource,{headers,signal:AbortSignal.timeout(30_000),cache:'no-store'});
  if(response.status===404){
    response=await fetch(base,{method:'POST',headers,body:JSON.stringify({name,group:process.env.TURSO_GROUP??'default'}),signal:AbortSignal.timeout(30_000)});
    if(response.status===409)response=await fetch(resource,{headers,signal:AbortSignal.timeout(30_000),cache:'no-store'});
  }
  if(!response.ok)throw new Error(`Workspace database provisioning failed (${response.status}). Retry this workspace request.`);
  const hostname=(await response.json() as {database?:{Hostname?:string}}).database?.Hostname;
  if(!hostname)throw new Error('The workspace database hostname was not returned. Retry this workspace request.');
  const minted=await fetch(resource+'/auth/tokens?expiration=never&authorization=full-access',{method:'POST',headers,signal:AbortSignal.timeout(30_000)});
  if(!minted.ok)throw new Error(`Workspace database access could not be configured (${minted.status}). Retry this workspace request.`);
  const jwt=(await minted.json() as {jwt?:string}).jwt;
  if(!jwt)throw new Error('Workspace database access was not returned. Retry this workspace request.');
  return {url:`libsql://${hostname}`,token:jwt,name};
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
