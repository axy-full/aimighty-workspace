import { readFile, writeFile, stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { createClient } from '@libsql/client';

const [group, credentialFile, outputFile] = process.argv.slice(2);
if (!['particl-staging', 'particl-production-tenants'].includes(group) || !credentialFile || !outputFile) {
  throw new Error('Usage: provisioning-rehearsal.mjs <Particl group> <private credential file> <new evidence file>');
}
const mode = (await stat(credentialFile)).mode;
if (mode & 0o077) throw new Error('Credential file must be readable only by its owner.');
const credential = (await readFile(credentialFile, 'utf8')).trim();
const base = 'https://api.turso.tech/v1/organizations/axyp22/databases';
const name = `particl-provision-check-${Date.now()}-${randomBytes(3).toString('hex')}`;
const evidence = { group, startedAt: new Date().toISOString(), created: false, databaseVerified: false, outsideGroupDenied: false, cleaned: false };
let client;
async function call(path, options = {}) {
  return fetch(base + path, { ...options, headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(30_000) });
}
let failed = false;
try {
  // The existing legacy database is outside both designated tenant groups.
  // Check authorization status only; never inspect its data or response body.
  const outside = await call('/aimighty-workspace');
  evidence.outsideGroupDenied = [403, 404].includes(outside.status);
  await outside.body?.cancel();
  if (!evidence.outsideGroupDenied) throw new Error('GROUP_ISOLATION_FAILED');
  const created = await call('', { method: 'POST', body: JSON.stringify({ name, group }) });
  if (!created.ok) throw new Error('CREATE_FAILED');
  evidence.created = true;
  await created.body?.cancel();
  const fetched = await call('/' + name);
  if (!fetched.ok) throw new Error('GET_FAILED');
  const metadata = await fetched.json();
  const hostname = metadata.database?.Hostname;
  if (typeof hostname !== 'string' || !/^[a-zA-Z0-9.-]+$/.test(hostname)) throw new Error('INVALID_HOSTNAME');
  const minted = await call('/' + name + '/auth/tokens?expiration=1h&authorization=full-access', { method: 'POST' });
  if (!minted.ok) throw new Error('TOKEN_FAILED');
  const token = (await minted.json()).jwt;
  if (!token) throw new Error('TOKEN_MISSING');
  client = createClient({ url: 'libsql://' + hostname, authToken: token });
  await client.batch([
    'CREATE TABLE provisioning_probe(id TEXT PRIMARY KEY,value TEXT NOT NULL)',
    { sql: 'INSERT INTO provisioning_probe VALUES(?,?)', args: ['probe', name] },
  ], 'write');
  const row = (await client.execute('SELECT value FROM provisioning_probe WHERE id=\'probe\'')).rows[0];
  evidence.databaseVerified = row?.value === name;
  if (!evidence.databaseVerified) throw new Error('DATABASE_VERIFY_FAILED');
} catch { failed = true; }
finally {
  client?.close();
  // Always try the exact unique resource, including ambiguous create responses.
  try {
    const removed = await call('/' + name, { method: 'DELETE' });
    evidence.cleaned = removed.ok || removed.status === 404;
    await removed.body?.cancel();
  } catch { evidence.cleaned = false; }
}
evidence.finishedAt = new Date().toISOString();
evidence.ok = !failed && evidence.databaseVerified && evidence.outsideGroupDenied && evidence.cleaned;
await writeFile(outputFile, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
console.log(JSON.stringify(evidence));
if (!evidence.ok) process.exitCode = 1;
