import { createHash } from 'node:crypto';
import { vendorKey } from './vendorKeys';
import { engineMock } from './mock';

export type OpenAIConnection = { configured: boolean; verified: boolean; models: string[]; checkedAt: number; error: string | null };
const cache = new Map<string, OpenAIConnection>();
/** Availability is scoped to a credential fingerprint, never shared between
 * studios. A read-only model listing incurs no generation request. */
export async function openAIConnection(force = false, fetcher: typeof fetch = fetch): Promise<OpenAIConnection> {
  if (engineMock()) return { configured: false, verified: false, models: [], checkedAt: Date.now(), error: 'Live language account verification is disabled in the mock environment.' };
  const key = vendorKey('openai');
  if (!key) return { configured: false, verified: false, models: [], checkedAt: Date.now(), error: 'No language account key is configured for this workspace.' };
  const fingerprint = createHash('sha256').update(key).digest('hex');
  const cached = cache.get(fingerprint);
  if (!force && cached && Date.now() - cached.checkedAt < (cached.verified ? 300000 : 15000)) return cached;
  let result: OpenAIConnection;
  try {
    const response = await fetcher('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15000), cache: 'no-store', redirect: 'error' });
    if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? 'The language account rejected this key or its model-list permission. Check the project key permissions.' : `The language account model verification is temporarily unavailable (${response.status}).`);
    const text = await response.text();
    if (text.length > 2_000_000) throw new Error('The language account returned an oversized model catalogue.');
    const body = JSON.parse(text);
    if (!Array.isArray(body.data) || body.data.length > 5000) throw new Error('The language account returned an invalid model catalogue.');
    const models = [...new Set<string>(body.data.flatMap((item: { id?: unknown }) => typeof item?.id === 'string' && /^[A-Za-z0-9._:-]{1,160}$/.test(item.id) ? [item.id] : []))];
    result = { configured: true, verified: true, models, checkedAt: Date.now(), error: null };
  } catch (error) {
    result = { configured: true, verified: false, models: [], checkedAt: Date.now(), error: error instanceof Error && error.message.startsWith('The language account ') ? error.message : 'The language account could not be reached for model verification.' };
  }
  if (cache.size >= 64) cache.delete(cache.keys().next().value!);
  cache.set(fingerprint, result);
  return result;
}
