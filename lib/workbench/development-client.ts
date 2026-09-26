import type { DevelopmentRequest, DevelopmentKind } from './development-types';
import { sourceCanonical } from './development-types';
import type { Project } from './studio';
import { withPendingAtomikLock } from './atomik-pending-request';

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
/**
 * One unconfirmed request per recovery slot. The Production agent keeps the
 * project's shared slot (no `slot`); the Brief & Script panel keys its own by
 * development kind, so an agent run never blocks or relabels the breakdown.
 */
export type PendingDevelopment = { version: 1; scope: string; projectId: string; body: string; slot?: string };
export function developmentPendingKey(scope: string, projectId: string, slot = '') {
  return `particl:development:v1:${encodeURIComponent(scope)}:${encodeURIComponent(projectId)}${slot ? ':' + encodeURIComponent(slot) : ''}`;
}
export async function developmentSourceHash(project: Project, kind: DevelopmentKind) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sourceCanonical(project, kind)));
  return Array.from(new Uint8Array(hash), n => n.toString(16).padStart(2, '0')).join('');
}
export function developmentInput(record: PendingDevelopment): DevelopmentRequest {
  const input = JSON.parse(record.body) as DevelopmentRequest & { quoteOnly?: unknown };
  if (!input || input.projectId !== record.projectId || !/^[\w-]{8,100}$/.test(input.requestId) ||
      !['idea', 'screenplay', 'adfilm', 'write', 'frames', 'sketch', 'cast', 'environment', 'beatsheet', 'condense', 'rig'].includes(input.kind) || !/^(anthropic|openai|spacexai)\//.test(input.model) ||
      (input.fromJobId != null && (input.kind !== 'write' || !/^wb_development_[a-f0-9-]+$/.test(input.fromJobId))) ||
      (input.fromBeats != null && (input.kind !== 'write' || input.fromBeats !== true || input.fromJobId != null)) ||
      (input.sketchAssetId != null && (input.kind !== 'sketch' || !/^[\w-]{1,100}$/.test(input.sketchAssetId))) ||
      (input.shotId != null && ((input.kind !== 'sketch' && input.kind !== 'frames') || !/^[\w-]{1,100}$/.test(input.shotId))) ||
      typeof input.effort !== 'string' || !/^[a-f0-9]{64}$/.test(input.sourceHash ?? '') ||
      !Number.isInteger(input.maxCredits) || input.maxCredits! < 0 || input.quoteOnly != null ||
      (input.maxUsd != null && (!Number.isFinite(input.maxUsd) || input.maxUsd < 0)) ||
      (input.attachmentAssetIds != null && (!Array.isArray(input.attachmentAssetIds) || input.attachmentAssetIds.length > 4 || input.kind === 'condense' || !input.attachmentAssetIds.every((id) => typeof id === 'string' && /^[\w-]{1,100}$/.test(id))))) {
    throw new Error('The saved development request cannot be verified. Review saved runs before starting another.');
  }
  return input;
}
export function readDevelopment(storage: StorageLike, scope: string, projectId: string, slot = ''): PendingDevelopment | null {
  const raw = storage.getItem(developmentPendingKey(scope, projectId, slot));
  if (!raw) return null;
  const record = JSON.parse(raw) as PendingDevelopment;
  if (!record || record.version !== 1 || record.scope !== scope || record.projectId !== projectId || typeof record.body !== 'string' || (record.slot ?? '') !== slot) {
    throw new Error('The development recovery record does not match this workspace and project.');
  }
  developmentInput(record);
  return record;
}
/**
 * The Brief & Script panel's unconfirmed request for `kind`: its own slot, or
 * a request of that kind it left in the shared slot before slots were keyed.
 * Another kind's request (an agent run) is not the panel's to recover. An
 * unreadable shared record still throws: it might be the panel's own.
 */
export function readKindDevelopment(storage: StorageLike, scope: string, projectId: string, kind: DevelopmentKind): PendingDevelopment | null {
  const own = readDevelopment(storage, scope, projectId, kind);
  if (own) return own;
  const shared = readDevelopment(storage, scope, projectId);
  return shared && developmentInput(shared).kind === kind ? shared : null;
}
export function recordDevelopment(storage: StorageLike, scope: string, projectId: string, body: string, slot = ''): PendingDevelopment {
  const record: PendingDevelopment = { version: 1, scope, projectId, body, ...(slot ? { slot } : {}) };
  developmentInput(record);
  const prior = readDevelopment(storage, scope, projectId, slot);
  if (prior && prior.body !== body) throw new Error('An earlier development request is unconfirmed. Recover it before starting a new run.');
  const key = developmentPendingKey(scope, projectId, slot), encoded = JSON.stringify(record);
  storage.setItem(key, encoded);
  if (storage.getItem(key) !== encoded) throw new Error('The recovery record could not be saved. No new request was sent.');
  return record;
}
export function clearDevelopment(storage: StorageLike, record: PendingDevelopment, requestId: string) {
  if (developmentInput(record).requestId !== requestId) return false;
  const prior = readDevelopment(storage, record.scope, record.projectId, record.slot ?? '');
  if (prior?.body !== record.body) return false;
  storage.removeItem(developmentPendingKey(record.scope, record.projectId, record.slot ?? ''));
  return true;
}
export const withDevelopmentLock = <T>(scope: string, projectId: string, run: () => Promise<T>) =>
  withPendingAtomikLock('development:' + scope, projectId, run);
