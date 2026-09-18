import { openAIHasCacheReads, openAIHasCacheWrites, textCostUsd, type CatalogModel } from './catalog';
import type { LanguageModelUsage } from 'ai';
import { vendorKey } from './vendorKeys';
import { recoveryFetch } from './recovery';
import type { GatewayReply } from './gateway';

export type TextVendor = 'openai' | 'gateway';
export const TEXT_PROVIDER_HEADER = 'X-Particl-Text-Provider';
export const OPENAI_BASE = () => 'https://api.openai.com/v1';
export function directOpenAIKey(model: string) { return model.startsWith('openai/') ? vendorKey('openai') : null; }
export function textVendor(model: string): TextVendor { return directOpenAIKey(model) ? 'openai' : 'gateway'; }
/** Strip only the catalog owner. Aliases are never translated into another model. */
export function openAIModelId(model: string) {
  if (!model.startsWith('openai/') || !model.slice(7) || model.slice(7).includes('/')) throw new Error('Choose an exact OpenAI model ID.');
  return model.slice(7);
}
/** GPT-3.5 and the original GPT-4 family use Chat Completions. Modern models
 * use Responses, including GPT-6 tool calling and Codex/pro models. */
export function usesOpenAIResponses(model: string) { return !/^gpt-(?:3\.5(?:-|$)|4(?:-|$))/.test(openAIModelId(model)); }
export function assertTextProvider(model: string, auth?: Record<string, string>) {
  const expected = auth?.[TEXT_PROVIDER_HEADER];
  if (expected && expected !== textVendor(model)) throw new Error('The selected provider connection changed after approval. Review a new request before continuing.');
}
/** Credentials are sent only to the two official language endpoints. Redirects
 * are rejected before a client can forward an authenticated request elsewhere. */
