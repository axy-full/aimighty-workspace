/**
 * Atomik skills, the parts with no database: what a skill is, how a run's
 * plan becomes a reusable template, how a template is filled in again, and
 * which allowed engine is nearest to one that is no longer offered.
 *
 * A template keeps a run's steps, each with its engine and settings (ratio,
 * resolution, length, audio task), and the person's own words turned into
 * named parameters: `{{product}}` where the run said "Wave Runner sneakers".
 * It keeps nothing the run produced — no take, no price, no status — and no
 * media: a step that worked from attached media is left out with the reason,
 * never saved without it.
 *
 * Pure, so the browser holds the same rules the server enforces
 * (lib/atomikSkills.ts) and the unit tests can hold them to their word.
 */

export const SKILL_SCOPES = ["personal", "workspace"] as const;
export type SkillScope = (typeof SKILL_SCOPES)[number];
export const SKILL_SCOPE_LABEL: Record<SkillScope, string> = { personal: "Just me", workspace: "Workspace" };
export type SkillStatus = "active" | "archived";
export type SkillStepKind = "video" | "image" | "audio";

/** A step's render settings: what the engine is asked for, never what it made. */
export type SkillSettings = { ratio?: string; resolution?: string; seconds?: number; task?: string };
export type SkillStep = { kind: SkillStepKind; title: string; prompt: string; model: string; params: SkillSettings };
/** A named piece of the person's words; `{{key}}` in a step's title or prompt. */
export type SkillParameter = { key: string; label: string; default: string };
export type SkillTemplate = { steps: SkillStep[]; parameters: SkillParameter[] };

export const SKILL_LIMITS = {
  name: 60,
  description: 140,
  slug: 40,
  /** What changed in a version, in a line. */
  note: 200,
  steps: 12,
  parameters: 8,
  label: 40,
  /** One parameter's value, as it is typed in. */
  value: 300,
  prompt: 4000,
  /** A step's title as a template holds it (placeholders included); a planned step's title is cut to 60. */
  title: 300,
  /** Skills a workspace keeps active; archived ones do not count. */
  activeSkills: 200,
  /** Versions one skill keeps. */
  versions: 100,
} as const;

export const SKILL_ID = /^skl_[A-Za-z0-9]{6,40}$/;
/** The slash command: `/wave-runner-spot`. */
export const SKILL_SLUG = /^[a-z][a-z0-9-]{1,39}$/;
export const PARAM_KEY = /^[a-z][a-z0-9_]{0,31}$/;
const PLACEHOLDER = /\{\{\s*([a-z][a-z0-9_]{0,31})\s*\}\}/g;
/** Any double brace at all: a prompt a person wrote with one could not be told apart from a parameter. */
const BRACES = /\{\{|\}\}/;

/** A person's mistake about a skill, said plainly (the routes answer it with its status). */
export class SkillTextError extends Error {
  constructor(message: string, readonly status = 400) { super(message); this.name = "SkillTextError"; }
}

export function isSkillScope(value: unknown): value is SkillScope {
  return typeof value === "string" && (SKILL_SCOPES as readonly string[]).includes(value);
}

/* ── Words ─────────────────────────────────────────────────────────────── */

/** One line: control characters out, runs of space folded, cut to the limit. */
export function cleanLine(value: unknown, limit: number): string {
  if (typeof value !== "string") return "";
  const flat = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return flat.length > limit ? flat.slice(0, limit).trimEnd() : flat;
}

/** A prompt: line breaks kept, other control characters out, cut to the limit. */
export function cleanPrompt(value: unknown, limit: number = SKILL_LIMITS.prompt): string {
  if (typeof value !== "string") return "";
  const text = value.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, " ").replace(/[ \t]+/g, " ").trim();
  return text.length > limit ? text.slice(0, limit).trimEnd() : text;
}

/** `Wave Runner spot` → `wave-runner-spot`: the command a name suggests. */
export function slugOf(name: string): string {
  const flat = name.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const lead = /^[a-z]/.test(flat) ? flat : flat ? `skill-${flat}` : "skill";
  const cut = lead.slice(0, SKILL_LIMITS.slug).replace(/-+$/, "");
  return cut.length >= 2 ? cut : `${cut}-skill`;
}

