import { GATEWAY_BASE, gatewayAuth, gatewayReachable } from "./gateway";

/**
 * Everything the Vercel AI Gateway will run, read from the gateway itself.
 *
 * Particl's own five engines are hand-written in lib/models.ts, because each
 * one is wired to a vendor by hand and carries knowledge no catalogue has —
 * which durations Seedance accepts as an interval, that an edit source must
 * be 480p or 720p, that Nano Banana wants an uppercase K. Alpha is the
 * opposite case: it offers WHATEVER the gateway is serving, which on the day
 * this was written was 369 models and will not be 369 tomorrow.
 *
 * So this is deliberately not a hand-written list. It reads /v1/models and
 * keeps the answer for an hour. A model that appears at Vercel appears in
 * Alpha without a deploy; one that is retired stops being offered without a
 * bug report. The only hand-written parts are the shortlist of engines worth
 * putting at the top of a menu, and the cost arithmetic — because the
 * catalogue states prices in five different shapes and a person needs one
 * number before they spend.
 */

/* ── What the gateway says about a model ──────────────────────────────── */

export type CatalogType =
  | "language" | "video" | "image" | "speech"
  | "embedding" | "transcription" | "reranking" | "realtime";

export type CatalogModel = {
  id: string;                       // "google/veo-3.1-generate-001"
  name: string;                     // "Veo 3.1"
  owner: string;                    // "google" — the id's first segment
  type: CatalogType;
  description: string;
  contextWindow: number | null;
  maxTokens: number | null;
  /** Raw pricing, exactly as the gateway states it. Shapes vary by type. */
  pricing: Record<string, unknown> | null;
};

type RawModel = {
  id?: string; name?: string; type?: string; description?: string;
  context_window?: number; max_tokens?: number;
  pricing?: Record<string, unknown> | null;
};

/* ── The read, cached ─────────────────────────────────────────────────── */

let cache: { at: number; models: CatalogModel[] } | null = null;
const TTL_MS = 60 * 60 * 1000;   // an hour; the catalogue moves in weeks

/**
 * Every model the gateway will serve this deployment.
 *
 * Returns an empty list rather than throwing when the gateway is
 * unreachable: Alpha's model menu going quiet is a far better failure than
 * Alpha's screen refusing to render, and every caller here is drawing a
 * menu rather than spending money.
 */
export async function catalog(force = false): Promise<CatalogModel[]> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.models;
  if (!gatewayReachable()) return cache?.models ?? [];
  try {
    const auth = await gatewayAuth();
    const res = await fetch(`${GATEWAY_BASE()}/models`, {
      headers: auth, signal: AbortSignal.timeout(15_000), cache: "no-store",
    });
    if (!res.ok) {
      console.warn(`catalog: ${res.status} ${(await res.text()).slice(0, 160)}`);
      return cache?.models ?? [];
    }
    const j = await res.json() as { data?: RawModel[] };
    const models = (j.data ?? [])
      .filter((m): m is RawModel & { id: string } => typeof m.id === "string")
      .map((m): CatalogModel => ({
        id: m.id,
        name: m.name ?? m.id.split("/").pop() ?? m.id,
        owner: m.id.split("/")[0] ?? "",
        type: (m.type as CatalogType) ?? "language",
        description: m.description ?? "",
        contextWindow: m.context_window ?? null,
        maxTokens: m.max_tokens ?? null,
        pricing: m.pricing ?? null,
      }));
    if (models.length) cache = { at: Date.now(), models };
    return models;
  } catch (e) {
    console.warn(`catalog: ${(e as Error).message}`);
    return cache?.models ?? [];
  }
}

export async function byType(type: CatalogType): Promise<CatalogModel[]> {
  return (await catalog()).filter((m) => m.type === type);
}

export async function findModel(id: string): Promise<CatalogModel | null> {
  return (await catalog()).find((m) => m.id === id) ?? null;
}

/* ── The shortlist ────────────────────────────────────────────────────── */

/**
 * The models put at the top of a menu, in order.
 *
 * A list of 369 is not a choice, it is a search problem, and most of that
 * list is embeddings and rerankers nobody picks by hand. These are the ones
 * worth naming. Anything here that the gateway is not currently serving is
 * silently dropped, so a retirement costs nothing; anything the gateway
 * serves that is NOT here is still reachable under "everything else".
 */
