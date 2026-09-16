import { test, expect } from '@playwright/test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import type { TenantWorkspace } from '../../lib/tenant';
import { attachmentDisposition } from '../../lib/contentDisposition';
import { originalAssetDownload } from '../../lib/workbench/original-asset';
import { seedProject } from '../../lib/workbench/studio';
import { resolveAsset } from '../../lib/workbench/node-graph';
import { servingFor } from '../../lib/serveType';
import { byteRange, type ByteRange } from '../../lib/mediaRange';

const dir = mkdtempSync(path.join(tmpdir(), 'particl-original-downloads-'));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, 'platform.db')}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, 'primary.db')}`;
process.env.KEYRING_SECRET ??= 'unit-test-keyring-secret-unit-test-keyring';
const workspace = (id: string) => ({ id, name: id, slug: id, legacy: false, dbUrl: `file:${path.join(dir, id + '.db')}`, dbToken: null, keys: {}, usesPlatformKeys: false }) as TenantWorkspace;
const bytes = readFileSync(path.resolve('public/campaign/hero.webp'));
const sha256 = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');

function load<T>(file: string, dependencies: Record<string, unknown>): T {
  const filename = path.resolve(file), require = createRequire(filename);
  const compiled = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', compiled)((name: string) => Object.hasOwn(dependencies, name) ? dependencies[name] : require(name), mod, mod.exports);
  return mod.exports as T;
}

async function fixture() {
  const tenant = await import('../../lib/tenant');
  const database = await import('../../lib/db');
  const records = await import('../../lib/workbench/records');
  const media = await import('../../lib/workbench/media-records');
  const generatedBytes = await (await import('sharp')).default(bytes).png().toBuffer();
  const studio = workspace('studio-' + crypto.randomUUID()), other = workspace('other-' + crypto.randomUUID());
  let viewer: string | null = 'owner';
  const reads: { id: string; tenant: string; range?: ByteRange | null; signal?: AbortSignal }[] = [];
  await tenant.runInTenant(studio, async () => {
    await records.workbenchReady();
    await database.db().execute({
      sql: `INSERT INTO uploads(id,filename,mime,ext,bytes,sha256,width,height,stored_url,created_at,kind) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      args: ['original', 'Caméra master.webp', 'image/webp', 'webp', bytes.length, sha256(bytes), 1672, 941, '', 1, 'image'],
    });
    await database.db().execute({
      sql: `INSERT INTO workbench_media(id,owner,name,mime,ext,size,stored_url,sha256) VALUES(?,?,?,?,?,?,?,?)`,
      args: ['private-original', 'owner', 'Caméra private.webp', 'image/webp', 'webp', bytes.length, '', sha256(bytes)],
    });
    await database.db().execute({
      sql: `INSERT INTO generations(id,model,prompt,params,status,created_at,updated_at,kind) VALUES('generated','fixture','Original provider output','{}','succeeded',1,1,'image')`,
      args: [],
    });
  });
  const stream = (value: Uint8Array) => new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(value); controller.close(); } });
  const deps = {
    '@/lib/auth': { withTenant: (handler: unknown) => handler, requireUser: async () => viewer ? { user: { id: viewer } } : { response: new Response('Sign in', { status: 401 }) } },
    '@/lib/db': database,
    '@/lib/tenant': tenant,
    '@/lib/workbench/records': records,
    '@/lib/workbench/media-records': media,
    '@/lib/mediaBindings': {}, '@/lib/uploadReservations': {}, '@/lib/workbench/request-scope': {},
    '@/lib/contentDisposition': { attachmentDisposition }, '@/lib/serveType': { servingFor }, '@/lib/mediaRange': { byteRange },
    '@/lib/storage': {
      openUploadStream: async (id: string, _ext: string, range?: ByteRange | null, _url?: string, signal?: AbortSignal) => {
        reads.push({ id, tenant: tenant.requireTenant().id, range, signal });
        const result = range ? bytes.subarray(range.start, range.end + 1) : bytes;
        return { stream: stream(result), size: result.length };
      },
      openMediaStream: async (id: string) => { reads.push({ id, tenant: tenant.requireTenant().id }); return stream(generatedBytes); },
    },
    '@/lib/jobs': { getGeneration: async (id: string) => {
      await database.ready();
      return (await database.db().execute({ sql: 'SELECT * FROM generations WHERE id=? AND deleted=0', args: [id] })).rows[0] ?? null;
    } },
    '@/lib/downloadName': { downloadFilename: async () => 'generated-master.png' },
  };
  const uploads = load<typeof import('../../app/api/uploads/[id]/route')>('app/api/uploads/[id]/route.ts', deps).GET;
  const privateMedia = load<typeof import('../../app/api/workbench/media/[id]/route')>('app/api/workbench/media/[id]/route.ts', deps).GET;
  const generated = load<typeof import('../../app/api/media/[id]/route')>('app/api/media/[id]/route.ts', deps).GET;
  return { tenant, database, studio, other, reads, uploads, privateMedia, generated, generatedBytes, setViewer: (id: string | null) => { viewer = id; } };
}

const request = (url: string, range?: string) => new Request('https://particl.test' + url, { headers: range ? { Range: range } : {} });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

