import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as zod from 'zod';
import * as tenant from '../../lib/tenant';
import { MediaSourceError } from '../../lib/mediaBindings';
import { workbenchScopeFor } from '../../lib/workbench/request-scope';
import { AccountError } from '../../lib/accountDb';
import * as requestBody from '../../lib/requestBody';
import { ConsumerOAuthError } from '../../lib/higgsfield-consumer/oauth';
import { ConsumerDiscoveryError } from '../../lib/higgsfield-consumer/mcp';
import { ConsumerJobError } from '../../lib/higgsfield-consumer/jobs';
import * as contract from '../../lib/higgsfield-consumer/video-contract';
import { ConsumerOriginalError } from '../../lib/higgsfield-consumer/video-original';
import * as records from '../../lib/higgsfield-consumer/marketing-records';

const key = '11111111-1111-4111-8111-111111111111';
const wallet = '22222222-2222-4222-8222-222222222222';
const input = { prompt: 'A plain bottle on a studio background.', duration: 15, resolution: '720p', aspectRatio: '16:9', generateAudio: true };
const quote = { action: 'quote', draftId: 'draft-1', input, idempotencyKey: key };
const submit = { action: 'submit', draftId: 'draft-1', id: key, workspaceId: wallet, credits: 10 };
const status = { action: 'status', draftId: 'draft-1', id: key };
const scope = workbenchScopeFor('workspace', 'owner');

/** Real withTenant, requireOwner, requireRender, input schema and byte reader.
 * Only session resolution, recovery transport, rate storage and service I/O are isolated. */
async function fixture() {
  const auth = await import('../../lib/auth');
  let store = { workspace: { id: 'workspace', deletedAt: null, suspendedAt: null },
    user: { id: 'owner', role: 'admin', owner: true } } as tenant.TenantStore;
  const source = ts.createSourceFile('auth.ts', readFileSync('lib/auth.ts', 'utf8'), ts.ScriptTarget.Latest, true);
  const statement = source.statements.find(s => ts.isFunctionDeclaration(s) && s.name?.text === 'withTenant')!;
  const wrapped = {} as Pick<typeof auth, 'withTenant'>;
  const compile = (text: string) => ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function('exports', 'resolveStore', 'runWithStore', 'NoTenantError', 'MediaSourceError', 'workbenchScopeFor', 'recoveryRoute', compile(statement.getText(source)))(
    wrapped, async () => store, tenant.runWithStore, tenant.NoTenantError, MediaSourceError, workbenchScopeFor, (handler: unknown) => handler,
  );
  const calls: { name: string; args: unknown[]; workspace: string }[] = [];
  const limits: unknown[][] = [];
  const guarded: { userId: string; wanted: records.SetupIds; workspace: string }[] = [];
  let limited = false, failure: unknown;
  class ServiceError extends Error { constructor(readonly code: string, message: string, readonly status = 409) { super(message); } }
  const service = (name: string, result: unknown) => async (...args: unknown[]) => {
    calls.push({ name, args, workspace: tenant.requireTenant().id });
    if (failure) throw failure;
    return result;
  };
  const job = { id: key, draftId: 'draft-1', status: 'quoted', quoteCredits: 10, creditUnit: 'higgsfield_credits' };
  const deps: Record<string, unknown> = {
    zod,
    '@/lib/auth': { ...auth, withTenant: wrapped.withTenant },
    '@/lib/tenant': tenant,
    '@/lib/accountDb': { AccountError, takeAccountLimit: async (...args: unknown[]) => {
      limits.push(args); if (limited) throw new AccountError('private limit detail', 429);
    } },
    '@/lib/requestBody': requestBody,
    '@/lib/higgsfield-consumer/oauth': { ConsumerOAuthError },
    '@/lib/higgsfield-consumer/mcp': { ConsumerDiscoveryError },
    '@/lib/higgsfield-consumer/jobs': { ConsumerJobError },
    '@/lib/higgsfield-consumer/video-contract': contract,
    '@/lib/higgsfield-consumer/video-original': { ConsumerOriginalError },
    /* The standalone guard: real id extraction; the record read is isolated — an `acct_` id is one Particl did not make. */
    '@/lib/higgsfield-consumer/marketing-records': { ...records, refuseForeignSetup: async (userId: string, wanted: records.SetupIds) => {
      guarded.push({ userId, wanted, workspace: tenant.requireTenant().id });
      if (Object.values(wanted).flat().some((id) => id.startsWith('acct_'))) throw new records.ConsumerSetupError();
    } },
    '@/lib/higgsfield-consumer/marketing-setup': { SETUP_TYPE_IDS: ['product', 'avatar', 'hook', 'setting', 'ad_reference', 'brand_kit'], connectedMarketingSetup: service('setup', { connected: true, reads: [] }) },
    '@/lib/higgsfield-consumer/video-service': {
      ConsumerVideoServiceError: ServiceError, MARKETING_VIDEO_REHEARSAL: input,
      ensureConsumerRehearsal: service('rehearsal', 'rehearsal-draft'),
      consumerMarketingJobs: service('list', [job]),
      quoteConsumerMarketingVideo: service('quote', job),
      submitConsumerMarketingVideo: service('submit', { ...job, status: 'accepted' }),
      pollConsumerMarketingVideo: service('status', { job: { ...job, status: 'accepted' } }),
    },
  };
  const output = { exports: {} as Record<'GET' | 'POST', (req: Request, ctx?: unknown) => Promise<Response>> };
  new Function('require', 'module', 'exports', compile(readFileSync('app/api/higgsfield/consumer/video/route.ts', 'utf8')))((name: string) => {
    if (!(name in deps)) throw new Error(`Unexpected route dependency ${name}`);
    return deps[name];
  }, output, output.exports);
  return {
    calls, limits, job, guarded, store: () => store, setStore: (value: tenant.TenantStore) => { store = value; },
    fail: (value: unknown) => { failure = value; }, limit: () => { limited = true; },
    request: (method: 'GET' | 'POST', body: unknown = quote, options: { scope?: string | null; origin?: string; query?: string; raw?: string | Uint8Array; contentLength?: string; empty?: boolean } = {}) => {
      const captured = options.scope === undefined ? scope : options.scope;
      const req = new Request(`https://particl.example/api/higgsfield/consumer/video${options.query ?? ''}`, {
        method, headers: { ...(captured === null ? {} : { 'X-Workbench-Scope': captured }),
          ...(options.origin ? { Origin: options.origin } : {}), ...(options.contentLength ? { 'Content-Length': options.contentLength } : {}) },
        ...(method === 'POST' && !options.empty ? { body: (options.raw ?? JSON.stringify(body)) as BodyInit } : {}),
      });
      return output.exports[method](req);
    },
  };
}

