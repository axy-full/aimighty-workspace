import type { Generation } from "../jobs";
import { displayModelName } from "../models";
import type { BillingSource, ComposerModel, ComposerPicks, ComposerSettings, ComposerType } from "../workspace/composer";

/**
 * Recreate (README › Interactions, the asset's "Retry"): a take's whole
 * recipe handed back to Gen — the words as typed, which credits paid, the
 * model, its settings, the references it was made with, the Soul identity and
 * the shot setup. Pure: what a take carries, why one cannot be recreated in
 * Gen, and how what Gen now holds differs from what the take was made with.
 *
 * Nothing here runs anything: Gen prices the recipe again, on the button,
 * before a credit moves.
 */

/** A reference the take was made with, cited by the store it lives in (params.references). */
export type RecipeReference = { origin: "upload" | "generation"; id: string; role?: string; kind?: "image" | "video" | "audio" };
/** Sound takes: the length, the instrumental switch and the voice. */
export type RecipeSound = { seconds?: number; instrumental?: boolean; voiceId?: string };

/**
 * What the shell hands Gen, through its one letterbox (lib/shell/gen-preset.ts).
 * Crew, Soul ID, ⌘K and the public site's hero send words, a model and
 * settings (an empty prompt leaves Gen's words as they are); Recreate sends a
 * take's recipe (`from`), applied in one step that Undo reverses.
 */
export type GenPreset = {
  prompt: string;
  model?: string;
  type?: ComposerType;
  note?: string;
  billing?: BillingSource;
  picks?: ComposerPicks;
  references?: RecipeReference[];
  shotSpec?: Record<string, string>;
  sound?: RecipeSound;
  /** A connected take: whether the account was asked to enhance the words (settings.enhance_prompt). */
  enhance?: boolean;
  /** The take this recipe came from. */
  from?: { id: string; name: string };
  /** Use settings only: the model and its settings; the words and references in Gen stay. */
  settingsOnly?: boolean;
};

export type RecipeSource = Pick<Generation, "id" | "kind" | "model" | "prompt" | "params" | "provider" | "task">;

const ID = /^[A-Za-z0-9_-]{1,160}$/;
const REFERENCES_MAX = 10;
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);
const positive = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined);
const composerType = (kind: string): ComposerType | undefined => (kind === "image" || kind === "video" || kind === "audio" ? kind : undefined);

/** A take made through the connected account's catalogue (lib/higgsfield-consumer/original-identity.ts). */
export const madeOnAccount = (g: Pick<Generation, "provider" | "params">) => g.provider === "higgsfield" && g.params?.task === "connected-generation";

/** The words a person typed (the writer's rewrite and the cast expansion are the take's, not the recipe's). */
export function recipePrompt(g: Pick<Generation, "prompt" | "params">): string {
  return text(g.params?.rawPrompt) ?? g.prompt ?? "";
}

/**
 * What Gen itself writes as `params.task`: sound, music and a line (the audio route), the connected
 * catalogue's plain generation, and a plain generation named as one (the generate route leaves it out).
 */
const GEN_TASKS: ReadonlySet<unknown> = new Set(["generate", "sound", "music", "speech", "connected-generation"]);
/** The tasks that work on a source clip (lib/tasks.ts TaskId, lib/dubbing.ts, the audio route's voiceChange). */
const SOURCE_TASKS: ReadonlySet<unknown> = new Set(["edit", "extend", "motion", "upscale", "reframe", "genjutsu", "dub", "voiceChange"]);
/** Marketing Studio renders carry Business setup (products, avatars, styles) that Gen's composer has no place for. */
const BUSINESS_MODELS: ReadonlySet<string> = new Set(["marketing_studio_video", "marketing_studio_image", "ms_image", "marketing_studio_v2"]);

/**
 * Why Gen cannot recreate this take, or null. Gen makes images, video and
 * sound from words and references; a take from a tool (an edit, a dub, a
 * dialogue, a campaign template, a motion transfer, a trained identity's
 * still, the account's marketing video) or an engine Gen does not offer is
 * run again where it was made, and the reason names that place when it is
 * known. `params.task` is read as an allow-list, so a tool added later is
 * blocked until Gen can make it.
 */
