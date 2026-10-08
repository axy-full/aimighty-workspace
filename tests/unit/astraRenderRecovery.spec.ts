import { test, expect } from '@playwright/test';
import { astraRenderPendingKey, clearPendingAstraRender, persistPendingAstraRender, readPendingAstraRender, withAstraRenderLock } from '../../components/astra-blender/astra-render-recovery';
function storage() { const entries = new Map<string, string>(); return { getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => { entries.set(key, value); }, removeItem: (key: string) => { entries.delete(key); } }; }
const input = { projectId: 'project', requestId: 'render-request-1', source: 'native', sourceDigest: 'a'.repeat(64), quoteOnly: false, quoteDigest: 'b'.repeat(64), maxCredits: 12 };
test('native render recovery preserves exact approved bytes and refuses a competing identity', () => {
  const local = storage(), body = JSON.stringify(input), record = persistPendingAstraRender(local, 'scope', 'project', body);
  expect(readPendingAstraRender(local, 'scope', 'project')?.body).toBe(body);
  expect(persistPendingAstraRender(local, 'scope', 'project', body)).toEqual(record);
  expect(() => persistPendingAstraRender(local, 'scope', 'project', JSON.stringify({ ...input, requestId: 'another-request' }))).toThrow('needs recovery');
  clearPendingAstraRender(local, 'scope', 'project', { ...record, requestId: 'another-request' });
  expect(readPendingAstraRender(local, 'scope', 'project')).toEqual(record);
  clearPendingAstraRender(local, 'scope', 'project', record);
  expect(readPendingAstraRender(local, 'scope', 'project')).toBeNull();
});
test('storage failure and corrupt render credit approval block dispatch', () => {
  const broken = { ...storage(), setItem: () => { throw new Error('quota'); } };
  expect(() => persistPendingAstraRender(broken, 'scope', 'project', JSON.stringify(input))).toThrow('No new render was sent');
  const local = storage();
  local.setItem(astraRenderPendingKey('scope', 'project'), JSON.stringify({ version: 1, scope: 'scope', projectId: 'project', requestId: input.requestId, createdAt: Date.now(), body: JSON.stringify({ ...input, maxCredits: -1 }) }));
  expect(() => readPendingAstraRender(local, 'scope', 'project')).toThrow('could not be verified');
});
test('simultaneous native render actions serialize around one durable recovery record', async () => {
  const local = storage(), order: string[] = [];
  let done!: () => void;
  const gate = new Promise<void>((resolve) => { done = resolve; });
  const first = withAstraRenderLock('scope', 'project', async () => { order.push('first'); persistPendingAstraRender(local, 'scope', 'project', JSON.stringify(input)); await gate; });
  const next = withAstraRenderLock('scope', 'project', async () => { order.push('next'); expect(readPendingAstraRender(local, 'scope', 'project')?.requestId).toBe(input.requestId); });
  await Promise.resolve(); expect(order).toEqual(['first']); done(); await Promise.all([first, next]); expect(order).toEqual(['first', 'next']);
});