/** `wave_runner` → `Wave runner`: how a parameter's key reads when nobody named it. */
export function labelOf(key: string): string {
  const words = key.replace(/_+/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : "Parameter";
}

/** The key a phrase suggests: `@Maya` → `maya`, `Wave Runner sneakers` → `wave_runner_sneakers`. */
export function keyOf(phrase: string, taken: ReadonlySet<string> = new Set()): string {
  const flat = phrase.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  let key = (/^[a-z]/.test(flat) ? flat : flat ? `p_${flat}` : "value").slice(0, 28).replace(/_+$/, "");
  if (!key) key = "value";
  let out = key, n = 2;
  while (taken.has(out)) out = `${key}_${n++}`;
  return out;
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The phrase as a whole-word, case-insensitive match (a letter or digit on either side is another word). */
function phrasePattern(phrase: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(phrase)}(?![\\p{L}\\p{N}_])`, "giu");
}

/** True when the phrase is in the text as whole words, placeholders aside. */
export function hasPhrase(text: string, phrase: string): boolean {
  return text.split(PLACEHOLDER_SPLIT).some((part, i) => i % 2 === 0 && phrasePattern(phrase).test(part));
}

/* Splits a text into [words, placeholder-key, words, …] so replacement never reaches inside a placeholder. */
const PLACEHOLDER_SPLIT = /\{\{\s*([a-z][a-z0-9_]{0,31})\s*\}\}/;

/** Every occurrence of the phrase, outside placeholders, becomes `{{key}}`. */
export function withPlaceholder(text: string, phrase: string, key: string): string {
  const parts = text.split(PLACEHOLDER_SPLIT);
  return parts.map((part, i) => (i % 2 === 1 ? `{{${part}}}` : part.replace(phrasePattern(phrase), `{{${key}}}`))).join("");
}

/** The parameter keys a text names. */
export function placeholdersIn(text: string): string[] {
  return [...new Set([...text.matchAll(PLACEHOLDER)].map((m) => m[1]))];
}

/* ── Suggested parameters ──────────────────────────────────────────────── */

const STOP = new Set([
  "a", "an", "the", "of", "in", "on", "at", "to", "for", "with", "and", "or", "by", "from", "into", "onto", "as", "is", "are",
  "be", "was", "were", "our", "your", "their", "its", "his", "her", "this", "that", "these", "those", "it", "we", "you", "they",
  "i", "me", "my", "us", "some", "any", "each", "every", "very", "just", "then", "than", "so", "but", "not", "no", "up", "down",
  "out", "over", "under", "about", "make", "made", "want", "need", "please", "can", "could", "would", "should", "will", "one",
  "two", "three", "shot", "shots", "spot", "film", "video", "image", "still", "clip", "second", "seconds", "frame", "scene",
]);

type Word = { text: string; lower: string; at: number; end: number };
function wordsOf(text: string): Word[] {
  return [...text.matchAll(/[@#]?[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu)].map((m) => ({
    text: m[0], lower: m[0].toLowerCase().replace(/['’]s$/, ""), at: m.index ?? 0, end: (m.index ?? 0) + m[0].length,
  }));
}

export type ParameterDraft = { key: string; label: string; phrase: string };

/**
 * What in a run looks like the person's own input: a phrase their request
 * used that a step's prompt repeats — "Wave Runner sneakers", "beach at
 * sunset" — and any cast they named (`@Maya`). Only suggestions: the person
 * keeps, renames or removes each one before anything is saved.
 */
export function suggestParameters(requests: readonly string[], steps: readonly { title: string; prompt: string }[], max = 4): ParameterDraft[] {
  const said = requests.map(wordsOf);
  const grams = new Set<string>();
  const capitalised = new Set<string>();
  for (const words of said) {
    for (let i = 0; i < words.length; i++) {
      if (/^\p{Lu}/u.test(words[i].text)) capitalised.add(words[i].lower);
      for (let n = 1; n <= 6 && i + n <= words.length; n++) grams.add(words.slice(i, i + n).map((w) => w.lower).join(" "));
    }
  }
  const found = new Map<string, { phrase: string; words: number; count: number; mention: boolean }>();
  const note = (phrase: string, words: number, mention: boolean) => {
    const key = phrase.toLowerCase();
    const seen = found.get(key);
    if (seen) seen.count++;
    else found.set(key, { phrase, words, count: 1, mention });
  };
  for (const step of steps) {
    for (const text of [step.prompt, step.title]) {
      const words = wordsOf(text);
      for (let i = 0; i < words.length;) {
        /* Cast is its own input, named or not. */
        if (words[i].text.startsWith("@") && words[i].text.length > 2) { note(words[i].text, 1, true); i++; continue; }
        let taken = 0;
        for (let n = Math.min(6, words.length - i); n >= 1; n--) {
          const run = words.slice(i, i + n);
          if (run.some((w) => w.text.startsWith("@"))) continue;
          if (STOP.has(run[0].lower) || STOP.has(run[n - 1].lower)) continue;
          if (!grams.has(run.map((w) => w.lower).join(" "))) continue;
          const solid = run.filter((w) => !STOP.has(w.lower) && w.lower.length >= 3);
          if (!solid.length) continue;
          /* One word only when it is a name the person capitalised, or carries a number. */
          if (n === 1 && !(capitalised.has(run[0].lower) && run[0].lower.length >= 3) && !/\d/.test(run[0].lower)) continue;
          note(text.slice(run[0].at, run[n - 1].end), n, false);
          taken = n;
          break;
        }
        i += Math.max(1, taken);
      }
    }
  }
  const ranked = [...found.values()].sort((a, b) => Number(b.mention) - Number(a.mention) || b.words - a.words || b.count - a.count);
  const chosen: typeof ranked = [];
  for (const candidate of ranked) {
    if (chosen.length >= max) break;
    const lower = candidate.phrase.toLowerCase();
    if (chosen.some((c) => c.phrase.toLowerCase().includes(lower) || lower.includes(c.phrase.toLowerCase()))) continue;
    chosen.push(candidate);
  }
  const taken = new Set<string>();
  return chosen.map((c) => {
    const key = keyOf(c.mention ? c.phrase.slice(1) : c.phrase, taken);
    taken.add(key);
    return { key, label: c.mention ? "Cast" : labelOf(key), phrase: c.phrase };
  }).map((d, i, all) => (d.label === "Cast" && all.filter((x) => x.label === "Cast").length > 1 ? { ...d, label: `Cast · ${d.phrase}` } : d));
}

/* ── From a run to a template ──────────────────────────────────────────── */

/** A step as a run stored it (lib/atomik.ts › Step): only its plan is read. */
export type RunStep = {
  kind: string; title: string; prompt: string; model: string; params: Record<string, unknown>;
  refs?: readonly unknown[]; status?: string; genId?: string | null; estCostUsd?: number | null;
};

/** Why a run's step cannot be kept in a skill, or null when it can. */
export function unkeptReason(step: RunStep): string | null {
  if (step.model.startsWith("connected:")) return "it was planned on the connected account, which Atomik no longer uses";
  if (step.kind !== "video" && step.kind !== "image" && step.kind !== "audio") return "no engine here makes it";
  if (step.refs && step.refs.length) return "it works from attached media, which a skill cannot keep yet";
  if (!step.prompt.trim()) return "it has no prompt";
  return null;
}

/** The settings a step keeps: what its engine is asked for. Everything else a run holds is left behind. */
export function settingsOf(kind: SkillStepKind, params: Record<string, unknown>): SkillSettings {
  const out: SkillSettings = {};
  if (kind !== "audio") {
    if (typeof params.ratio === "string" && params.ratio.length <= 16) out.ratio = params.ratio;
    if (typeof params.resolution === "string" && params.resolution.length <= 16) out.resolution = params.resolution;
  }
  const seconds = Number(params.seconds);
  if (kind !== "image" && Number.isFinite(seconds) && seconds > 0) out.seconds = Math.min(600, Math.round(seconds));
  if (kind === "audio" && typeof params.task === "string" && /^[a-z_]{1,24}$/.test(params.task)) out.task = params.task;
  return out;
}

/**
 * A run's plan as a template: each step's kind, engine and settings, with
 * every chosen phrase turned into `{{key}}` in its title and prompt — longest
 * first, so a phrase inside another is never half replaced. The phrase itself
 * becomes the parameter's default. Outputs, prices, statuses and media are
 * never read into it.
 */
export function templateFromRun(steps: readonly RunStep[], drafts: readonly ParameterDraft[]): SkillTemplate {
  if (!steps.length) throw new SkillTextError("Choose at least one step to keep.");
  if (steps.length > SKILL_LIMITS.steps) throw new SkillTextError(`A skill keeps at most ${SKILL_LIMITS.steps} steps.`);
  steps.forEach((step, i) => {
    const why = unkeptReason(step);
    if (why) throw new SkillTextError(`Step ${i + 1} can't be kept: ${why}. Leave it out to save the rest.`);
    if (BRACES.test(step.prompt) || BRACES.test(step.title)) throw new SkillTextError(`Step ${i + 1} has double braces in its words, which a skill uses for its parameters. Leave it out to save the rest.`);
  });
  const parameters = checkDrafts(drafts);
  const order = [...parameters].sort((a, b) => b.default.length - a.default.length);
  const out: SkillStep[] = steps.map((step) => {
    let title = cleanLine(step.title, SKILL_LIMITS.title) || "Step";
    let prompt = cleanPrompt(step.prompt);
    for (const p of order) { title = withPlaceholder(title, p.default, p.key); prompt = withPlaceholder(prompt, p.default, p.key); }
    const kind = step.kind as SkillStepKind;
    /* Not cut again: a cut could split a placeholder in two. */
    return { kind, title, prompt, model: step.model, params: settingsOf(kind, step.params) };
  });
  for (const p of parameters)
    if (!out.some((s) => placeholdersIn(s.prompt).includes(p.key) || placeholdersIn(s.title).includes(p.key)))
      throw new SkillTextError(`“${p.default}” isn't in any step you kept. Remove that parameter or keep the step that says it.`);
  return { steps: out, parameters };
}

