import { CATEGORIES, type ShotSpec } from "./studio";
import { MODELS, DEFAULT_MODEL_ID } from "./models";
import { TEXT_RATES } from "./refineGate";
import { DEFAULT_PLANS, cleanPlans, type PlanDef } from "./plans";

/**
 * The platform layer: what every new workspace inherits and may change.
 *
 * Four things, each with a default in code and an override in the platform
 * record (lib/platform.ts), edited from the admin console:
 *   setup   — the default Setup, real Studio options, so "0 of 12 rows set"
 *             is never the starting state;
 *   starter — the production a new workspace opens on: three shots pre-named,
 *             one cast member, generic and rights-clear by construction;
 *   rules   — what working teams have learned, as sentences: some for the
 *             prompt writer, some appended to the prompt itself, each in scope
 *             for video, stills or both (the platform half of 2.5);
 *   caps    — the numbers a workspace starts with: welcome credits, a default
 *             cap for a new production, the share of a cap that warns;
 *   plans   — §7A's four subscriptions, what each costs a month and what it
 *             includes. Here rather than in a table of its own because a
 *             plan is a platform default a workspace is put ON, not data a
 *             workspace owns (rule 3), and because the console already edits
 *             this record.
 * Pure: no database here, so the browser can validate what it edits.
 */
export const DEFAULT_SETUP: ShotSpec = {
  shot: "ws", angle: "eye", move: "static", lens: "35", light: "natural",
  time: "afternoon", look: "35mm", mood: "calm", pace: "realtime", sound: "ambient",
};

export type StarterShot = { code: string; title: string; description: string; planned: number; setup: ShotSpec; cast: string[] };
export type StarterCast = { name: string; kind: "character" | "location" | "prop" | "style"; description: string };
export type StarterProduction = { name: string; code: string; description: string; shots: StarterShot[]; cast: StarterCast[] };

export const STARTER_CAST: StarterCast = {
  name: "Mara",
  kind: "character",
  description: "A courier in her thirties. Cropped dark hair, a weathered orange jacket, a canvas bag across the chest. Always mid-errand, never posed.",
};

/** A starter shot's `setup` holds only what differs from the default Setup; the seed merges them. */
export const STARTER_PRODUCTION: StarterProduction = {
  name: "Starter production",
  code: "START",
  description: "Three shots to render against, so the first take is a minute away. Rename it, change anything, or delete it.",
  shots: [
    { code: "SH010", title: "The city, first light", planned: 5,
      description: "An establishing shot: a quiet street at dawn, wet from the night, the first light along the rooftops.",
      setup: { shot: "evs", time: "dawn" }, cast: [] },
    { code: "SH020", title: "The courier", planned: 5,
      description: "@Mara crosses the street with the bag held close, the camera pushing in as she passes.",
      setup: { shot: "ms", move: "push" }, cast: [STARTER_CAST.name] },
    { code: "SH030", title: "The hand-off", planned: 5,
      description: "A close-up: the package changes hands on a doorstep, soft light, nothing said.",
      setup: { shot: "cu", light: "soft" }, cast: [STARTER_CAST.name] },
  ],
  cast: [
    STARTER_CAST,
    { name: "Mule", kind: "prop", description: "A battered cargo bicycle, orange frame, canvas panniers, a bell that does not work." },
    { name: "WetStreet", kind: "location", description: "A narrow street at dawn, wet from the night, shutters down, the first light along the rooftops." },
    { name: "FirstLight", kind: "style", description: "Dawn, soft and low. 35mm, natural light, muted colour, nothing polished." },
  ],
};

/** Where a rule applies: a kind, or one engine family's dialect. */
export type RuleScope = "all" | "video" | "image" | "seedance-2" | "kling-3" | "nano-banana";
export const RULE_SCOPES: RuleScope[] = ["all", "video", "image", "seedance-2", "kling-3", "nano-banana"];
export const RULE_SCOPE_LABELS: Record<RuleScope, string> = {
  all: "video + stills", video: "video", image: "stills", "seedance-2": "Seedance only", "kling-3": "Kling only", "nano-banana": "Nano Banana only",
};
export type RuleApply = "writer" | "prompt";
export type PlatformRule = { id: string; text: string; scope: RuleScope; apply: RuleApply; on: boolean };

