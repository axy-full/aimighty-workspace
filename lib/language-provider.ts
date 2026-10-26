import { createOpenAI } from '@ai-sdk/openai';
import { createGateway } from '@ai-sdk/gateway';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createXai } from '@ai-sdk/xai';
import { wrapLanguageModel, type LanguageModel } from 'ai';
import { gatewayAuth, gatewayReachable, GATEWAY_BASE } from './gateway';
import { vendorKey } from './vendorKeys';
import { recoveryFetch } from './recovery';
import { assertTextProvider, directOpenAIKey, OPENAI_BASE, openAIFetch, openAIModelId, TEXT_PROVIDER_HEADER, usesOpenAIResponses } from './openai-direct';
import { ANTHROPIC_NO_TOOL_HEADER, DIRECT_BASE_URL, DIRECT_KEY, directFetch, directKey, directModelId, isDirectRoute, redactProviderError, textRoute, type DirectVendor } from './textRoute';
import { listedTextDirectVendors } from './textDirectVendors';
import { geminiSafetyProviderOptions } from './geminiSafety';
/** A direct door that TEXT_DIRECT lists, with its key: text that needs neither the gateway nor OpenAI. Gemini is always direct (lib/textDirectVendors.ts) but its key alone does not
 * make this true: the default writers are Claude, so a Gemini key (also the stills key) must not switch a deployment's default writer to the router. */
export function directTextReachable() {
  return [...listedTextDirectVendors()].some(vendor => !!vendorKey(DIRECT_KEY[vendor]));
}
export function languageReachable() {
  return gatewayReachable() || !!vendorKey('openai') || directTextReachable();
}
/**
 * The last step of a tool loop, where no tool may be called. Hardening: on
 * Anthropic's direct door the tools stay defined while the history holds tool
 * calls and `tool_choice: none` is sent (ANTHROPIC_NO_TOOL_HEADER); elsewhere
 * they are removed as well, since a provider may ignore the choice.
 */
export function finalToolStep(model: LanguageModel): { toolChoice: 'none'; activeTools?: never[] } {
  const provider = typeof model === 'string' ? '' : model.provider;
  return provider.startsWith('anthropic') ? { toolChoice: 'none' } : { toolChoice: 'none', activeTools: [] };
}
export async function languageAuth(model: string): Promise<Record<string, string>> {
  const route = textRoute(model);
  if (isDirectRoute(route)) return { Authorization: `Bearer ${directKey(route)}`, [TEXT_PROVIDER_HEADER]: route };
  const key = directOpenAIKey(model);
  return key ? { Authorization: `Bearer ${key}`, [TEXT_PROVIDER_HEADER]: 'openai' } : { ...await gatewayAuth(), [TEXT_PROVIDER_HEADER]: 'gateway' };
}
/** The one Gemini safety configuration (lib/geminiSafety.ts) on a language request, over whatever else its Google options hold. */
function withGeminiSafety<P extends { providerOptions?: Record<string, Record<string, unknown>> }>(params: P): P {
  const safety = geminiSafetyProviderOptions();
  return { ...params, providerOptions: { ...params.providerOptions, google: { ...params.providerOptions?.google, ...safety.google }, vertex: { ...params.providerOptions?.vertex, ...safety.vertex } } } as P;
}
/** One provider's own SDK, on its own key, own origin and the exact mapped id.
 * The key is read here (or is a caller's own key, passed in explicitly), never taken from the caller's headers. */
function directLanguageModel(vendor: DirectVendor, model: string, fetcher: typeof fetch, ownKey?: string): LanguageModel {
  /* A caller's own key replaces the platform's; the platform's key is then not read at all. */
  if (ownKey !== undefined && !ownKey) throw new Error('The caller key for this direct language door is empty; nothing was sent.');
  const id = directModelId(model), apiKey = ownKey ?? directKey(vendor);
  const settings = { apiKey, baseURL: DIRECT_BASE_URL[vendor], fetch: directFetch(vendor, fetcher) };
  const native = vendor === 'anthropic' ? createAnthropic(settings).languageModel(id)
    : vendor === 'google' ? createGoogleGenerativeAI(settings).languageModel(id)
    : createXai(settings).languageModel(id);
  // Provider errors leave without the request body, so no caller's log can print the prompt.
  return wrapLanguageModel({ model: native, middleware: {
    // Anthropic: keep the tools on a no-tool step (see ANTHROPIC_NO_TOOL_HEADER); the fetch guard sets tool_choice none.
    transformParams: async ({ params }) => vendor === 'anthropic' && params.toolChoice?.type === 'none' && params.tools?.length
      ? { ...params, toolChoice: { type: 'auto' }, headers: { ...params.headers, [ANTHROPIC_NO_TOOL_HEADER]: '1' } }
      : vendor === 'google' ? withGeminiSafety(params) : params,
    wrapGenerate: async ({ doGenerate }) => { try { return await doGenerate(); } catch (error) { throw redactProviderError(error); } },
    wrapStream: async ({ doStream }) => { try { return await doStream(); } catch (error) { throw redactProviderError(error); } },
  } });
}
/** Provider choice is made once before the first SDK call. A failed direct
 * attempt never falls back to Gateway or another provider, and never silently
 * changes model IDs. Callers pass `maxRetries: 0`. */
export function languageModel(model: string, options: { auth: Record<string, string>; fetch?: typeof fetch; apiKey?: string }): LanguageModel {
  assertTextProvider(model, options.auth);
  const fetcher = options.fetch ?? recoveryFetch;
  const route = textRoute(model);
  /* A caller's own key is for a direct door only: it never reaches OpenAI or the gateway. */
  if (options.apiKey !== undefined && !isDirectRoute(route)) throw new Error('A caller key is accepted only for a direct language door; nothing was sent.');
  if (route === 'openai') {
    const openai = createOpenAI({ apiKey: directOpenAIKey(model)!, baseURL: OPENAI_BASE(), fetch: openAIFetch(fetcher) });
    const selected = usesOpenAIResponses(model) ? openai.responses(openAIModelId(model)) : openai.chat(openAIModelId(model));
    return wrapLanguageModel({ model: selected, middleware: { transformParams: async ({ params }) => ({ ...params, providerOptions: { ...params.providerOptions, openai: { ...params.providerOptions?.openai, store: false } } }) } });
  }
  if (isDirectRoute(route)) return directLanguageModel(route, model, fetcher, options.apiKey);
  const auth = { ...options.auth }; delete auth[TEXT_PROVIDER_HEADER];
  const token = auth.Authorization?.replace(/^Bearer\s+/i, '');
  if (!token) throw new Error('The selected language provider is not connected for this workspace.');
  const gateway = createGateway({ apiKey: token, headers: { ...auth, 'ai-gateway-auth-method': auth['ai-gateway-auth-method'] ?? (vendorKey('gateway') ? 'api-key' : 'oidc') }, baseURL: new URL('/v4/ai', GATEWAY_BASE()).href, fetch: fetcher });
  /* A Gemini model the gateway serves carries the same safety settings as one called directly (lib/geminiSafety.ts). */
  return model.startsWith('google/') ? wrapLanguageModel({ model: gateway(model), middleware: { transformParams: async ({ params }) => withGeminiSafety(params) } }) : gateway(model);
}
