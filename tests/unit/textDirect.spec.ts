import { test, expect } from '@playwright/test';
import { generateText } from 'ai';
import { gatewayPost, explainGatewayFailure, GATEWAY_URL } from '../../lib/gateway';
import { languageAuth, languageModel } from '../../lib/language-provider';
import { directTextCostUsd, TEXT_PROVIDER_HEADER, textVendor } from '../../lib/openai-direct';
import { VERIFIED_TEXT_MODEL_IDS } from '../../lib/atomikModelPolicy';
import { atomikReasoningRequest } from '../../lib/atomik-reasoning';
import { directTextRequest, directTextUsage, textPost } from '../../lib/textDirect';
import { DIRECT_MODEL_IDS, UNMAPPED_DIRECT_MODEL_IDS, directFetch, directModelId, textRoute } from '../../lib/textRoute';
import { textDirectVendors } from '../../lib/textDirectVendors';
import type { CatalogModel } from '../../lib/catalog';

/* Every provider call in this file goes to a stubbed fetch. Keys are fixtures and never leave the process. */
const KEYS = { ANTHROPIC_API_KEY: 'test-anthropic-key-never-sent', GEMINI_API_KEY: 'test-gemini-key-never-sent', XAI_API_KEY: 'test-xai-key-never-sent', AI_GATEWAY_API_KEY: 'test-gateway-key-never-sent' };
const ENV = ['ENGINE_MOCK', 'TEXT_DIRECT', 'OPENAI_API_KEY', 'ANTHROPIC_BASE_URL', ...Object.keys(KEYS)] as const;
const saved = Object.fromEntries(ENV.map(name => [name, process.env[name]]));
const originalFetch = globalThis.fetch;
test.beforeEach(() => {
  for (const name of ENV) delete process.env[name];
  Object.assign(process.env, KEYS);
  globalThis.fetch = async () => { throw new Error('No real provider call is allowed in this test.'); };
});
test.afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const name of ENV) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; }
});

type Call = { url: string; init?: RequestInit; headers: Headers; body: Record<string, unknown> };
function stub(reply: () => Response) {
  const calls: Call[] = [];
  const fetch: typeof globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init, headers: new Headers(init?.headers), body: init?.body ? JSON.parse(String(init.body)) : {} });
    return reply();
  };
  return { calls, fetch };
}

const anthropicReply = (text = '{"ok":true}') => ({ id: 'msg_fixture', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null,
  usage: { input_tokens: 100, cache_creation_input_tokens: 40, cache_read_input_tokens: 60, output_tokens: 25 } });
const googleReply = (text = '{"ok":true}') => ({ candidates: [{ content: { parts: [{ text }], role: 'model' }, finishReason: 'STOP', index: 0 }],
  usageMetadata: { promptTokenCount: 200, candidatesTokenCount: 30, thoughtsTokenCount: 50, cachedContentTokenCount: 120, totalTokenCount: 280 }, modelVersion: 'gemini-2.5-flash', responseId: 'resp_google_fixture' });
const xaiReply = (text = '{"ok":true}') => ({ id: 'resp_xai_fixture', object: 'response', created_at: 1, model: 'grok-4.6', status: 'completed',
  output: [{ type: 'message', id: 'msg_xai_fixture', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }],
  usage: { input_tokens: 150, input_tokens_details: { cached_tokens: 100 }, output_tokens: 40, output_tokens_details: { reasoning_tokens: 30 }, total_tokens: 190, cost_in_usd_ticks: 12345 } });

const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };
const picture = 'data:image/png;base64,iVBORw0KGgo=';
const body = (model: string, extra: Record<string, unknown> = {}) => JSON.stringify({
  model, max_tokens: 4000, ...extra,
  messages: [{ role: 'system', content: 'Inspect the references.' }, { role: 'user', content: [{ type: 'text', text: 'Review.' }, { type: 'image_url', image_url: { url: picture, detail: 'low' } }] }],
});

