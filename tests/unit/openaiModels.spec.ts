import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { openAIConnection } from '../../lib/openai-models';
import { runInTenant, type TenantWorkspace } from '../../lib/tenant';

function workspace(key?: string): TenantWorkspace { return { id: randomUUID(), slug: 'unit', name: 'Unit', legacy: false, dbUrl: 'file:unused', dbToken: null, keys: key ? { openai: key } : {}, usesPlatformKeys: false, allowanceUsd: null, suspendedAt: null, suspendedReason: null, flaggedAt: null, flagNote: null, concurrency: null, rendersPerHour: null, storageQuotaBytes: null, deletedAt: null, gatewayKeyId: null, ownerId: 'owner', createdAt: 0 }; }
test('direct model verification is read-only, exact and credential-scoped', async () => {
  const old = process.env.ENGINE_MOCK; delete process.env.ENGINE_MOCK;
  try {
    let calls = 0;
    const first = workspace('unit-' + randomUUID()), second = workspace('unit-' + randomUUID());
    const fetcher: typeof fetch = async (url, init) => {
      calls++; expect(url).toBe('https://api.openai.com/v1/models'); expect(init?.method ?? 'GET').toBe('GET'); expect(init?.redirect).toBe('error');
      expect(JSON.stringify(init?.headers)).toContain(calls === 1 ? first.keys.openai : second.keys.openai);
      return Response.json({ data: [{ id: calls === 1 ? 'gpt-6-astra' : 'gpt-4.1' }, { id: 'https://wrong.invalid' }] });
    };
    const one = await runInTenant(first, () => openAIConnection(false, fetcher));
    expect(one.verified).toBe(true); expect(one.models).toEqual(['gpt-6-astra']);
    expect(await runInTenant(first, () => openAIConnection(false, fetcher))).toEqual(one);
    expect((await runInTenant(second, () => openAIConnection(false, fetcher))).models).toEqual(['gpt-4.1']);
    expect(calls).toBe(2);
    expect(JSON.stringify(one)).not.toContain(first.keys.openai);
  } finally { if (old === undefined) delete process.env.ENGINE_MOCK; else process.env.ENGINE_MOCK = old; }
});
test('mock, disconnected and rejected keys cannot advertise live model access', async () => {
  const old = process.env.ENGINE_MOCK; delete process.env.ENGINE_MOCK;
  try {
    const noCall: typeof fetch = async () => { throw new Error('must not call'); };
    expect((await runInTenant(workspace(), () => openAIConnection(true, noCall))).configured).toBe(false);
    const rejected = await runInTenant(workspace('unit-' + randomUUID()), () => openAIConnection(true, async () => new Response('private provider error', { status: 403 })));
    expect(rejected).toMatchObject({ configured: true, verified: false, models: [] });
    expect(rejected.error).not.toContain('private provider');
    process.env.ENGINE_MOCK = '1';
    expect((await runInTenant(workspace('unit-' + randomUUID()), () => openAIConnection(true, noCall))).verified).toBe(false);
  } finally { if (old === undefined) delete process.env.ENGINE_MOCK; else process.env.ENGINE_MOCK = old; }
});