/** The seed from the brief (2.5): what one team learned, for everyone. */
export const DEFAULT_RULES: PlatformRule[] = [
  { id: "one-move", scope: "video", apply: "writer", on: true, text: "One camera move per shot; a travelling technique replaces the move row rather than adding to it." },
  { id: "niche-terms", scope: "all", apply: "writer", on: true, text: "A niche term goes out as the term plus what actually happens in frame." },
  { id: "positive", scope: "all", apply: "writer", on: true, text: "Describe everything positively; only subtitles and audio reliably take a NO." },
  { id: "time-vs-light", scope: "all", apply: "writer", on: true, text: "Time of day and lighting are separate rows and never both say golden hour." },
  { id: "plain-sentences", scope: "image", apply: "writer", on: true, text: "Write camera and subject direction as plain sentences, never as headers or labels: all-caps headers leak into a still as burned-in captions." },
  { id: "no-lettering", scope: "image", apply: "prompt", on: true, text: "No lettering, captions, logos or text of any kind appears in the frame." },
  // Each engine's dialect (brief 1.1): the Setup rows are engine-neutral; these turn them into what each engine reads.
  { id: "kling-shape", scope: "kling-3", apply: "writer", on: true, text: "Kling reads one plain paragraph: the subject, what it does, where, then the camera and the light, in that order. Under 120 words. No timestamps, no shot numbers, no headers." },
  { id: "kling-physics", scope: "kling-3", apply: "writer", on: true, text: "Kling's strength is physics: name the material and the force — water, cloth, hair, smoke, weight, wind — and what it does to the subject." },
  { id: "kling-negative", scope: "kling-3", apply: "writer", on: true, text: "Anything to avoid goes to Kling's negative field, never into the prompt." },
  { id: "nb-whole-scene", scope: "nano-banana", apply: "writer", on: true, text: "Nano Banana wants the one scene described whole — subject, setting, light, lens — as plain sentences. A still is not a shot list: no beats, no camera moves." },
  { id: "nb-photographic", scope: "nano-banana", apply: "writer", on: true, text: "Frame and light in photographic terms — 35mm, eye level, shallow depth, soft window light — rather than film-set jargon." },
];

export type PlatformCaps = {
  /** Credits a new production starts capped at; null means no cap. */
  defaultCapCredits: number | null;
  /** Credits a new workspace opens with; null means the deployment's SIGNUP_CREDITS. */
  signupCredits: number | null;
  /** The share of a production's cap that warns the producer. */
  warnPct: number;
  /** Renders a workspace may have going at once; past it a take waits for a slot. */
  concurrency: number;
  /** Renders a workspace may start in an hour. */
  rendersPerHour: number;
  /** What a workspace may keep, in gigabytes. */
  storageGb: number;
};
export const DEFAULT_CAPS: PlatformCaps = { defaultCapCredits: null, signupCredits: null, warnPct: 80, concurrency: 4, rendersPerHour: 60, storageGb: 50 };

/** The text jobs Atomik and the writer run, each routed to a model (brief 1.8): enhancement is high-volume and runs fast and cheap; ideas and shots can afford a stronger one. */
export type TextJob = "enhance" | "idea" | "shot";
export const TEXT_JOBS: TextJob[] = ["enhance", "idea", "shot"];
export const TEXT_JOB_LABELS: Record<TextJob, string> = { enhance: "Prompt enhancement", idea: "Ideas and treatments", shot: "Shot lists" };
export type TextModels = Record<TextJob, string>;
export const DEFAULT_TEXT_MODELS: TextModels = { enhance: "anthropic/claude-sonnet-5", idea: "anthropic/claude-opus-5", shot: "anthropic/claude-opus-5" };
/** The text models a console may name: the gateway-prefixed ids the rates table knows. */
export const TEXT_MODEL_IDS: string[] = Object.keys(TEXT_RATES).filter((k) => k.includes("/"));

/** The engine a composer opens on, per kind, and the model per text job. The platform's choice; a workspace's Defaults & caps may name another engine. */
export type PlatformModels = { video: string; image: string; text: TextModels };
const firstVisible = (kind: "video" | "image"): string => MODELS.find((m) => m.kind === kind && !m.hidden)?.id ?? DEFAULT_MODEL_ID;
export const DEFAULT_MODELS: PlatformModels = { video: DEFAULT_MODEL_ID, image: firstVisible("image"), text: { ...DEFAULT_TEXT_MODELS } };

function cleanTextModels(v: unknown): TextModels {
  const out = { ...DEFAULT_TEXT_MODELS };
  if (!isObj(v)) return out;
  for (const job of TEXT_JOBS) {
    const id = (v as Record<string, unknown>)[job];
    if (typeof id === "string" && TEXT_MODEL_IDS.includes(id)) out[job] = id;
  }
  return out;
}

/** The model a text job runs on, from the layer's pair — never empty. */
export function textModelFor(models: { text?: Partial<TextModels> } | null | undefined, job: TextJob): string {
  const id = models?.text?.[job];
  return typeof id === "string" && id ? id : DEFAULT_TEXT_MODELS[job];
}

/** A real, visible engine of the kind — or nothing. */
export function modelOfKind(id: unknown, kind: "video" | "image"): string | null {
  if (typeof id !== "string" || !id) return null;
  const m = MODELS.find((x) => x.id === id);
  return m && m.kind === kind && !m.hidden ? m.id : null;
}

