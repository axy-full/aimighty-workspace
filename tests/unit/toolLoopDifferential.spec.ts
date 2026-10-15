import { test, expect } from '@playwright/test';
import { ToolLoopAgent as RealToolLoopAgent, Output, isStepCount, tool } from 'ai';
import type { LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4Content, LanguageModelV4GenerateResult } from '@ai-sdk/provider';
import { z } from 'zod';
import { finalToolStep, languageAuth, languageModel } from '../../lib/language-provider';
import { stepTextUsage } from '../../lib/textDirect';
import { runToolLoop, loopTool, ToolLoopOutputError, v4Model, type LoopMessage, type LoopUsage } from '../../lib/llm/tool-loop';

/*
 * Vercel out, step B1 (docs/plans/vercel-out.md, 2.3): our own tool loop (lib/llm/tool-loop.ts) against `ToolLoopAgent`, while `ai` is still installed. The same scripted
 * model, the same tools and the same settings go through both, and what reaches the provider (every `doGenerate` option, and on the wire the exact HTTP request), what comes back
 * (steps, output, per-step and total usage) and what a failure throws must be the same. Delete this file with `ai` (B7). No network: models are scripted or sit on a stubbed fetch.
 */

/* `ai`'s generics are not what this file tests: the agent is used loosely, its result as plain data. */
type AiStep = { stepNumber: number; usage: LoopUsage; finishReason: string; text: string; toolCalls: { toolCallId: string; toolName: string; input: unknown }[] };
type AiResult = { steps: AiStep[]; totalUsage: LoopUsage; text: string; finishReason: string; readonly output: unknown };
const ToolLoopAgent = RealToolLoopAgent as unknown as new (settings: Record<string, unknown>) => { generate(options: Record<string, unknown>): Promise<AiResult> };

/* ── A scripted model that records what it was asked ── */
type Reply = Partial<LanguageModelV4GenerateResult> | ((options: LanguageModelV4CallOptions, index: number) => Partial<LanguageModelV4GenerateResult> | Promise<never>);
const usage = (input: number, output: number, extra: { cacheRead?: number; cacheWrite?: number; reasoning?: number; raw?: Record<string, number> } = {}) => ({
  inputTokens: { total: input, noCache: input - (extra.cacheRead ?? 0) - (extra.cacheWrite ?? 0), cacheRead: extra.cacheRead, cacheWrite: extra.cacheWrite },
  outputTokens: { total: output, text: output - (extra.reasoning ?? 0), reasoning: extra.reasoning },
  ...(extra.raw ? { raw: extra.raw } : {}),
});
function scripted(replies: Reply[], provider = 'scripted.chat') {
  const calls: LanguageModelV4CallOptions[] = [];
  const model: LanguageModelV4 = {
    specificationVersion: 'v4', provider, modelId: 'scripted-1', supportedUrls: {},
    async doGenerate(options) {
      const index = calls.length;
      calls.push(options);
      const reply = replies[Math.min(index, replies.length - 1)];
      const made = typeof reply === 'function' ? await reply(options, index) : reply;
      return { content: [], finishReason: { unified: 'stop', raw: 'stop' }, usage: usage(10, 5), warnings: [], ...made } as LanguageModelV4GenerateResult;
    },
    async doStream() { throw new Error('No streaming.'); },
  };
  return { model, calls };
}
const call = (id: string, name: string, input: unknown): LanguageModelV4Content => ({ type: 'tool-call', toolCallId: id, toolName: name, input: typeof input === 'string' ? input : JSON.stringify(input) });
const said = (text: string): LanguageModelV4Content => ({ type: 'text', text });
const toolsStep = (...content: LanguageModelV4Content[]): Partial<LanguageModelV4GenerateResult> => ({ content, finishReason: { unified: 'tool-calls', raw: 'tool_use' } });

