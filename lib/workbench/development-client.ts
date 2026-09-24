import type { DevelopmentRequest, DevelopmentKind } from './development-types';
import { sourceCanonical } from './development-types';
import type { Project } from './studio';
import { withPendingAtomikLock } from './atomik-pending-request';

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export type PendingDevelopment = { version: 1; scope: string; projectId: string; body: string };
export function developmentPendingKey(scope: string, projectId: string) {
  return `particl:development:v1:${encodeURIComponent(scope)}:${encodeURIComponent(projectId)}`;
}
export async function developmentSourceHash(project: Project, kind: DevelopmentKind) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sourceCanonical(project, kind)));
  return Array.from(new Uint8Array(hash), n => n.toString(16).padStart(2, '0')).join('');
}
export function developmentInput(record: PendingDevelopment): DevelopmentRequest {
  const input = JSON.parse(record.body) as DevelopmentRequest & { quoteOnly?: unknown };
  if (!input || input.projectId !== record.projectId || !/^[\w-]{8,100}$/.test(input.requestId) ||
      !['idea', 'screenplay', 'adfilm', 'write', 'frames', 'sketch', 'cast', 'environment', 'condense', 'rig'].includes(input.kind) || !/^(anthropic|openai|spacexai)\//.test(input.model) ||
      (input.fromJobId != null && (input.kind !== 'write' || !/^wb_development_[a-f0-9-]+$/.test(input.fromJobId))) ||
      (input.fromBeats != null && (input.kind !== 'write' || input.fromBeats !== true || input.fromJobId != null)) ||
      (input.sketchAssetId != null && (input.kind !== 'sketch' || !/^[\w-]{1,100}$/.test(input.sketchAssetId))) ||
      (input.shotId != null && ((input.kind !== 'sketch' && input.kind !== 'frames') || !/^[\w-]{1,100}$/.test(input.shotId))) ||
      typeof input.effort !== 'string' || !/^[a-f0-9]{64}$/.test(input.sourceHash ?? '') ||
      !Number.isInteger(input.maxCredits) || input.maxCredits! < 0 || input.quoteOnly != null ||
      (input.maxUsd != null && (!Number.isFinite(input.maxUsd) || input.maxUsd < 0))) {
    throw new Error('The saved development request cannot be verified. Review saved runs before starting another.');
  }
  return input;
}
export function readDevelopment(storage: StorageLike, scope: string, projectId: string): PendingDevelopment | null {
  const raw = storage.getItem(developmentPendingKey(scope, projectId));
  if (!raw) return null;
  const record = JSON.parse(raw) as PendingDevelopment;
  if (!record || record.version !== 1 || record.scope !== scope || record.projectId !== projectId || typeof record.body !== 'string') {
    throw new Error('The development recovery record does not match this workspace and project.');
  }
  developmentInput(record);
  return record;
}
export function recordDevelopment(storage: StorageLike, scope: string, projectId: string, body: string): PendingDevelopment {
  const record: PendingDevelopment = { version: 1, scope, projectId, body };
  developmentInput(record);
  const prior = readDevelopment(storage, scope, projectId);
  if (prior && prior.body !== body) throw new Error('An earlier development request is unconfirmed. Recover it before starting a new run.');
  const key = developmentPendingKey(scope, projectId), encoded = JSON.stringify(record);
  storage.setItem(key, encoded);
  if (storage.getItem(key) !== encoded) throw new Error('The recovery record could not be saved. No new request was sent.');
  return record;
}
export function clearDevelopment(storage: StorageLike, record: PendingDevelopment, requestId: string) {
  if (developmentInput(record).requestId !== requestId) return false;
  const prior = readDevelopment(storage, record.scope, record.projectId);
  if (prior?.body !== record.body) return false;
  storage.removeItem(developmentPendingKey(record.scope, record.projectId));
  return true;
}
export const withDevelopmentLock = <T>(scope: string, projectId: string, run: () => Promise<T>) =>
  withPendingAtomikLock('development:' + scope, projectId, run);
