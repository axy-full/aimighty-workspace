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
import * as retired from '../../lib/higgsfield-consumer/retired';
import { crossOriginProblem } from '../../lib/requestOrigin';

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
  new Function('exports', 'resolveStore', 'runWithStore', 'NoTenantError', 'MediaSourceError', 'workbenchScopeFor', 'recoveryRoute', 'crossOriginProblem', compile(statement.getText(source)))(
    wrapped, async () => store, tenant.runWithStore, tenant.NoTenantError, MediaSourceError, workbenchScopeFor, (handler: unknown) => handler, crossOriginProblem,
  );
  const calls: { name: string; args: unknown[]; workspace: string }[] = [];
  const limits: unknown[][] = [];
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
    /* The standalone guard runs inside the quote service (tests/unit/higgsfieldConsumerVideoService.spec.ts); the route maps its refusal. */
    '@/lib/higgsfield-consumer/marketing-records': { ConsumerSetupError: records.ConsumerSetupError },
    /* The handlers kept behind signInOff, as they ran before Release 1 (the switch itself: tests/unit/signinOffRelease1.spec.ts). */
    '@/lib/higgsfield-consumer/retired': { ...retired, signInOff: (kept: unknown) => kept },
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
    calls, limits, job, store: () => store, setStore: (value: tenant.TenantStore) => { store = value; },
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

async function expectRetired(response: Response) {
  expect(response.status).toBe(410);
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  expect(await response.json()).toEqual({ code: 'retired', error: retired.SIGN_IN_RETIRED_MESSAGE });
}
const setup = { action: 'setup', types: ['avatar', 'hook'] };

test('quote, rehearsal, submit and the setup read answer 410 before any limit or service; status and the saved jobs still reach the service', async () => {
  const f = await fixture();
  for (const body of [quote, { action: 'quote-rehearsal', idempotencyKey: key }, submit, setup, { action: 'setup' }])
    await expectRetired(await f.request('POST', body, { origin: 'https://particl.example' }));
  expect(f.calls).toEqual([]); expect(f.limits).toEqual([]);
  const polled = await f.request('POST', status, { origin: 'https://particl.example' });
  expect(polled.status).toBe(200);
  expect(polled.headers.get('Cache-Control')).toBe('private, no-store');
  expect(polled.headers.get('X-Content-Type-Options')).toBe('nosniff');
  expect(await polled.json()).toHaveProperty('job');
  expect((await f.request('GET', undefined, { query: '?draftId=draft-1&userId=other&workspaceId=other' })).status).toBe(200);
  const listing = await f.request('GET');
  expect(listing.status).toBe(200); expect(listing.headers.get('Cache-Control')).toBe('private, no-store');
  expect(await listing.json()).toEqual({ jobs: [f.job] });
  expect(f.calls).toEqual([
    { name: 'status', args: [{ userId: 'owner', draftId: 'draft-1', id: key }], workspace: 'workspace' },
    { name: 'list', args: ['owner', 'draft-1'], workspace: 'workspace' },
    { name: 'list', args: ['owner', undefined], workspace: 'workspace' },
  ]);
  expect(f.limits).toEqual([['hf-consumer-video:workspace:owner:status', 30, 60_000]]);
});

test('a stale tab\'s retired request gets the plain answer whatever its body; the status schema stays strict', async () => {
  const f = await fixture();
  const staleRetired = [{ ...quote, userId: 'other' }, { ...quote, idempotencyKey: 'not-a-uuid' }, { ...quote, input: { ...input, duration: 3 } },
    { ...submit, credits: -1 }, { ...submit, input }, { action: 'quote-rehearsal', idempotencyKey: key, draftId: 'foreign' }, { action: 'setup', types: ['bogus'] }];
  for (const body of staleRetired) await expectRetired(await f.request('POST', body));
  const malformed = [null, [], {}, { ...quote, action: 'generate' }, { ...status, tool: 'generate_video' }, { ...status, userId: 'other' }, { ...status, id: 'bad' }, { ...status, draftId: '../foreign' }];
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

test('a paused owner can still read a running job; limits block status, and a retired action never reaches the limits', async () => {
  const f = await fixture(), original = f.store();
  f.setStore({ ...original, workspace: { ...original.workspace!, suspendedAt: 1, suspendedReason: 'Paused' } });
  await expectRetired(await f.request('POST', submit));
  expect(f.calls).toEqual([]);
  expect((await f.request('POST', status)).status).toBe(200);
  expect(f.calls.map(call => call.name)).toEqual(['status']);
  f.setStore(original); f.limit();
  const limited = await f.request('POST', status);
  expect(limited.status).toBe(429); expect(await limited.text()).not.toContain('private limit detail');
  for (const body of [quote, { action: 'quote-rehearsal', idempotencyKey: key }, submit]) await expectRetired(await f.request('POST', body));
  expect(f.calls.map(call => call.name)).toEqual(['status']);
  expect(f.limits.map(args => args[0])).toEqual(['hf-consumer-video:workspace:owner:status', 'hf-consumer-video:workspace:owner:status']);
});

test('known failures preserve actionable status while unknown service details remain private', async () => {
  const f = await fixture();
  for (const [error, status] of [[new ConsumerOAuthError('reconnect_required'), 401], [new ConsumerDiscoveryError('timeout'), 504],
    [new ConsumerJobError('quote_expired'), 409], [new ConsumerJobError('capacity'), 409], [new contract.ConsumerVideoError('quote_changed'), 409],
    [new Error('private provider token and response'), 503]] as const) {
    f.fail(error);
    const response = await f.request('POST', { action: 'status', draftId: 'draft-1', id: key });
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
