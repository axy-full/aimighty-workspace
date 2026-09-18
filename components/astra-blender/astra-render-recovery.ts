/** Durable request bytes are written before a native-render POST. */
export type PendingAstraRender = {
  version: 1;
  scope: string;
  projectId: string;
  requestId: string;
  body: string;
  createdAt: number;
};
type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function astraRenderPendingKey(scope: string, projectId: string) {
  if (!scope || !projectId) throw new Error('Open an authenticated project before rendering.');
  return `particl:astra-render-pending:v1:${encodeURIComponent(scope)}:${encodeURIComponent(projectId)}`;
}

export function readPendingAstraRender(storage: StorageLike, scope: string, projectId: string): PendingAstraRender | null {
  let raw: string | null;
  try { raw = storage.getItem(astraRenderPendingKey(scope, projectId)); }
  catch { throw new Error('Browser recovery storage is unavailable. Enable it before starting a native render.'); }
  if (raw === null) return null;
  try {
    const record = JSON.parse(raw) as PendingAstraRender;
    const input = JSON.parse(record.body);
    if (record.version !== 1 || record.scope !== scope || record.projectId !== projectId || typeof record.requestId !== 'string' || !record.requestId || typeof record.body !== 'string' || record.body.length > 20000 || !Number.isFinite(record.createdAt)
      || input.projectId !== projectId || input.requestId !== record.requestId || !['scene', 'native'].includes(input.source) || !Number.isSafeInteger(input.maxCredits) || input.maxCredits < 0 || input.maxCredits > 100000 || input.quoteOnly !== false || typeof input.sourceDigest !== 'string' || !/^[a-f0-9]{64}$/.test(input.sourceDigest) || typeof input.quoteDigest !== 'string' || !/^[a-f0-9]{64}$/.test(input.quoteDigest)) throw new Error('invalid');
    return record;
  } catch { throw new Error('The saved render request could not be verified. Review render history before starting another render.'); }
}

export function persistPendingAstraRender(storage: StorageLike, scope: string, projectId: string, body: string) {
  const input = JSON.parse(body) as { requestId?: string };
  const existing = readPendingAstraRender(storage, scope, projectId);
  if (existing) {
    if (existing.requestId === input.requestId && existing.body === body) return existing;
    throw new Error('Another native render request needs recovery. Recover it before starting a new render.');
  }
  const record: PendingAstraRender = { version: 1, scope, projectId, requestId: String(input.requestId || ''), body, createdAt: Date.now() };
  const key = astraRenderPendingKey(scope, projectId);
  const encoded = JSON.stringify(record);
  try {
    storage.setItem(key, encoded);
    if (storage.getItem(key) !== encoded) throw new Error('The saved request changed.');
    readPendingAstraRender(storage, scope, projectId);
  } catch { throw new Error('The render recovery record could not be saved. No new render was sent.'); }
  return record;
}

export function clearPendingAstraRender(storage: StorageLike, scope: string, projectId: string, record: PendingAstraRender) {
  const current = readPendingAstraRender(storage, scope, projectId);
  if (current && (current.requestId !== record.requestId || current.body !== record.body)) return;
  try { storage.removeItem(astraRenderPendingKey(scope, projectId)); }
  catch { throw new Error('The render was found, but its recovery record could not be cleared. Refresh render history.'); }
}

const turns = new Map<string, Promise<void>>();
export async function withAstraRenderLock<T>(scope: string, projectId: string, action: () => Promise<T>): Promise<T> {
  const key = astraRenderPendingKey(scope, projectId), previous = turns.get(key) ?? Promise.resolve();
  let release!: () => void;
  const turn = new Promise<void>((resolve) => { release = resolve; });
  turns.set(key, turn);
  await previous;
  try {
    if (typeof navigator !== 'undefined' && navigator.locks?.request) return await navigator.locks.request(key, action);
    return await action();
  } finally { release(); if (turns.get(key) === turn) turns.delete(key); }
}