export function cleanModels(v: unknown): PlatformModels {
  if (!isObj(v)) return { ...DEFAULT_MODELS, text: { ...DEFAULT_TEXT_MODELS } };
  return { video: modelOfKind(v.video, "video") ?? DEFAULT_MODELS.video, image: modelOfKind(v.image, "image") ?? DEFAULT_MODELS.image, text: cleanTextModels(v.text) };
}

/** What a workspace's composer opens on: its own Defaults & caps when they name a real engine, else the platform's. */
export function resolveModels(settings: Record<string, string | undefined>, layer: { models: PlatformModels }): PlatformModels {
  return {
    video: modelOfKind(settings.defaultVideoModel, "video") ?? layer.models.video,
    image: modelOfKind(settings.defaultImageModel, "image") ?? layer.models.image,
    text: { ...DEFAULT_TEXT_MODELS, ...(layer.models.text ?? {}) },
  };
}

export type PlatformLayer = { setup: ShotSpec; starter: StarterProduction; rules: PlatformRule[]; caps: PlatformCaps; models: PlatformModels; plans: PlanDef[] };
export type LayerKey = keyof PlatformLayer;
export const LAYER_KEYS: LayerKey[] = ["setup", "starter", "rules", "caps", "models", "plans"];
export const DEFAULT_LAYER: PlatformLayer = { setup: DEFAULT_SETUP, starter: STARTER_PRODUCTION, rules: DEFAULT_RULES, caps: DEFAULT_CAPS, models: DEFAULT_MODELS, plans: DEFAULT_PLANS };

const isObj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** A Setup keeps only real Studio categories with real options; anything else is dropped. */
export function cleanSetup(v: unknown): ShotSpec {
  const out: ShotSpec = {};
  if (!isObj(v)) return out;
  for (const [k, val] of Object.entries(v)) {
    const cat = CATEGORIES.find((c) => c.key === k);
    if (!cat || typeof val !== "string") continue;
    if (cat.options.some((o) => o.value === val)) out[k] = val;
  }
  return out;
}

export function cleanStarter(v: unknown): StarterProduction | null {
  if (!isObj(v)) return null;
  const name = str(v.name, 80); if (!name) return null;
  const code = str(v.code, 16).replace(/[^A-Za-z0-9_-]/g, "");
  const description = str(v.description, 500);
  const cast: StarterCast[] = (Array.isArray(v.cast) ? v.cast : []).map((c) => {
    if (!isObj(c)) return null;
    /* A cast name is a citation — `@Name` in a prompt — so it is one word: letters, digits, underscores (lib/cast.ts nameProblem). */
    const n = str(c.name, 40).replace(/^@/, ""); if (!/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(n)) return null;
    const kind = ["character", "location", "prop", "style"].includes(String(c.kind)) ? (c.kind as StarterCast["kind"]) : "character";
    return { name: n, kind, description: str(c.description, 600) };
  }).filter((c): c is StarterCast => Boolean(c)).slice(0, 6);
  const names = new Set(cast.map((c) => c.name));
  const shots: StarterShot[] = (Array.isArray(v.shots) ? v.shots : []).map((s) => {
    if (!isObj(s)) return null;
    const c = str(s.code, 16).replace(/[^A-Za-z0-9_-]/g, ""); if (!c) return null;
    const planned = Number(s.planned); const p = Number.isFinite(planned) && planned > 0 ? Math.min(60, Math.round(planned)) : 5;
    const sc = (Array.isArray(s.cast) ? s.cast : []).map((x) => String(x).replace(/^@/, "")).filter((x) => names.has(x));
    return { code: c, title: str(s.title, 160), description: str(s.description, 2000), planned: p, setup: cleanSetup(s.setup), cast: sc };
  }).filter((s): s is StarterShot => Boolean(s)).slice(0, 12);
  if (!shots.length) return null;
  return { name, code, description, shots, cast };
}

export function cleanRules(v: unknown): PlatformRule[] | null {
  if (!Array.isArray(v)) return null;
  const out: PlatformRule[] = [];
  const seen = new Set<string>();
  for (const r of v) {
    if (!isObj(r)) continue;
    const text = str(r.text, 400); if (!text) continue;
    let id = str(r.id, 40).replace(/[^A-Za-z0-9_-]/g, "") || `rule-${out.length + 1}`;
    while (seen.has(id)) id = `${id}-x`;
    seen.add(id);
    const scope: RuleScope = RULE_SCOPES.includes(r.scope as RuleScope) ? (r.scope as RuleScope) : "all";
    const apply: RuleApply = r.apply === "prompt" ? "prompt" : "writer";
    out.push({ id, text, scope, apply, on: r.on !== false });
  }
  return out.slice(0, 40);
}