/** The person's parameters, checked: named, distinct, and each a phrase of their own words. */
function checkDrafts(drafts: readonly ParameterDraft[]): SkillParameter[] {
  if (drafts.length > SKILL_LIMITS.parameters) throw new SkillTextError(`A skill takes at most ${SKILL_LIMITS.parameters} parameters.`);
  const keys = new Set<string>();
  const phrases = new Set<string>();
  return drafts.map((d) => {
    const key = typeof d.key === "string" ? d.key.trim() : "";
    if (!PARAM_KEY.test(key)) throw new SkillTextError("Name each parameter with lower-case letters, digits and underscores, starting with a letter.");
    if (keys.has(key)) throw new SkillTextError(`Two parameters are called ${key}. Give each its own name.`);
    keys.add(key);
    const label = cleanLine(d.label, SKILL_LIMITS.label) || labelOf(key);
    const phrase = cleanLine(d.phrase, SKILL_LIMITS.value);
    if (!phrase) throw new SkillTextError(`Say which words ${label} stands for.`);
    if (BRACES.test(phrase)) throw new SkillTextError("A parameter's words can't hold double braces.");
    if (phrases.has(phrase.toLowerCase())) throw new SkillTextError(`Two parameters stand for “${phrase}”. Keep one.`);
    phrases.add(phrase.toLowerCase());
    return { key, label, default: phrase };
  });
}