test('consumer video route rejects signed-out, member, nonowner admin and both API token scopes before service access', async () => {
  const f = await fixture(), original = f.store();
  for (const method of ['GET', 'POST'] as const) {
    f.setStore({ ...original, user: null });
    expect((await f.request(method, quote, { scope: null })).status).toBe(401);
    for (const role of ['member', 'admin'] as const) {
      f.setStore({ ...original, user: { ...original.user!, role, owner: false } });
      expect((await f.request(method)).status).toBe(403);
    }
    for (const tokenScope of ['read', 'render'] as const) {
      f.setStore({ ...original, token: { id: 'api-token', name: 'Fixture', scope: tokenScope, capUsd: null } });
      expect((await f.request(method, quote, { scope: null })).status).toBe(403);
    }
    f.setStore({ ...original, workspace: { ...original.workspace!, deletedAt: 1 } });
    expect((await f.request(method)).status).toBe(401);
  }
  expect(f.calls).toEqual([]); expect(f.limits).toEqual([]);
});

test('captured workspace/account, browser origin and MFA guards run before every mutation', async () => {
  const f = await fixture(), original = f.store();
  for (const captured of [null, '', workbenchScopeFor('other', 'owner'), workbenchScopeFor('workspace', 'other')])
    expect((await f.request('POST', submit, { scope: captured })).status).toBe(409);
  for (const captured of ['', workbenchScopeFor('other', 'owner'), workbenchScopeFor('workspace', 'other')])
    expect((await f.request('GET', undefined, { scope: captured })).status).toBe(409);
  expect((await f.request('POST', submit, { origin: 'https://other.example' })).status).toBe(403);
  f.setStore({ ...original, mfaRequired: true });
  for (const method of ['GET', 'POST'] as const) expect((await f.request(method)).status).toBe(428);
  expect(f.calls).toEqual([]); expect(f.limits).toEqual([]);
});

