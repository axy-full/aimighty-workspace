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

/** What the shell hands Gen. Crew and Soul ID send words (and a model); Recreate sends a recipe (`from`). */
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
 * Why Gen cannot recreate this take, or null. Gen makes images, video and
 * sound from words and references; a take from a tool (an edit, a campaign
 * template, a motion transfer, a dub) or an engine Gen does not offer is run
 * again where it was made.
 */
export function recreateBlock(g: Pick<Generation, "kind" | "params" | "task">): string | null {
  if (!composerType(g.kind)) return "Gen makes images, video and sound, not 3D.";
  const p = g.params ?? {};
  const fromTool = (g.task && g.task !== "generate")
    || typeof p.workflow === "string"
    || p.task === "genjutsu" || p.task === "edit" || p.task === "extend"
    || p.task === "dialogue" || p.task === "voiceChange"
    || Boolean(p.marketing) || Boolean(p.soulIdentityId);
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
    from: { id: g.id, name: options.name },
    ...(options.settingsOnly ? { settingsOnly: true } : {}),
    note: `${options.settingsOnly ? "Settings" : "Recreate"} · ${options.name}`,
  };
}

/** How a reference the take cited is named in Gen's well: @Image2, @Video1. */
export const referenceTag = (reference: Pick<RecipeReference, "kind">, index: number) => `@${reference.kind === "video" ? "Video" : "Image"}${index + 1}`;

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

export function recipeChips(input: {
  preset: GenPreset;
  /** The credits Gen will charge now. */
  billing: BillingSource;
  /** The model Gen will send, and the settings it will send with it. */
  model: ComposerModel | null;
  settings: ComposerSettings;
  /** The model list is still being read. */
  reading: boolean;
  /** The account's identities, once read (null until then). */
  identities: readonly { soulId: string; name: string; status: string | null }[] | null;
}): RecipeChip[] {
  const { preset, model, settings } = input;
  if (!preset.model) return [];
  const wanted = displayModelName(preset.model);
  if (input.reading) return [{ key: "model", label: "Model", value: wanted, state: "reading" }];
  const chips: RecipeChip[] = [];
  const lostAccount = preset.billing === "connected" && input.billing !== "connected";
  const sameModel = !lostAccount && model?.id === preset.model;
  chips.push(sameModel
    ? { key: "model", label: "Model", value: model!.label, state: "kept" }
    : { key: "model", label: "Model", value: `${wanted} → ${model ? (model.label === wanted ? "Studio engine" : model.label) : "none"}`, state: "changed", why: lostAccount ? "The connected account is the owner’s" : "Not offered here now" });

  const picks = preset.picks ?? {};
  const compare = (key: "ratio" | "resolution" | "duration", label: string, want: string | number | undefined, now: string | number, offered: readonly (string | number)[] | undefined, show: (v: string | number) => string) => {
    if (want === undefined) return;
    if (!offered?.length) {
      if (!sameModel) chips.push({ key, label, value: `${show(want)} → default`, state: "changed", why: `${model?.label ?? "This model"} has no ${label.toLowerCase()} choice` });
      return;
    }
    if (want === now) chips.push({ key, label, value: show(want), state: "kept" });
    else chips.push({ key, label, value: `${show(want)} → ${show(now)}`, state: "changed", why: offered.includes(want) ? "Changed here" : `${model?.label ?? "This model"} has no ${show(want)}` });
  };
  compare("ratio", "Aspect", picks.ratio, settings.ratio, model?.ratios, String);
  compare("resolution", "Resolution", picks.resolution, settings.resolution, model?.resolutions, String);
  compare("duration", "Length", picks.duration, settings.duration, model?.durations, (v) => `${v} s`);

  if (picks.soulId) {
    const found = input.identities?.find((c) => c.soulId === picks.soulId && c.status !== "training" && c.status !== "failed");
    if (!model?.soulId) chips.push({ key: "identity", label: "Identity", value: "Identity → none", state: "changed", why: `${model?.label ?? "This model"} takes no identity` });
    else if (!input.identities) chips.push({ key: "identity", label: "Identity", value: "Identity", state: "reading" });
    else if (!found) chips.push({ key: "identity", label: "Identity", value: "Identity → none", state: "changed", why: "No longer on the account" });
    else if (settings.soulId === picks.soulId) chips.push({ key: "identity", label: "Identity", value: found.name, state: "kept" });
    else chips.push({ key: "identity", label: "Identity", value: `${found.name} → none`, state: "changed", why: "Changed here" });
  }
  if (preset.sound?.seconds && model?.audioTask && model.audioTask !== "speech")
    chips.push({ key: "length", label: "Length", value: `${Math.round(preset.sound.seconds * 10) / 10} s`, state: "kept" });
  return chips;
}
