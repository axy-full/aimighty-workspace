import { test, expect } from '@playwright/test';
import { generateText, tool } from 'ai';
import { z } from 'zod';
import { runInTenant, type TenantWorkspace } from '../../lib/tenant';
import { finalToolStep, languageAuth, languageModel } from '../../lib/language-provider';
import { openaiDirectPost } from '../../lib/openai-direct';
import { textPost } from '../../lib/textDirect';
import { ANTHROPIC_NO_TOOL_HEADER, DIRECT_MODEL_IDS, directModelId, textRouteWorks } from '../../lib/textRoute';
import { catalog, menuFor, routableTextModelIds } from '../../lib/catalog';
import { DEFAULT_TEXT_MODELS, TEXT_MODEL_IDS } from '../../lib/platformLayer';
import { ATOMIK_AUTO_MODEL_IDS, selectAtomikModel } from '../../lib/atomikModelPolicy';
import { ENHANCER_MODELS } from '../../lib/shell/enhancer';

/*
 * The exact request each direct text door sends (URL, header names, body), the
 * Anthropic error line, and the rule that a menu offers only models with a
 * working route. Every provider call goes to a stubbed fetch: the keys are
 * fixtures, header values are never asserted for a key, and nothing is sent.
 */
const KEYS = { ANTHROPIC_API_KEY: 'test-anthropic-key-never-sent', GEMINI_API_KEY: 'test-gemini-key-never-sent', XAI_API_KEY: 'test-xai-key-never-sent' };
const ENV = ['ENGINE_MOCK', 'TEXT_DIRECT', 'OPENAI_API_KEY', 'MODEL_CATALOG', 'AI_GATEWAY_API_KEY', 'VERCEL', 'VERCEL_OIDC_TOKEN', ...Object.keys(KEYS)] as const;
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

type Call = { url: string; headers: Headers; body: Record<string, unknown> };
function stub(reply: () => Response) {
  const calls: Call[] = [];
  const fetch: typeof globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), headers: new Headers(init?.headers), body: init?.body ? JSON.parse(String(init.body)) : {} });
    return reply();
  };
  return { calls, fetch };
}
const names = (headers: Headers) => [...headers.keys()].sort();

const anthropicReply = (text = '{"ok":true}') => ({ id: 'msg_fixture', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } });
const googleReply = { candidates: [{ content: { parts: [{ text: 'ok' }], role: 'model' }, finishReason: 'STOP', index: 0 }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 }, modelVersion: 'gemini-3.1-flash-lite', responseId: 'resp_google_fixture' };
const xaiReply = { id: 'resp_xai_fixture', object: 'response', created_at: 1, model: 'grok-4.20-0309-reasoning', status: 'completed',
  output: [{ type: 'message', id: 'msg_xai_fixture', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'ok', annotations: [] }] }], usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } };
const openaiReply = { id: 'resp_fixture', object: 'response', created_at: 1, model: 'gpt-5.5', status: 'completed', output: [{ type: 'message', id: 'msg_fixture', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'ok', annotations: [] }] }], usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 }, error: null, incomplete_details: null };
const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };
const chat = (model: string, extra: Record<string, unknown> = {}) => JSON.stringify({ model, max_tokens: 600, ...extra, messages: [{ role: 'system', content: 'Write briefly.' }, { role: 'user', content: 'A tree in rain.' }] });

test('Anthropic: the exact Messages request for Opus 5.5 — real id, effort with adaptive thinking, no sampling, JSON schema', async () => {
  process.env.TEXT_DIRECT = 'anthropic';
  const { calls, fetch } = stub(() => Response.json(anthropicReply()));
  const reply = await textPost(chat('anthropic/claude-opus-5.5', { temperature: 0.7, top_p: 0.9, reasoning_effort: 'low',
    response_format: { type: 'json_schema', json_schema: { name: 'proposal', strict: true, schema } } }), { auth: await languageAuth('anthropic/claude-opus-5.5'), fetch });
  expect(reply.ok).toBe(true);
  expect(calls).toHaveLength(1);
  expect(calls[0].url).toBe('https://api.anthropic.com/v1/messages');
  expect(names(calls[0].headers)).toEqual(['anthropic-version', 'content-type', 'user-agent', 'x-api-key']);
  expect(calls[0].headers.get('anthropic-version')).toBe('2023-06-01');
  expect(calls[0].body).toEqual({
    model: 'claude-opus-5-5', max_tokens: 600,
    thinking: { type: 'adaptive' }, output_config: { effort: 'low', format: { type: 'json_schema', schema } },
    system: [{ type: 'text', text: 'Write briefly.' }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'A tree in rain.' }] }],
  });
});