test('owner actions pass resolved tenant identity and only validated arguments to the service', async () => {
  const f = await fixture();
  const bodies = [quote, { action: 'quote-rehearsal', idempotencyKey: key }, submit, status];
  for (const body of bodies) {
    const response = await f.request('POST', body, { origin: 'https://particl.example' });
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(await response.json()).toHaveProperty('job');
  }
  expect((await f.request('GET', undefined, { query: '?draftId=draft-1&userId=other&workspaceId=other' })).status).toBe(200);
  const listing = await f.request('GET');
  expect(listing.status).toBe(200); expect(listing.headers.get('Cache-Control')).toBe('private, no-store');
  expect(await listing.json()).toEqual({ jobs: [f.job] });
  expect(f.calls).toEqual([
    { name: 'quote', args: ['owner', 'draft-1', input, key], workspace: 'workspace' },
    { name: 'rehearsal', args: ['owner'], workspace: 'workspace' },
    { name: 'quote', args: ['owner', 'rehearsal-draft', input, key], workspace: 'workspace' },
    { name: 'submit', args: [{ userId: 'owner', draftId: 'draft-1', id: key }, submit], workspace: 'workspace' },
    { name: 'status', args: [{ userId: 'owner', draftId: 'draft-1', id: key }], workspace: 'workspace' },
    { name: 'list', args: ['owner', 'draft-1'], workspace: 'workspace' },
    { name: 'list', args: ['owner', undefined], workspace: 'workspace' },
  ]);
  expect(f.limits).toEqual(bodies.map(body => [`hf-consumer-video:workspace:owner:${body.action}`, body.action === 'status' ? 30 : 6, 60_000]));
});

test('strict action schemas reject caller identities, provider overrides and malformed bounds before service/rate access', async () => {
  const f = await fixture();
  const malformed = [null, [], {}, { ...quote, action: 'generate' }, { ...quote, userId: 'other' }, { ...quote, workspaceId: wallet },
    { ...quote, draftId: '../foreign' }, { ...quote, draftId: 'x'.repeat(201) }, { ...quote, idempotencyKey: 'not-a-uuid' },
    /* FINAL_SPEC §2.1: medias and durations ≥ 4 are part of the contract now; a malformed media, a role the model lacks, and out-of-range durations are still refused here. */
    ...[{ model: 'other' }, { get_cost: false }, { use_unlim: true }, { medias: [{ id: 'not-a-uuid', role: 'image' }] }, { medias: [{ id: '11111111-1111-4111-8111-111111111111', role: 'poster' }] },
      { hookId: 'h1', adReferenceId: 'r1' }, { productIds: ['p1'], webProductIds: ['w1'] }, { prompt: ' ' }, { prompt: 'a'.repeat(5001) },
      { duration: 3 }, { duration: 121 }, { duration: 12.5 }, { duration: '15' }, { resolution: '4k' }, { aspectRatio: 'bogus' }, { generateAudio: 'true' }]
      .map(patch => ({ ...quote, input: { ...input, ...patch } })),
    { ...submit, credits: -1 }, { ...submit, credits: 100001 }, { ...submit, credits: '10' }, { ...submit, workspaceId: 'bad' },
    { ...submit, id: 'bad' }, { ...submit, input }, { ...status, tool: 'generate_video' },
    { action: 'quote-rehearsal', idempotencyKey: key, input }, { action: 'quote-rehearsal', idempotencyKey: key, draftId: 'foreign' }];
  for (const body of malformed) expect((await f.request('POST', body)).status, JSON.stringify(body).slice(0, 180)).toBe(400);
  for (const id of ['', '../other', 'a'.repeat(201)]) expect((await f.request('GET', undefined, { query: `?draftId=${encodeURIComponent(id)}` })).status).toBe(400);
  expect(f.calls).toEqual([]); expect(f.limits).toEqual([]);
});

