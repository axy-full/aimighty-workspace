import { recoveryFetch as fetch } from "./recovery";
import { vendorKey, deploymentIdentityAllowed } from "./vendorKeys";
import { engineMock, mockCompletion } from "./mock";
import { assertTextProvider, openaiDirectPost, TEXT_PROVIDER_HEADER, textVendor } from './openai-direct';
/**
 * Vercel AI Gateway — the one door this deployment can always open.
 *
 * Reached with an AI_GATEWAY_API_KEY, or with no key at all on Vercel, where
 * every function carries an OIDC identity the gateway accepts. Both the
 * prompt writer (lib/enhance.ts) and the still-image engines (lib/gemini.ts)
 * go through here, so one credit balance pays for both.
 */

export const GATEWAY_BASE = () =>
  process.env.AI_GATEWAY_BASE_URL?.replace(/\/$/, "") ?? "https://ai-gateway.vercel.sh/v1";
export const GATEWAY_URL = () => `${GATEWAY_BASE()}/chat/completions`;

export function gatewayReachable(): boolean {
  if (engineMock()) return true;
  if (vendorKey("gateway")) return true;
  return deploymentIdentityAllowed() && Boolean(process.env.VERCEL_OIDC_TOKEN || process.env.VERCEL);
}

/**
 * Credentials for the gateway: an explicit key wins; otherwise the OIDC
 * identity of this deployment, which @vercel/oidc reads from the request
 * (and, in local development, from the token `vercel env pull` writes).
 */
export async function gatewayAuth(): Promise<Record<string, string>> {
  if (engineMock()) return {};
  const key = vendorKey("gateway");
  if (key) return { Authorization: `Bearer ${key}` };
  if (!deploymentIdentityAllowed()) {
    throw new Error("The prompt writer isn't connected for this workspace. Ask the platform to connect it.");
  }
  let token: string | null = process.env.VERCEL_OIDC_TOKEN ?? null;
  try {
    const { getVercelOidcToken } = await import("@vercel/oidc");
    token = await getVercelOidcToken();
  } catch { /* not on Vercel and no pulled token — the env value stands */ }
  if (!token) {
    throw new Error(
      "The model gateway is unreachable from here: set AI_GATEWAY_API_KEY, or run on the host with OIDC enabled."
    );
  }
  return { Authorization: `Bearer ${token}` };
}

/** What a gateway error should say to a person, by status. */
export function explainGatewayFailure(status: number, text: string): string | null {
  try {
    const reply = JSON.parse(text);
    if (reply.provider === 'openai') return status === 401 ? 'The language account rejected the connected API key. Check the language account.' : status === 429 ? 'The language account reached its rate or usage limit. Check the connected language account.' : `The language account could not complete this request (${status}). ${typeof reply.error?.message === 'string' ? reply.error.message.slice(0, 400) : ''}`;
  } catch { /* Other gateway responses retain their existing explanation. */ }
  if (status === 403 && /free tier|RestrictedModels/i.test(text)) {
    return "The model gateway is on its free tier, which does not include this model. " +
           "Add credits under the gateway's billing settings and it will work from then on.";
  }
  if (status === 402 || /insufficient.*credit|credit.*exhaust/i.test(text)) {
    return "The model gateway has run out of credit. Top it up under the gateway's billing settings.";
  }
  if (status === 401) {
    return "The model gateway rejected this deployment's credentials." +
      (vendorKey("gateway")
        ? " Ask the platform to check it."
        : " On the host the OIDC identity is fresh on every request; locally, a token from an environment pull expires after twelve hours.");
  }
  return null;
}

/**
 * The gateway's credit balance, in dollars — what is left of what was
 * topped up, and what has been used. Null when this deployment cannot
 * reach the gateway or the call fails; never a reason to block anything.
 */
export async function gatewayCredits(): Promise<{ balanceUsd: number; usedUsd: number } | null> {
  if (!gatewayReachable()) return null;
  try {
    const auth = await gatewayAuth();
    const res = await fetch(`${GATEWAY_BASE()}/credits`, {
      headers: auth, signal: AbortSignal.timeout(6_000), cache: "no-store",
    });
    if (!res.ok) {
      console.warn(`gateway credits: ${res.status} ${(await res.text()).slice(0, 160)}`);
      return null;
    }
    const j = await res.json() as { balance?: string | number; total_used?: string | number };
    const balance = Number(j.balance), used = Number(j.total_used);
    if (!Number.isFinite(balance)) return null;
    return { balanceUsd: balance, usedUsd: Number.isFinite(used) ? used : 0 };
  } catch (e) {
    console.warn(`gateway credits: ${(e as Error).message}`);
    return null;
  }
}

export type GatewayReply = { ok: boolean; status: number; text: string };

/**
 * One POST to the gateway's chat endpoint, the body already serialised.
 * Under ENGINE_MOCK the reply is canned and nothing leaves the process.
 */
export async function gatewayPost(
  body: string,
  opts: { auth?: Record<string, string>; timeoutMs?: number; mock?: "prompt" | "turn" | "idea" | "scene" | "shots" } = {},
): Promise<GatewayReply> {
  if (engineMock()) return mockCompletion(opts.mock ?? "prompt", body);
  const input = JSON.parse(body) as Record<string, unknown>;
  if (typeof input.model !== 'string') throw new Error('Choose a language model before submitting.');
  assertTextProvider(input.model, opts.auth);
  if (textVendor(input.model) === 'openai') return openaiDirectPost(input, { timeoutMs: opts.timeoutMs });
  const auth = { ...(opts.auth ?? await gatewayAuth()) }; delete auth[TEXT_PROVIDER_HEADER];
  const res = await fetch(GATEWAY_URL(), {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body,
    signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
  });
  return { ok: res.ok, status: res.status, text: await res.text() };
}

/**
 * A chat call whose instruction is marked cacheable (brief 1.8).
 *
 * Atomik sends the same system prompt, the same rule library and the same
 * Setup on every call; a cache read costs a fraction of a fresh one. Not
 * every model on the gateway accepts the mark, so one that refuses is asked
 * again plain rather than failing the person's press.
 */
export type ChatCall = {
  model: string; system: string; user: string; maxTokens?: number;
  auth?: Record<string, string>; timeoutMs?: number; mock?: "prompt" | "turn" | "idea" | "scene" | "shots";
};

/** The body of one chat call. Pure, so the shape can be read in a test. */
export function chatBody(c: ChatCall, cacheable = true): string {
  return JSON.stringify({
    model: c.model,
    max_tokens: c.maxTokens ?? 1200,
    messages: [
      cacheable
        ? { role: "system", content: c.system, cache_control: { type: "ephemeral" } }
        : { role: "system", content: c.system },
      { role: "user", content: c.user },
    ],
  });
}

const REFUSED_THE_MARK = /cache_control|unknown|unsupported|invalid/i;

export async function gatewayChat(c: ChatCall): Promise<GatewayReply> {
  const send = (cacheable: boolean) =>
    gatewayPost(chatBody(c, cacheable), { auth: c.auth, timeoutMs: c.timeoutMs, mock: c.mock });
  const res = await send(true);
  if (textVendor(c.model) !== 'openai' && res.status === 400 && REFUSED_THE_MARK.test(res.text)) {
    console.warn(`gatewayChat: ${c.model} rejected the cache mark, retrying plain — ${res.text.slice(0, 140)}`);
    return send(false);
  }
  return res;
}
