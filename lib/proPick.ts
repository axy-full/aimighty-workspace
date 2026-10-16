/**
 * The Pro pick: the engines the owner names for finals (16 Oct 2026: "Pro pick menu: Seedance 2.5, Veo 3.1, Kling 4.0, Runway Gen-4.5. Names live in config, never in the design";
 * "yes to lib/proPick.ts with a site override"). A config list, in order, that the composer's engines response marks (`pro` on a model row, and a `pro` list in the response);
 * the design hard-codes none of the names. Pure and client-safe: no database, no imports. The server half is lib/proPick.server.ts.
 *
 * An entry names an engine either as a MODEL of the registry (lib/models.ts: a row the composer can render) or as a TOOL (a direct engine's tool, lib/directEngineMcp.ts:
 * Veo and Runway are tools, not model rows). An entry may name a FALLBACK model, used while its engine is not there for the workspace: Kling 4.0 is inert until fal lists it
 * and its price is confirmed (lib/modelGate.ts), and "Kling 3.0 Pro until then" is that fallback, shown under its own name so nobody thinks they are getting 4.0.
 *
 * The site override: the `proPick` field of the site row (platform_layer, key `site`; no migration, no environment variable). It replaces the default list whole, and only if
 * every entry in it is well formed (`cleanProPick`): a list with one bad entry is ignored altogether and the default stands.
 */
export type ProEngine = { kind: "model"; id: string } | { kind: "tool"; id: string; model?: string };
export type ProPickEntry = { key: string; label: string; engine: ProEngine; fallback?: { kind: "model"; id: string } };

/** The owner's choice, in his order. Model ids are the registry's (an id the registry does not hold is simply not there); tool ids are the direct engines' tool names. */
export const PRO_PICK_DEFAULT: readonly ProPickEntry[] = Object.freeze([
  { key: "seedance-2-5", label: "Seedance 2.5", engine: { kind: "model", id: "dreamina-seedance-2-5-260628" } },
  { key: "veo-3-1", label: "Veo 3.1", engine: { kind: "tool", id: "veo_video", model: "veo-3.1-generate-preview" } },
  { key: "kling-4", label: "Kling 4.0", engine: { kind: "model", id: "fal-ai/kling-video/v4/pro" }, fallback: { kind: "model", id: "fal-ai/kling-video/v3/pro" } },
  { key: "runway-gen-4-5", label: "Runway Gen-4.5", engine: { kind: "tool", id: "runway_video", model: "gen4.5" } },
]);

export const PRO_PICK_MAX = 8;
const KEY = /^[a-z0-9][a-z0-9-]{0,40}$/;
const LABEL = /^[\p{L}\p{N}][\p{L}\p{N} .+\-]{0,39}$/u;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,119}$/;
const TOOL_ID = /^[a-z][a-z0-9_]{1,40}$/;
const TOOL_MODEL = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/;

const isRecord = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const onlyKeys = (v: Record<string, unknown>, allowed: string[]) => Object.keys(v).every((k) => allowed.includes(k));

/** A stored override made safe: the whole list, or null when it is not a list of one to PRO_PICK_MAX well-formed, distinct entries (then the default stands). */
export function cleanProPick(value: unknown): ProPickEntry[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > PRO_PICK_MAX) return null;
  const out: ProPickEntry[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (!isRecord(raw) || !onlyKeys(raw, ["key", "label", "engine", "fallback"])) return null;
    const { key, label, engine, fallback } = raw;
    if (typeof key !== "string" || !KEY.test(key) || seen.has(key)) return null;
    if (typeof label !== "string" || !LABEL.test(label)) return null;
    seen.add(key);
    let eng: ProEngine;
    if (!isRecord(engine) || typeof engine.id !== "string") return null;
    if (engine.kind === "model") {
      if (!onlyKeys(engine, ["kind", "id"]) || !MODEL_ID.test(engine.id)) return null;
      eng = { kind: "model", id: engine.id };
    } else if (engine.kind === "tool") {
      if (!onlyKeys(engine, ["kind", "id", "model"]) || !TOOL_ID.test(engine.id)) return null;
      if (engine.model !== undefined && (typeof engine.model !== "string" || !TOOL_MODEL.test(engine.model))) return null;
      eng = { kind: "tool", id: engine.id, ...(engine.model !== undefined ? { model: engine.model as string } : {}) };
    } else return null;
    let fb: ProPickEntry["fallback"];
    if (fallback !== undefined) {
      if (!isRecord(fallback) || !onlyKeys(fallback, ["kind", "id"]) || fallback.kind !== "model" || typeof fallback.id !== "string" || !MODEL_ID.test(fallback.id)) return null;
      fb = { kind: "model", id: fallback.id };
    }
    out.push({ key, label, engine: eng, ...(fb ? { fallback: fb } : {}) });
  }
  return out;
}

/** One entry as the composer's engines response carries it, after the engine's availability for the workspace has been asked. */
export type ProPickRow = {
  key: string;
  /** The entry's own name, or the fallback model's own name when it fell back. */
  label: string;
  kind: "model" | "tool";
  /** The model id (kind model) or the tool id (kind tool) that this entry resolved to. */
  id: string;
  model?: string;
  /** True when the entry's engine is not there and its fallback stands in. */
  fellBack: boolean;
};