test('TEXT_DIRECT empty keeps every non-OpenAI model on the gateway, unchanged', async () => {
  expect(textDirectVendors().size).toBe(0);
  for (const model of ['anthropic/claude-sonnet-4.6', 'google/gemini-2.5-flash', 'spacexai/grok-4.6']) {
    expect(textRoute(model)).toBe('gateway'); expect(textVendor(model)).toBe('gateway');
    expect(await languageAuth(model)).toEqual({ Authorization: `Bearer ${KEYS.AI_GATEWAY_API_KEY}`, [TEXT_PROVIDER_HEADER]: 'gateway' });
  }
  const sent: { url: string; body: string; auth: string | null }[] = [];
  globalThis.fetch = async (url, init) => { sent.push({ url: String(url), body: String(init?.body), auth: new Headers(init?.headers).get('authorization') }); return Response.json({ choices: [{ message: { content: 'ok' } }], usage: { cost: 0.001 } }); };
  const raw = body('anthropic/claude-sonnet-4.6');
  const reply = await textPost(raw, { auth: await languageAuth('anthropic/claude-sonnet-4.6') });
  expect(reply.ok).toBe(true); expect(JSON.parse(reply.text).usage.cost).toBe(0.001);
  // Byte-identical body, gateway URL, gateway key: today's path.
  expect(sent).toEqual([{ url: GATEWAY_URL(), body: raw, auth: `Bearer ${KEYS.AI_GATEWAY_API_KEY}` }]);
  // Switching one vendor on leaves the others where they were.
  process.env.TEXT_DIRECT = 'google, unknown';
  expect([...textDirectVendors()]).toEqual(['google']);
  expect(textRoute('anthropic/claude-sonnet-4.6')).toBe('gateway'); expect(textRoute('google/gemini-2.5-flash')).toBe('google');
});

test('every offered Claude, Gemini and Grok id is mapped explicitly or listed as unmapped', () => {
  const unmapped = new Set<string>(UNMAPPED_DIRECT_MODEL_IDS);
  for (const id of VERIFIED_TEXT_MODEL_IDS.filter(id => !id.startsWith('openai/'))) {
    expect(Object.hasOwn(DIRECT_MODEL_IDS, id) !== unmapped.has(id), id).toBe(true);
  }
  expect(directModelId('anthropic/claude-sonnet-4.6')).toBe('claude-sonnet-4-6');
  expect(directModelId('anthropic/claude-haiku-4.5')).toBe('claude-haiku-4-5');
  expect(directModelId('spacexai/grok-4.7')).toBe('grok-4.7');
  expect(directModelId('xai/grok-4.7')).toBe('grok-4.7');
  for (const id of UNMAPPED_DIRECT_MODEL_IDS) expect(() => directModelId(id)).toThrow('no direct provider model');
  expect(() => directModelId('anthropic/claude-sonnet-9')).toThrow('no direct provider model');
});