export function openAIFetch(fetcher: typeof fetch): typeof fetch {
  return (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== 'https://api.openai.com' || !['/v1/responses', '/v1/chat/completions'].includes(url.pathname)) throw new Error('The OpenAI language endpoint is not supported.');
    return fetcher(input, { ...init, redirect: 'error' });
  };
}
function record(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
/** Preserve the provider's original per-call details. The SDK normalizes an
 * absent cache-read count to zero, so its aggregate/defaulted fields alone do
 * not establish whether a direct OpenAI response supplied billing telemetry. */
export function sdkTextUsage(usage: LanguageModelUsage, directOpenAI: boolean) {
  if (directOpenAI) {
    const raw = record(usage.raw);
    return {
      prompt_tokens: raw.input_tokens ?? raw.prompt_tokens ?? usage.inputTokens,
      completion_tokens: raw.output_tokens ?? raw.completion_tokens ?? usage.outputTokens,
      prompt_tokens_details: raw.input_tokens_details ?? raw.prompt_tokens_details,
      completion_tokens_details: raw.output_tokens_details ?? raw.completion_tokens_details,
    };
  }
  return { prompt_tokens: usage.inputTokens, completion_tokens: usage.outputTokens };
}

/** Price direct OpenAI usage against the pre-submission catalog snapshot.
 * Unknown applicable cache categories remain unknown instead of becoming zero. */
export function directTextCostUsd(model: CatalogModel, value: unknown): number | null {
  const usage = record(value), details = record(usage.prompt_tokens_details);
  const input = usage.prompt_tokens, output = usage.completion_tokens;
  if (![input, output].every(n => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0)) return null;
  const p = model.pricing ?? {};
  const readRequired = openAIHasCacheReads(model.id) || 'input_cache_read' in p || 'input_cache_read_tiers' in p;
  const writeRequired = openAIHasCacheWrites(model.id) || 'input_cache_write' in p || 'input_cache_write_tiers' in p;
  const read = details.cached_tokens === undefined && !readRequired ? 0 : details.cached_tokens;
  const write = details.cache_write_tokens === undefined && !writeRequired ? 0 : details.cache_write_tokens;
  if (![read, write].every(n => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0)) return null;
  return textCostUsd(model, input as number, output as number, { cacheReadTokens: read as number, cacheWriteTokens: write as number });
}

function messages(value: unknown, responses: boolean) {
  if (!Array.isArray(value) || !value.length) throw new Error('The direct OpenAI request needs messages.');
  return value.map((value) => {
    const item = record(value), role = item.role;
    if (!['system', 'developer', 'user', 'assistant'].includes(String(role)) || item.tool_calls) throw new Error('Use the native agent transport for OpenAI tool calls.');
    if (typeof item.content === 'string') return { role, content: item.content };
    if (!Array.isArray(item.content)) throw new Error('The direct OpenAI request has unsupported message content.');
    const content = item.content.map((part) => {
      const block = record(part);
      if (block.type === 'text' && typeof block.text === 'string') return { type: responses ? 'input_text' : 'text', text: block.text };
      const image = record(block.image_url);
      if (block.type === 'image_url' && typeof image.url === 'string' && role === 'user') return responses ? { type: 'input_image', image_url: image.url, ...(image.detail ? { detail: image.detail } : {}) } : { type: 'image_url', image_url: image };
      throw new Error('The direct OpenAI request has unsupported message content.');
    });
    // Assistant history in Responses uses a text string; the app never injects
    // provider reasoning or model-generated images into this raw-text path.
    if (responses && role === 'assistant') return { role, content: content.map((part) => 'text' in part ? part.text : '').join('') };
    return { role, content };
  });
}

/** Adapt the app's bounded non-streaming chat wire format to the direct API.
 * Tool loops use @ai-sdk/openai instead; there is no transport retry here. */
export function openAIDirectBody(input: Record<string, unknown>) {
  if (typeof input.model !== 'string') throw new Error('The direct OpenAI request needs a model.');
  if (input.stream || input.tools || input.functions || input.modalities) throw new Error('This OpenAI request needs its dedicated native transport.');
  const responses = usesOpenAIResponses(input.model), model = openAIModelId(input.model);
  const options = record(record(input.providerOptions).openai);
  const effort = input.reasoning_effort ?? options.reasoningEffort;
  const maxTokens = input.max_completion_tokens ?? input.max_tokens;
  const reasoningModel = /^(?:o\d|gpt-(?:[5-9]|\d{2,}))/.test(model);
  const body: Record<string, unknown> = { model, store: false, [responses ? 'input' : 'messages']: messages(input.messages, responses) };
  if (maxTokens !== undefined) body[responses ? 'max_output_tokens' : 'max_tokens'] = maxTokens;
  if (!reasoningModel) {
    if (input.temperature !== undefined) body.temperature = input.temperature;
    if (input.top_p !== undefined) body.top_p = input.top_p;
  }
  if (responses) {
    if (effort !== undefined || options.reasoningMode !== undefined) body.reasoning = { ...(effort !== undefined ? { effort } : {}), ...(options.reasoningMode !== undefined ? { mode: options.reasoningMode } : {}) };
    const format = record(input.response_format);
    if (format.type === 'json_schema') body.text = { format: { type: 'json_schema', ...record(format.json_schema) } };
    else if (format.type === 'json_object') body.text = { format: { type: 'json_object' } };
    else if (format.type && format.type !== 'text') throw new Error('This OpenAI response format is unsupported.');
  } else {
    if (input.response_format !== undefined) body.response_format = input.response_format;
    if (input.stop !== undefined) body.stop = input.stop;
  }
  return { endpoint: responses ? 'responses' : 'chat/completions', body };
}
function gatewayResponse(value: Record<string, unknown>) {
  const usage = record(value.usage), details = record(value.incomplete_details);
  const content: string[] = [], refusals: string[] = [];
  for (const item of Array.isArray(value.output) ? value.output : []) {
    const output = record(item);
    if (output.type !== 'message') continue;
    for (const item of Array.isArray(output.content) ? output.content : []) {
      const part = record(item);
      if (part.type === 'output_text' && typeof part.text === 'string') content.push(part.text);
      if (part.type === 'refusal' && typeof part.refusal === 'string') refusals.push(part.refusal);
    }
  }
  return { id: value.id, model: value.model, provider: 'openai', choices: [{ index: 0, message: { role: 'assistant', content: content.join(''), ...(refusals.length ? { refusal: refusals.join('') } : {}) }, finish_reason: refusals.length ? 'content_filter' : details.reason === 'max_output_tokens' ? 'length' : value.status === 'failed' ? 'error' : 'stop' }],
    usage: { prompt_tokens: usage.input_tokens, completion_tokens: usage.output_tokens, total_tokens: usage.total_tokens, prompt_tokens_details: usage.input_tokens_details, completion_tokens_details: usage.output_tokens_details }, ...(value.error ? { error: value.error } : {}) };
}
export async function openaiDirectPost(input: Record<string, unknown>, options: { timeoutMs?: number; fetch?: typeof fetch } = {}): Promise<GatewayReply> {
  const key = typeof input.model === 'string' ? directOpenAIKey(input.model) : null;
  if (!key) throw new Error('OpenAI is not connected for this workspace.');
  const { endpoint, body } = openAIDirectBody(input);
  const response = await openAIFetch(options.fetch ?? recoveryFetch)(`${OPENAI_BASE()}/${endpoint}`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(options.timeoutMs ?? 120000) });
  const raw = await response.text();
  let result: Record<string, unknown>;
  try { result = record(JSON.parse(raw)); }
  catch { return { ok: false, status: response.ok ? 502 : response.status, text: JSON.stringify({ provider: 'openai', error: { message: 'OpenAI returned an unreadable response. This request will not be retried automatically.' } }) }; }
  return { ok: response.ok, status: response.status, text: JSON.stringify(response.ok && endpoint === 'responses' ? gatewayResponse(result) : { ...result, provider: 'openai' }) };
}
