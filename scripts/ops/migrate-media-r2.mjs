import { readFileSync, writeFileSync, realpathSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { list, get, head } from '@vercel/blob';
import { migrateObjects } from '../../lib/storage/migrate.mjs';

// Run with node --env-file=/private/path/migration.env scripts/ops/migrate-media-r2.mjs.
// Default: inventory only. --apply copies and verifies. --report must be outside the public checkout.
const root = realpathSync(fileURLToPath(new URL('../..', import.meta.url)));
const args = process.argv.slice(2);
const apply = args.includes('--apply');
const value = flag => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1]; };
const concurrency = Number(value('--transfers') ?? 4);
const report = value('--report');
const token = process.env.BLOB_READ_WRITE_TOKEN;

function loadBackend() {
  const cache = new Map();
  const load = name => {
    if (cache.has(name)) return cache.get(name).exports;
    const filename = path.join(root, 'lib/storage', name + '.ts');
    const nativeRequire = createRequire(filename);
    const loaded = { exports: {} }; cache.set(name, loaded);
    const code = ts.transpileModule(readFileSync(filename, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText;
    new Function('require', 'module', 'exports', code)(specifier => {
      // Offline operator has no app database. Its conditional writes and byte verification are its recovery fence.
      if (specifier === '../recovery') return { withRecoveryActivity: (_kind, work) => work() };
      if (specifier === './types') return load('types');
      return nativeRequire(specifier);
    }, loaded, loaded.exports);
    return loaded.exports;
  };
  return load('r2').createR2Backend;
}

try {
  for (const name of ['BLOB_READ_WRITE_TOKEN', 'R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET']) {
    if (!process.env[name]) throw new Error('MISSING_CONFIGURATION');
  }
  if (!/^[a-f0-9]{32}$/i.test(process.env.R2_ACCOUNT_ID)) throw new Error('INVALID_ACCOUNT');
  if (apply && !report) throw new Error('PRIVATE_REPORT_REQUIRED');
  if (report) {
    if (existsSync(report)) throw new Error('REPORT_ALREADY_EXISTS');
    const location = path.join(realpathSync(path.dirname(path.resolve(report))), path.basename(report));
    if (location === root || location.startsWith(root + path.sep)) throw new Error('REPORT_MUST_BE_PRIVATE');
  }
  const target = loadBackend()({ accountId: process.env.R2_ACCOUNT_ID, accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY, bucket: process.env.R2_BUCKET,
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com` });
  const items = []; let cursor;
  do {
    const page = await list({ token, limit: 1000, ...(cursor ? { cursor } : {}) });
    for (const item of page.blobs) items.push({ key: item.pathname, size: item.size, etag: item.etag, url: item.url });
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  const maximum = Number(value("--limit") ?? items.length);
  if (!Number.isSafeInteger(maximum) || maximum < 1) throw new Error("INVALID_LIMIT");
  const source = {
    async get(item) {
      const found = await get(item.url, { token, access: new URL(item.url).hostname.includes('.public.blob.') ? 'public' : 'private',
        headers: { 'Accept-Encoding': 'identity', 'If-Match': item.etag }, abortSignal: AbortSignal.timeout(120_000) });
      if (!found?.stream || found.statusCode !== 200 || found.blob.etag !== item.etag || found.blob.size !== item.size) throw new Error('SOURCE_CHANGED');
      return { stream: found.stream, contentType: found.blob.contentType };
    },
    async verify(item) {
      const current = await head(item.url, { token });
      if (current.etag !== item.etag || current.size !== item.size) throw new Error('SOURCE_CHANGED');
    },
  };
  let lastProgress = 0;
  const result = await migrateObjects({ items: items.slice(0, maximum), source, target, apply, concurrency, progress(counts) {
    if (Date.now() - lastProgress > 15_000) { console.log(JSON.stringify({ mode: apply ? 'copy' : 'inventory', ...counts })); lastProgress = Date.now(); }
  } });
  if (report) writeFileSync(report, JSON.stringify({ at: new Date().toISOString(), apply, ...result }, null, 2), { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ mode: apply ? 'copy' : 'inventory', ...result.counts }));
  if (result.counts.failed || result.counts.conflicts) process.exitCode = 1;
} catch {
  console.error('Migration stopped. No source objects were deleted. Check private configuration and rerun the inventory.');
  process.exitCode = 1;
}