test('node original selection preserves stored identities through grade/output nodes and never downloads a thumbnail', () => {
  const project = seedProject();
  const original = project.assets.find(a => a.id === 'hero')!;
  original.url = '/api/uploads/camera-master';
  original.uploadId = 'camera-master';
  expect(originalAssetDownload(resolveAsset(project.nodes.find(n => n.id === 'result')!, project.nodes, project.assets)!)).toMatchObject({ url: '/api/uploads/camera-master?download=1' });
  expect(originalAssetDownload({ ...original, url: '/api/workbench/preview/upload/camera-master' })?.url).toBe('/api/uploads/camera-master?download=1');
  expect(originalAssetDownload({ ...original, url: '/api/workbench/preview/upload/unknown', uploadId: undefined })).toBeNull();
  expect(originalAssetDownload({ ...original, url: '/api/media/provider-master?stream=1', generationId: 'provider-master' })?.url).toBe('/api/media/provider-master?download=1');
  expect(originalAssetDownload({ ...original, url: '/api/workbench/media/private-original' })?.url).toBe('/api/workbench/media/private-original?download=1');
  expect(originalAssetDownload({ ...original, kind: 'link', url: 'https://example.com' })).toBeNull();
  expect(originalAssetDownload({ ...original, uploadId: undefined, url: 'https://example.com/thumbnail.png' })).toBeNull();
});

test('download filenames preserve Unicode and extensions without header or path injection', () => {
  const value = attachmentDisposition('Caméra "master"\r\n/../../take.tiff');
  expect(value).toContain("filename*=UTF-8''Cam%C3%A9ra");
  expect(value).toContain('.tiff');
  expect(value).not.toMatch(/[\r\n/\\]/);
  expect(() => attachmentDisposition('\ud800.png')).not.toThrow();
});

test('uploaded and generated downloads return exact original bytes with private attachment headers', async () => {
  const f = await fixture();
  await f.tenant.runInTenant(f.studio, async () => {
    for (const [route, id, url] of [[f.uploads, 'original', '/api/uploads/original'], [f.generated, 'generated', '/api/media/generated']] as const) {
      const response = await route(request(url + '?download=1'), ctx(id));
      expect(response.status).toBe(200);
      expect(response.headers.get('content-disposition')).toMatch(/^attachment; filename=/);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(sha256(new Uint8Array(await response.arrayBuffer()))).toBe(sha256(id === 'generated' ? f.generatedBytes : bytes));
    }
    const preview = await f.uploads(request('/api/uploads/original'), ctx('original'));
    expect(preview.headers.get('content-disposition')).toBeNull();
    expect((await preview.arrayBuffer()).byteLength).toBe(bytes.length);
  });
  expect(f.reads).toHaveLength(3);
});

test('private workbench originals stream ranges and retain original filenames and owner/publication rules', async () => {
  const f = await fixture();
  await f.tenant.runInTenant(f.studio, async () => {
    const req = request('/api/workbench/media/private-original?download=1', 'bytes=0-31');
    const response = await f.privateMedia(req, ctx('private-original'));
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe(`bytes 0-31/${bytes.length}`);
    expect(response.headers.get('content-disposition')).toContain("filename*=UTF-8''Cam%C3%A9ra%20private.webp");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes.subarray(0, 32));
    expect(f.reads[0].signal).toBe(req.signal);
    const invalid = await f.privateMedia(request('/api/workbench/media/private-original?download=1', 'bytes=-0'), ctx('private-original'));
    expect(invalid.status).toBe(416);
    expect(f.reads).toHaveLength(1);
    f.setViewer('colleague');
    expect((await f.privateMedia(request('/api/workbench/media/private-original?download=1'), ctx('private-original'))).status).toBe(404);
    await f.database.db().execute({ sql: 'INSERT INTO workbench_bibles(project_id,version,owner,body,created_at) VALUES(?,?,?,?,?)', args: ['project', 1, 'colleague', JSON.stringify({ assets: [{ url: '/api/workbench/media/private-original' }] }), 1] });
    expect((await f.privateMedia(request('/api/workbench/media/private-original?download=1'), ctx('private-original'))).status).toBe(404);
    await f.database.db().execute({ sql: 'UPDATE workbench_bibles SET owner=? WHERE project_id=?', args: ['owner', 'project'] });
    const published = await f.privateMedia(request('/api/workbench/media/private-original?download=1'), ctx('private-original'));
    expect(published.status).toBe(200);
    expect(sha256(new Uint8Array(await published.arrayBuffer()))).toBe(sha256(bytes));
  });
});

test('download query never bypasses workspace isolation or authentication for any stored source', async () => {
  const f = await fixture();
  for (const ws of [f.other, f.studio]) {
    if (ws === f.studio) f.setViewer(null);
    await f.tenant.runInTenant(ws, async () => {
      for (const [route, id, url] of [[f.uploads, 'original', '/api/uploads/original'], [f.generated, 'generated', '/api/media/generated'], [f.privateMedia, 'private-original', '/api/workbench/media/private-original']] as const) {
        expect((await route(request(url + '?download=1'), ctx(id))).status).toBe(ws === f.other ? 404 : 401);
      }
    });
  }
  expect(f.reads).toEqual([]);
});