export function recreateBlock(g: Pick<Generation, "kind" | "model" | "params" | "task">): string | null {
  if (!composerType(g.kind)) return "Gen makes images, video and sound, not 3D.";
  const p = g.params ?? {};
  if (p.task === "dialogue" || Array.isArray(p.lines)) return "A dialogue is made in Edit & Sound, not Gen.";
  if (p.sourceGenId || p.sourceUploadId || SOURCE_TASKS.has(p.task)) return "This take was made from a source clip. Run that tool again from Takes.";
  if (p.task === "connected-generation" && p.workflow !== undefined && p.workflow !== "generation") return "This take came from a connected tool, not Gen. Run that tool again.";
  if (BUSINESS_MODELS.has(g.model)) return "This ad was made in Business, with its product and setup. Make it again from Ads.";
  /* Anything else Gen did not make itself. Every original the connected account delivered is receipted
     in these credits (lib/higgsfield-consumer/video-original.ts). */
  const onAccount = p.consumerCreditUnit === "higgsfield_credits";
  const fromTool = (g.task && g.task !== "generate")
    || (p.task !== undefined && !GEN_TASKS.has(p.task))
    || typeof p.workflow === "string"
    || (onAccount && p.task !== "connected-generation")
    || Boolean(p.marketing) || Boolean(p.soulIdentityId) || record(p.identity);
  return fromTool ? "Made with a tool Gen does not have. Run it again from that tool." : null;
}

/** The take's recipe, as Gen reads it. */
export function recreatePreset(g: RecipeSource, options: { name: string; settingsOnly?: boolean }): GenPreset {
  const params = g.params ?? {};
  const type = composerType(g.kind);
  const connected = madeOnAccount(g);
  /* The account's own settings are what the catalogue was asked for; the top-level `duration` is the measured file. */
  const asked = connected && record(params.settings) ? params.settings : null;
  const picks: ComposerPicks = {};
  const ratio = asked ? text(asked.aspect_ratio) : text(params.ratio) ?? text(params.aspectRatio);
  const resolution = asked ? text(asked.resolution) : text(params.resolution);
  const duration = type === "video" ? positive(asked ? asked.duration : params.duration) : undefined;
  const soulId = asked ? text(asked.soul_id) : undefined;
  const enhance = asked && typeof asked.enhance_prompt === "boolean" ? asked.enhance_prompt : undefined;
  if (ratio) picks.ratio = ratio;
  if (resolution) picks.resolution = resolution;
  if (duration) picks.duration = duration;
  if (soulId) picks.soulId = soulId;

  const references: RecipeReference[] = [];
  if (type !== "audio" && Array.isArray(params.references)) {
    for (const entry of params.references) {
      if (!record(entry) || references.length >= REFERENCES_MAX) continue;
      const origin = typeof entry.genId === "string" ? "generation" : typeof entry.uploadId === "string" ? "upload" : null;
      const id = origin === "generation" ? entry.genId : entry.uploadId;
      if (!origin || typeof id !== "string" || !ID.test(id)) continue;
      const role = text(entry.role);
      const kind = entry.kind === "image" || entry.kind === "video" || entry.kind === "audio" ? entry.kind : undefined;
      references.push({ origin, id, ...(role ? { role } : {}), ...(kind ? { kind } : {}) });
    }
  }

  const shotSpec = record(params.shotSpec)
    ? Object.fromEntries(Object.entries(params.shotSpec).filter((pair): pair is [string, string] => typeof pair[1] === "string" && pair[1].length > 0).slice(0, 20))
    : {};

  const sound: RecipeSound = {};
  if (type === "audio" && !connected) {
    const seconds = positive(params.durationSeconds) ?? (positive(params.lengthMs) ? Number(params.lengthMs) / 1000 : undefined);
    if (seconds) sound.seconds = seconds;
    if (typeof params.instrumental === "boolean") sound.instrumental = params.instrumental;
    const voice = text(params.voiceId);
    if (voice) sound.voiceId = voice;
  }

  return {
    prompt: recipePrompt(g),
    model: g.model,
    ...(type ? { type } : {}),
    billing: connected ? "connected" : "workspace",
    picks,
    ...(references.length ? { references } : {}),
    ...(Object.keys(shotSpec).length ? { shotSpec } : {}),
    ...(Object.keys(sound).length ? { sound } : {}),
    ...(enhance !== undefined ? { enhance } : {}),
    from: { id: g.id, name: options.name },
    ...(options.settingsOnly ? { settingsOnly: true } : {}),
    note: `${options.settingsOnly ? "Settings" : "Recreate"} · ${options.name}`,
  };
}