export function cleanCaps(v: unknown): PlatformCaps {
  const c = { ...DEFAULT_CAPS };
  if (!isObj(v)) return c;
  const n = (x: unknown) => (x == null || x === "" ? null : Number(x));
  const cap = n(v.defaultCapCredits); c.defaultCapCredits = cap != null && Number.isFinite(cap) && cap > 0 ? Math.round(cap) : null;
  const su = n(v.signupCredits); c.signupCredits = su != null && Number.isFinite(su) && su >= 0 ? Math.round(su) : null;
  const w = Number(v.warnPct); c.warnPct = Number.isFinite(w) && w >= 1 && w <= 100 ? Math.round(w) : DEFAULT_CAPS.warnPct;
  const cc = Number(v.concurrency); c.concurrency = Number.isFinite(cc) && cc >= 1 && cc <= 100 ? Math.round(cc) : DEFAULT_CAPS.concurrency;
  const rh = Number(v.rendersPerHour); c.rendersPerHour = Number.isFinite(rh) && rh >= 1 && rh <= 10_000 ? Math.round(rh) : DEFAULT_CAPS.rendersPerHour;
  const sg = Number(v.storageGb); c.storageGb = Number.isFinite(sg) && sg >= 1 && sg <= 100_000 ? Math.round(sg * 10) / 10 : DEFAULT_CAPS.storageGb;
  return c;
}

/** Stored overrides on top of the defaults; an unreadable override loses to the default. */
export function mergeLayer(stored: Partial<Record<LayerKey, unknown>>): PlatformLayer {
  const setup = stored.setup !== undefined ? cleanSetup(stored.setup) : DEFAULT_SETUP;
  const starter = (stored.starter !== undefined ? cleanStarter(stored.starter) : null) ?? STARTER_PRODUCTION;
  const rules = (stored.rules !== undefined ? cleanRules(stored.rules) : null) ?? DEFAULT_RULES;
  const caps = stored.caps !== undefined ? cleanCaps(stored.caps) : DEFAULT_CAPS;
  const models = stored.models !== undefined ? cleanModels(stored.models) : DEFAULT_MODELS;
  /* `cleanPlans` always returns the four §7A rows, so a workspace pointing at
     a plan an edit removed still resolves to one: "on no plan" and "on a plan
     that went missing" are different states and only the first is real. */
  const plans = stored.plans !== undefined ? cleanPlans(stored.plans) : DEFAULT_PLANS;
  return { setup: Object.keys(setup).length ? setup : DEFAULT_SETUP, starter, rules, caps, models, plans };
}

/** The starter's shots with the layer's default Setup underneath each shot's own. */
export function starterShotsWithSetup(layer: PlatformLayer): StarterShot[] {
  return layer.starter.shots.map((s) => ({ ...s, setup: { ...layer.setup, ...s.setup } }));
}

/** The rules in scope for a kind and an audience, as one paragraph — or nothing. */
export function rulesBlock(rules: PlatformRule[], kind: "video" | "image", apply: RuleApply, family?: string | null): string {
  return rules
    .filter((r) => r.on && r.apply === apply && (r.scope === "all" || r.scope === kind || (Boolean(family) && r.scope === family)))
    .map((r) => r.text.trim().replace(/\s+/g, " "))
    .filter(Boolean)
    .join(" ");
}

/** The writer's rules, one line per scope, for a writer that serves every engine at once (Atomik). Prompt rules are left to the render, which appends them. */
export function writerRulesByScope(rules: PlatformRule[]): string {
  return RULE_SCOPES.map((scope) => {
    const text = rules.filter((r) => r.on && r.apply === "writer" && r.scope === scope).map((r) => r.text.trim().replace(/\s+/g, " ")).filter(Boolean).join(" ");
    return text ? `${scope === "all" ? "Every engine" : RULE_SCOPE_LABELS[scope].replace(/ only$/, "")}: ${text}` : "";
  }).filter(Boolean).join("\n");
}

/** Where a rule came from: inherited from the platform, or written by this workspace. */
export type RuleSource = "platform" | "workspace";
export type EffectiveRule = PlatformRule & { source: RuleSource };

/**
 * The rules in force in one workspace: the platform's, each switched off
 * here when its id is in `off`, then the workspace's own. A switched-off
 * rule is listed (so the team sees what it turned off) but is not `on`.
 */
export function mergeRules(platform: PlatformRule[], workspace: PlatformRule[], off: string[]): EffectiveRule[] {
  const offSet = new Set(off);
  return [
    ...platform.map((r) => ({ ...r, on: r.on && !offSet.has(r.id), source: "platform" as const })),
    ...workspace.map((r) => ({ ...r, source: "workspace" as const })),
  ];
}