test('Anthropic: request and reply fixture through the SDK, cache tokens in usage, no cost', async () => {
  process.env.TEXT_DIRECT = 'anthropic';
  const model = 'anthropic/claude-sonnet-4.6';
  const auth = await languageAuth(model);
  expect(auth[TEXT_PROVIDER_HEADER]).toBe('anthropic');
  const { calls, fetch } = stub(() => Response.json(anthropicReply()));
  const reply = await textPost(body(model, { response_format: { type: 'json_schema', json_schema: { name: 'proposal', strict: true, schema } }, providerOptions: { gateway: { only: ['anthropic'] } } }), { auth, fetch });
  expect(calls).toHaveLength(1);
  const [call] = calls;
  expect(call.url).toBe('https://api.anthropic.com/v1/messages');
  expect(call.headers.get('x-api-key')).toBe(KEYS.ANTHROPIC_API_KEY);
  expect(call.headers.get('authorization')).toBeNull(); expect(call.headers.get(TEXT_PROVIDER_HEADER)).toBeNull();
  expect(call.init?.redirect).toBe('error');
  expect(call.body).toMatchObject({ model: 'claude-sonnet-4-6', max_tokens: 4000, system: [{ type: 'text', text: 'Inspect the references.' }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Review.' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } }] }],
    output_config: { format: { type: 'json_schema', schema } } });
  expect(JSON.stringify(call.body)).not.toContain('gateway');
  expect(reply.ok).toBe(true);
  const json = JSON.parse(reply.text);
  expect(json).toMatchObject({ provider: 'anthropic', model: 'claude-sonnet-4-6', choices: [{ index: 0, message: { role: 'assistant', content: '{"ok":true}' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 200, completion_tokens: 25, prompt_tokens_details: { cached_tokens: 60, cache_write_tokens: 40 } } });
  expect(json.usage).not.toHaveProperty('cost'); expect(json).not.toHaveProperty('cost');
  // What PR 3 will bill: uncached input, cache reads and cache writes each at their own price.
  const priced = { id: model, owner: 'anthropic', name: 'Sonnet', type: 'language', description: '', contextWindow: 1000000, maxTokens: 128000, pricing: { input: .000003, output: .000015, input_cache_read: .0000003, input_cache_write: .00000375 } } as CatalogModel;
  expect(directTextCostUsd(priced, json.usage)).toBeCloseTo(100 * .000003 + 60 * .0000003 + 40 * .00000375 + 25 * .000015, 12);
});

test('Google: request and reply fixture, thought tokens billed as output, cached tokens inside the prompt', async () => {
  process.env.TEXT_DIRECT = 'google';
  const model = 'google/gemini-2.5-flash';
  const { calls, fetch } = stub(() => Response.json(googleReply()));
  const reply = await textPost(body(model, { response_format: { type: 'json_object' }, providerOptions: { google: { thinkingConfig: { thinkingLevel: 'low' } }, vertex: { thinkingConfig: { thinkingLevel: 'low' } } } }), { auth: await languageAuth(model), fetch });
  expect(calls).toHaveLength(1);
  const [call] = calls;
  expect(call.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
  expect(call.headers.get('x-goog-api-key')).toBe(KEYS.GEMINI_API_KEY); expect(call.init?.redirect).toBe('error');
  expect(call.body).toMatchObject({ systemInstruction: { parts: [{ text: 'Inspect the references.' }] },
    contents: [{ role: 'user', parts: [{ text: 'Review.' }, { inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgo=' } }] }],
    generationConfig: { maxOutputTokens: 4000, responseMimeType: 'application/json', thinkingConfig: { thinkingLevel: 'low' } } });
  expect(JSON.stringify(call.body)).not.toContain('vertex');
  const json = JSON.parse(reply.text);
  expect(json).toMatchObject({ provider: 'google', choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 200, completion_tokens: 80, prompt_tokens_details: { cached_tokens: 120, cache_write_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 50 } } });
  expect(json.usage).not.toHaveProperty('cost');
});

test('xAI: request and reply fixture on the Responses endpoint, ticks kept only for comparison', async () => {
  process.env.TEXT_DIRECT = 'xai';
  const model = 'spacexai/grok-4.6';
  const { calls, fetch } = stub(() => Response.json(xaiReply()));
  const reply = await textPost(body(model, { reasoning_effort: 'high' }), { auth: await languageAuth(model), fetch });
  expect(calls).toHaveLength(1);
  const [call] = calls;
  expect(call.url).toBe('https://api.x.ai/v1/responses');
  expect(call.headers.get('authorization')).toBe(`Bearer ${KEYS.XAI_API_KEY}`); expect(call.init?.redirect).toBe('error');
  expect(call.body).toMatchObject({ model: 'grok-4.6', max_output_tokens: 4000, reasoning: { effort: 'high' } });
  expect(JSON.stringify(call.body)).toContain('iVBORw0KGgo=');
  const json = JSON.parse(reply.text);
  expect(json).toMatchObject({ provider: 'xai', choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 150, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 100, cache_write_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 30 } },
    provider_usage: { cost_in_usd_ticks: 12345 } });
  expect(json.usage).not.toHaveProperty('cost');
});

test('reasoning maps to each provider\'s native options', () => {
  const base = { messages: [{ role: 'user', content: 'Hi.' }], max_tokens: 9000 };
  const claude = (id: string, fields: Record<string, unknown>) => directTextRequest('anthropic', { model: id, ...base, ...fields });
  // budget:N → enabled thinking; max_tokens drops by the budget because the SDK adds it back on the wire.
  expect(claude('anthropic/claude-sonnet-4.5', { reasoning: { enabled: true, max_tokens: 4096 } })).toMatchObject({ maxOutputTokens: 4904, providerOptions: { anthropic: { thinking: { type: 'enabled', budgetTokens: 4096 } } } });
  expect(claude('anthropic/claude-sonnet-4.6', { reasoning: { enabled: false } }).providerOptions).toEqual({ anthropic: { thinking: { type: 'disabled' } } });
  expect(claude('anthropic/claude-opus-4.6', { reasoning_effort: 'medium' }).providerOptions).toEqual({ anthropic: { effort: 'medium', thinking: { type: 'adaptive' } } });
  expect(claude('anthropic/claude-opus-4.5', { reasoning_effort: 'low' }).providerOptions).toEqual({ anthropic: { effort: 'low' } });
  // Opus 5 max arrives as native options; the gateway's routing hint is dropped.
  const opus = { id: 'anthropic/claude-opus-5', owner: 'anthropic', name: 'Opus 5', type: 'language', description: '', maxTokens: 128000, reasoningOptions: [{ type: 'effort', values: ['low', 'medium', 'high', 'xhigh', 'max'] }], tags: ['reasoning'] } as CatalogModel;
  const max = atomikReasoningRequest(opus, 'max', 4000);
  expect(claude(opus.id, { providerOptions: max.providerOptions, max_tokens: max.maxTokens }).providerOptions).toEqual({ anthropic: { thinking: { type: 'adaptive' }, effort: 'max' } });
  expect(() => claude('anthropic/claude-opus-4.6', { reasoning_effort: 'minimal' })).toThrow('not available');
  expect(() => claude('anthropic/claude-sonnet-4.5', { reasoning: { enabled: true, max_tokens: 9000 } })).toThrow('room for the answer');

  const gemini = (fields: Record<string, unknown>) => directTextRequest('google', { model: 'google/gemini-2.5-flash', ...base, ...fields });
  expect(gemini({ reasoning: { enabled: false } })).toMatchObject({ maxOutputTokens: 9000, providerOptions: { google: { thinkingConfig: { thinkingBudget: 0 } } } });
  expect(gemini({ reasoning: { enabled: true, max_tokens: 2048 } })).toMatchObject({ maxOutputTokens: 9000, providerOptions: { google: { thinkingConfig: { thinkingBudget: 2048 } } } });
  expect(gemini({ providerOptions: { google: { thinkingConfig: { thinkingLevel: 'medium' } }, vertex: { x: 1 }, gateway: { only: ['google'] } } }).providerOptions).toEqual({ google: { thinkingConfig: { thinkingLevel: 'medium' } } });

  const grok = (fields: Record<string, unknown>) => directTextRequest('xai', { model: 'spacexai/grok-4.6', ...base, ...fields });
  expect(grok({ reasoning_effort: 'low' }).providerOptions).toEqual({ xai: { reasoningEffort: 'low' } });
  expect(grok({}).providerOptions).toEqual({});
  expect(() => grok({ reasoning: { enabled: true, max_tokens: 1024 } })).toThrow('not available');
});

test('Anthropic budget thinking keeps the approved max_tokens on the wire', async () => {
  process.env.TEXT_DIRECT = 'anthropic';
  const model = 'anthropic/claude-sonnet-4.5';
  const { calls, fetch } = stub(() => Response.json({ ...anthropicReply('Done.'), model: 'claude-sonnet-4-5' }));
  await textPost(JSON.stringify({ model, max_tokens: 9000, temperature: .4, reasoning: { enabled: true, max_tokens: 4096 }, messages: [{ role: 'user', content: 'Hi.' }] }), { auth: await languageAuth(model), fetch });
  expect(calls[0].body).toMatchObject({ model: 'claude-sonnet-4-5', max_tokens: 9000, thinking: { type: 'enabled', budget_tokens: 4096 } });
  expect(calls[0].body).not.toHaveProperty('temperature');
});

test('usage maps from the provider\'s raw usage; an unreported count stays unknown', () => {
  expect(directTextUsage('anthropic', { raw: { input_tokens: 10, cache_read_input_tokens: null, cache_creation_input_tokens: 5, output_tokens: 3 } })).toEqual({ prompt_tokens: 15, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 5 } });
  expect(directTextUsage('anthropic', { raw: { input_tokens: 10, output_tokens: 3 } })).toMatchObject({ prompt_tokens: undefined, prompt_tokens_details: { cached_tokens: undefined, cache_write_tokens: undefined } });
  expect(directTextUsage('google', { raw: { promptTokenCount: 50, toolUsePromptTokenCount: 5, candidatesTokenCount: 7 } })).toEqual({ prompt_tokens: 55, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 0 } });
  expect(directTextUsage('google', { raw: {} }).prompt_tokens).toBeUndefined();
  expect(directTextUsage('xai', { raw: { input_tokens: 20, output_tokens: 4 } })).toEqual({ prompt_tokens: 20, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } });
  expect(directTextUsage('xai', { raw: undefined }).completion_tokens).toBeUndefined();
});

test('a missing key fails before sending and names the variable; no fallback to the gateway', async () => {
  process.env.TEXT_DIRECT = 'anthropic,google,xai';
  for (const [model, name] of [['anthropic/claude-sonnet-4.6', 'ANTHROPIC_API_KEY'], ['google/gemini-2.5-flash', 'GEMINI_API_KEY'], ['spacexai/grok-4.6', 'XAI_API_KEY']]) {
    delete process.env[name];
    await expect(languageAuth(model)).rejects.toThrow(name);
    expect(() => languageModel(model, { auth: {} })).toThrow(name);
    const { calls, fetch } = stub(() => Response.json({}));
    globalThis.fetch = fetch;
    const reply = await textPost(body(model), { fetch });
    expect(reply).toMatchObject({ ok: false, status: 422 }); expect(JSON.parse(reply.text).error.message).toContain(name);
    expect(calls).toHaveLength(0);
  }
});

test('an unmapped model is refused before sending', async () => {
  process.env.TEXT_DIRECT = 'anthropic';
  const { calls, fetch } = stub(() => Response.json(anthropicReply()));
  const reply = await textPost(body('anthropic/claude-opus-5-fast'), { fetch });
  expect(reply).toMatchObject({ ok: false, status: 422 }); expect(calls).toHaveLength(0);
});

test('the fetch guard refuses a foreign origin or another endpoint and forbids redirects', async () => {
  const { calls, fetch } = stub(() => new Response('{}'));
  for (const [vendor, url] of [['anthropic', 'https://evil.example/v1/messages'], ['anthropic', 'https://api.anthropic.com/v1/files'], ['google', 'https://generativelanguage.googleapis.com.evil.example/v1beta/models/gemini-2.5-flash:generateContent'], ['google', 'https://generativelanguage.googleapis.com/v1beta/files'], ['xai', 'http://api.x.ai/v1/responses'], ['xai', 'https://api.x.ai/v1/images/generations']] as const)
    expect(() => directFetch(vendor, fetch)(url, { method: 'POST' })).toThrow('not supported');
  expect(calls).toHaveLength(0);
  await directFetch('xai', fetch)('https://api.x.ai/v1/responses', { method: 'POST', redirect: 'follow' });
  expect(calls[0].init?.redirect).toBe('error');

  // A base URL from the environment cannot move the Anthropic key elsewhere.
  process.env.TEXT_DIRECT = 'anthropic'; process.env.ANTHROPIC_BASE_URL = 'https://evil.example/v1';
  const anthropic = stub(() => Response.json(anthropicReply()));
  await textPost(body('anthropic/claude-sonnet-4.6'), { fetch: anthropic.fetch });
  expect(anthropic.calls.map(call => call.url)).toEqual(['https://api.anthropic.com/v1/messages']);

  // A redirect makes fetch throw once the request is out: uncertain, so it surfaces as an error, never a retry.
  let sent = 0;
  const redirecting: typeof globalThis.fetch = async (_url, init) => { sent++; if (init?.redirect === 'error') throw new TypeError('fetch failed: unexpected redirect'); return Response.redirect('https://evil.example/', 307); };
  await expect(textPost(body('anthropic/claude-sonnet-4.6'), { fetch: redirecting })).rejects.toThrow();
  expect(sent).toBe(1);
});

test('a provider refusal returns its status once, with account wording, and is never retried', async () => {
  process.env.TEXT_DIRECT = 'anthropic';
  const { calls, fetch } = stub(() => Response.json({ type: 'error', error: { type: 'rate_limit_error', message: 'Fixture rate limit.' } }, { status: 429 }));
  const reply = await textPost(body('anthropic/claude-sonnet-4.6'), { fetch });
  expect(reply).toMatchObject({ ok: false, status: 429 }); expect(calls).toHaveLength(1);
  expect(explainGatewayFailure(reply.status, reply.text)).toContain('rate or usage limit');
});

test('a direct vendor never reaches the gateway, by any path', async () => {
  process.env.TEXT_DIRECT = 'anthropic';
  let calls = 0; globalThis.fetch = async () => { calls++; throw new Error('must not send'); };
  const model = 'anthropic/claude-sonnet-4.6';
  await expect(gatewayPost(body(model))).rejects.toThrow('routed to its provider directly');
  // An approval issued for the gateway no longer matches once the vendor is switched on.
  await expect(textPost(body(model), { auth: { Authorization: 'Bearer x', [TEXT_PROVIDER_HEADER]: 'gateway' } })).rejects.toThrow('connection changed');
  expect(calls).toBe(0);
});

test('SDK callers get the provider\'s own model with the guard and the mapped id', async () => {
  process.env.TEXT_DIRECT = 'google';
  const model = 'google/gemini-3-flash';
  const { calls, fetch } = stub(() => Response.json(googleReply('Hello.')));
  const selected = languageModel(model, { auth: await languageAuth(model), fetch });
  const result = await generateText({ model: selected, prompt: 'Hi.', maxOutputTokens: 100, maxRetries: 0 });
  expect(result.text).toBe('Hello.');
  expect(calls.map(call => call.url)).toEqual(['https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent']);
  expect(directTextUsage('google', result.steps[0].usage)).toMatchObject({ prompt_tokens: 200, completion_tokens: 80 });
});
