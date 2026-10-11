import { APICallError, generateText, Output, type LanguageModelUsage, type ModelMessage, type SystemModelMessage } from 'ai';
import type { JSONObject, JSONSchema7 } from '@ai-sdk/provider';
import { gatewayPost, type GatewayReply } from './gateway';
import { engineMock } from './mock';
import { assertTextProvider, sdkTextUsage } from './openai-direct';
import { languageModel } from './language-provider';
import { recoveryFetch } from './recovery';
import { directVendorOf, isDirectRoute, redactProviderError, textRoute, type DirectVendor } from './textRoute';

/**
 * The raw text seam (P4b). Callers send the OpenAI-compatible chat body they
 * already send through `gatewayPost` and get the same reply shape back.
 *
 * - Mock, OpenAI and every vendor not switched on in `TEXT_DIRECT` take
 *   today's path (`gatewayPost`), unchanged.
 * - Anthropic, Google and xAI, once switched on, go to their own API through
 *   `generateText` on the router's model, one attempt, no retries. The body is
 *   mapped to native options here, never in the callers.
 *
 * The direct reply carries no `cost`: the money paths charge its usage ×
 * the price snapshot (`directTextCostUsd`, lib/openai-direct.ts).
 */
export type TextPostOptions = {
  auth?: Record<string, string>; timeoutMs?: number;
  mock?: 'prompt' | 'turn' | 'idea' | 'scene' | 'shots' | 'memory';
  /** Tests inject the transport; production uses the recovery fetch. */
  fetch?: typeof fetch;
};

export async function textPost(body: string, opts: TextPostOptions = {}): Promise<GatewayReply> {
  if (engineMock()) return gatewayPost(body, opts);
  const input = record(JSON.parse(body));
  if (typeof input.model !== 'string') throw new Error('Choose a language model before submitting.');
  const route = textRoute(input.model);
  if (!isDirectRoute(route)) return gatewayPost(body, opts);
  assertTextProvider(input.model, opts.auth);
  return directTextPost(route, input, opts);
}

function record(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
const int = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** A refusal raised before anything was sent. The money paths settle it as declined, with nothing billed. */
export class TextNotSentError extends Error { readonly status = 422; override name = 'TextNotSentError'; }
function notSent(message: string): never { throw new TextNotSentError(message); }

/** What a log line may say about a provider failure: never the error object, whose request body carries the prompt. */
export function providerErrorSummary(error: unknown): string {
  const value = error && typeof error === 'object' ? error as { name?: unknown; statusCode?: unknown; code?: unknown; data?: unknown } : {};
  const nested = record(record(value.data).error);
  const code = value.code ?? nested.type ?? nested.code;
  return `${typeof value.name === 'string' ? value.name : 'Error'} status=${typeof value.statusCode === 'number' ? value.statusCode : '-'} code=${typeof code === 'string' || typeof code === 'number' ? code : '-'}`;
}

/** Claude models that take `effort` without adaptive thinking (as in developmentProviderOptions). */
const CLAUDE_EFFORT_ONLY = /^anthropic\/claude-(?:sonnet|opus|haiku)-(?:4|4\.5)$/;
const CLAUDE_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
/** Anthropic's documented per-image limit for base64 input. */
const ANTHROPIC_IMAGE_BYTES = 5 * 1024 * 1024;

type DirectFormat = { type: 'json'; schema?: JSONObject; name?: string } | null;
export type DirectTextRequest = {
  instructions?: SystemModelMessage[];
  messages: ModelMessage[];
  maxOutputTokens: number;
  temperature?: number; topP?: number; stopSequences?: string[];
  providerOptions: Record<string, JSONObject>;
  responseFormat: DirectFormat;
};

function text(content: unknown, what: string): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content) && content.every(part => record(part).type === 'text' && typeof record(part).text === 'string'))
    return content.map(part => String(record(part).text)).join('');
  return notSent(`The direct language request has unsupported ${what} content.`);
}

function image(vendor: DirectVendor, part: Record<string, unknown>) {
  const url = record(part.image_url).url, detail = record(part.image_url).detail;
  const data = typeof url === 'string' ? /^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(url) : null;
  // Only inline pictures: a remote URL would have the provider (or the SDK) fetch it.
  if (!data) return notSent('The direct language request accepts only inline (data URL) images.');
  const base64 = data[2].replace(/\s+/g, '');
  if (vendor === 'anthropic' && Math.floor(base64.length * 3 / 4) > ANTHROPIC_IMAGE_BYTES) notSent('An image is larger than the provider accepts (5 MB). Use a smaller picture.');
  return { type: 'file' as const, data: base64, mediaType: data[1].toLowerCase(),
    ...(vendor === 'xai' && typeof detail === 'string' && ['low', 'high', 'auto'].includes(detail) ? { providerOptions: { xai: { imageDetail: detail } } } : {}) };
}

