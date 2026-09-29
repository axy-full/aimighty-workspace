import type { Generation } from "../jobs";
import { displayModelName } from "../models";
import { AUDIO_SECONDS, type ComposerModel, type ComposerPicks, type ComposerSettings, type ComposerType } from "../workspace/composer";

/**
 * Recreate (README › Interactions, the asset's "Retry"): a take's whole
 * recipe handed back to Gen — the words as typed, the model, its settings, the
 * references it was made with and the shot setup. Pure: what a take carries,
 * why one cannot be recreated in Gen, and how what Gen now holds differs from
 * what the take was made with. A take made on the Higgsfield account (history:
 * the sign-in is retired) recreates on this workspace's Studio engines.
 *
 * Nothing here runs anything: Gen prices the recipe again, on the button,
 * before a credit moves.
 */

/** A reference the take was made with, cited by the store it lives in (params.references). */
export type RecipeReference = { origin: "upload" | "generation"; id: string; role?: string; kind?: "image" | "video" | "audio" };
/** Sound takes: the length, the instrumental switch and the voice. */
export type RecipeSound = { seconds?: number; instrumental?: boolean; voiceId?: string };
/** A take's settings; `soulId` is an identity it was made with on the retired Higgsfield account: shown, never sent. */
export type RecipePicks = ComposerPicks & { soulId?: string };
/** The settings Gen's composer takes from a recipe: an account identity stays behind. */
export function composerPicksOf(picks: RecipePicks | undefined): ComposerPicks {
  if (!picks) return {};
  return {
    ...(picks.ratio !== undefined ? { ratio: picks.ratio } : {}),
    ...(picks.resolution !== undefined ? { resolution: picks.resolution } : {}),
    ...(picks.duration !== undefined ? { duration: picks.duration } : {}),
    ...(picks.draft !== undefined ? { draft: picks.draft } : {}),
  };
}

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
  /**
   * Which credits paid for the take: "connected" marks one made on the
   * Higgsfield account before its sign-in was retired (history). Gen recreates
   * every take on this workspace's Studio engines.
   */
  billing?: "workspace" | "connected";
  picks?: RecipePicks;
  references?: RecipeReference[];
  shotSpec?: Record<string, string>;
  sound?: RecipeSound;
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
  /* A final has no recipe of its own: its words, references and settings are its draft's (lib/draftFinal.ts). */
  if (typeof p.finalOf === "string") return "A 1080p final is made from its draft. Recreate the draft instead.";
  if (p.task === "connected-generation" && p.workflow !== undefined && p.workflow !== "generation") return "This take came from a connected tool, not Gen. Run that tool again.";
  if (BUSINESS_MODELS.has(g.model)) return "This ad was made in Business on a signed-in Higgsfield account. Particl no longer signs in to Higgsfield.";
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
  const picks: RecipePicks = {};
  const ratio = asked ? text(asked.aspect_ratio) : text(params.ratio) ?? text(params.aspectRatio);
  const resolution = asked ? text(asked.resolution) : text(params.resolution);
  const duration = type === "video" ? positive(asked ? asked.duration : params.duration) : undefined;
  const soulId = asked ? text(asked.soul_id) : undefined;
  if (ratio) picks.ratio = ratio;
  if (resolution) picks.resolution = resolution;
  if (duration) picks.duration = duration;
  if (soulId) picks.soulId = soulId;
  /* A draft comes back as a draft: 480p first, its final after (lib/draftFinal.ts). */
  if (params.draft === true) picks.draft = true;

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
  key: "model" | "ratio" | "resolution" | "duration" | "draft" | "identity" | "length" | "voice" | "instrumental";
  label: string;
  /** "16:9", or "21:9 → 16:9" when Gen now holds something else. */
  value: string;
  state: "kept" | "changed" | "reading";
  /** Why it changed, said once, short. */
  why?: string;
};

/** An account take's model: its catalogue id on the Higgsfield account is not a name. */
export const ACCOUNT_MODEL = "Account model";