/* ── Checking an edited template ───────────────────────────────────────── */

/**
 * A template as a person edited it, checked and cleaned: steps with prompts,
 * known kinds and plain settings; parameters named once, each with a default;
 * every placeholder a parameter, and every parameter used.
 */
export function checkTemplate(value: unknown): SkillTemplate {
  const raw = value && typeof value === "object" ? value as { steps?: unknown; parameters?: unknown } : {};
  const stepsIn = Array.isArray(raw.steps) ? raw.steps : [];
  if (!stepsIn.length) throw new SkillTextError("A skill needs at least one step.");
  if (stepsIn.length > SKILL_LIMITS.steps) throw new SkillTextError(`A skill keeps at most ${SKILL_LIMITS.steps} steps.`);
  const paramsIn = Array.isArray(raw.parameters) ? raw.parameters : [];
  if (paramsIn.length > SKILL_LIMITS.parameters) throw new SkillTextError(`A skill takes at most ${SKILL_LIMITS.parameters} parameters.`);
  const keys = new Set<string>();
  const parameters: SkillParameter[] = paramsIn.map((p) => {
    const o = p && typeof p === "object" ? p as Record<string, unknown> : {};
    const key = typeof o.key === "string" ? o.key.trim() : "";
    if (!PARAM_KEY.test(key)) throw new SkillTextError("Name each parameter with lower-case letters, digits and underscores, starting with a letter.");
    if (keys.has(key)) throw new SkillTextError(`Two parameters are called ${key}. Give each its own name.`);
    keys.add(key);
    const label = cleanLine(o.label, SKILL_LIMITS.label) || labelOf(key);
    const fallback = cleanLine(o.default, SKILL_LIMITS.value);
    if (!fallback) throw new SkillTextError(`Give ${label} a default: the words a run uses when nobody changes them.`);
    if (BRACES.test(fallback)) throw new SkillTextError("A parameter's words can't hold double braces.");
    return { key, label, default: fallback };
  });
  const steps: SkillStep[] = stepsIn.map((s, i) => {
    const o = s && typeof s === "object" ? s as Record<string, unknown> : {};
    const kind = o.kind === "video" || o.kind === "image" || o.kind === "audio" ? o.kind : null;
    if (!kind) throw new SkillTextError(`Step ${i + 1} must be a video, image or audio step.`);
    const model = typeof o.model === "string" ? o.model.trim() : "";
    if (!model || model.length > 120 || model.startsWith("connected:")) throw new SkillTextError(`Choose an engine for step ${i + 1}.`);
    const prompt = cleanPrompt(o.prompt);
    if (prompt.length < 3) throw new SkillTextError(`Write a prompt for step ${i + 1}.`);
    const title = cleanLine(o.title, SKILL_LIMITS.title) || `Step ${i + 1}`;
    for (const text of [prompt, title]) {
      const stray = text.replace(PLACEHOLDER, "");
      if (BRACES.test(stray)) throw new SkillTextError(`Step ${i + 1} has double braces that aren't a parameter. Write parameters as {{name}}.`);
      for (const key of placeholdersIn(text))
        if (!keys.has(key)) throw new SkillTextError(`Step ${i + 1} uses {{${key}}}, which isn't one of this skill's parameters.`);
    }
    return { kind, title, prompt, model, params: settingsOf(kind, o.params && typeof o.params === "object" ? o.params as Record<string, unknown> : {}) };
  });
  for (const p of parameters)
    if (!steps.some((s) => placeholdersIn(s.prompt).includes(p.key) || placeholdersIn(s.title).includes(p.key)))
      throw new SkillTextError(`${p.label} isn't used in any step. Use it as {{${p.key}}} or remove it.`);
  return { steps, parameters };
}

