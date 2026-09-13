import { vendorKey, deploymentIdentityAllowed } from "./vendorKeys";
import { engineMock, mockCompletion } from "./mock";
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
      "Vercel AI Gateway is unreachable from here: set AI_GATEWAY_API_KEY, or run on Vercel with OIDC enabled."
    );
  }
  return { Authorization: `Bearer ${token}` };
}

/** What a gateway error should say to a person, by status. */
export function explainGatewayFailure(status: number, text: string): string | null {
  if (status === 403 && /free tier|RestrictedModels/i.test(text)) {
    return "Vercel AI Gateway is on its free tier, which does not include this model. " +
           "Add credits under Vercel → AI Gateway and it will work from then on.";
  }
  if (status === 402 || /insufficient.*credit|credit.*exhaust/i.test(text)) {
    return "Vercel AI Gateway has run out of credit. Top it up under Vercel → AI Gateway.";
  }
  if (status === 401) {
    return "Vercel AI Gateway rejected this deployment's credentials." +
      (vendorKey("gateway")
        ? " Ask the platform to check it."
        : " On Vercel the OIDC identity is fresh on every request; locally, a token from `vercel env pull` expires after twelve hours.");
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
 *
 * The kill switch (SOW v2 §9, board 12h) is NOT read here: this module is
 * in the browser bundle (lib/providers.ts imports it for gatewayReachable),
 * so it can reach nothing of the platform record. The three server-only
 * callers read it at their own door instead, before they call this — the
 * writer (lib/enhance.ts), the planner turn (lib/atomik.ts) and the adapter
 * (lib/engines/vercel.ts) — through lib/meter.ts refuseIfPaused(null,
 * "vercel"), because a text job is metered only after the gateway has
 * answered and the meter's own gate never sees it.
 */
export async function gatewayPost(
  body: string,
  opts: { auth?: Record<string, string>; timeoutMs?: number; mock?: "prompt" | "turn" | "idea" | "scene" | "shots" } = {},
): Promise<GatewayReply> {
  if (engineMock()) return mockCompletion(opts.mock ?? "prompt", body);
  const auth = opts.auth ?? await gatewayAuth();
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
  if (res.status === 400 && REFUSED_THE_MARK.test(res.text)) {
    console.warn(`gatewayChat: ${c.model} rejected the cache mark, retrying plain — ${res.text.slice(0, 140)}`);
    return send(false);
  }
  return res;
}