/* ── The same tools for both ── */
const Result = z.object({ summary: z.string(), count: z.number().int() });
function kit() {
  const started: string[] = [];
  const defs = {
    inspect_board: { description: 'Read the board.', inputSchema: z.object({}).strict(), execute: async () => { started.push('inspect_board'); return { cards: ['a', 'b'] }; } },
    add: { description: 'Add a card.', inputSchema: z.object({ kind: z.enum(['still', 'clip']), n: z.number().int().default(1), tags: z.array(z.string()).optional(), box: z.object({ x: z.number(), y: z.number().optional() }).optional() }).strict(),
      execute: async (input: { kind: string; n: number }) => { started.push(`add:${input.kind}:${input.n}`); return { ok: true, n: input.n }; } },
    name: { inputSchema: z.object({ name: z.string().min(3) }), execute: async (input: { name: string }) => { started.push(`name:${input.name}`); return `named ${input.name}`; } },
    boom: { description: 'Always fails.', inputSchema: z.object({}), execute: async () => { started.push('boom'); throw new Error('exploded'); } },
  };
  return { started, defs };
}
type Defs = ReturnType<typeof kit>['defs'];
const aiTools = (defs: Defs) => Object.fromEntries(Object.entries(defs).map(([k, d]) => [k, tool(d as never)]));
const ownTools = (defs: Defs) => Object.fromEntries(Object.entries(defs).map(([k, d]) => [k, loopTool(d as never)]));

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAHFhgcwAAAABJRU5ErkJggg==';
const USER = [{ type: 'text' as const, text: 'Plan two shots.' }, { type: 'text' as const, text: 'Label: still.png' }, { type: 'file' as const, data: PNG, mediaType: 'image/png' }];
const MESSAGES: LoopMessage[] = [{ role: 'user', content: USER }];

type Scenario = { replies: Reply[]; provider?: string; maxSteps?: number; output?: boolean; final?: boolean; providerOptions?: Record<string, Record<string, never>>; signal?: () => AbortSignal; images?: boolean };
async function both(s: Scenario) {
  const settings = { maxOutputTokens: 3000, temperature: 0.2 };
  const run = async (which: 'ai' | 'own') => {
    const { defs, started } = kit();
    const { model, calls } = scripted(s.replies, s.provider);
    const maxSteps = s.maxSteps ?? 3;
    const signal = s.signal?.() ?? new AbortController().signal;
    const prepare = ({ stepNumber }: { stepNumber: number }) => (s.final !== false && stepNumber >= maxSteps - 1 ? finalToolStep(model) : {});
    let result: Awaited<ReturnType<typeof runToolLoop<z.infer<typeof Result>>>> | null = null, error: unknown = null, aiResult: AiResult | null = null;
    const finished: number[] = [];
    try {
      if (which === 'ai') {
        const agent = new ToolLoopAgent({ model, instructions: 'You plan.', ...settings, maxRetries: 0, stopWhen: isStepCount(maxSteps), ...(s.output === false ? {} : { output: Output.object({ schema: Result }) }),
          tools: aiTools(defs) as never, providerOptions: s.providerOptions as never, prepareStep: prepare as never, onStepFinish: (step: { stepNumber: number }) => { finished.push(step.stepNumber); } });
        aiResult = await agent.generate({ messages: MESSAGES as never, abortSignal: signal });
      } else {
        result = await runToolLoop({ model: v4Model(model), instructions: 'You plan.', ...settings, maxSteps, ...(s.output === false ? {} : { output: Result }), tools: ownTools(defs) as never,
          providerOptions: s.providerOptions as never, prepareStep: prepare, onStepFinish: (step) => { finished.push(step.stepNumber); }, messages: MESSAGES, abortSignal: signal });
      }
    } catch (e) { error = e; }
    const steps = (aiResult?.steps ?? result?.steps ?? []);
    /* The headers differ on purpose (`ai` adds its own user-agent); the abort signal is the caller's. */
    const asked = calls.map(({ headers: _headers, abortSignal: _signal, ...rest }) => rest);
    return {
      asked, started, finished, error,
      steps: steps.map((st) => ({ usage: st.usage, finishReason: st.finishReason, text: st.text, toolCalls: st.toolCalls.map((c) => ({ id: c.toolCallId, name: c.toolName, input: c.input, invalid: Boolean((c as { invalid?: boolean }).invalid) })) })),
      totalUsage: aiResult?.totalUsage ?? result?.totalUsage ?? null,
      output: aiResult ? (() => { try { return aiResult.output; } catch { return undefined; } })() : result?.output,
      text: aiResult?.text ?? result?.text,
    };
  };
  const [a, b] = [await run('ai'), await run('own')];
  return { a, b };
}
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