test('Anthropic: Sonnet 5.5 and Haiku 5.5 map to their real ids; the SDK leaves sampling off the models that refuse it', async () => {
  process.env.TEXT_DIRECT = 'anthropic';
  expect(directModelId('anthropic/claude-sonnet-5.5')).toBe('claude-sonnet-5-5');
  expect(directModelId('anthropic/claude-haiku-5.5')).toBe('claude-haiku-5-5');
  expect(directModelId('anthropic/claude-opus-5.5')).toBe('claude-opus-5-5');
  expect(directModelId('anthropic/claude-fable-5.1')).toBe('claude-fable-5-1');
  for (const [model, id] of [['anthropic/claude-sonnet-5.5', 'claude-sonnet-5-5'], ['anthropic/claude-haiku-5.5', 'claude-haiku-5-5']]) {
    const { calls, fetch } = stub(() => Response.json(anthropicReply('ok')));
    await textPost(chat(model, { temperature: 0.2, top_p: 0.5 }), { fetch });
    expect(calls[0].body).toEqual({ model: id, max_tokens: 600, system: [{ type: 'text', text: 'Write briefly.' }], messages: [{ role: 'user', content: [{ type: 'text', text: 'A tree in rain.' }] }] });
  }
});

test('every direct id is one the owner\'s keys listed on 11 October 2026', () => {
  expect([...new Set(Object.values(DIRECT_MODEL_IDS))].sort()).toEqual([
    'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1', 'claude-opus-5', 'claude-sonnet-5', 'claude-fable-5',
    'gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-pro-preview', 'gemini-3.1-flash-lite', 'gemini-3-flash-preview',
    'grok-4.7', 'grok-4.6', 'grok-4.5', 'grok-4.3', 'grok-4.20-0309-reasoning',
  ].sort());
});

test('Anthropic (hardening): a no-tool final step keeps the tools defined and sends tool_choice none, since the SDK drops them for none', async () => {
  process.env.TEXT_DIRECT = 'anthropic';
  const { calls, fetch } = stub(() => Response.json(anthropicReply('Done.')));
  const model = languageModel('anthropic/claude-sonnet-5.5', { auth: {}, fetch });
  expect(finalToolStep(model)).toEqual({ toolChoice: 'none' });
  await generateText({
    model, maxRetries: 0, maxOutputTokens: 200, toolChoice: 'none',
    tools: { inspect_board: tool({ description: 'Read the board.', inputSchema: z.object({}).strict(), execute: async () => ({ cards: 0 }) }) },
    messages: [
      { role: 'user', content: 'Plan the board.' },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'call_1', toolName: 'inspect_board', input: {} }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call_1', toolName: 'inspect_board', output: { type: 'json', value: { cards: 0 } } }] },
    ],
  });
  expect(calls).toHaveLength(1);
  expect(calls[0].headers.has(ANTHROPIC_NO_TOOL_HEADER)).toBe(false);
  expect(names(calls[0].headers)).toEqual(['anthropic-beta', 'anthropic-version', 'content-type', 'user-agent', 'x-api-key']);
  expect(calls[0].headers.get('anthropic-beta')).toBe('structured-outputs-2025-11-13'); // the SDK's flag for tool schemas
  expect(calls[0].body.tool_choice).toEqual({ type: 'none' });
  expect((calls[0].body.tools as { name: string }[]).map(t => t.name)).toEqual(['inspect_board']);
  // Off the Anthropic door the last step still removes the tools.
  process.env.AI_GATEWAY_API_KEY = 'test-gateway-key-never-sent'; delete process.env.TEXT_DIRECT;
  expect(finalToolStep(languageModel('anthropic/claude-sonnet-4.6', { auth: await languageAuth('anthropic/claude-sonnet-4.6') }))).toEqual({ toolChoice: 'none', activeTools: [] });
});

