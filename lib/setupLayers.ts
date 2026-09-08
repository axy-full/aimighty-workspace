/**
 * Setup you can see and override (brief 2.3).
 *
 * Four layers, each inheriting and overriding the one above: the platform's
 * default → the workspace's Setup → the production's Setup → the shot's own
 * rows. The result says where every active value came from, and the prompt
 * is read against it: a row the prompt names differently is an override,
 * shown as one rather than silently losing. Pure; the composer reads it.
 */
export type Spec = Record<string, string>;
export type Source = "platform" | "workspace" | "production" | "shot";
export const LAYERS: Source[] = ["platform", "workspace", "production", "shot"];
export const LAYER_LABELS: Record<Source, string> = { platform: "PLATFORM", workspace: "WORKSPACE", production: "PRODUCTION", shot: "SHOT" };

export type Layered = { effective: Spec; sources: Record<string, Source> };

export function layerSetup(layers: Partial<Record<Source, Spec | null | undefined>>): Layered {
  const effective: Spec = {}; const sources: Record<string, Source> = {};
  for (const source of LAYERS) {
    const spec = layers[source];
    if (!spec) continue;
    for (const [key, value] of Object.entries(spec)) {
      if (typeof value !== "string" || !value) continue;
      effective[key] = value; sources[key] = source;
    }
  }
  return { effective, sources };
}

export type Row = { key: string; value: string; source: Source };
export type Override = { key: string; setupValue: string; promptValue: string };
export type SetupDiff = { active: Row[]; overrides: Override[]; added: { key: string; value: string }[] };

/** The Setup as it stands against what the prompt says: what applies, what the prompt overrides, what the prompt adds. */
export function setupDiff(layered: Layered, detected: Spec, order: string[] = []): SetupDiff {
  const rank = (k: string) => { const i = order.indexOf(k); return i < 0 ? order.length : i; };
  const keys = Object.keys(layered.effective).sort((a, b) => rank(a) - rank(b));
  const active: Row[] = []; const overrides: Override[] = [];
  for (const key of keys) {
    const setupValue = layered.effective[key]; const promptValue = detected[key];
    if (promptValue && promptValue !== setupValue) overrides.push({ key, setupValue, promptValue });
    else active.push({ key, value: setupValue, source: layered.sources[key] });
  }
  const added = Object.entries(detected).filter(([k, v]) => v && !layered.effective[k]).map(([key, value]) => ({ key, value }));
  return { active, overrides, added };
}

/** One line: "Setup: 35mm · Golden hour · Handheld — this shot overrides: Locked off", or nothing when nothing is set. */
export function diffLine(diff: SetupDiff, label: (key: string, value: string) => string): string {
  const parts = diff.active.map((r) => label(r.key, r.value)).filter(Boolean);
  const over = diff.overrides.map((o) => label(o.key, o.setupValue)).filter(Boolean);
  if (!parts.length && !over.length) return "";
  const head = parts.length ? `Setup: ${parts.join(" · ")}` : "Setup: nothing left standing";
  return over.length ? `${head} — this shot overrides: ${over.join(" · ")}` : head;
}

/** The effective rows with the prompt's own words on top: what a render actually carries. */
export function appliedSetup(layered: Layered, detected: Spec): Spec {
  const out = { ...layered.effective };
  for (const [k, v] of Object.entries(detected)) if (v) out[k] = v;
  return out;
}
