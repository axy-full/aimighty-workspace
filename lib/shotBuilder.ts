import { CATEGORIES } from "./studio";
import { estimateCostUsd, estimateImageCostUsd, DEFAULT_MODEL_ID } from "./models";

/**
 * The shot builder's pure half (brief 1.8): the engine a shot should go to,
 * the model's structured reply read into shots, and what each will cost —
 * before anything is rendered. No Node imports; the breakdown prices from
 * here. The call itself lives in the draft route.
 */
export type ShotEngine = "seedance" | "kling" | "nano-banana";
export const ENGINE_MODEL: Record<ShotEngine, string> = { seedance: DEFAULT_MODEL_ID, kling: "fal-ai/kling-video/v3/standard", "nano-banana": "gemini-3-pro-image" };
export const ENGINE_LABEL: Record<ShotEngine, string> = { seedance: "Seedance", kling: "Kling", "nano-banana": "Nano Banana" };

/** The platform's rule (brief 2.5): Kling for water, cloth and physics; Seedance for everything else; a still goes to Nano Banana. */
export function suggestEngine(text: string, kind: "video" | "image" = "video"): { engine: ShotEngine; why: string } {
  if (kind === "image") return { engine: "nano-banana", why: "a still" };
  const m = /\b(water|rain|wave|waves|sea|ocean|river|splash|pour(?:s|ing)?|flood|wet|cloth|fabric|silk|dress|curtain|flag|hair|smoke|steam|dust|sand|physics|collide|collision|shatter|crumble|fall(?:s|ing)?|bounce|ripple|swirl)\b/i.exec(text);
  return m ? { engine: "kling", why: `${m[1].toLowerCase()}: water, cloth and physics go to Kling` } : { engine: "seedance", why: "standard video" };
}

export type ShotProposal = { title: string; description: string; planned: number; setup: Record<string, string>; cast: string[]; engine: ShotEngine; why: string };

const ENGINES = new Set<ShotEngine>(["seedance", "kling", "nano-banana"]);

/** A Setup with only real rows and real options kept. */
export function cleanSetupFields(v: unknown): Record<string, string> {
  if (!v || typeof v !== "object") return {};
  const out: Record<string, string> = {};
  for (const c of CATEGORIES) {
    const raw = (v as Record<string, unknown>)[c.key];
    if (typeof raw !== "string") continue;
    const hit = c.options.find((o) => o.value === raw || o.label.toLowerCase() === raw.toLowerCase());
    if (hit) out[c.key] = hit.value;
  }
  return out;
}

/** The model's reply as shots, or nothing: JSON with or without a fence, each shot's rows validated, its engine checked against the rule. */
export function shotsFromReply(text: string, castNames: string[] = []): ShotProposal[] | null {
  const body = String(text ?? "").replace(/```(?:json)?/gi, "").trim();
  const start = body.indexOf("{"), end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let j: { shots?: unknown };
  try { j = JSON.parse(body.slice(start, end + 1)) as { shots?: unknown }; } catch { return null; }
  if (!Array.isArray(j.shots)) return null;
  const known = new Set(castNames.map((n) => n.toLowerCase()));
  const out: ShotProposal[] = [];
  for (const raw of j.shots.slice(0, 12)) {
    const s = (raw ?? {}) as Record<string, unknown>;
    const description = typeof s.description === "string" ? s.description.trim().slice(0, 1200) : "";
    if (!description) continue;
    const title = typeof s.title === "string" ? s.title.trim().slice(0, 120) : "";
    const planned = Math.max(2, Math.min(30, Math.round(Number(s.planned) || 5)));
    const cast = Array.isArray(s.cast) ? s.cast.map((c) => String(c).replace(/^@/, "").trim()).filter((c) => c && (!known.size || known.has(c.toLowerCase()))).slice(0, 6) : [];
    const rule = suggestEngine(`${title} ${description}`);
    const asked = typeof s.engine === "string" && ENGINES.has(s.engine as ShotEngine) ? (s.engine as ShotEngine) : rule.engine;
    const why = typeof s.why === "string" && s.why.trim() ? s.why.trim().slice(0, 160) : rule.why;
    out.push({ title, description, planned, setup: cleanSetupFields(s.setup), cast, engine: asked === "nano-banana" ? "seedance" : asked, why });
  }
  return out.length ? out : null;
}

/** One take of a shot at its engine, in dollars: 1080p 16:9, the planned seconds (Seedance bills five at least). */
export function shotCostUsd(engine: ShotEngine, planned: number | null): number {
  const secs = Math.max(5, planned ?? 5);
  if (engine === "nano-banana") return estimateImageCostUsd(ENGINE_MODEL["nano-banana"], "2K", 0)?.net ?? 0;
  return estimateCostUsd(ENGINE_MODEL[engine], "1080p", "16:9", secs, 0, false, { audio: engine === "seedance" })?.net ?? 0;
}

/** The option values the model may use, row by row, for the instruction. */
export function setupVocabulary(): string {
  return CATEGORIES.map((c) => `${c.key}: ${c.options.map((o) => o.value).join("|")}`).join("\n");
}
