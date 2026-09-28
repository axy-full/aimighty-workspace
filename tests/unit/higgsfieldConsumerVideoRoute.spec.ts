import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { websiteRouteModules } from '../helpers/websiteRouteAccess';
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
/** Whether the platform's website tools can take this work now (a managed workspace). */
let platformAvailable = true;
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
    /* The one neutral mapping every consumer route shares for the platform's website account. */
    '@/lib/higgsfield-consumer/website-problems': await import('../../lib/higgsfield-consumer/website-problems'),
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
  // The real route guard, read budget and neutral refusals, over this fixture's session, tenant and rate recorder.
  Object.assign(deps, await websiteRouteModules({ auth: deps['@/lib/auth'], tenant, accountDb: deps['@/lib/accountDb'], available: () => platformAvailable }));
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

test('the quote service\'s standalone refusal answers 409 setup_not_particl with its own safe words', async () => {
  const f = await fixture();
  f.fail(Object.assign(new records.ConsumerSetupError(), { cause: new Error('PRIVATE_ACCOUNT_DETAIL') }));
  const response = await f.request('POST', { ...quote, input: { ...input, mode: 'ugc', productIds: ['acct_p1'] } }, { origin: 'https://particl.example' });
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ code: 'setup_not_particl', error: new records.ConsumerSetupError().message });
  expect(f.calls.map((call) => call.name)).toEqual(['quote']);
});

test('a platform job is approved by its credits alone, and website refusals answer neutrally', async () => {
  const f = await fixture();
  const approval = { action: 'submit', draftId: 'draft-1', id: key, credits: 25 };
  expect((await f.request('POST', approval)).status).toBe(200);
  expect((await f.request('POST', { ...approval, workspaceId: null })).status).toBe(200);
  expect(f.calls.map((call) => call.args[1])).toEqual([
    { action: 'submit', draftId: 'draft-1', id: key, credits: 25 },
    { action: 'submit', draftId: 'draft-1', id: key, credits: 25, workspaceId: null },
  ]);
  const { WebsiteToolsUnavailableError } = await import('../../lib/higgsfield-consumer/platform-account');
  const { WebsitePriceChangedError } = await import('../../lib/higgsfield-consumer/account-billing');
  const { ForeignAccountObjectError } = await import('../../lib/higgsfield-consumer/account-objects');
  const { SpendReservationError } = await import('../../lib/generationRequests');
  for (const [error, status, code] of [
    [new WebsiteToolsUnavailableError('account_changed'), 503, 'website_unavailable'],
    [new WebsiteToolsUnavailableError('busy'), 503, 'website_unavailable'],
    [new WebsitePriceChangedError(), 409, 'price_changed'],
    [new ForeignAccountObjectError(), 409, 'object_not_particl'],
    [new SpendReservationError('This job needs 25 credits; 3 are available after reserved jobs.', 402), 402, 'reservation_refused'],
  ] as const) {
    f.fail(error);
    const refused = await f.request('POST', approval);
    expect(refused.status).toBe(status);
    const body = await refused.json();
    expect(body.code).toBe(code);
    expect(JSON.stringify(body)).not.toMatch(/account_changed|wallet|subject|generation/);
  }
});

test('a managed workspace: any signed-in member quotes, approves and follows their own jobs on the platform website tools; tokens never', async () => {
  const f = await fixture(), original = f.store();
  const member = { ...original, workspace: { ...original.workspace!, usesPlatformKeys: true }, user: { ...original.user!, id: 'member', role: 'member', owner: false } } as tenant.TenantStore;
  const memberScope = workbenchScopeFor('workspace', 'member');
  f.setStore(member);
  // The page learns only whether the website tools can take this work now.
  platformAvailable = false;
  let listing = await f.request('GET', undefined, { scope: memberScope, query: '?draftId=draft-1' });
  expect(listing.status).toBe(200);
  expect(await listing.json()).toEqual({ jobs: [f.job], websiteTools: { managed: true, available: false } });
  platformAvailable = true;
  listing = await f.request('GET', undefined, { scope: memberScope, query: '?draftId=draft-1' });
  expect(await listing.json()).toEqual({ jobs: [f.job], websiteTools: { managed: true, available: true } });
  // Approved by credits alone, no wallet named.
  const approve = { action: 'submit', draftId: 'draft-1', id: key, credits: 25 };
  for (const body of [quote, approve, status, { action: 'setup', types: ['hook'] }])
    expect((await f.request('POST', body, { scope: memberScope })).status, body.action).toBe(200);
  expect(f.calls.map(call => [call.name, call.args[0]])).toEqual([
    ['list', 'member'], ['list', 'member'], ['quote', 'member'], ['submit', { userId: 'member', draftId: 'draft-1', id: key }], ['status', { userId: 'member', draftId: 'draft-1', id: key }], ['setup', 'member'],
  ]);
  // Setup reads with the grant a quote would use: the platform's account.
  expect(f.calls.at(-1)!.args[2]).toEqual({ kind: 'platform_account', tool: null });
  // Every account-reading action draws on the shared account's one read budget.
  expect(f.limits.filter(limit => limit[0] === 'hf-website-account:reads')).toEqual(Array(4).fill(['hf-website-account:reads', 120, 60_000]));
  // The owner's own connection check stays the owner's; API tokens never run website tools.
  expect((await f.request('POST', { action: 'quote-rehearsal', idempotencyKey: key }, { scope: memberScope })).status).toBe(403);
  for (const tokenScope of ['read', 'render'] as const) {
    f.setStore({ ...member, token: { id: 'api-token', name: 'Fixture', scope: tokenScope, capUsd: null } });
    for (const method of ['GET', 'POST'] as const) expect((await f.request(method, quote, { scope: null })).status).toBe(403);
  }
  // A suspended workspace neither quotes nor approves; its saved jobs stay readable.
  f.setStore({ ...member, workspace: { ...member.workspace!, suspendedAt: 1, suspendedReason: 'Paused' } });
  for (const body of [quote, approve]) expect((await f.request('POST', body, { scope: memberScope })).status).toBe(423);
  expect((await f.request('POST', status, { scope: memberScope })).status).toBe(200);
  // The workspace's own four-job limit, in the words its funding calls for.
  f.setStore(member);
  f.fail(new ConsumerJobError('capacity', 429));
  const refused = await f.request('POST', quote, { scope: memberScope });
  expect(refused.status).toBe(429);
  const body = await refused.json();
  expect(body.error).toBe('Four website-tool jobs are already running in this workspace. Try again when one finishes.');
  expect(JSON.stringify(body)).not.toMatch(/connected|Engines/);
  // The account's own refusals (its wallet, its price, its tools) read neutrally; input the member can fix still says so.
  for (const [error, status, code] of [
    [new contract.ConsumerVideoError('insufficient_credits'), 503, 'website_unavailable'],
    [new contract.ConsumerVideoError('workspace_changed'), 503, 'website_unavailable'],
    [new contract.ConsumerVideoError('preflight_unavailable'), 503, 'website_unavailable'],
    [new contract.ConsumerVideoError('quote_changed'), 409, 'price_changed'],
    [new ConsumerDiscoveryError('protocol_error'), 503, 'website_unavailable'],
    [new contract.ConsumerVideoError('invalid_input'), 400, 'invalid_input'],
  ] as const) {
    f.fail(error);
    const answer = await f.request('POST', quote, { scope: memberScope });
    expect([answer.status, (await answer.clone().json()).code], error.code).toEqual([status, code]);
    if (code !== 'invalid_input') expect(await answer.text()).not.toMatch(/connected|wallet|workspace has/i);
  }
});