function messages(vendor: DirectVendor, value: unknown): Pick<DirectTextRequest, 'instructions' | 'messages'> {
  if (!Array.isArray(value) || !value.length) notSent('The direct language request needs messages.');
  const instructions: SystemModelMessage[] = [], out: ModelMessage[] = [];
  for (const raw of value) {
    const item = record(raw), role = String(item.role);
    if (item.tool_calls || item.function_call || !['system', 'developer', 'user', 'assistant'].includes(role)) notSent('Use the native agent transport for language tool calls.');
    // Anthropic's prompt-cache mark, which the gateway honoured, stays on the same message.
    const cache = vendor === 'anthropic' && record(item.cache_control).type === 'ephemeral' ? { providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' as const } } } } : {};
    if (role === 'system' || role === 'developer') {
      if (out.length) notSent('The direct language request has a system message after the conversation started.');
      instructions.push({ role: 'system', content: text(item.content, 'system'), ...cache });
    } else if (role === 'assistant') {
      out.push({ role: 'assistant', content: text(item.content, 'assistant'), ...cache });
    } else if (typeof item.content === 'string') {
      out.push({ role: 'user', content: item.content, ...cache });
    } else if (Array.isArray(item.content)) {
      out.push({ role: 'user', ...cache, content: item.content.map((raw) => {
        const part = record(raw);
        if (part.type === 'text' && typeof part.text === 'string') return { type: 'text' as const, text: part.text };
        if (part.type === 'image_url') return image(vendor, part);
        return notSent('The direct language request has unsupported message content.');
      }) });
    } else notSent('The direct language request has unsupported message content.');
  }
  if (!out.length) notSent('The direct language request needs a user message.');
  return { ...(instructions.length ? { instructions } : {}), messages: out };
}

/** `reasoning`, `reasoning_effort` and `providerOptions` → the vendor's native options. */
function reasoning(vendor: DirectVendor, model: string, input: Record<string, unknown>, maxTokens: number) {
  const given = record(input.providerOptions);
  const own = { ...record(given[vendor]) } as JSONObject;   // other vendors' options (gateway routing, vertex, openai) are dropped
  const fields = input.reasoning === undefined ? null : record(input.reasoning);
  const budget = fields?.enabled === true ? fields.max_tokens : undefined;
  const off = fields?.enabled === false || input.reasoning_effort === 'none';
  const effort = input.reasoning_effort === undefined || input.reasoning_effort === 'none' ? undefined : String(input.reasoning_effort);
  if (fields && fields.enabled !== false && !(fields.enabled === true && int(budget) && budget > 0)) notSent('This reasoning setting is not available for direct requests.');
  if (int(budget) && budget >= maxTokens) notSent('The reasoning budget must leave room for the answer.');
  let maxOutputTokens = maxTokens;
  if (vendor === 'anthropic') {
    if (off) own.thinking = { type: 'disabled' };
    else if (int(budget)) {
      own.thinking = { type: 'enabled', budgetTokens: budget };
      // The SDK adds the budget back onto max_tokens; the approved ceiling already includes it.
      maxOutputTokens = maxTokens - budget;
    } else if (effort !== undefined) {
      if (!CLAUDE_EFFORTS.has(effort)) notSent(`That effort setting is not available for ${model}.`);
      own.effort = effort;
      if (!CLAUDE_EFFORT_ONLY.test(model)) own.thinking = { type: 'adaptive' };
    }
  } else if (vendor === 'google') {
    const thinkingConfig = { ...record(own.thinkingConfig) } as JSONObject;
    if (off) thinkingConfig.thinkingBudget = 0;
    else if (int(budget)) thinkingConfig.thinkingBudget = budget;
    else if (effort !== undefined) thinkingConfig.thinkingLevel = effort;
    if (Object.keys(thinkingConfig).length) own.thinkingConfig = thinkingConfig;
  } else {
    if (int(budget)) notSent(`A reasoning token budget is not available for ${model}.`);
    if (off) own.reasoningEffort = 'none';
    else if (effort !== undefined) own.reasoningEffort = effort;
  }
  return { maxOutputTokens, providerOptions: Object.keys(own).length ? { [vendor]: own } : {} };
}

/** Map one OpenAI-compatible chat body to a native request. Pure; refuses anything it cannot carry faithfully. */
export function directTextRequest(vendor: DirectVendor, input: Record<string, unknown>): DirectTextRequest {
  const model = String(input.model);
  if (input.stream || input.tools || input.functions || input.tool_choice || input.modalities || (input.n !== undefined && input.n !== 1))
    notSent('This language request needs its dedicated native transport.');
  const maxTokens = input.max_completion_tokens ?? input.max_tokens;
  // The paid path always bounds the answer; an unbounded direct call is never sent.
  if (!int(maxTokens) || maxTokens < 1) notSent('The direct language request needs max_tokens.');
  const format = record(input.response_format);
  let responseFormat: DirectFormat = null;
  if (format.type === 'json_object') responseFormat = { type: 'json' };
  else if (format.type === 'json_schema') {
    const spec = record(format.json_schema);
    if (!spec.schema || typeof spec.schema !== 'object') notSent('The JSON schema response format needs a schema.');
    responseFormat = { type: 'json', schema: spec.schema as JSONObject, ...(typeof spec.name === 'string' ? { name: spec.name } : {}) };
  } else if (format.type !== undefined && format.type !== 'text') notSent('This language response format is unsupported.');
  const stop = input.stop === undefined ? undefined : Array.isArray(input.stop) ? input.stop.map(String) : [String(input.stop)];
  return {
    ...messages(vendor, input.messages),
    ...reasoning(vendor, model, input, maxTokens),
    ...(typeof input.temperature === 'number' ? { temperature: input.temperature } : {}),
    ...(typeof input.top_p === 'number' ? { topP: input.top_p } : {}),
    ...(stop ? { stopSequences: stop } : {}),
    responseFormat,
  };
}

/**
 * Provider usage → the OpenAI-compatible usage the money paths read, from the
 * provider's own `raw` usage (the SDK's normalised totals can leave out cache
 * or thought tokens). Pass a step's usage (`result.steps[n].usage`): the
 * aggregate `result.usage` has no `raw`. A count the provider did not report
 * stays undefined, so pricing it returns null rather than a guess.
 * - Anthropic: `input_tokens` excludes cache reads and writes; prompt = all three.
 * - Google: `promptTokenCount` already includes cached tokens; thought tokens are
 *   billed as output, so completion = candidates + thoughts (a missing candidates
 *   count leaves completion unknown). No cache writes.
 * - xAI: `input_tokens` includes cached tokens; `output_tokens` includes
 *   reasoning. No cache writes. `cost_in_usd_ticks` is kept for comparison only.
 */
export function directTextUsage(vendor: DirectVendor, usage: Pick<LanguageModelUsage, 'raw'>) {
  const raw = record(usage.raw);
  const zeroIfNull = (value: unknown) => value === null ? 0 : value;
  const sum = (...values: unknown[]) => values.every(int) ? (values as number[]).reduce((a, b) => a + b, 0) : undefined;
  if (vendor === 'anthropic') {
    const read = zeroIfNull(raw.cache_read_input_tokens), write = zeroIfNull(raw.cache_creation_input_tokens);
    return { prompt_tokens: sum(raw.input_tokens, read, write), completion_tokens: int(raw.output_tokens) ? raw.output_tokens : undefined,
      prompt_tokens_details: { cached_tokens: int(read) ? read : undefined, cache_write_tokens: int(write) ? write : undefined } };
  }
  if (vendor === 'google') {
    const cached = raw.cachedContentTokenCount ?? 0;
    const thoughts = raw.thoughtsTokenCount ?? 0;
    // A missing candidates count is unknown output, never zero: the caller then follows its uncertain-usage rule.
    return { prompt_tokens: sum(raw.promptTokenCount, raw.toolUsePromptTokenCount ?? 0), completion_tokens: sum(raw.candidatesTokenCount, thoughts),
      prompt_tokens_details: { cached_tokens: int(cached) ? cached : undefined, cache_write_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: int(thoughts) ? thoughts : undefined } };
  }
  const cached = record(raw.input_tokens_details).cached_tokens ?? 0, reasoningTokens = record(raw.output_tokens_details).reasoning_tokens;
  // xAI's input count includes cached tokens; the SDK guards the one shape where it does not.
  const prompt = int(raw.input_tokens) && int(cached) ? (cached <= raw.input_tokens ? raw.input_tokens : raw.input_tokens + cached) : undefined;
  return { prompt_tokens: prompt, completion_tokens: int(raw.output_tokens) ? raw.output_tokens : undefined,
    prompt_tokens_details: { cached_tokens: int(cached) ? cached : undefined, cache_write_tokens: 0 },
    ...(int(reasoningTokens) ? { completion_tokens_details: { reasoning_tokens: reasoningTokens } } : {}) };
}

/**
 * One SDK step's usage in the OpenAI-compatible shape the money paths price,
 * for agents (suite, 3D blocking, development, the rig planner) that call
 * `languageModel()` themselves. `direct` is whether the call took a direct
 * door (`isDirectText`): its vendor then follows from the app id, and the
 * provider's own raw counts are read (cache reads and writes, thought tokens).
 * A gateway step keeps the SDK's normalised totals, as before.
 */
export function stepTextUsage(model: string, usage: LanguageModelUsage, direct: boolean) {
  if (!direct) return sdkTextUsage(usage, false);
  const vendor = directVendorOf(model);
  return vendor ? directTextUsage(vendor, usage) : sdkTextUsage(usage, true);
}

const FINISH: Record<string, string> = { stop: 'stop', length: 'length', 'content-filter': 'content_filter', 'tool-calls': 'tool_calls', error: 'error' };

async function directTextPost(vendor: DirectVendor, input: Record<string, unknown>, opts: TextPostOptions): Promise<GatewayReply> {
  const reply = (status: number, message: string) => ({ ok: false, status, text: JSON.stringify({ provider: vendor, error: { message: message.slice(0, 400) } }) });
  let sent = false;
  try {
    const request = directTextRequest(vendor, input);
    const fetcher = opts.fetch ?? recoveryFetch;
    const model = languageModel(String(input.model), { auth: opts.auth ?? {}, fetch: (url, init) => { sent = true; return fetcher(url, init); } });
    const format = request.responseFormat;
    // The text output spec with a JSON response format: the provider is asked for
    // JSON, and the answer is returned as text without the SDK's eager parse
    // throwing away a paid reply that does not validate.
    const output = format ? { ...Output.text(), responseFormat: Promise.resolve(format.schema ? { type: 'json' as const, schema: format.schema as JSONSchema7, ...(format.name ? { name: format.name } : {}) } : { type: 'json' as const }) } : undefined;
    const result = await generateText({
      model, maxRetries: 0, abortSignal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
      ...(request.instructions ? { instructions: request.instructions } : {}), messages: request.messages,
      maxOutputTokens: request.maxOutputTokens, temperature: request.temperature, topP: request.topP, stopSequences: request.stopSequences,
      providerOptions: request.providerOptions, ...(output ? { output } : {}),
    });
    // The step's usage carries the provider's raw counts; the aggregate drops them. No tools, so one step.
    const usage = result.steps.length === 1 ? result.steps[0].usage : { raw: undefined };
    return { ok: true, status: 200, text: JSON.stringify({
      id: result.response.id, model: result.response.modelId, provider: vendor,
      choices: [{ index: 0, message: { role: 'assistant', content: result.text }, finish_reason: FINISH[result.finishReason] ?? 'stop' }],
      usage: directTextUsage(vendor, usage),
      provider_usage: usage.raw ?? null,
    }) };
  } catch (error) {
    // Name, status and code only: an APICallError carries the request body, prompt included.
    console.warn(`direct text ${vendor}: ${sent ? 'failed' : 'not sent'} ${providerErrorSummary(error)}`);
    if (!sent) {
      if (error instanceof TextNotSentError) return reply(error.status, error.message);
      // Missing key, unmapped id, refused endpoint or a request the SDK rejected locally: nothing left the process.
      return reply(422, error instanceof Error ? error.message : 'The direct language request was not sent.');
    }
    if (APICallError.isInstance(error) && typeof error.statusCode === 'number' && error.statusCode >= 400)
      return reply(error.statusCode, error.message);
    // Sent, with no readable provider status (timeout, network, redirect): the caller treats it as uncertain.
    // Rethrown without the request body, so an upstream log of the whole error cannot print the prompt.
    throw redactProviderError(error);
  }
}
