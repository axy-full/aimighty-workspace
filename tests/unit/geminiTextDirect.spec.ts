import { test, expect } from '@playwright/test';
import { languageAuth } from '../../lib/language-provider';
import { textPost } from '../../lib/textDirect';
import { textRoute, textRouteWorks } from '../../lib/textRoute';
import { textVendor, textEngine } from '../../lib/openai-direct';
import { textDirectVendors } from '../../lib/textDirectVendors';
import { GEMINI_SAFETY_SETTINGS } from '../../lib/geminiSafety';

/* Vercel out (docs/plans/vercel-out.md): Gemini text goes straight to Google with the shared safety settings whatever TEXT_DIRECT says, and never to the gateway.
   Every call here is a stand-in; the keys are fixtures and never leave the process. */
const KEYS = { GEMINI_API_KEY: 'test-gemini-key-never-sent', AI_GATEWAY_API_KEY: 'test-gateway-key-never-sent' };
const ENV = ['ENGINE_MOCK', 'TEXT_DIRECT', 'OPENAI_API_KEY', ...Object.keys(KEYS)] as const;
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

const googleReply = { candidates: [{ content: { parts: [{ text: 'Done.' }], role: 'model' }, finishReason: 'STOP', index: 0 }],
  usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 3, totalTokenCount: 23 }, modelVersion: 'gemini-3.5-flash-lite', responseId: 'resp_fixture' };
function stub() {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const fetch: typeof globalThis.fetch = async (url, init) => { calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : {} }); return Response.json(googleReply); };
  return { calls, fetch };
}
const request = (model: string) => JSON.stringify({ model, max_tokens: 500, messages: [{ role: 'user', content: 'Hi.' }] });

test('with TEXT_DIRECT empty, a Gemini model is still on Google\'s own API, and a model of another vendor is not', () => {
  expect([...textDirectVendors()]).toEqual(['google']);
  expect(textRoute('google/gemini-3.5-flash-lite')).toBe('google');
  expect(textVendor('google/gemini-3.5-flash-lite')).toBe('google');
  expect(textEngine('google/gemini-3.5-flash-lite')).toBe('google');
  expect(textRoute('anthropic/claude-sonnet-5')).toBe('gateway');
  expect(textRoute('spacexai/grok-4.6')).toBe('gateway');
});

test('a Gemini text call goes once to Google with the four safety settings at BLOCK_NONE, and the gateway is never called', async () => {
  const { calls, fetch } = stub();
  globalThis.fetch = fetch;
  const reply = await textPost(request('google/gemini-3.5-flash-lite'), { auth: await languageAuth('google/gemini-3.5-flash-lite'), fetch });
  expect(reply.ok).toBe(true);
  expect(calls).toHaveLength(1);
  expect(new URL(calls[0].url).origin).toBe('https://generativelanguage.googleapis.com');
  expect(calls[0].body.safetySettings).toEqual(GEMINI_SAFETY_SETTINGS);
  expect(calls[0].body.safetySettings).toHaveLength(4);
});

test('a Gemini id with no direct model is refused before sending; it does not fall back to the gateway', async () => {
  const { calls, fetch } = stub();
  globalThis.fetch = fetch;
  const reply = await textPost(request('google/gemini-2.5-flash'), { fetch });
  expect(reply).toMatchObject({ ok: false, status: 422 });
  expect(calls).toHaveLength(0);
  expect(textRouteWorks('google/gemini-2.5-flash')).toBe(false);
});

test('no Gemini key: the call fails before sending and names the variable, even with the gateway key set', async () => {
  delete process.env.GEMINI_API_KEY;
  const { calls, fetch } = stub();
  globalThis.fetch = fetch;
  await expect(languageAuth('google/gemini-3.5-flash-lite')).rejects.toThrow('GEMINI_API_KEY');
  const reply = await textPost(request('google/gemini-3.5-flash-lite'), { fetch });
  expect(reply).toMatchObject({ ok: false, status: 422 });
  expect(JSON.parse(reply.text).error.message).toContain('GEMINI_API_KEY');
  expect(calls).toHaveLength(0);
  expect(textRouteWorks('google/gemini-3.5-flash-lite')).toBe(false);
});

test('a Gemini key alone does not make direct text reachable or switch the default writer to the router; listing google does', async () => {
  const { directTextReachable, languageReachable } = await import('../../lib/language-provider');
  const { refineProvider } = await import('../../lib/enhance');
  delete process.env.AI_GATEWAY_API_KEY; delete process.env.REFINE_PROVIDER;
  expect(directTextReachable(), 'the stills key is also this key').toBe(false);
  expect(languageReachable()).toBe(false);
  expect(refineProvider(), 'the default writer stays where it was').toBe('byteplus');
  process.env.TEXT_DIRECT = 'google';
  expect(directTextReachable()).toBe(true);
  expect(refineProvider()).toBe('gateway');
});

test('the missing-key words for Gemini say it always goes direct and needs the key', async () => {
  delete process.env.GEMINI_API_KEY;
  await expect(languageAuth('google/gemini-3.5-flash-lite')).rejects.toThrow('Gemini text always goes direct to Google and needs GEMINI_API_KEY');
});