test('a planning turn: tools in call order, a bad call answered, the last step without tools, the same JSON out', async () => {
  const { a, b } = await both({ replies: [
    { ...toolsStep(call('c1', 'inspect_board', ''), call('c2', 'add', { kind: 'still' }), call('c3', 'add', { kind: 'clip', n: 3, tags: ['x'], box: { x: 1 } }), call('c4', 'name', { name: 'ab' }), call('c5', 'nope', { a: 1 }), call('c6', 'boom', {}), call('c7', 'name', '{bad json')), usage: usage(120, 40, { cacheRead: 30, cacheWrite: 10, reasoning: 6, raw: { in: 120 } }) },
    { ...toolsStep(call('d1', 'name', { name: 'abc' })), usage: usage(200, 20, { cacheRead: 50, cacheWrite: 5, reasoning: 3, raw: { mid: 1 } }) },
    { content: [said(JSON.stringify({ summary: 'Two shots.', count: 2 }))], usage: usage(260, 30, { cacheRead: 70, cacheWrite: 2, reasoning: 5, raw: { final: 1 } }) },
  ] });
  expect(b.error).toBeNull(); expect(a.error).toBeNull();
  expect(b.asked).toHaveLength(3);
  expect(b.asked).toEqual(a.asked);
  expect(b.started).toEqual(a.started);
  expect(b.steps).toEqual(a.steps);
  expect(b.totalUsage).toEqual(a.totalUsage);
  /* The total is the sum over all three steps, in every counted field (not the last step's). */
  expect(b.totalUsage).toMatchObject({ inputTokens: 580, outputTokens: 90, totalTokens: 670,
    inputTokenDetails: { cacheReadTokens: 150, cacheWriteTokens: 17, noCacheTokens: 413 }, outputTokenDetails: { reasoningTokens: 14, textTokens: 76 } });
  expect(b.output).toEqual({ summary: 'Two shots.', count: 2 });
  expect(b.output).toEqual(a.output);
  expect(b.finished).toEqual(a.finished);
  /* The last step has the tool choice off and no tools, on a provider that is not Anthropic. */
  expect(b.asked[2]).toMatchObject({ toolChoice: { type: 'none' } }); expect(b.asked[2].tools).toBeUndefined();
  expect(b.asked[0].tools?.map((t) => t.name)).toEqual(['inspect_board', 'add', 'name', 'boom']);
  expect(b.asked[0].responseFormat).toMatchObject({ type: 'json' });
});

test('on Anthropic the last step keeps the tools defined and only turns the choice off', async () => {
  const { a, b } = await both({ provider: 'anthropic.messages', replies: [
    { ...toolsStep(call('c1', 'inspect_board', {})) }, { ...toolsStep(call('c2', 'inspect_board', {})) }, { content: [said('{"summary":"ok","count":1}')] },
  ] });
  expect(b.asked).toEqual(a.asked);
  expect(b.asked[2].toolChoice).toEqual({ type: 'none' }); expect(b.asked[2].tools?.length).toBe(4);
  expect(b.output).toEqual(a.output);
});