/* ── Citations ─────────────────────────────────────────────────────────── */

type Citable = "image" | "video";
const TAG_WORD: Record<Citable, string> = { image: "Image", video: "Video" };

/**
 * How each reference is cited: @Image1, @Video1 — counted within its own
 * kind, in order, the way the engine numbers what it is sent (lib/ark.ts ›
 * buildRequestBody). Anything else (a sound) has no tag.
 */
export function referenceTags(kinds: readonly (string | undefined)[]): (string | null)[] {
  const seen: Record<Citable, number> = { image: 0, video: 0 };
  return kinds.map((kind) => (kind === "image" || kind === "video" ? `@${TAG_WORD[kind]}${++seen[kind]}` : null));
}

/**
 * The take's references once read again. The ones still here keep their
 * order and take the numbers the well gives them; the ones that are gone are
 * numbered after them, so every citation in the words still names a slot of
 * its own (a reference added next fills the first gap) and none of them lands
 * on a different picture. Returns each reference's tag in the take and now,
 * and the words with every citation moved in one pass.
 */
export function retagRecipe(prompt: string, refs: readonly { kind: string | undefined; found: boolean }[]): {
  prompt: string;
  was: (string | null)[];
  now: (string | null)[];
} {
  const was = referenceTags(refs.map((r) => r.kind));
  const now: (string | null)[] = refs.map(() => null);
  const next: Record<Citable, number> = { image: 0, video: 0 };
  for (const found of [true, false]) {
    refs.forEach((r, i) => {
      if (r.found !== found || (r.kind !== "image" && r.kind !== "video")) return;
      now[i] = `@${TAG_WORD[r.kind]}${++next[r.kind]}`;
    });
  }
  const moves = new Map<string, string>();
  was.forEach((tag, i) => { if (tag && now[i] && tag !== now[i]) moves.set(tag, now[i]!); });
  const moved = moves.size ? prompt.replace(/@(?:Image|Video)\d+(?!\d)/g, (tag) => moves.get(tag) ?? tag) : prompt;
  return { prompt: moved, was, now };
}

/** True when the words cite this tag (@Image1 is not @Image12). */
export const cites = (prompt: string, tag: string) => new RegExp(`${tag}(?!\\d)`).test(prompt);

/* ── Settings the new model does not offer ───────────────────────────── */

/** 480p < 720p < 1080p < 2k < 4k; 1K < 2K < 4K. Unknown sizes have no rank. */
function sizeRank(value: string): number | null {
  const lines = /^(\d{3,4})p$/i.exec(value);
  if (lines) return Number(lines[1]);
  const k = /^(\d(?:\.\d)?)k$/i.exec(value);
  return k ? Number(k[1]) * 1000 : null;
}

/**
 * Where a setting the take was made with lands when the model Gen now holds
 * does not offer it: the nearest offered value at or below it (a recreate never
 * quietly costs more), else the smallest above. Undefined when there is no
 * sensible neighbour, and the engine's default stands.
 */
export function nearestSetting<T extends string | number>(want: T, offered: readonly T[]): T | undefined {
  if (!offered.length || offered.includes(want)) return undefined;
  const rank = (v: T) => (typeof v === "number" ? v : sizeRank(v));
  const target = rank(want);
  if (target === null) return undefined;
  const ranked = offered.flatMap((v) => { const r = rank(v); return r === null ? [] : [{ v, r }]; }).sort((a, b) => a.r - b.r);
  const below = ranked.filter((x) => x.r <= target);
  return below.length ? below[below.length - 1].v : ranked[0]?.v;
}

/* ── What Gen holds against what the take was made with ──────────────── */

export type RecipeChip = {
  key: "model" | "ratio" | "resolution" | "duration" | "identity" | "length";
  label: string;
  /** "16:9", or "21:9 → 16:9" when Gen now holds something else. */
  value: string;
  state: "kept" | "changed" | "reading";
  /** Why it changed, said once, short. */
  why?: string;
};

