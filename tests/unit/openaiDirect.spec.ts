import { test, expect } from '@playwright/test';
import { generateText, Output } from 'ai';
import { z } from 'zod';
import { runInTenant, type TenantWorkspace } from '../../lib/tenant';
import { gatewayPost, gatewayChat, explainGatewayFailure } from '../../lib/gateway';
import { languageAuth, languageModel } from '../../lib/language-provider';
import { openAIDirectBody, openaiDirectPost, directTextCostUsd, sdkTextUsage, textVendor, TEXT_PROVIDER_HEADER } from '../../lib/openai-direct';
import { executeDevelopmentAgent, type DevelopmentCall } from '../../lib/workbench/development-server';

const workspace = (keys: Record<string, string>, platform = false): TenantWorkspace => ({ id: 'direct-openai-fixture', slug: 'direct-openai-fixture', name: 'Direct OpenAI fixture', legacy: false, dbUrl: 'file::memory:', dbToken: null, keys, usesPlatformKeys: platform, allowanceUsd: null, gatewayKeyId: null, ownerId: 'owner', createdAt: 0, suspendedAt: null, suspendedReason: null, flaggedAt: null, flagNote: null, concurrency: 3, rendersPerHour: 30, storageQuotaBytes: null, deletedAt: null });
const fakeKey = 'test-openai-key-never-sent';
const model = 'openai/gpt-6-astra';
const response = (text = '{"ok":true}') => ({ id: 'resp_fixture', object: 'response', created_at: 1, model: 'gpt-6-astra', status: 'completed', output: [{ type: 'message', id: 'msg_fixture', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }], usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120, input_tokens_details: { cached_tokens: 12, cache_write_tokens: 30 }, output_tokens_details: { reasoning_tokens: 7 } }, error: null, incomplete_details: null });
const originalFetch = globalThis.fetch, originalMock = process.env.ENGINE_MOCK, originalKey = process.env.OPENAI_API_KEY;
test.beforeEach(() => { delete process.env.ENGINE_MOCK; delete process.env.OPENAI_API_KEY; });
test.afterEach(() => { globalThis.fetch = originalFetch; if (originalMock === undefined) delete process.env.ENGINE_MOCK; else process.env.ENGINE_MOCK = originalMock; if (originalKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = originalKey; });

test('direct routing respects tenant key isolation and does not reroute non-OpenAI models', async () => {
  process.env.OPENAI_API_KEY = 'deployment-test-only';
  await runInTenant(workspace({ gateway: 'workspace-gateway' }), async () => { expect(textVendor(model)).toBe('gateway'); });
  await runInTenant(workspace({}, true), async () => { expect(textVendor(model)).toBe('openai'); });
  await runInTenant(workspace({ openai: fakeKey }), async () => {
    expect(textVendor(model)).toBe('openai'); expect(textVendor('anthropic/claude-fixture')).toBe('gateway');
    expect(await languageAuth(model)).toEqual({ Authorization: `Bearer ${fakeKey}`, [TEXT_PROVIDER_HEADER]: 'openai' });
  });
});
test('raw modern requests retain exact model IDs, images, effort and strict JSON schema in Responses format', async () => {
  const format = { type: 'json_schema', json_schema: { name: 'proposal', strict: true, schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false } } };
  const input = { model: 'openai/gpt-6-astra-thinking', max_tokens: 4000, temperature: .6, providerOptions: { openai: { reasoningEffort: 'max' } }, response_format: format, messages: [{ role: 'system', content: 'Inspect references.', cache_control: { type: 'ephemeral' } }, { role: 'user', content: [{ type: 'text', text: 'Review.' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA', detail: 'low' } }] }] };
  const wire = openAIDirectBody(input);
  expect(wire.endpoint).toBe('responses'); expect(wire.body).toMatchObject({ model: 'gpt-6-astra-thinking', max_output_tokens: 4000, reasoning: { effort: 'max' }, store: false, text: { format: { type: 'json_schema', ...format.json_schema } }, input: [{ role: 'system', content: 'Inspect references.' }, { role: 'user', content: [{ type: 'input_text', text: 'Review.' }, { type: 'input_image', image_url: 'data:image/png;base64,AAAA', detail: 'low' }] }] });
  expect(wire.body).not.toHaveProperty('temperature'); expect(wire.body).not.toHaveProperty('providerOptions');
  const calls: { url: string; init?: RequestInit }[] = [];
  await runInTenant(workspace({ openai: fakeKey }), async () => {
    const result = await openaiDirectPost(input, { fetch: async (url, init) => { calls.push({ url: String(url), init }); return Response.json(response()); } });
    expect(JSON.parse(result.text)).toMatchObject({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 12 }, completion_tokens_details: { reasoning_tokens: 7 } } });
  });
  expect(calls).toHaveLength(1); expect(calls[0].url).toBe('https://api.openai.com/v1/responses'); expect(new Headers(calls[0].init?.headers).get('authorization')).toBe(`Bearer ${fakeKey}`); expect(calls[0].init?.redirect).toBe('error');
});
test('legacy GPT uses chat with JSON mode and only the model owner removed', async () => {
  const wire = openAIDirectBody({ model: 'openai/gpt-3.5-turbo', max_tokens: 300, response_format: { type: 'json_object' }, messages: [{ role: 'user', content: 'Return JSON.' }] });
  expect(wire).toEqual({ endpoint: 'chat/completions', body: { model: 'gpt-3.5-turbo', store: false, max_tokens: 300, response_format: { type: 'json_object' }, messages: [{ role: 'user', content: 'Return JSON.' }] } });
});
test('gatewayPost directly dispatches OpenAI without Gateway credentials and does not retry an error', async () => {
  const calls: string[] = [];
  globalThis.fetch = async (url) => { calls.push(String(url)); return Response.json({ error: { message: 'Invalid unsupported setting.', type: 'invalid_request_error' } }, { status: 400 }); };
  await runInTenant(workspace({ openai: fakeKey }), async () => {
    const result = await gatewayChat({ model, system: 'Be concise.', user: 'Hello.' });
    expect(result.ok).toBe(false); expect(result.status).toBe(400); expect(explainGatewayFailure(400, result.text)).toContain('OpenAI');
  });
  expect(calls).toEqual(['https://api.openai.com/v1/responses']);
});
test('provider connection changes fail closed before a raw or SDK request', async () => {
  let calls = 0; globalThis.fetch = async () => { calls++; throw new Error('must not send'); };
  await runInTenant(workspace({ gateway: 'gateway-key' }), async () => {
    const auth = { Authorization: `Bearer ${fakeKey}`, [TEXT_PROVIDER_HEADER]: 'openai' };
    await expect(gatewayPost(JSON.stringify({ model, messages: [{ role: 'user', content: 'Hello.' }] }), { auth })).rejects.toThrow('connection changed');
    expect(() => languageModel(model, { auth })).toThrow('connection changed');
  });
  expect(calls).toBe(0);
});
test('installed OpenAI SDK sends Responses structured output and native maximum effort without model rewriting', async () => {
  await runInTenant(workspace({ openai: fakeKey }), async () => {
    const calls: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
    const selected = languageModel(model, { auth: await languageAuth(model), fetch: async (url, init) => { calls.push({ url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) }); return Response.json(response()); } });
    const result = await generateText({ model: selected, prompt: 'Return JSON.', output: Output.object({ schema: z.object({ ok: z.boolean() }) }), providerOptions: { openai: { reasoningEffort: 'max' } }, maxOutputTokens: 4000, maxRetries: 0 });
    expect(result.output).toEqual({ ok: true }); expect(result.usage).toMatchObject({ inputTokens: 100, outputTokens: 20 }); expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.openai.com/v1/responses'); expect(calls[0].body).toMatchObject({ model: 'gpt-6-astra', store: false, max_output_tokens: 4000, reasoning: { effort: 'max' }, text: { format: { type: 'json_schema' } } });
    expect(calls[0].headers.get(TEXT_PROVIDER_HEADER)).toBeNull(); expect(calls[0].headers.get('ai-gateway-auth-method')).toBeNull();
  });
});
test('development agent sends one direct OpenAI request and reports submitted errors without fallback', async () => {
  await runInTenant(workspace({ openai: fakeKey }), async () => {
    const input: DevelopmentCall = { model: { id: model, name: 'GPT-6 Astra', owner: 'openai', type: 'language', description: '', contextWindow: 1050000, maxTokens: 128000, reasoningOptions: [{ type: 'effort', values: ['high'] }], pricing: { input: .00001, output: .00005 } }, effort: 'high', stage: 'draft', kind: 'idea', instructions: 'Develop ideas.', prompt: 'A film.', maxTokens: 4000, chunk: { index: 0, start: 0, end: 7, segments: [] } };
    let calls = 0;
    await expect(executeDevelopmentAgent(input, { method: 'api-key', token: fakeKey, vendor: 'openai' }, async (url) => { calls++; expect(String(url)).toBe('https://api.openai.com/v1/responses'); return Response.json({ error: { message: 'Fixture outage', type: 'server_error', code: 'server_error' } }, { status: 503 }); })).rejects.toMatchObject({ providerSubmitted: true });
    expect(calls).toBe(1);
  });
});

test('incomplete and refused Responses retain paid usage and expose the correct finish reason', async () => {
  await runInTenant(workspace({ openai: fakeKey }), async () => {
    for (const refused of [false, true]) {
      const value = refused ? { ...response(), output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'Fixture refusal.' }] }] } : { ...response(), status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } };
      const result = await openaiDirectPost({ model, messages: [{ role: 'user', content: 'Return JSON.' }] }, { fetch: async () => Response.json(value) });
      expect(JSON.parse(result.text)).toMatchObject({ choices: [{ finish_reason: refused ? 'content_filter' : 'length' }], usage: { prompt_tokens: 100, completion_tokens: 20 } });
    }
  });
});