export const FEATURED = {
  /** Models that plan a production. Cheap-and-fast first is deliberate:
   *  most briefs do not need a frontier model to become a shot list. */
  planner: [
    "anthropic/claude-sonnet-5",
    "anthropic/claude-opus-5",
    "google/gemini-3-flash",
    "google/gemini-3.1-pro-preview",
    "openai/gpt-5.2",
    "deepseek/deepseek-v4-pro",
    "moonshotai/kimi-k2-thinking",
    "zai/glm-4.6",
  ],
  video: [
    "bytedance/seedance-2.5",
    "google/veo-3.1-generate-001",
    "google/veo-3.1-fast-generate-001",
    "klingai/kling-v3.0-t2v",
    "klingai/kling-v3.0-i2v",
    "alibaba/wan-v3.0-video",
    "minimax/minimax-h3",
    "spacexai/grok-imagine-video-1.5",
  ],
  image: [
    "google/gemini-3-pro-image",
    "bytedance/seedream-5.0-pro",
    "bfl/flux-2-pro",
    "openai/gpt-image-2",
    "recraft/recraft-v4",
    "spacexai/grok-imagine-image-2.0",
  ],
  speech: [
    "openai/tts-1-hd",
    "fish-audio/s2.1-pro",
    "spacexai/grok-tts",
  ],
} as const;

/** The featured models of one kind that the gateway is actually serving,
 *  in the order above, followed by everything else of that kind. */
export async function menuFor(kind: keyof typeof FEATURED): Promise<{
  featured: CatalogModel[]; rest: CatalogModel[];
}> {
  const type: CatalogType = kind === "planner" ? "language" : kind;
  const all = await byType(type);
  const want = FEATURED[kind] as readonly string[];
  const featured = want
    .map((id) => all.find((m) => m.id === id))
    .filter((m): m is CatalogModel => Boolean(m));
  const seen = new Set(featured.map((m) => m.id));
  const rest = all.filter((m) => !seen.has(m.id))
    .sort((a, b) => a.id.localeCompare(b.id));
  return { featured, rest };
}

/* ── What a step will cost ────────────────────────────────────────────── */

const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
};

type DurationTier = {
  resolution?: string; cost_per_second?: string | number;
  audio?: boolean; mode?: string;
};

/**
 * What one video render costs, in dollars.
 *
 * The gateway states video prices two ways. Most models price by the
 * second, in a table keyed by resolution and sometimes by audio or a
 * std/pro mode. Seedance prices by TOKEN, against a count that depends on
 * resolution and duration in a way no formula here can reproduce
 * faithfully — so for those this returns null and the caller says "priced
 * at render" rather than inventing a number. Guessing a token count would
 * put a wrong figure in front of someone deciding whether to spend.
 */
export function videoCostUsd(m: CatalogModel, opts: {
  seconds: number; resolution?: string; audio?: boolean; mode?: string;
}): number | null {
  const p = m.pricing;
  if (!p) return null;
  const tiers = p.video_duration_pricing as DurationTier[] | undefined;
  if (!Array.isArray(tiers) || tiers.length === 0) return null;

  const wantRes = (opts.resolution ?? "1080p").toLowerCase();
  const wantAudio = Boolean(opts.audio);
  const wantMode = opts.mode ?? "std";

  const score = (t: DurationTier) => {
    let s = 0;
    if (t.resolution) s += t.resolution.toLowerCase() === wantRes ? 4 : -3;
    if (t.audio != null) s += t.audio === wantAudio ? 2 : -2;
    if (t.mode) s += t.mode === wantMode ? 1 : -1;
    return s;
  };
  const best = [...tiers].sort((a, b) => score(b) - score(a))[0];
  const perSecond = num(best?.cost_per_second);
  if (perSecond == null) return null;
  return perSecond * Math.max(0, opts.seconds);
}

/** What one still costs, in dollars, or null when it is priced by token. */
export function imageCostUsd(m: CatalogModel): number | null {
  const p = m.pricing;
  if (!p) return null;
  const flat = num(p.image);
  if (flat != null) return flat;
  return null;   // openai's image models bill as tokens; say so rather than guess
}

/** Dollars for a text call of roughly this size. */
export function textCostUsd(m: CatalogModel, inTokens: number, outTokens: number): number | null {
  const p = m.pricing;
  if (!p) return null;
  const i = num(p.input), o = num(p.output);
  if (i == null && o == null) return null;
  return (i ?? 0) * inTokens + (o ?? 0) * outTokens;
}

/** A short, honest price label for a menu row. */
export function priceLabel(m: CatalogModel): string {
  const p = m.pricing;
  if (!p) return "";
  if (m.type === "video") {
    const tiers = p.video_duration_pricing as DurationTier[] | undefined;
    if (Array.isArray(tiers) && tiers.length) {
      const rates = tiers.map((t) => num(t.cost_per_second)).filter((n): n is number => n != null);
      if (rates.length) {
        const lo = Math.min(...rates);
        return `from $${lo.toFixed(3)}/s`;
      }
    }
    if (p.video_token_pricing) return "priced by token";
    return "";
  }
  if (m.type === "image") {
    const flat = num(p.image);
    return flat != null ? `$${flat.toFixed(3)}/image` : "priced by token";
  }
  const i = num(p.input), o = num(p.output);
  if (i == null && o == null) return "";
  return `$${((i ?? 0) * 1e6).toFixed(2)}/$${((o ?? 0) * 1e6).toFixed(2)} per Mtok`;
}
