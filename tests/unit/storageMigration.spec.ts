import { test, expect } from '@playwright/test';
import { migrationBackend, type StorageBackend } from '../../lib/storage/backend';
import { migrateObjects } from '../../lib/storage/migrate.mjs';

function store(kind: 'blob' | 'r2', files: Record<string, string> = {}) {
  const objects = new Map(Object.entries(files).map(([key, value]) => [key, Buffer.from(value)]));
  const writes: string[] = [], deletions: string[] = [], reads: string[] = [], signatures: {key: string; expires: number}[] = [];
  const backend: StorageBackend = {
    kind,
    async head(key) { return objects.has(key) ? { size: objects.get(key)!.length } : null; },
    async get(key) { reads.push(key); const bytes = objects.get(key); return bytes ? { stream: new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }), headers: new Headers(), statusCode: 200 } : null; },
    async put(key, body, options) {
      if (objects.has(key) && !options.overwrite) throw new Error('exists');
      const chunks = [];
      if (Buffer.isBuffer(body)) chunks.push(body);
      else for await (const chunk of body) chunks.push(Buffer.from(chunk));
      objects.set(key, Buffer.concat(chunks)); writes.push(key);
    },
    async del(keys) { deletions.push(...keys); },
    async list() { return { items: [], hasMore: false }; },
    async presignGet(key, expires) { signatures.push({key, expires}); return `https://${kind}.invalid/signed`; },
  };
  return { backend, objects, writes, deletions, reads, signatures };
}

test('R2 reads first, falls back only for absent objects, and never writes or deletes Blob', async () => {
  const primary = store('r2', { 'ws/a/one': 'new' }), fallback = store('blob', { 'ws/a/one': 'old', 'ws/a/two': 'two' });
  const backend = migrationBackend(primary.backend, fallback.backend);
  expect(await new Response((await backend.get('ws/a/one'))!.stream).text()).toBe('new');
  expect(fallback.reads).toEqual([]);
  expect(await new Response((await backend.get('ws/a/two'))!.stream).text()).toBe('two');
  expect(await backend.head('ws/a/two')).toEqual({ size: 3 });
  await backend.put('ws/a/three', Buffer.from('3'), { contentType: 'text/plain', overwrite: false });
  await backend.del(['ws/a/one']);
  expect(primary.writes).toEqual(['ws/a/three']); expect(primary.deletions).toEqual(['ws/a/one']);
  expect(fallback.writes).toEqual([]); expect(fallback.deletions).toEqual([]);
  await backend.presignGet('ws/a/two', Date.now() + 86_400_000);
  expect(fallback.signatures[0].expires).toBeLessThanOrEqual(Date.now() + 900_000);
  primary.backend.get = async () => { throw new Error('403'); };
  await expect(backend.get('ws/a/two')).rejects.toThrow('403');
  expect(fallback.reads).toEqual(['ws/a/two']);
});

test('legacy Blob URLs retain their exact suffix and public/private origin during fallback', async () => {
  const original = 'https://legacy.public.blob.vercel-storage.com/ws/a/uploads/photo-random.png';
  const primary = store('r2'), fallback = store('blob', { [original]: 'original' });
  const backend = migrationBackend(primary.backend, fallback.backend, () => original);
  expect(await new Response((await backend.get('ws/a/uploads/photo-random.png'))!.stream).text()).toBe('original');
  expect(fallback.reads).toEqual([original]);
  primary.objects.set('ws/a/uploads/photo-random.png', Buffer.from('copied'));
  expect(await new Response((await backend.get('ws/a/uploads/photo-random.png'))!.stream).text()).toBe('copied');
  expect(fallback.reads).toHaveLength(1);
});

test('migration defaults to a dry run, verifies both stores and resumes without overwriting or deleting', async () => {
  const from = store('blob', { 'ws/a/one': 'one', 'ws/b/two': 'two' }), to = store('r2');
  const items = [...from.objects].map(([key, bytes]) => ({ key, size: bytes.length }));
  const source = { get: async (item: { key: string }) => ({ ...(await from.backend.get(item.key))!, contentType: 'text/plain' }), verify: async () => {} };
  const first = await migrateObjects({ items, source, target: to.backend });
  expect(first.counts).toMatchObject({ missing: 2, copied: 0 }); expect(to.writes).toEqual([]);
  expect((await migrateObjects({ items, source, target: to.backend, apply: true })).counts).toMatchObject({ copied: 2, verified: 2, bytes: 6, failed: 0 });
  expect((await migrateObjects({ items, source, target: to.backend, apply: true })).counts).toMatchObject({ copied: 0, verified: 2 });
  to.objects.set('ws/a/one', Buffer.from('bad'));
  expect((await migrateObjects({ items, source, target: to.backend, apply: true })).counts).toMatchObject({ conflicts: 1, verified: 1 });
  expect(to.writes).toHaveLength(2); expect(from.deletions).toEqual([]); expect(to.deletions).toEqual([]);
  expect(to.objects.get('ws/a/one')!.toString()).toBe('bad');
});

test('migration detects changed source versions and partial writes without claiming success', async () => {
  const from = store('blob', { 'ws/a/one': 'one' }), to = store('r2');
  const items = [{ key: 'ws/a/one', size: 3 }];
  const source = { get: async () => ({ ...(await from.backend.get(items[0].key))!, contentType: 'text/plain' }), verify: async () => { throw new Error('changed'); } };
  expect((await migrateObjects({ items, source, target: to.backend, apply: true })).counts).toMatchObject({ copied: 1, verified: 0, failed: 1 });
  to.backend.put = async () => { throw new Error('lost acknowledgement'); };
  to.objects.clear();
  expect((await migrateObjects({ items, source, target: to.backend, apply: true })).counts).toMatchObject({ copied: 0, verified: 0, failed: 1 });
  expect(from.objects.get(items[0].key)!.toString()).toBe('one');
});


test('migration locks the source stream before destination setup and releases it after verification', async () => {
  const bytes = Buffer.from('streamed original');
  const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close(); } });
  const to = store('r2');
  const put = to.backend.put;
  to.backend.put = async (...args) => {
    expect(stream.locked).toBe(true);
    await Promise.resolve();
    await put(...args);
  };
  const source = { get: async () => ({ stream, contentType: 'text/plain' }), verify: async () => {} };
  const result = await migrateObjects({ items: [{key: 'ws/a/original', size: bytes.length}], source, target: to.backend, apply: true });
  expect(result.counts).toMatchObject({ copied: 1, verified: 1, failed: 0 });
  expect(stream.locked).toBe(false);
});
