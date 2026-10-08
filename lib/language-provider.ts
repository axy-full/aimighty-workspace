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
import { DIRECT_BASE_URL, DIRECT_KEY, directFetch, directKey, directModelId, isDirectRoute, textRoute, type DirectVendor } from './textRoute';
import { textDirectVendors } from './textDirectVendors';
export function languageReachable() {
  return gatewayReachable() || !!vendorKey('openai') || [...textDirectVendors()].some(vendor => !!vendorKey(DIRECT_KEY[vendor]));
}
export async function languageAuth(model: string): Promise<Record<string, string>> {
  const route = textRoute(model);
  if (isDirectRoute(route)) return { Authorization: `Bearer ${directKey(route)}`, [TEXT_PROVIDER_HEADER]: route };
  const key = directOpenAIKey(model);
  return key ? { Authorization: `Bearer ${key}`, [TEXT_PROVIDER_HEADER]: 'openai' } : { ...await gatewayAuth(), [TEXT_PROVIDER_HEADER]: 'gateway' };
}
/** One provider's own SDK, on its own key, own origin and the exact mapped id.
 * The key is read here, never taken from the caller's headers. */
function directLanguageModel(vendor: DirectVendor, model: string, fetcher: typeof fetch): LanguageModel {
  const id = directModelId(model), apiKey = directKey(vendor);
  const settings = { apiKey, baseURL: DIRECT_BASE_URL[vendor], fetch: directFetch(vendor, fetcher) };
  if (vendor === 'anthropic') return createAnthropic(settings).languageModel(id);
  if (vendor === 'google') return createGoogleGenerativeAI(settings).languageModel(id);
  return createXai(settings).languageModel(id);
}
/** Provider choice is made once before the first SDK call. A failed direct
 * attempt never falls back to Gateway or another provider, and never silently
 * changes model IDs. Callers pass `maxRetries: 0`. */
export function languageModel(model: string, options: { auth: Record<string, string>; fetch?: typeof fetch }): LanguageModel {
  assertTextProvider(model, options.auth);
  const fetcher = options.fetch ?? recoveryFetch;
  const route = textRoute(model);
  if (route === 'openai') {
    const openai = createOpenAI({ apiKey: directOpenAIKey(model)!, baseURL: OPENAI_BASE(), fetch: openAIFetch(fetcher) });
    const selected = usesOpenAIResponses(model) ? openai.responses(openAIModelId(model)) : openai.chat(openAIModelId(model));
    return wrapLanguageModel({ model: selected, middleware: { transformParams: async ({ params }) => ({ ...params, providerOptions: { ...params.providerOptions, openai: { ...params.providerOptions?.openai, store: false } } }) } });
  }
  if (isDirectRoute(route)) return directLanguageModel(route, model, fetcher);
  const auth = { ...options.auth }; delete auth[TEXT_PROVIDER_HEADER];
  const token = auth.Authorization?.replace(/^Bearer\s+/i, '');
  if (!token) throw new Error('The selected language provider is not connected for this workspace.');
  const gateway = createGateway({ apiKey: token, headers: { ...auth, 'ai-gateway-auth-method': auth['ai-gateway-auth-method'] ?? (vendorKey('gateway') ? 'api-key' : 'oidc') }, baseURL: new URL('/v4/ai', GATEWAY_BASE()).href, fetch: fetcher });
  return gateway(model);
}