test('reasoning and the provider\'s metadata come back on the next step as provider options', async () => {
  const meta = { anthropic: { signature: 'sig-1' } };
  const { a, b } = await both({ provider: 'anthropic.messages', replies: [
    { content: [{ type: 'reasoning', text: 'thinking', providerMetadata: meta }, said('Looking.'), { ...call('c1', 'inspect_board', {}), providerMetadata: { anthropic: { cache: 'x' } } }], finishReason: { unified: 'tool-calls', raw: 'tool_use' } },
    { content: [said('{"summary":"ok","count":1}')] },
  ], maxSteps: 2 });
  expect(b.asked).toEqual(a.asked);
  expect(b.asked[1].prompt.find((m) => m.role === 'assistant')?.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'reasoning', providerOptions: meta })]));
  expect(b.steps).toEqual(a.steps);
});

test('the loop stops at the step limit even while the model keeps calling tools; output stays unset', async () => {
  const { a, b } = await both({ final: false, maxSteps: 2, replies: [{ ...toolsStep(call('c1', 'inspect_board', {})) }] });
  expect(b.asked).toHaveLength(2); expect(b.asked).toEqual(a.asked);
  expect(b.steps).toEqual(a.steps);
  expect(b.output).toBeUndefined(); expect(a.output).toBeUndefined();
});

test('a reply cut off at its length is not run and not repeated; its text is what is parsed', async () => {
  const { a, b } = await both({ replies: [{ content: [said('{"summary":"cut'), call('c1', 'add', { kind: 'still' })], finishReason: { unified: 'length', raw: 'max_tokens' } }] });
  expect(b.asked).toHaveLength(1); expect(b.asked).toEqual(a.asked);
  expect(b.started).toEqual([]); expect(a.started).toEqual([]);
  expect(message(b.error)).toBe(message(a.error));
  expect(b.error).toBeInstanceOf(ToolLoopOutputError);
});

test('an answer that is not the object asked for throws the same words, carrying what it used', async () => {
  for (const text of ['not json', '{"summary":"x"}']) {
    const { a, b } = await both({ replies: [{ content: [said(text)], usage: usage(50, 7, { raw: { n: 1 } }) }] });
    expect(message(b.error)).toBe(message(a.error));
    const own = b.error as ToolLoopOutputError;
    expect(own.usage).toEqual((a.error as { usage: unknown }).usage);
    expect(own.text).toBe(text);
    expect(own.stepUsage).toHaveLength(1);
  }
});

test('model JSON is refused exactly where ai\'s secure parse refuses it, and nowhere else', async () => {
  const inputs = [
    '{"__proto__":{"polluted":1},"kind":"still"}',
    '{"constructor":{"prototype":{"polluted":1}},"kind":"still"}',
    '{"kind":"still","n":4,"tags":["see __proto__ docs"]}',
    '{"kind":"clip","tags":["constructor"],"box":{"x":1}}',
  ];
  const { a, b } = await both({ replies: [
    { ...toolsStep(...inputs.map((input, i) => call(`p${i}`, 'add', input))) },
    { content: [said(JSON.stringify({ summary: 'see __proto__ docs', count: 1 }))] },
  ] });
  expect(b.error).toBeNull(); expect(a.error).toBeNull();
  expect(b.asked).toEqual(a.asked);
  expect(b.started).toEqual(a.started);
  expect(b.started).toEqual(['add:still:4', 'add:clip:1']);
  expect(b.steps).toEqual(a.steps);
  /* A mention inside a string is a valid answer, as `ai` takes it. */
  expect(b.output).toEqual({ summary: 'see __proto__ docs', count: 1 });
  expect(b.output).toEqual(a.output);
  /* And a final answer with the key is refused by both, in the same words. */
  for (const text of ['{"__proto__":{"x":1},"summary":"x","count":1}', '{"constructor":{"prototype":{}},"summary":"x","count":1}']) {
    const r = await both({ replies: [{ content: [said(text)] }] });
    expect(r.b.error).toBeInstanceOf(ToolLoopOutputError);
    expect(message(r.b.error)).toBe(message(r.a.error));
  }
});