test('raw and SDK receipts preserve cache categories and missing SDK defaults never become known zero', async () => {
  const priced = { id: model, owner: 'openai', name: 'Astra', type: 'language' as const, description: '', contextWindow: 1050000, maxTokens: 128000, pricing: { input: .00001, output: .00005, input_cache_read: .000001, input_cache_write: .0000125 } };
  await runInTenant(workspace({ openai: fakeKey }), async () => {
    const direct = await openaiDirectPost({ model, messages: [{ role: 'user', content: 'Return JSON.' }] }, { fetch: async () => Response.json(response()) });
    const usage = JSON.parse(direct.text).usage;
    expect(directTextCostUsd(priced, usage)).toBeCloseTo(58 * .00001 + 12 * .000001 + 30 * .0000125 + 20 * .00005, 12);
    for (const details of [{}, { cached_tokens: 0 }, { cache_write_tokens: 0 }, { cached_tokens: null, cache_write_tokens: 0 }, { cached_tokens: '0', cache_write_tokens: 0 }, { cached_tokens: 80, cache_write_tokens: 30 }]) expect(directTextCostUsd(priced, { ...usage, prompt_tokens_details: details })).toBeNull();
    for (const missing of [false, true]) {
      const value = response();
      if (missing) delete (value.usage as { input_tokens_details?: unknown }).input_tokens_details;
      const selected = languageModel(model, { auth: await languageAuth(model), fetch: async () => Response.json(value) });
      const result = await generateText({ model: selected, prompt: 'Return JSON.', maxRetries: 0 });
      const serialized = sdkTextUsage(result.steps[0].usage, true);
      expect(directTextCostUsd(priced, serialized)).toBe(missing ? null : directTextCostUsd(priced, usage));
      if (missing) expect(result.usage.inputTokenDetails.cacheReadTokens).toBe(0); // installed SDK default, not a receipt
    }
  });
});