/* ── Filling a template in ─────────────────────────────────────────────── */

export type FilledStep = Omit<SkillStep, "params"> & { params: SkillSettings; index: number };

/**
 * The values a run is planned with: each parameter's own, or its default when
 * the person left it alone. A value is one line of their words; an empty one
 * is asked for, never guessed.
 */
export function parameterValues(parameters: readonly SkillParameter[], given: unknown): Record<string, string> {
  const input = given && typeof given === "object" && !Array.isArray(given) ? given as Record<string, unknown> : {};
  const out: Record<string, string> = {};
  for (const p of parameters) {
    const raw = Object.hasOwn(input, p.key) ? input[p.key] : p.default;
    if (typeof raw !== "string" && raw !== undefined) throw new SkillTextError(`${p.label} must be words.`);
    if (typeof raw === "string" && raw.length > SKILL_LIMITS.value * 2) throw new SkillTextError(`Keep ${p.label} under ${SKILL_LIMITS.value} characters.`);
    const value = cleanLine(raw ?? "", SKILL_LIMITS.value);
    if (!value) throw new SkillTextError(`Fill in ${p.label}.`);
    out[p.key] = value;
  }
  return out;
}

/** Every placeholder replaced, in one pass: a value that looks like a placeholder stays words. */
export function fillText(text: string, values: Readonly<Record<string, string>>): string {
  return text.replace(PLACEHOLDER, (whole, key: string) => (Object.hasOwn(values, key) ? values[key] : whole));
}