test('with no tools and no output schema it is one plain call', async () => {
  const run = async (which: 'ai' | 'own') => {
    const { model, calls } = scripted([{ content: [said('Hello.')], usage: usage(9, 2, { raw: { a: 9 } }) }]);
    const common = { maxOutputTokens: 500, providerOptions: { openai: { imageDetail: 'low' } } as never };
    const messages: LoopMessage[] = [{ role: 'user', content: 'Say hello.' }];
    if (which === 'ai') {
      const r = await new ToolLoopAgent({ model, instructions: 'Be brief.', ...common, maxRetries: 0, stopWhen: isStepCount(1) }).generate({ prompt: 'Say hello.', abortSignal: AbortSignal.timeout(5000) });
      return { calls: calls.map(({ headers: _h, abortSignal: _s, ...rest }) => rest), text: r.text, usage: r.totalUsage, step: r.steps[0].usage, finishReason: r.finishReason };
    }
    const r = await runToolLoop({ model, instructions: 'Be brief.', ...common, maxSteps: 1, messages, abortSignal: AbortSignal.timeout(5000) });
    return { calls: calls.map(({ headers: _h, abortSignal: _s, ...rest }) => rest), text: r.text, usage: r.totalUsage, step: r.steps[0].usage, finishReason: r.finishReason };
  };
  const a = await run('ai'), b = await run('own');
  expect(b).toEqual(a);
  expect(b.calls[0].tools).toBeUndefined(); expect(b.calls[0].responseFormat).toBeUndefined();
});

test('a provider error on the second step is the error thrown, and the first step\'s usage rides on it', async () => {
  const failure = new Error('The provider said no.');
  const { a, b } = await both({ replies: [{ ...toolsStep(call('c1', 'inspect_board', {})), usage: usage(33, 4, { raw: { first: 1 } }) }, () => Promise.reject(failure) as never] });
  expect(b.error).toBe(failure); expect(a.error).toBe(failure);
  expect(b.asked).toEqual(a.asked);
  expect((failure as { toolLoopUsage?: unknown[] }).toolLoopUsage).toEqual([expect.objectContaining({ inputTokens: 33, outputTokens: 4, raw: { first: 1 } })]);
});

test('an abort between steps stops before the next call', async () => {
  let latest = new AbortController();
  const { a, b } = await both({ signal: () => { latest = new AbortController(); return latest.signal; }, replies: [() => { latest.abort(); return { ...toolsStep(call('c1', 'inspect_board', {})) }; }, { content: [said('{"summary":"ok","count":1}')] }] });
  expect(a.asked).toHaveLength(1);
  expect(b.asked).toHaveLength(1);
  expect((a.error as Error).name).toBe('AbortError');
  expect((b.error as Error).name).toBe((a.error as Error).name);
});

test('settings are checked as `ai` checks them', async () => {
  const { model } = scripted([{ content: [said('x')] }]);
  await expect(runToolLoop({ model, messages: MESSAGES, maxSteps: 1, maxOutputTokens: 0 })).rejects.toThrow('maxOutputTokens');
  await expect(runToolLoop({ model, messages: MESSAGES, maxSteps: 1, seed: 1.5 })).rejects.toThrow('seed');
  await expect(runToolLoop({ model, messages: MESSAGES, maxSteps: 0 })).rejects.toThrow('maxSteps');
  expect(() => v4Model('anthropic/claude-sonnet-5')).toThrow('v4');
});

test('an image given as a link is refused, never fetched', async () => {
  const { model, calls } = scripted([{ content: [said('x')] }]);
  await expect(runToolLoop({ model, maxSteps: 1, messages: [{ role: 'user', content: [{ type: 'image', image: 'https://example.com/a.png' }] }] })).rejects.toThrow('data URL');
  expect(calls).toHaveLength(0);
});