test('Anthropic: a 400 is logged with its status, type and message, never the prompt or the key', async () => {
  process.env.TEXT_DIRECT = 'anthropic';
  const secret = 'PROMPT-THAT-MUST-NOT-BE-LOGGED';
  const lines: string[] = [];
  const realWarn = console.warn, realError = console.error, realLog = console.log;
  console.warn = console.error = console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try {
    const body = { type: 'error', error: { type: 'invalid_request_error', message: 'max_tokens: 999999999 > 128000, which is the maximum allowed number of output tokens for claude-opus-5-5' } };
    const reply = await textPost(JSON.stringify({ model: 'anthropic/claude-opus-5.5', max_tokens: 100, messages: [{ role: 'user', content: secret }] }), { fetch: async () => Response.json(body, { status: 400 }) });
    expect(reply).toMatchObject({ ok: false, status: 400 });
  } finally { console.warn = realWarn; console.error = realError; console.log = realLog; }
  const log = lines.join('\n');
  expect(log).toContain('direct text anthropic: failed AI_APICallError status=400 code=invalid_request_error message="max_tokens: 999999999 > 128000');
  expect(log).not.toContain(secret);
  expect(log).not.toContain(KEYS.ANTHROPIC_API_KEY);
});

test('OpenAI: the exact Responses request for GPT-5.5 on its own key', async () => {
  const key = 'test-openai-key-never-sent';
  const workspace: TenantWorkspace = { id: 'direct-text-fixture', slug: 'direct-text-fixture', name: 'Direct text fixture', legacy: false, dbUrl: 'file::memory:', dbToken: null, keys: { openai: key }, usesPlatformKeys: false, allowanceUsd: null, gatewayKeyId: null, ownerId: 'owner', createdAt: 0, suspendedAt: null, suspendedReason: null, flaggedAt: null, flagNote: null, concurrency: 3, rendersPerHour: 30, storageQuotaBytes: null, deletedAt: null };
  process.env.OPENAI_API_KEY = key;
  const { calls, fetch } = stub(() => Response.json(openaiReply));
  await runInTenant(workspace, async () => {
    const result = await openaiDirectPost(JSON.parse(chat('openai/gpt-5.5', { reasoning_effort: 'low' })), { fetch });
    expect(result.ok).toBe(true);
  });
  expect(calls).toHaveLength(1);
  expect(calls[0].url).toBe('https://api.openai.com/v1/responses');
  expect(names(calls[0].headers)).toEqual(['authorization', 'content-type']);
  expect(calls[0].body).toEqual({ model: 'gpt-5.5', store: false, max_output_tokens: 600, reasoning: { effort: 'low' },
    input: [{ role: 'system', content: 'Write briefly.' }, { role: 'user', content: 'A tree in rain.' }] });
});