test('JSON and wire-byte validation returns 400 or 413 without admitting a service request', async () => {
  const f = await fixture();
  for (const raw of ['{broken', '', '{"action":', '{"input":"secret-marker"']) {
    const response = await f.request('POST', undefined, { raw });
    expect(response.status).toBe(400); expect(await response.text()).not.toContain('secret-marker');
  }
  expect((await f.request('POST', undefined, { empty: true })).status).toBe(400);
  expect((await f.request('POST', undefined, { raw: new Uint8Array([0xc3, 0x28]) })).status).toBe(400);
  for (const options of [{ contentLength: '24001' }, { raw: ' '.repeat(24001), contentLength: '1' }, { raw: `"${'😀'.repeat(6000)}"` }])
    expect((await f.request('POST', quote, options)).status).toBe(413);
  expect(f.calls).toEqual([]); expect(f.limits).toEqual([]);
});

test('suspended owners cannot dispatch but can review saved jobs; rate limits precede service calls', async () => {
  const f = await fixture(), original = f.store();
  f.setStore({ ...original, workspace: { ...original.workspace!, suspendedAt: 1, suspendedReason: 'Paused' } });
  expect((await f.request('POST', submit)).status).toBe(423);
  expect(f.calls).toEqual([]);
  expect((await f.request('POST', status)).status).toBe(200);
  expect(f.calls.map(call => call.name)).toEqual(['status']);
  f.setStore(original); f.limit();
  for (const body of [quote, { action: 'quote-rehearsal', idempotencyKey: key }, submit, status]) {
    const response = await f.request('POST', body);
    expect(response.status).toBe(429); expect(await response.text()).not.toContain('private limit detail');
  }
  expect(f.calls.map(call => call.name)).toEqual(['status']);
});

test('known failures preserve actionable status while unknown service details remain private', async () => {
  const f = await fixture();
  for (const [error, status] of [[new ConsumerOAuthError('reconnect_required'), 401], [new ConsumerDiscoveryError('timeout'), 504],
    [new ConsumerJobError('quote_expired'), 409], [new ConsumerJobError('capacity'), 409], [new contract.ConsumerVideoError('quote_changed'), 409],
    [new Error('private provider token and response'), 503]] as const) {
    f.fail(error);
    const response = await f.request('POST', quote);
    expect(response.status).toBe(status);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await response.text()).not.toContain('private provider token');
  }
});

test('original collection errors remain recoverable and expose only fixed safe categories', async () => {
  const f = await fixture();
  for (const [code, http] of [['quota',507],['busy',409],['conflict',409],['deleted',409],['invalid_video',422],['timeout',504],['storage_unavailable',503],['not_found',404]] as const) {
    const error = new ConsumerOriginalError(code);
    Object.assign(error, { cause: new Error('PRIVATE_URL_AND_TOKEN') });
    f.fail(error);
    const response = await f.request('POST', status);
    expect(response.status).toBe(http);
    expect(await response.json()).toEqual({ code: `original_${code}`, error: error.message });
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  }
});

test('a marketing quote naming an account product, avatar or ad reference Particl did not make is refused before it is priced', async () => {
  const f = await fixture();
  for (const extra of [{ productIds: ['acct_p1'] }, { avatars: [{ id: 'acct_a1', type: 'preset' }] }, { adReferenceId: 'acct_r1', mode: 'ugc' }]) {
    const response = await f.request('POST', { ...quote, input: { ...input, mode: 'ugc', ...extra } }, { origin: 'https://particl.example' });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ code: 'setup_not_particl', error: new records.ConsumerSetupError().message });
  }
  expect(f.calls).toEqual([]);
  const made = await f.request('POST', { ...quote, input: { ...input, mode: 'ugc', productIds: ['made_p1'], avatars: [{ id: 'soul_a', type: 'custom' }] } }, { origin: 'https://particl.example' });
  expect(made.status).toBe(200);
  expect(f.guarded.at(-1)).toEqual({ userId: 'owner', workspace: 'workspace', wanted: { product: ['made_p1'], avatar: ['soul_a'], brand_kit: [], ad_reference: [] } });
  /* The fixed rehearsal names no setup item and is never guarded. */
  const before = f.guarded.length;
  expect((await f.request('POST', { action: 'quote-rehearsal', idempotencyKey: key }, { origin: 'https://particl.example' })).status).toBe(200);
  expect(f.guarded.length).toBe(before);
});