/** The template's steps with these values in them, ready to be priced and proposed. */
export function fillTemplate(template: SkillTemplate, values: Readonly<Record<string, string>>): FilledStep[] {
  return template.steps.map((step, index) => {
    const prompt = fillText(step.prompt, values).trim();
    if (prompt.length > SKILL_LIMITS.prompt) throw new SkillTextError(`With these words, step ${index + 1}'s prompt runs past ${SKILL_LIMITS.prompt.toLocaleString("en-US")} characters. Shorten a parameter.`);
    return { ...step, index, title: fillText(step.title, values).slice(0, 60).trim() || `Step ${index + 1}`, prompt };
  });
}

/** A parameter's value as a message says it: `product “red high-tops”`. */
export function describeValues(parameters: readonly SkillParameter[], values: Readonly<Record<string, string>>): string {
  return parameters.map((p) => `${p.label.toLowerCase()} “${values[p.key] ?? p.default}”`).join(", ");
}

/* ── Engines ───────────────────────────────────────────────────────────── */

/** What the nearest-engine rule needs of an engine a step may run on. */
export type EngineChoice = { id: string; label: string; kind: string; ratios: string[]; resolutions: string[]; durations: number[] };
/** What it needs of the catalogue, for an engine that is no longer offered. */
export type CatalogueEntry = { id: string; label: string; family: string; provider: string };

export type EngineProblem = {
  /** The step's position in the template, from 0. */
  step: number; title: string; model: string; label: string;
  /** `off`: switched off for Atomik in Settings › Engines. `gone`: no longer offered at all. */
  reason: "off" | "gone";
  nearest: { id: string; label: string } | null;
  /** Every allowed engine of the step's kind, the nearest first: what the person may choose instead. */
  choices: { id: string; label: string }[];
};

/**
 * The allowed engine nearest to one a step can no longer run on: the same
 * kind; then the same family (Kling 3.0 Pro → Kling 3.0), the same provider,
 * and the settings the step asks for; then the order the engines are listed
 * in. Null when no allowed engine makes that kind. Only ever offered — a run
 * waits until the person chooses it.
 */
export function rankEngines(step: Pick<SkillStep, "kind" | "model" | "params">, allowed: readonly EngineChoice[], catalogue: readonly CatalogueEntry[]): EngineChoice[] {
  const from = catalogue.find((m) => m.id === step.model);
  const family = (id: string) => catalogue.find((m) => m.id === id);
  const score = (e: EngineChoice) => {
    const entry = family(e.id);
    let n = 0;
    if (from && entry && entry.family === from.family) n += 100;
    if (from && entry && entry.provider === from.provider) n += 20;
    if (step.params.ratio && e.ratios.includes(step.params.ratio)) n += 4;
    if (step.params.resolution && e.resolutions.some((r) => r.toLowerCase() === String(step.params.resolution).toLowerCase())) n += 4;
    if (step.params.seconds && e.durations.includes(step.params.seconds)) n += 2;
    return n;
  };
  return allowed
    .map((e, order) => ({ e, order, n: score(e) }))
    .filter(({ e }) => e.kind === step.kind && e.id !== step.model)
    .sort((a, b) => b.n - a.n || a.order - b.order)
    .map(({ e }) => e);
}

/** Why a step cannot run on its engine here, with the nearest allowed one; null when it can. */
export function engineProblem(step: SkillStep, index: number, allowed: readonly EngineChoice[], off: readonly string[], catalogue: readonly CatalogueEntry[]): EngineProblem | null {
  if (allowed.some((e) => e.id === step.model && e.kind === step.kind)) return null;
  const known = catalogue.find((m) => m.id === step.model);
  const ranked = rankEngines(step, allowed, catalogue);
  return {
    step: index, title: step.title, model: step.model, label: known?.label ?? step.model,
    reason: known && off.includes(step.model) ? "off" : "gone",
    nearest: ranked[0] ? { id: ranked[0].id, label: ranked[0].label } : null,
    choices: ranked.map((e) => ({ id: e.id, label: e.label })),
  };
}

