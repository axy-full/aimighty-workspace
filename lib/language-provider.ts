import { createOpenAI } from '@ai-sdk/openai';
import { createGateway } from '@ai-sdk/gateway';
import { wrapLanguageModel, type LanguageModel } from 'ai';
import { gatewayAuth, gatewayReachable, GATEWAY_BASE } from './gateway';
import { vendorKey } from './vendorKeys';
import { recoveryFetch } from './recovery';
import { assertTextProvider, directOpenAIKey, OPENAI_BASE, openAIFetch, openAIModelId, TEXT_PROVIDER_HEADER, textVendor, usesOpenAIResponses } from './openai-direct';
export function languageReachable() { return gatewayReachable() || !!vendorKey('openai'); }
export async function languageAuth(model: string): Promise<Record<string, string>> {
  const key = directOpenAIKey(model);
  return key ? { Authorization: `Bearer ${key}`, [TEXT_PROVIDER_HEADER]: 'openai' } : { ...await gatewayAuth(), [TEXT_PROVIDER_HEADER]: 'gateway' };
}
/** Provider choice is made once before the first SDK call. A failed direct
 * OpenAI attempt never falls back to Gateway or silently changes model IDs. */
export function languageModel(model: string, options: { auth: Record<string, string>; fetch?: typeof fetch }): LanguageModel {
  assertTextProvider(model, options.auth);
  const fetcher = options.fetch ?? recoveryFetch;
  if (textVendor(model) === 'openai') {
    const openai = createOpenAI({ apiKey: directOpenAIKey(model)!, baseURL: OPENAI_BASE(), fetch: openAIFetch(fetcher) });
    const selected = usesOpenAIResponses(model) ? openai.responses(openAIModelId(model)) : openai.chat(openAIModelId(model));
    return wrapLanguageModel({ model: selected, middleware: { transformParams: async ({ params }) => ({ ...params, providerOptions: { ...params.providerOptions, openai: { ...params.providerOptions?.openai, store: false } } }) } });
  }
  const auth = { ...options.auth }; delete auth[TEXT_PROVIDER_HEADER];
  const token = auth.Authorization?.replace(/^Bearer\s+/i, '');
  if (!token) throw new Error('The selected language provider is not connected for this workspace.');
  const gateway = createGateway({ apiKey: token, headers: { ...auth, 'ai-gateway-auth-method': auth['ai-gateway-auth-method'] ?? (vendorKey('gateway') ? 'api-key' : 'oidc') }, baseURL: new URL('/v4/ai', GATEWAY_BASE()).href, fetch: fetcher });
  return gateway(model);
}