export function recipeChips(input: {
  preset: GenPreset;
  /** The output Gen is on now. */
  type: ComposerType;
  /** The model Gen will send, the list it chose from, and the settings it will send with it. */
  model: ComposerModel | null;
  models: readonly ComposerModel[];
  settings: ComposerSettings;
  /** The model list is still being read. */
  reading: boolean;
  /** Why the composer has no model, when it has none (a failed read). */
  blocked: string | null;
  /** Sound as Gen holds it now: the length billed, the Instrumental switch, the voice a line is read in and the model's voices. */
  sound?: { seconds: number; instrumental: boolean; voice: { id: string; name: string } | null; voices: readonly { id: string; name: string }[] };
}): RecipeChip[] {
  const { preset, model, settings } = input;
  if (!preset.model) return [];
  const wanted = input.models.find((m) => m.id === preset.model)?.label
    ?? (preset.billing === "connected" ? ACCOUNT_MODEL : displayModelName(preset.model));
  if (input.reading) return [{ key: "model", label: "Model", value: wanted, state: "reading" }];
  /* No model at all: one line with the composer's own reason; settings have nothing to be compared against. */
  if (!model) return [{ key: "model", label: "Model", value: `${wanted} → none`, state: "changed", why: input.blocked ?? "No model is offered here" }];
  const chips: RecipeChip[] = [];
  /* Gen offers no signed-in account's catalogue (28 September 2026): an account take recreates on Studio engines, for everyone. */
  const lostAccount = preset.billing === "connected";
  const sameModel = !lostAccount && model.id === preset.model;
  if (sameModel) chips.push({ key: "model", label: "Model", value: model.label, state: "kept" });
  else {
    const why = lostAccount ? "Gen runs on Studio engines only"
      : input.type !== preset.type || input.models.some((m) => m.id === preset.model) ? "Changed here"
      : "Not offered here now";
    const now = model.label === wanted ? "Studio engine" : model.label;
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
  if (picks.draft)
    chips.push(settings.draft ? { key: "draft", label: "Draft", value: "Draft first", state: "kept" }
      : { key: "draft", label: "Draft", value: "Draft → full take", state: "changed", why: `${model.label} has no draft mode` });

  /* An identity built on the Higgsfield account travels with no Studio engine. */
  if (picks.soulId) chips.push({ key: "identity", label: "Identity", value: "Identity → none", state: "changed", why: "Made on the Higgsfield account" });
  /* Sound: what the take was made with against what Gen's length, Instrumental and voice now hold. */
  const task = model.audioTask, sound = input.sound;
  if (preset.sound?.seconds && (task === "sound" || task === "music")) {
    const want = Math.round(preset.sound.seconds * 10) / 10, now = sound?.seconds ?? want;
    const { min, max } = AUDIO_SECONDS[task];
    chips.push(want === now ? { key: "length", label: "Length", value: `${want} s`, state: "kept" }
      : { key: "length", label: "Length", value: `${want} s → ${now} s`, state: "changed",
          why: want < min || want > max ? `${model.label} runs ${min}–${max} s` : Number.isInteger(want) ? "Changed here" : "Whole seconds here" });
  }
  if (preset.sound?.instrumental !== undefined && task === "music") {
    const word = (on: boolean) => (on ? "Instrumental" : "With vocals");
    const now = sound?.instrumental ?? preset.sound.instrumental;
    chips.push(now === preset.sound.instrumental ? { key: "instrumental", label: "Vocals", value: word(now), state: "kept" }
      : { key: "instrumental", label: "Vocals", value: `${word(preset.sound.instrumental)} → ${word(now)}`, state: "changed", why: "Changed here" });
  }
  if (preset.sound?.voiceId && task === "speech") {
    const was = sound?.voices.find((v) => v.id === preset.sound!.voiceId), now = sound?.voice ?? null;
    chips.push(now?.id === preset.sound.voiceId ? { key: "voice", label: "Voice", value: now.name, state: "kept" }
      : { key: "voice", label: "Voice", value: `${was?.name ?? "Voice"} → ${now?.name ?? "none"}`, state: "changed", why: was ? "Changed here" : `Not one of ${model.label}’s voices here` });
  }
  return chips;
}