test('Gemini: the exact generateContent request on the stable Flash-Lite id', async () => {
  process.env.TEXT_DIRECT = 'google';
  const { calls, fetch } = stub(() => Response.json(googleReply));
  const reply = await textPost(chat('google/gemini-3.1-flash-lite'), { auth: await languageAuth('google/gemini-3.1-flash-lite'), fetch });
  expect(reply.ok).toBe(true);
  expect(calls[0].url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent');
  expect(names(calls[0].headers)).toEqual(['content-type', 'user-agent', 'x-goog-api-key']);
  /* Owner, 14 Oct 2026: every Gemini call carries the one safety configuration (lib/geminiSafety.ts): the four adjustable categories at BLOCK_NONE. */
  expect(calls[0].body).toEqual({ generationConfig: { maxOutputTokens: 600 }, systemInstruction: { parts: [{ text: 'Write briefly.' }] }, contents: [{ role: 'user', parts: [{ text: 'A tree in rain.' }] }],
    safetySettings: ['HARM_CATEGORY_HARASSMENT', 'HARM_CATEGORY_HATE_SPEECH', 'HARM_CATEGORY_SEXUALLY_EXPLICIT', 'HARM_CATEGORY_DANGEROUS_CONTENT'].map((category) => ({ category, threshold: 'BLOCK_NONE' })) });
});

test('xAI: the exact Responses request on the dated Grok 4.20 id', async () => {
  process.env.TEXT_DIRECT = 'xai';
  const { calls, fetch } = stub(() => Response.json(xaiReply));
  const reply = await textPost(chat('spacexai/grok-4.20-reasoning', { reasoning_effort: 'low' }), { auth: await languageAuth('spacexai/grok-4.20-reasoning'), fetch });
  expect(reply.ok).toBe(true);
  expect(calls[0].url).toBe('https://api.x.ai/v1/responses');
  expect(names(calls[0].headers)).toEqual(['authorization', 'content-type', 'user-agent']);
  expect(calls[0].body).toEqual({ model: 'grok-4.20-0309-reasoning', max_output_tokens: 600, reasoning: { effort: 'low' },
    input: [{ role: 'system', content: 'Write briefly.' }, { role: 'user', content: [{ type: 'input_text', text: 'A tree in rain.' }] }] });
});

test('a model is offered only with a working route: its key and TEXT_DIRECT (or OpenAI on its key); gateway-only models need the gateway', () => {
  // No gateway, nothing direct: nothing but OpenAI-with-key works, and Gemini, which is always direct, on its own key.
  expect(textRouteWorks('anthropic/claude-opus-5.5')).toBe(false);
  expect(textRouteWorks('google/gemini-3.1-pro-preview')).toBe(true);
  delete process.env.GEMINI_API_KEY;
  expect(textRouteWorks('google/gemini-3.1-pro-preview')).toBe(false);   // no key: it never falls back to the gateway
  process.env.GEMINI_API_KEY = KEYS.GEMINI_API_KEY;
  expect(textRouteWorks('openai/gpt-5.5')).toBe(false);
  process.env.OPENAI_API_KEY = 'test-openai-key-never-sent';
  expect(textRouteWorks('openai/gpt-5.5')).toBe(true);
  // Anthropic direct with its key: Claude works, the rest still does not.
  process.env.TEXT_DIRECT = 'anthropic';
  expect(textRouteWorks('anthropic/claude-opus-5.5')).toBe(true);
  expect(textRouteWorks('anthropic/claude-sonnet-4.6')).toBe(false);   // not on the owner's Anthropic key list
  expect(textRouteWorks('google/gemini-3.1-pro-preview')).toBe(true);   // Gemini is always direct, whatever TEXT_DIRECT says
  expect(textRouteWorks('spacexai/grok-4.7')).toBe(false);
  // Direct without the key: off, even with the gateway up (the call would not go there).
  delete process.env.ANTHROPIC_API_KEY; process.env.AI_GATEWAY_API_KEY = 'test-gateway-key-never-sent';
  expect(textRouteWorks('anthropic/claude-opus-5.5')).toBe(false);
  // Gateway up, vendor not direct: what the gateway listed works; a provider-priced model the gateway never listed does not. Gemini is never carried by the gateway.
  delete process.env.TEXT_DIRECT;
  expect(textRouteWorks('spacexai/grok-4.7')).toBe(true);
  delete process.env.GEMINI_API_KEY;
  expect(textRouteWorks('google/gemini-3.1-pro-preview')).toBe(false);   // gateway up, no Gemini key
  process.env.GEMINI_API_KEY = KEYS.GEMINI_API_KEY;
  expect(textRouteWorks('anthropic/claude-sonnet-5')).toBe(true);
  expect(textRouteWorks('anthropic/claude-opus-5.5')).toBe(false);
  // Direct doors offer only ids they can send: unconfirmed ids stay on the gateway.
  process.env.TEXT_DIRECT = 'anthropic,google,xai'; Object.assign(process.env, KEYS); delete process.env.AI_GATEWAY_API_KEY;
  expect(textRouteWorks('google/gemini-3.6-flash')).toBe(true);
  expect(textRouteWorks('google/gemini-3.8-flash')).toBe(false);   // not on the key's list
  expect(textRouteWorks('google/gemini-3.5-flash')).toBe(false);   // on the key's list, price to confirm
  expect(directModelId('google/gemini-3.5-flash')).toBe('gemini-3.5-flash');
  expect(textRouteWorks('spacexai/grok-4.1-fast-reasoning')).toBe(false);
});

test('admin text routing lists every routable, priced text model: the same filter as the menus', async () => {
  process.env.MODEL_CATALOG = 'static';
  process.env.TEXT_DIRECT = 'anthropic,google,xai';
  const ids = await routableTextModelIds();
  expect(ids).toEqual(expect.arrayContaining(['anthropic/claude-opus-5.5', 'anthropic/claude-sonnet-5.5', 'anthropic/claude-haiku-5.5', 'google/gemini-3.6-flash', 'spacexai/grok-4.7', 'spacexai/grok-4.20-reasoning']));
  for (const id of ['anthropic/claude-haiku-4.5', 'anthropic/claude-sonnet-4.6', 'google/gemini-3.5-flash', 'google/gemini-2.5-pro', 'openai/gpt-5.5']) expect(ids, id).not.toContain(id);
  delete process.env.ANTHROPIC_API_KEY;
  expect((await routableTextModelIds()).filter(id => id.startsWith('anthropic/'))).toEqual([]);
});

test('without the gateway, the static catalogue, Atomik and the enhancer offer the direct Claude models and the direct Gemini models (Gemini is always direct), and nothing gateway-only', async () => {
  process.env.MODEL_CATALOG = 'static';
  process.env.TEXT_DIRECT = 'anthropic';
  // Text models; stills (image output) follow their own key and door.
  const ids = (await catalog(true)).filter(m => m.type === 'language' && !m.outputModalities?.includes('image')).map(m => m.id);
  expect(ids).toEqual(expect.arrayContaining(['anthropic/claude-opus-5.5', 'anthropic/claude-sonnet-5.5', 'anthropic/claude-haiku-5.5', 'anthropic/claude-fable-5.1']));
  /* Gemini text is always direct, on its own key: exactly the mapped ids whose price is confirmed (the seven others are on no menu). Nothing else that is not Claude. */
  const GEMINI_DIRECT = ['google/gemini-3-flash', 'google/gemini-3.1-pro-preview', 'google/gemini-3.5-flash-lite', 'google/gemini-3.6-flash'];
  expect(ids.filter(id => !id.startsWith('anthropic/')).sort()).toEqual(GEMINI_DIRECT);
  const planner = await menuFor('planner');
  expect(planner.featured.slice(0, 2).map(m => m.id)).toEqual(['anthropic/claude-sonnet-5.5', 'anthropic/claude-opus-5.5']);
  expect([...planner.featured, ...planner.rest].map(m => m.id).filter(id => /claude-(?:opus|sonnet|haiku)-4/.test(id))).toEqual([]);
  expect([...planner.featured, ...planner.rest].map(m => m.id)).toEqual(expect.arrayContaining(['anthropic/claude-opus-5.5', 'anthropic/claude-sonnet-5.5']));
  expect(selectAtomikModel('auto', ids)).toBe('anthropic/claude-sonnet-5.5');
  expect(ENHANCER_MODELS.claude.filter(id => ids.includes(id)).slice(0, 2)).toEqual(['anthropic/claude-sonnet-5.5', 'anthropic/claude-haiku-5.5']);
  // Priced from Anthropic's list: Opus 5.5 $4 / $20, Sonnet 5.5 $2 / $10, Haiku 5.5 $0.10 / $0.50 up to 100k prompt tokens.
  const priced = new Map((await catalog(true)).map(m => [m.id, m.pricing]));
  expect(priced.get('anthropic/claude-opus-5.5')).toMatchObject({ input: '0.000004', output: '0.00002', input_cache_read: '0.0000002', input_cache_write: '0.000005' });
  expect(priced.get('anthropic/claude-sonnet-5.5')).toMatchObject({ input: '0.000002', output: '0.00001', input_cache_read: '0.0000001', input_cache_write: '0.0000025' });
  expect(priced.get('anthropic/claude-haiku-5.5')).toMatchObject({ input: '0.0000001', output: '0.0000005' });
  // And as the catalogue snapshot states each (lib/modelCatalog.json): every rate a direct Claude call settles at is there and positive, Opus above Sonnet
  // above Haiku for input and output, and Haiku 5.5's flat rate is its first prompt tier's.
  const { snapshotModels } = await import('../../lib/catalog');
  const pricedRates = priced as Map<string, Record<string, unknown> | null>;
  const CLAUDE = ['anthropic/claude-opus-5.5', 'anthropic/claude-sonnet-5.5', 'anthropic/claude-haiku-5.5'] as const;
  for (const id of CLAUDE) {
    const stated = snapshotModels().find(m => m.id === id)?.pricing;
    expect(stated, id).toBeTruthy();
    expect(pricedRates.get(id), id).toEqual(stated);
    for (const key of ['input', 'output', 'input_cache_read', 'input_cache_write']) expect(Number(pricedRates.get(id)![key]), `${id} ${key}`).toBeGreaterThan(0);
  }
  const rate = (id: (typeof CLAUDE)[number], key: string) => Number(pricedRates.get(id)![key]);
  for (const key of ['input', 'output']) {
    expect(rate(CLAUDE[0], key), key).toBeGreaterThan(rate(CLAUDE[1], key));
    expect(rate(CLAUDE[1], key), key).toBeGreaterThan(rate(CLAUDE[2], key));
    expect(Number((pricedRates.get(CLAUDE[2])![`${key}_tiers`] as { cost: string }[])[0].cost), key).toBe(rate(CLAUDE[2], key));
  }
  // Nothing direct and no gateway: no Claude or Grok at all; Gemini is still the direct ids on its key, and none without it.
  delete process.env.TEXT_DIRECT;
  const textIds = async () => (await catalog(true)).filter(m => m.type === 'language' && !m.outputModalities?.includes('image') && !m.id.startsWith('openai/')).map(m => m.id);
  expect((await textIds()).sort()).toEqual(GEMINI_DIRECT);
  delete process.env.GEMINI_API_KEY;
  expect(await textIds()).toEqual([]);
});

test('defaults: enhancement, ideas and shots on Opus 5.5 (the owner, 16 Oct 2026, for enhancement); Auto tries Sonnet 5.5, then Opus 5.5', () => {
  expect(DEFAULT_TEXT_MODELS).toEqual({ enhance: 'anthropic/claude-opus-5.5', idea: 'anthropic/claude-opus-5.5', shot: 'anthropic/claude-opus-5.5' });
  expect(ATOMIK_AUTO_MODEL_IDS.slice(0, 2)).toEqual(['anthropic/claude-sonnet-5.5', 'anthropic/claude-opus-5.5']);
  expect(selectAtomikModel('auto', ['anthropic/claude-opus-5.5', 'openai/gpt-5.5'])).toBe('anthropic/claude-opus-5.5');
  expect(selectAtomikModel('auto', ['anthropic/claude-sonnet-4.6', 'anthropic/claude-sonnet-5', 'openai/gpt-5.5'])).toBe('anthropic/claude-sonnet-5');
  expect(selectAtomikModel('auto', ['anthropic/claude-sonnet-4.6', 'openai/gpt-5.5'])).toBe('openai/gpt-5.5');
  for (const id of Object.values(DEFAULT_TEXT_MODELS)) expect(TEXT_MODEL_IDS).toContain(id);
  expect(TEXT_MODEL_IDS).toEqual(expect.arrayContaining(['openai/gpt-5.5', 'openai/gpt-5.4', 'spacexai/grok-4.7', 'google/gemini-3.6-flash']));
});
