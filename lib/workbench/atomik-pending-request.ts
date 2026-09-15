import type { AtomikVideoFrame } from './atomik-reference-types';
/** Browser-side write-ahead record: a lost HTTP response must never mint another paid request ID. */
export type AtomikPendingStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export type AtomikSubmission = {
  projectId: string; requestId: string; request: string; model: string; effort?: string; depth: string;
  refs: string[]; role?: string; maxCredits: number; videoFrames?: AtomikVideoFrame[];
};
export type PendingAtomikRequest = {
  version: 1; scope: string; projectId: string; requestId: string;
  /** Preserve the exact bytes, including the quoted model and credit ceiling. */
  body: string; createdAt: number;
};
export type AtomikRecoveryJob = { id: string; requestId: string; status: string; error?: string | null };
export class AtomikPendingConflict extends Error {
  constructor(public readonly pending: PendingAtomikRequest) {
    super('An earlier Atomik request is unresolved. Recover that request before starting another.');
    this.name = 'AtomikPendingConflict';
  }
}

export function atomikPendingKey(scope: string, projectId: string) {
  if (!scope.trim() || !projectId.trim()) throw new Error('Sign in to this production before starting Atomik.');
  return 'particl:atomik-pending:v1:' + encodeURIComponent(scope) + ':' + encodeURIComponent(projectId);
}
export function atomikPendingInput(record: PendingAtomikRequest): AtomikSubmission {
  let data: unknown;
  try { data = JSON.parse(record.body); } catch { throw new Error('The saved Atomik request is unreadable. Review Activity before starting another request.'); }
  const value = data as Partial<AtomikSubmission> & { quoteOnly?: unknown };
  if (!value || typeof value !== 'object' || value.projectId !== record.projectId || value.requestId !== record.requestId ||
    typeof value.request !== 'string' || typeof value.model !== 'string' ||
    (value.effort != null && (typeof value.effort !== 'string' || value.effort.length < 1 || value.effort.length > 40)) || !['Quick', 'Considered', 'Deep'].includes(value.depth ?? '') ||
    !Array.isArray(value.refs) || !value.refs.every(ref => typeof ref === 'string') ||
    (value.videoFrames != null && (!Array.isArray(value.videoFrames) || value.videoFrames.length > 6 || !value.videoFrames.every(frame => frame && typeof frame.assetId === 'string' && typeof frame.uploadId === 'string' && typeof frame.timeSeconds === 'number' && Number.isFinite(frame.timeSeconds) && frame.timeSeconds >= 0 && frame.timeSeconds <= 3600))) ||
    (value.role != null && typeof value.role !== 'string') || value.quoteOnly != null ||
    typeof value.maxCredits !== 'number' || !Number.isInteger(value.maxCredits) || value.maxCredits < 0) {
    throw new Error('The saved Atomik request cannot be verified. Review Activity before starting another request.');
  }
  return value as AtomikSubmission;
}
export function readPendingAtomik(storage: AtomikPendingStorage, scope: string, projectId: string): PendingAtomikRequest | null {
  let raw: string | null;
  try { raw = storage.getItem(atomikPendingKey(scope, projectId)); }
  catch { throw new Error('Browser storage is unavailable. Atomik cannot safely recover paid requests on this device.'); }
  if (raw == null) return null;
  let record: PendingAtomikRequest;
  try { record = JSON.parse(raw); }
  catch { throw new Error('The saved Atomik request is unreadable. Review Activity before starting another request.'); }
  if (!record || record.version !== 1 || record.scope !== scope || record.projectId !== projectId ||
    typeof record.requestId !== 'string' || typeof record.body !== 'string' || typeof record.createdAt !== 'number') {
    throw new Error('The saved Atomik request does not match this account and production. Review Activity before starting another request.');
  }
  atomikPendingInput(record);
  return record;
}
export function persistPendingAtomik(storage: AtomikPendingStorage, scope: string, projectId: string, body: string, createdAt = Date.now()): PendingAtomikRequest {
  let input: Partial<AtomikSubmission>;
  try { input = JSON.parse(body); } catch { throw new Error('The Atomik request could not be recorded.'); }
  const record: PendingAtomikRequest = { version: 1, scope, projectId, requestId: String(input?.requestId ?? ''), body, createdAt };
  atomikPendingInput(record);
  const existing = readPendingAtomik(storage, scope, projectId);
  if (existing) {
    if (existing.requestId === record.requestId && existing.body === body) return existing;
    throw new AtomikPendingConflict(existing);
  }
  const key = atomikPendingKey(scope, projectId), encoded = JSON.stringify(record);
  try {
    storage.setItem(key, encoded);
    if (storage.getItem(key) !== encoded) throw new Error('The request record changed.');
  } catch { throw new Error('Atomik could not save its recovery record. No new paid request was sent. Enable browser storage and try again.'); }
  return record;
}

/** A matching accepted job resolves the submission; an absent GET row or uncertain outcome does not. */
export type AtomikResolution =
  | { job: AtomikRecoveryJob }
  | { rejectedStatus: number; confirmedNoJob: boolean };
export function resolvePendingAtomik(storage: AtomikPendingStorage, scope: string, projectId: string, record: PendingAtomikRequest, resolution: AtomikResolution): boolean {
  const resolved = 'job' in resolution
    ? resolution.job.requestId === record.requestId && ['queued', 'running', 'succeeded', 'failed'].includes(resolution.job.status)
    : resolution.confirmedNoJob && [400, 402, 422].includes(resolution.rejectedStatus);
  if (!resolved) return false;
  const current = readPendingAtomik(storage, scope, projectId);
  if (!current) return true;
  if (current.requestId !== record.requestId || current.body !== record.body) return false;
  try { storage.removeItem(atomikPendingKey(scope, projectId)); }
  catch { throw new Error('The request is resolved, but its recovery record could not be cleared. Reopen Atomik to check its status again.'); }
  return true;
}

const localTurns = new Map<string, Promise<void>>();
/** Web Locks coordinate tabs; the local queue also protects double clicks without Web Locks. */
export async function withPendingAtomikLock<T>(scope: string, projectId: string, run: () => Promise<T>): Promise<T> {
  const key = atomikPendingKey(scope, projectId);
  const prior = localTurns.get(key) ?? Promise.resolve();
  let release!: () => void;
  const turn = new Promise<void>(resolve => { release = resolve; });
  localTurns.set(key, turn);
  await prior;
  try {
    if (typeof navigator !== 'undefined' && navigator.locks?.request) {
      return await navigator.locks.request(key, { mode: 'exclusive' }, run);
    }
    return await run();
  } finally {
    release();
    if (localTurns.get(key) === turn) localTurns.delete(key);
  }
}