test('an image part by data URL or base64 reaches the provider as the same file part', async () => {
  const run = async (which: 'ai' | 'own') => {
    const { model, calls } = scripted([{ content: [said('ok')] }]);
    const parts = [{ type: 'text' as const, text: 'See.' }, { type: 'image' as const, image: `data:image/png;base64,${PNG}`, providerOptions: { openai: { imageDetail: 'low' } } }, { type: 'image' as const, image: PNG }];
    if (which === 'ai') await new ToolLoopAgent({ model, maxRetries: 0, stopWhen: isStepCount(1) }).generate({ messages: [{ role: 'user', content: parts }] as never });
    else await runToolLoop({ model, maxSteps: 1, messages: [{ role: 'user', content: parts }] });
    return calls.map(({ headers: _h, abortSignal: _s, ...rest }) => rest);
  };
  expect(await run('own')).toEqual(await run('ai'));
});

/* ── The same through the real provider SDKs, on a stubbed fetch: the exact HTTP request, and the usage the money path prices ── */
const KEYS = { ANTHROPIC_API_KEY: 'test-anthropic-key-never-sent', GEMINI_API_KEY: 'test-gemini-key-never-sent', XAI_API_KEY: 'test-xai-key-never-sent', OPENAI_API_KEY: 'test-openai-key-never-sent' };
const ENV = ['ENGINE_MOCK', 'TEXT_DIRECT', 'AI_GATEWAY_API_KEY', ...Object.keys(KEYS)] as const;
const saved = Object.fromEntries(ENV.map((name) => [name, process.env[name]]));
const originalFetch = globalThis.fetch;
test.beforeEach(() => { for (const name of ENV) delete process.env[name]; Object.assign(process.env, KEYS); process.env.TEXT_DIRECT = 'anthropic,google,xai'; globalThis.fetch = async () => { throw new Error('No real provider call is allowed in this test.'); }; });
test.afterEach(() => { globalThis.fetch = originalFetch; for (const name of ENV) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; } });

const VENDORS: { id: string; reply: (text: string) => unknown }[] = [
  { id: 'anthropic/claude-sonnet-5', reply: (text) => ({ id: 'msg_fixture', type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 100, cache_creation_input_tokens: 40, cache_read_input_tokens: 60, output_tokens: 25 } }) },
  { id: 'google/gemini-3.5-flash-lite', reply: (text) => ({ candidates: [{ content: { parts: [{ text }], role: 'model' }, finishReason: 'STOP', index: 0 }],
    usageMetadata: { promptTokenCount: 200, candidatesTokenCount: 30, thoughtsTokenCount: 50, cachedContentTokenCount: 120, totalTokenCount: 280 }, modelVersion: 'gemini-3.5-flash-lite', responseId: 'resp_google_fixture' }) },
  { id: 'spacexai/grok-4.6', reply: (text) => ({ id: 'resp_xai_fixture', object: 'response', created_at: 1, model: 'grok-4.6', status: 'completed',
    output: [{ type: 'message', id: 'msg_xai_fixture', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }],
    usage: { input_tokens: 150, input_tokens_details: { cached_tokens: 100 }, output_tokens: 40, output_tokens_details: { reasoning_tokens: 30 }, total_tokens: 190, cost_in_usd_ticks: 12345 } }) },
  { id: 'openai/gpt-6-astra', reply: (text) => ({ id: 'resp_fixture', object: 'response', created_at: 1, model: 'gpt-6-astra', status: 'completed',
    output: [{ type: 'message', id: 'msg_fixture', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }],
    usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 12 }, output_tokens: 20, output_tokens_details: { reasoning_tokens: 4 }, total_tokens: 120 } }) },
];