/** The problem as the person reads it. */
export function engineProblemText(p: EngineProblem): string {
  const why = p.reason === "off" ? `${p.label} is switched off for Atomik in Settings › Engines.` : `${p.label} is no longer offered in Atomik.`;
  return p.nearest ? `${why} Nearest allowed: ${p.nearest.label}.` : `${why} No allowed engine makes this kind of step here.`;
}

/* ── What a browser reads ──────────────────────────────────────────────── */

/** A skill as a member reads it: who made it said as names, never as account ids. */
export type SkillView = {
  id: string; slug: string; name: string; description: string;
  scope: SkillScope; status: SkillStatus; version: number;
  byYou: boolean; byName: string | null;
  /** Who made the version in use. */
  editedByYou: boolean; editedByName: string | null;
  archivedByYou: boolean; archivedByName: string | null; archivedAt: number | null;
  createdAt: number; updatedAt: number;
  template: SkillTemplate;
  /** Only its maker moves a skill between Just me and Workspace. */
  canChangeScope: boolean;
};

export type SkillVersionView = {
  version: number; name: string; slug: string; description: string; scope: SkillScope;
  note: string | null; byYou: boolean; byName: string | null; createdAt: number;
  /** Present when one version is read on its own. */
  template?: SkillTemplate;
};

/** A run a person could save as a skill: an Atomik chat with a plan. */
export type SavableRun = { chatId: string; title: string; projectId: string | null; steps: number; updatedAt: number };

/** The Save as skill form, filled from a run: what can be kept, and what looks like the person's input. */
export type SkillDraft = {
  chatId: string; name: string; slug: string;
  /** `latest`: the step is in the chat's latest plan (the one on screen); earlier plans' steps start unticked. */
  steps: { id: string; kind: string; title: string; prompt: string; model: string; label: string; settings: SkillSettings; keep: boolean; latest: boolean; why: string | null }[];
  parameters: ParameterDraft[];
};

/** A step of a planned or previewed run, priced in the workspace's own unit. */
export type SkillRunStep = {
  index: number; kind: SkillStepKind; title: string; prompt: string; model: string; label: string; params: SkillSettings;
  /** Credits for a workspace that pays in credits (the estimate admission bills); null when only its checkpoint can price it. */
  estCredits: number | null;
  /** Dollars for a workspace on its own keys; never both. */
  estUsd: number | null;
  /** True when the person chose this engine in place of one the skill can no longer use. */
  swapped: boolean;
};

export type SkillRunPreview = { steps: SkillRunStep[]; problems: EngineProblem[]; values: Record<string, string> };

/** The engines a template runs on, once each, as the person reads them. */
export function engineSummary(template: SkillTemplate, label: (id: string) => string): string {
  return [...new Set(template.steps.map((s) => label(s.model)))].join(", ");
}

/** A step's settings in a line: `5s · 1080p · 16:9`. */
export function settingsLine(params: SkillSettings): string {
  return [params.task ? params.task : null, params.seconds ? `${params.seconds}s` : null, params.resolution ?? null, params.ratio ?? null].filter(Boolean).join(" · ");
}

/**
 * Values typed after a command, in the form a run records them:
 * `/wave-runner-spot product: Red High-Tops · setting: a rooftop at dusk`.
 * Each `name: words` pair is matched to a parameter by its key or its label;
 * anything else is left for the form, which shows every value before a run.
 */
export function commandValues(rest: string, parameters: readonly SkillParameter[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of rest.split(/\s*[·;]\s*/)) {
    const m = /^([^:]{1,40}):\s*(.+)$/.exec(part.trim());
    if (!m) continue;
    const name = m[1].trim().toLowerCase();
    const p = parameters.find((x) => x.key === name || x.label.toLowerCase() === name);
    const value = cleanLine(m[2], SKILL_LIMITS.value);
    if (p && value) out[p.key] = value;
  }
  return out;
}