/** A connected take's model when Gen cannot read the account's list: its catalogue id is not a name. */
export const ACCOUNT_MODEL = "Account model";

export function recipeChips(input: {
  preset: GenPreset;
  /** The output and the credits Gen is on now. */
  type: ComposerType;
  billing: BillingSource;
  /** The model Gen will send, the list it chose from, and the settings it will send with it. */
  model: ComposerModel | null;
  models: readonly ComposerModel[];
  settings: ComposerSettings;
  /** The model list is still being read. */
  reading: boolean;
  /** Why the composer has no model, when it has none (a failed read, no connected account). */
  blocked: string | null;
  /** The person is the workspace owner (the connected account is theirs). */
  owner: boolean;
  /** The account's identities, once read (null until then). */
  identities: readonly { soulId: string; name: string; status: string | null }[] | null;
}): RecipeChip[] {
  const { preset, model, settings } = input;
  if (!preset.model) return [];
  const wanted = input.models.find((m) => m.id === preset.model)?.label
    ?? (preset.billing === "connected" ? ACCOUNT_MODEL : displayModelName(preset.model));
  if (input.reading) return [{ key: "model", label: "Model", value: wanted, state: "reading" }];
  /* No model at all: one line with the composer's own reason; settings have nothing to be compared against. */
  if (!model) return [{ key: "model", label: "Model", value: `${wanted} → none`, state: "changed", why: input.blocked ?? "No model is offered here" }];
  const chips: RecipeChip[] = [];
  const lostAccount = preset.billing === "connected" && input.billing !== "connected";
  const sameModel = !lostAccount && model.id === preset.model;
  if (sameModel) chips.push({ key: "model", label: "Model", value: model.label, state: "kept" });
  else {
    const why = lostAccount ? (input.owner ? "Studio engines chosen" : "The connected account is the owner’s")
      : input.type !== preset.type || input.billing !== preset.billing || input.models.some((m) => m.id === preset.model) ? "Changed here"
      : "Not offered here now";
    const now = model.label === wanted ? (input.billing === "connected" ? "account" : "Studio engine") : model.label;
    chips.push({ key: "model", label: "Model", value: `${wanted} → ${now}`, state: "changed", why });
  }

  const picks = preset.picks ?? {};
  const compare = (key: "ratio" | "resolution" | "duration", label: string, want: string | number | undefined, now: string | number, offered: readonly (string | number)[] | undefined, show: (v: string | number) => string) => {
    if (want === undefined) return;
    if (!offered?.length) {
      if (!sameModel) chips.push({ key, label, value: `${show(want)} → default`, state: "changed", why: `${model.label} has no ${label.toLowerCase()} choice` });
      return;
    }
    if (want === now) chips.push({ key, label, value: show(want), state: "kept" });
    else chips.push({ key, label, value: `${show(want)} → ${show(now)}`, state: "changed", why: offered.includes(want) ? "Changed here" : `${model.label} has no ${show(want)}` });
  };
  compare("ratio", "Aspect", picks.ratio, settings.ratio, model.ratios, String);
  compare("resolution", "Resolution", picks.resolution, settings.resolution, model.resolutions, String);
  compare("duration", "Length", picks.duration, settings.duration, model.durations, (v) => `${v} s`);

  if (picks.soulId) {
    const found = input.identities?.find((c) => c.soulId === picks.soulId && c.status !== "training" && c.status !== "failed");
    if (!model.soulId) chips.push({ key: "identity", label: "Identity", value: "Identity → none", state: "changed", why: `${model.label} takes no identity` });
    else if (!input.identities) chips.push({ key: "identity", label: "Identity", value: "Identity", state: "reading" });
    else if (!found) chips.push({ key: "identity", label: "Identity", value: "Identity → none", state: "changed", why: "No longer on the account" });
    else if (settings.soulId === picks.soulId) chips.push({ key: "identity", label: "Identity", value: found.name, state: "kept" });
    else chips.push({ key: "identity", label: "Identity", value: `${found.name} → none`, state: "changed", why: "Changed here" });
  }
  if (preset.sound?.seconds && model.audioTask && model.audioTask !== "speech")
    chips.push({ key: "length", label: "Length", value: `${Math.round(preset.sound.seconds * 10) / 10} s`, state: "kept" });
  return chips;
}
