import { test, expect } from '@playwright/test';
import {
  AtomikPendingConflict, atomikPendingKey, atomikPendingInput, persistPendingAtomik,
  readPendingAtomik, resolvePendingAtomik, withPendingAtomikLock, type AtomikPendingStorage,
} from '../../lib/workbench/atomik-pending-request';

class MemoryStorage implements AtomikPendingStorage {
  values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}
const scope = 'workspace-a:user-a', projectId = 'draft-a';
const body = JSON.stringify({ projectId, requestId: 'request-original', request: 'Make a Mira treatment', model: 'test/quoted-model', depth: 'Quick', refs: ['character'], maxCredits: 3 });
const alternate = JSON.stringify({ ...JSON.parse(body), requestId: 'request-reopened', model: 'test/different-model' });

test('a dropped submit response restores the exact quoted body and request ID after a reload', async () => {
  const storage = new MemoryStorage();
  const server = new Map<string, { id: string; requestId: string; status: string }>();
  let paidCalls = 0;
  const original = persistPendingAtomik(storage, scope, projectId, body);
  // The server accepted the request, but the original dialog never received its response.
  const input = atomikPendingInput(original);
  server.set(input.requestId, { id: 'job-1', requestId: input.requestId, status: 'queued' });
  paidCalls++;

  // A fresh component lifetime reads the same browser record instead of inventing an identity.
  const restored = readPendingAtomik(storage, scope, projectId)!;
  expect(restored.body).toBe(body);
  expect(atomikPendingInput(restored)).toMatchObject({ model: 'test/quoted-model', maxCredits: 3 });
  expect(() => persistPendingAtomik(storage, scope, projectId, alternate)).toThrow(AtomikPendingConflict);
  expect(resolvePendingAtomik(storage, scope, projectId, restored, { job: server.get(restored.requestId)! })).toBe(true);
  expect(readPendingAtomik(storage, scope, projectId)).toBeNull();
  expect(paidCalls).toBe(1);
});

test('missing GET results and ambiguous errors retain the original request across repeated retries', () => {
  const storage = new MemoryStorage();
  const pending = persistPendingAtomik(storage, scope, projectId, body);
  for (const rejectedStatus of [0, 400, 401, 402, 403, 409, 422, 429, 500, 502]) {
    expect(resolvePendingAtomik(storage, scope, projectId, pending, { rejectedStatus, confirmedNoJob: false })).toBe(false);
  }
  for (const rejectedStatus of [0, 401, 403, 409, 429, 500, 502]) {
    expect(resolvePendingAtomik(storage, scope, projectId, pending, { rejectedStatus, confirmedNoJob: true })).toBe(false);
  }
  expect(persistPendingAtomik(storage, scope, projectId, body)).toEqual(pending);
  expect(readPendingAtomik(storage, scope, projectId)?.requestId).toBe('request-original');
});

test('only a verified rejection with a successful empty lookup clears a rejected submission', () => {
  for (const rejectedStatus of [400, 402, 422]) {
    const storage = new MemoryStorage();
    const pending = persistPendingAtomik(storage, scope, projectId, body);
    expect(resolvePendingAtomik(storage, scope, projectId, pending, { rejectedStatus, confirmedNoJob: true })).toBe(true);
    expect(readPendingAtomik(storage, scope, projectId)).toBeNull();
  }
});

test('an uncertain provider result and another job identity cannot clear the recovery record', () => {
  const storage = new MemoryStorage();
  const pending = persistPendingAtomik(storage, scope, projectId, body);
  expect(resolvePendingAtomik(storage, scope, projectId, pending, { job: { id: 'job-1', requestId: pending.requestId, status: 'uncertain' } })).toBe(false);
  expect(resolvePendingAtomik(storage, scope, projectId, pending, { job: { id: 'job-2', requestId: 'different-request', status: 'succeeded' } })).toBe(false);
  expect(readPendingAtomik(storage, scope, projectId)).toEqual(pending);
});

test('recovery records are isolated by authenticated workspace, user and draft', () => {
  const storage = new MemoryStorage();
  persistPendingAtomik(storage, scope, projectId, body);
  expect(readPendingAtomik(storage, 'workspace-a:user-b', projectId)).toBeNull();
  expect(readPendingAtomik(storage, 'workspace-b:user-a', projectId)).toBeNull();
  expect(readPendingAtomik(storage, scope, 'draft-b')).toBeNull();
  expect(() => atomikPendingKey('', projectId)).toThrow('Sign in');
});

test('corrupt and unwritable storage prevent a paid POST rather than discarding recovery data', async () => {
  const storage = new MemoryStorage();
  storage.setItem(atomikPendingKey(scope, projectId), '{broken-json');
  expect(() => readPendingAtomik(storage, scope, projectId)).toThrow('unreadable');
  expect(storage.getItem(atomikPendingKey(scope, projectId))).toBe('{broken-json');
  let paidCalls = 0;
  const unavailable: AtomikPendingStorage = { getItem: () => null, setItem: () => { throw new Error('quota full'); }, removeItem: () => {} };
  await expect((async () => {
    persistPendingAtomik(unavailable, scope, projectId, body);
    paidCalls++;
  })()).rejects.toThrow('No new paid request was sent');
  expect(paidCalls).toBe(0);
});

test('a late result for an old request cannot remove a newer pending request', () => {
  const storage = new MemoryStorage();
  const old = persistPendingAtomik(storage, scope, projectId, body);
  resolvePendingAtomik(storage, scope, projectId, old, { job: { id: 'job-1', requestId: old.requestId, status: 'succeeded' } });
  const current = persistPendingAtomik(storage, scope, projectId, alternate);
  expect(resolvePendingAtomik(storage, scope, projectId, old, { job: { id: 'job-1', requestId: old.requestId, status: 'succeeded' } })).toBe(false);
  expect(readPendingAtomik(storage, scope, projectId)).toEqual(current);
});

test('simultaneous attempts preserve the first unresolved identity before either can be replaced', async () => {
  const storage = new MemoryStorage();
  let paidCalls = 0;
  const outcomes = await Promise.allSettled([body, alternate].map(candidate =>
    withPendingAtomikLock(scope, projectId, async () => {
      persistPendingAtomik(storage, scope, projectId, candidate);
      paidCalls++;
      // Simulate an interrupted response: leave the recovery record unresolved.
      await Promise.resolve();
    }),
  ));
  expect(outcomes.filter(value => value.status === 'fulfilled')).toHaveLength(1);
  expect(outcomes.filter(value => value.status === 'rejected')).toHaveLength(1);
  expect(paidCalls).toBe(1);
  expect(readPendingAtomik(storage, scope, projectId)?.body).toBe(body);
});
