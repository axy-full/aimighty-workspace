import type { CrewMcpAccess } from "./mcp";
import { engineMock } from "../mock";
import { catalog } from "../catalog";
import { vendorKey } from "../vendorKeys";
import { MEMBER_MAX_TOKENS, REQUEST_TIMEOUT_MS, CREW_OUTPUT_TOKENS, CREW_MAX_TURNS, type CrewEffort, type CrewPhase, type Rate } from "./room";

/**
 * One Grok request (CREW_ADDENDUM.md › Grok orchestration). Server only: the
 * key comes from the workspace's own xAI key or the deployment's
 * XAI_API_KEY (lib/vendorKeys) and never reaches the browser.
 */
const ENDPOINT = "https://api.x.ai/v1/responses";
const MODELS_ENDPOINT = "https://api.x.ai/v1/models";

export function xaiModel(): string {
  return (process.env.XAI_MODEL || "grok-4.6").trim();
}
export function xaiConnected(): boolean {
  return engineMock() || Boolean(vendorKey("xai"));
}

/**
 * The rate a round is priced at: the live catalogue's entry for this model
 * (listed there under the provider's prefix), else XAI_RATE_USD_PER_MTOK
 * ("input,output"). With neither there is no honest price, so no round.
 */
export async function xaiRate(model = xaiModel()): Promise<Rate | null> {
  const fromEnv = (process.env.XAI_RATE_USD_PER_MTOK || "").split(",").map((v) => Number(v.trim()));
  if (fromEnv.length === 2 && fromEnv.every((v) => Number.isFinite(v) && v > 0)) return { inputUsdPerToken: fromEnv[0] / 1e6, outputUsdPerToken: fromEnv[1] / 1e6 };
  if (engineMock()) return { inputUsdPerToken: 2 / 1e6, outputUsdPerToken: 6 / 1e6 };
  const listed = (await catalog().catch(() => [])).find((m) => m.type === "language" && m.id.split("/").pop() === model);
  const input = Number(listed?.pricing?.input), output = Number(listed?.pricing?.output);
  return Number.isFinite(input) && input > 0 && Number.isFinite(output) && output > 0 ? { inputUsdPerToken: input, outputUsdPerToken: output } : null;
}

export type GrokAnswer = { ok: true; text: string; promptTokens: number; completionTokens: number; providerCostUsd?: number } | { ok: false; status: number; reason: string; uncertain?: boolean };

async function once(body: string, key: string): Promise<GrokAnswer> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` }, body, signal: abort.signal, cache: "no-store", redirect: "error" });
    const raw = await response.text();
    if (!response.ok) return { ok: false, status: response.status, uncertain: response.status >= 500 || response.status === 408, reason: `The engine declined the request (${response.status}).` };
    if (raw.length > 2_000_000) return { ok: false, status: 502, uncertain: true, reason: "The engine response was too large. No retry was sent." };
    const json = JSON.parse(raw) as { status?: string; output?: { type?: string; content?: { type?: string; text?: string }[] }[]; usage?: { input_tokens?: number; output_tokens?: number; cost_in_usd_ticks?: number } };
    const text = (json.output ?? []).filter(item => item.type === "message").flatMap(item => item.content ?? []).filter(item => item.type === "output_text").map(item => item.text ?? "").join("\n").trim();
    const promptTokens = json.usage?.input_tokens, completionTokens = json.usage?.output_tokens, ticks = json.usage?.cost_in_usd_ticks;
    if (json.status !== "completed" || !text) return { ok: false, status: 502, uncertain: true, reason: "The engine did not finish its answer. No retry was sent." };
    if (![promptTokens, completionTokens, ticks].every(n => typeof n === "number" && Number.isSafeInteger(n) && n >= 0))
      return { ok: false, status: 502, uncertain: true, reason: "The engine did not report complete usage. No retry was sent." };
    return { ok: true, text: text.slice(0, MEMBER_MAX_TOKENS * 8), promptTokens: promptTokens!, completionTokens: completionTokens!, providerCostUsd: ticks! / 1e10 };
  } catch (error) {
    return { ok: false, status: 504, uncertain: true, reason: error instanceof Error && error.name === "AbortError" ? "The engine took longer than 45 seconds." : "The engine could not be reached." };
  } finally {
    clearTimeout(timer);
  }
}

/** A paid request is sent once. A lost answer never causes an automatic replay. */
export async function askGrok(input: { system: string; user: string; phase: CrewPhase; effort: CrewEffort; mock: () => string; model?: string; mcp?: Pick<CrewMcpAccess, "token" | "url"> }): Promise<GrokAnswer> {
  if (engineMock()) {
    const text = input.mock();
    return { ok: true, text, promptTokens: Math.ceil((input.system.length + input.user.length) / 4), completionTokens: Math.ceil(text.length / 4) };
  }
  const key = vendorKey("xai");
  if (!key) return { ok: false, status: 503, reason: "Crew's managed engine is unavailable." };
  const body = JSON.stringify({
    model: input.model?.trim() || xaiModel(),
    input: [{ role: "system", content: input.system }, { role: "user", content: input.user }],
    reasoning: { effort: input.effort }, max_output_tokens: CREW_OUTPUT_TOKENS[input.effort],
    max_turns: CREW_MAX_TURNS, parallel_tool_calls: false, store: false, stream: false,
    ...(input.mcp ? { tools: [{ type: "mcp", server_url: input.mcp.url, server_label: "particl_crew",
      allowed_tools: ["crew_context"], headers: { Authorization: `Bearer ${input.mcp.token}` } }] } : {}),
  });
  return once(body, key);
}

/** Verify lists models only: it proves the key without spending anything. */
export async function verifyXai(): Promise<{ ok: boolean; models: string[]; reason?: string }> {
  if (engineMock()) return { ok: true, models: [xaiModel()] };
  const key = vendorKey("xai");
  if (!key) return { ok: false, models: [], reason: "No xAI key is connected." };
  try {
    const response = await fetch(MODELS_ENDPOINT, { headers: { Authorization: `Bearer ${key}` }, cache: "no-store", signal: AbortSignal.timeout(15_000) });
    if (!response.ok) return { ok: false, models: [], reason: `xAI answered ${response.status}.` };
    const json = await response.json() as { data?: { id?: string }[] };
    return { ok: true, models: (json.data ?? []).map((m) => String(m.id ?? "")).filter(Boolean).slice(0, 60) };
  } catch {
    return { ok: false, models: [], reason: "xAI could not be reached." };
  }
}
