import { engineMock } from "../mock";
import { catalog } from "../catalog";
import { vendorKey } from "../vendorKeys";
import { MEMBER_MAX_TOKENS, REQUEST_TIMEOUT_MS, TEMPERATURE, type CrewEffort, type CrewPhase, type Rate } from "./room";

/**
 * One Grok request (CREW_ADDENDUM.md › Grok orchestration). Server only: the
 * key comes from the workspace's own xAI key or the deployment's
 * XAI_API_KEY (lib/vendorKeys) and never reaches the browser.
 */
const ENDPOINT = "https://api.x.ai/v1/chat/completions";
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

export type GrokAnswer = { ok: true; text: string; promptTokens: number; completionTokens: number } | { ok: false; status: number; reason: string };

async function once(body: string, key: string): Promise<GrokAnswer> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` }, body, signal: abort.signal, cache: "no-store" });
    const raw = await response.text();
    if (!response.ok) return { ok: false, status: response.status, reason: `The engine declined the request (${response.status}).` };
    const json = JSON.parse(raw) as { choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    const text = String(json.choices?.[0]?.message?.content ?? "").trim();
    const promptTokens = Number(json.usage?.prompt_tokens), completionTokens = Number(json.usage?.completion_tokens);
    if (!text) return { ok: false, status: 502, reason: "The engine answered with nothing." };
    /* No usage, no bill we can stand behind: treated as a failed request. */
    if (!Number.isFinite(promptTokens) || !Number.isFinite(completionTokens)) return { ok: false, status: 502, reason: "The engine did not report its usage." };
    return { ok: true, text, promptTokens, completionTokens };
  } catch (error) {
    return { ok: false, status: 504, reason: error instanceof Error && error.name === "AbortError" ? "The engine took longer than 45 seconds." : "The engine could not be reached." };
  } finally {
    clearTimeout(timer);
  }
}

/** 45 s, one retry — and the retry only for a timeout, a network failure or a 5xx/429. */
export async function askGrok(input: { system: string; user: string; phase: CrewPhase; effort: CrewEffort; mock: () => string }): Promise<GrokAnswer> {
  if (engineMock()) {
    const text = input.mock();
    return { ok: true, text, promptTokens: Math.ceil((input.system.length + input.user.length) / 4), completionTokens: Math.ceil(text.length / 4) };
  }
  const key = vendorKey("xai");
  if (!key) return { ok: false, status: 503, reason: "Add key in Workspace › Engines." };
  const body = JSON.stringify({
    model: xaiModel(),
    messages: [{ role: "system", content: input.system }, { role: "user", content: input.user }],
    temperature: TEMPERATURE[input.phase],
    max_tokens: MEMBER_MAX_TOKENS,
    stream: false,
  });
  const first = await once(body, key);
  if (first.ok || ![429, 500, 502, 503, 504].includes(first.status)) return first;
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
