import { engineMock, mockCompletion, mockDelay } from "./mock";
import { TEXT_PROVIDER_HEADER } from "./openai-direct";

/**
 * The text paths' shared pieces, apart from any gateway (Vercel out, plan docs/plans/vercel-out.md step A3). A pure move out of lib/gateway.ts: what the live text
 * paths use (the reply every text call returns, the canned reply under ENGINE_MOCK, how a provider's own error is explained to a person) lives here, so lib/gateway.ts
 * is left with the gateway's own door alone and can be deleted (step A5).
 */
export type TextReply = { ok: boolean; status: number; text: string };

export type MockKind = "prompt" | "turn" | "idea" | "scene" | "shots" | "memory";

/** The reply of a text call under ENGINE_MOCK: canned, after the mock's own delay; nothing leaves the process. Null when the mock is off. */
export async function mockTextReply(body: string, mock?: MockKind): Promise<TextReply | null> {
  if (!engineMock()) return null;
  await mockDelay(body);
  return mockCompletion(mock ?? "prompt", body);
}

/** What a direct provider's error should say to a person, by status: its own words for the four language accounts, null for anything else. */
export function explainTextFailure(status: number, text: string): string | null {
  try {
    const reply = JSON.parse(text);
    if (['openai', 'anthropic', 'google', 'xai'].includes(reply.provider)) return status === 401 ? 'The language account rejected the connected API key. Check the language account.' : status === 429 ? 'The language account reached its rate or usage limit. Check the connected language account.' : `The language account could not complete this request (${status}). ${typeof reply.error?.message === 'string' ? reply.error.message.slice(0, 400) : ''}`;
  } catch { /* Not a direct provider's reply. */ }
  return null;
}

/** The header that marks which provider an auth object is for (lib/openai-direct.ts): stripped before anything is sent to a door that does not take it. */
export const withoutProviderHeader = (auth: Record<string, string>): Record<string, string> => { const out = { ...auth }; delete out[TEXT_PROVIDER_HEADER]; return out; };