for (const vendor of VENDORS) {
  test(`${vendor.id}: the HTTP request and the usage are the same through both loops`, async () => {
    const wire = async (which: 'ai' | 'own') => {
      const sent: { url: string; body: unknown; names: string[] }[] = [];
      const fetch: typeof globalThis.fetch = async (url, init) => { sent.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null, names: [...new Headers(init?.headers).keys()].filter((n) => n !== 'user-agent' && !n.startsWith('x-stainless')).sort() }); return Response.json(vendor.reply('{"summary":"ok","count":1}')); };
      const model = languageModel(vendor.id, { auth: await languageAuth(vendor.id), fetch });
      const { defs } = kit();
      const common = { maxOutputTokens: 2000 };
      if (which === 'ai') {
        const r = await new ToolLoopAgent({ model, instructions: 'You plan.', ...common, maxRetries: 0, stopWhen: isStepCount(3), output: Output.object({ schema: Result }), tools: aiTools(defs) as never }).generate({ messages: MESSAGES as never, abortSignal: AbortSignal.timeout(10_000) });
        return { sent, steps: r.steps.map((s) => s.usage), total: r.totalUsage, output: r.output, priced: r.steps.map((s) => stepTextUsage(vendor.id, s.usage, true)) };
      }
      const r = await runToolLoop({ model: v4Model(model), instructions: 'You plan.', ...common, maxSteps: 3, output: Result, tools: ownTools(defs) as never, messages: MESSAGES, abortSignal: AbortSignal.timeout(10_000) });
      return { sent, steps: r.steps.map((s) => s.usage), total: r.totalUsage, output: r.output, priced: r.steps.map((s) => stepTextUsage(vendor.id, s.usage, true)) };
    };
    const a = await wire('ai'), b = await wire('own');
    expect(b.sent).toHaveLength(1);
    expect(b.sent).toEqual(a.sent);
    expect(b.steps).toEqual(a.steps);
    expect(b.total).toEqual(a.total);
    expect(b.output).toEqual(a.output);
    expect(b.priced).toEqual(a.priced);
    expect(b.steps[0].raw).toBeTruthy();
  });
}

test('Anthropic, two steps on the wire: the tool call, its result and the final answer are the same HTTP requests', async () => {
  const toolUse = { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: 'Looking.' }, { type: 'tool_use', id: 'toolu_1', name: 'add', input: { kind: 'still', n: 2 } }, { type: 'tool_use', id: 'toolu_2', name: 'boom', input: {} }],
    stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 90, cache_creation_input_tokens: 10, cache_read_input_tokens: 20, output_tokens: 15 } };
  const final = VENDORS[0].reply('{"summary":"done","count":2}');
  const wire = async (which: 'ai' | 'own') => {
    const sent: unknown[] = [];
    const fetch: typeof globalThis.fetch = async (_url, init) => { sent.push(JSON.parse(String(init?.body))); return Response.json(sent.length === 1 ? toolUse : final); };
    const model = languageModel('anthropic/claude-sonnet-5', { auth: await languageAuth('anthropic/claude-sonnet-5'), fetch });
    const { defs } = kit();
    const prepare = ({ stepNumber }: { stepNumber: number }) => (stepNumber >= 1 ? finalToolStep(model) : {});
    if (which === 'ai') {
      const r = await new ToolLoopAgent({ model, instructions: 'You plan.', maxOutputTokens: 2000, maxRetries: 0, stopWhen: isStepCount(2), output: Output.object({ schema: Result }), tools: aiTools(defs) as never, prepareStep: prepare as never }).generate({ messages: MESSAGES as never });
      return { sent, usage: r.steps.map((s) => s.usage), total: r.totalUsage, output: r.output };
    }
    const r = await runToolLoop({ model: v4Model(model), instructions: 'You plan.', maxOutputTokens: 2000, maxSteps: 2, output: Result, tools: ownTools(defs) as never, prepareStep: prepare, messages: MESSAGES });
    return { sent, usage: r.steps.map((s) => s.usage), total: r.totalUsage, output: r.output };
  };
  const a = await wire('ai'), b = await wire('own');
  expect(b.sent).toHaveLength(2);
  expect(b.sent).toEqual(a.sent);
  expect(b.usage).toEqual(a.usage);
  expect(b.total).toEqual(a.total);
  expect(b.total).toMatchObject({ inputTokens: 120 + 200, outputTokens: 15 + 25, inputTokenDetails: { cacheReadTokens: 80, cacheWriteTokens: 50 } });
  expect(b.output).toEqual(a.output);
});
