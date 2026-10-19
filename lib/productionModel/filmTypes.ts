import { z } from "zod";

/**
 * Film types and the steps each one starts with (v30 data model, docs/plans/v30-data-model.md § 2.1–2.2, PR A1).
 *
 * Server config, read by name and nowhere else: the steps a new v30 production is made with come from here, so no other
 * file names a film type or lists a step. The list is the platform's default, the same for every workspace, and names no
 * workspace, client or person (ground rule 3).
 *
 *   - `FILM_TYPES_DEFAULT` below is the owner's list (given 17 Oct 2026, plan Q1): ten film types and their steps.
 *   - The deployment's `V30_FILM_TYPES` setting (JSON, the shape of `filmTypeConfigSchema`) replaces it when it is set.
 *     A setting that is set but does not read is refused, never silently swapped for the default.
 *
 * A later PR moves the default to the platform layer (lib/platformLayer.ts) with a per-workspace override (rule 3); that is
 * not done here because adding a layer key changes the admin platform-layer response, which no Phase A PR may change.
 *
 * Only flag-on code (lib/productionModel/flag.ts, `V30_PRODUCTION_MODEL`) reads this. Server only: nothing here is for a
 * client bundle.
 */

/** The name of the deployment setting that holds the list. Read by name; the value is never logged. */
export const FILM_TYPES_SETTING = "V30_FILM_TYPES";

/** A step's kind and a film type's id: the same grammar, so a kind is safe as the start of a page id. */
export const STEP_KIND = /^[a-z][a-z0-9_]{0,31}$/;

/**
 * Where a step is worked on. A `document` step (Brief, Script) is read and edited in the document reader; a `table` step
 * (Deliver) is a table. Neither has a frame. A `canvas` step is one frame on the production's canvas.
 */
export const STEP_SURFACES = ["document", "canvas", "table"] as const;
export type StepSurface = (typeof STEP_SURFACES)[number];

/** A name as a person reads it: trimmed, inner runs of space collapsed (as the store's own rename does), 1 to 60 characters. */
const labelSchema = z
  .string()
  .transform((s) => s.trim().replace(/\s+/g, " "))
  .pipe(z.string().min(1).max(60));

const stepSchema = z.strictObject({
  kind: z.string().regex(STEP_KIND),
  label: labelSchema,
  surface: z.enum(STEP_SURFACES),
});

const filmTypeSchema = z
  .strictObject({
    id: z.string().regex(STEP_KIND),
    label: labelSchema,
    steps: z.array(stepSchema).min(1).max(24),
  })
  .superRefine((type, ctx) => {
    const kinds = new Set<string>();
    type.steps.forEach((step, index) => {
      if (kinds.has(step.kind)) ctx.addIssue({ code: "custom", path: ["steps", index, "kind"], message: "A step kind is listed twice in one film type." });
      kinds.add(step.kind);
    });
  });

export const filmTypeConfigSchema = z
  .strictObject({
    filmTypes: z.array(filmTypeSchema).min(1).max(24),
  })
  .superRefine((config, ctx) => {
    const ids = new Set<string>();
    config.filmTypes.forEach((type, index) => {
      if (ids.has(type.id)) ctx.addIssue({ code: "custom", path: ["filmTypes", index], message: "A film type is listed twice." });
      ids.add(type.id);
    });
  });

export type FilmTypeStep = z.output<typeof stepSchema>;
export type FilmType = z.output<typeof filmTypeSchema>;
export type FilmTypeConfig = z.output<typeof filmTypeConfigSchema> & { source: "setting" | "default" };

/* A step's kind is its label in lower-case snake_case ("Pitch deck" → pitch_deck, "Swap-ins" → swap_ins). Brief and
   Script are documents, Deliver is a table, and every other step is a canvas step (owner, 17 Oct 2026). */
const kindOf = (label: string) => label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
const NOT_CANVAS: Record<string, StepSurface> = { brief: "document", script: "document", deliver: "table" };
const filmType = (id: string, label: string, steps: string[]) => ({
  id,
  label,
  steps: steps.map((step) => ({ kind: kindOf(step), label: step, surface: NOT_CANVAS[kindOf(step)] ?? "canvas" })),
});

/**
 * The owner's film types and their steps, in order (17 Oct 2026). Labels exactly as he wrote them.
 * Feature, for later (nothing is built for it yet): its board is grouped by scene, and a representative scene is made
 * before the rest are scaled from it.
 */
export const FILM_TYPES_DEFAULT = {
  filmTypes: [
    filmType("ad_film", "Ad film", ["Pitch deck", "Brief", "Script", "Breakdown", "Look", "Elements", "Storyboard", "Shots", "Edit", "Deliver"]),
    filmType("feature", "Feature", ["Brief", "Script", "Breakdown", "Look", "Elements", "Storyboard", "Shots", "Edit", "Deliver"]),
    filmType("short_film", "Short film", ["Brief", "Script", "Breakdown", "Look", "Elements", "Storyboard", "Sound", "Shots", "Edit", "Deliver"]),
    filmType("ugc", "UGC", ["Brief", "Creator", "Hook", "Script", "Shots", "Captions", "Deliver"]),
    filmType("product_video", "Product video", ["Brief", "Product", "Look", "Storyboard", "Shots", "Edit", "Deliver"]),
    filmType("music_video", "Music video", ["Track", "Beat map", "Look", "Elements", "Storyboard", "Animatic", "Shots", "Edit", "Deliver"]),
    filmType("microdrama", "Microdrama", ["Series bible", "Episodes", "Elements", "Storyboard", "Shots", "Edit", "Deliver"]),
    filmType("pre_vis", "Pre-vis", ["Brief", "Breakdown", "Set map", "Elements", "Storyboard", "Animatic", "Shots", "Handoff"]),
    filmType("trend_clip", "Trend clip", ["Source", "Format breakdown", "Swap-ins", "Copy", "Shots", "Captions", "Deliver"]),
    filmType("social", "Social", ["Deliverables", "Hook", "Copy", "Design", "Visuals", "Captions", "Deliver"]),
  ],
} satisfies z.input<typeof filmTypeConfigSchema>;

/** What is wrong with the setting: where (`path`, e.g. `filmTypes.0.steps.2.surface`), never the value it holds. */
export class FilmTypeConfigError extends Error {
  constructor(message: string, readonly path: string | null = null) {
    super(path ? `${message} (at ${path})` : message);
    this.name = "FilmTypeConfigError";
  }
}

/** The film types in force: the deployment's setting when it is set, else the owner's default. */
export function filmTypeConfig(env: Record<string, string | undefined> = process.env): FilmTypeConfig {
  const raw = env[FILM_TYPES_SETTING];
  if (raw === undefined || raw.trim() === "") {
    return { ...filmTypeConfigSchema.parse(FILM_TYPES_DEFAULT), source: "default" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new FilmTypeConfigError(`${FILM_TYPES_SETTING} is set but is not JSON.`);
  }
  const result = filmTypeConfigSchema.safeParse(parsed);
  if (!result.success) {
    /* Only the issue's path: schema keys and list indexes. Never a value, nor an unknown key's own text. */
    const issue = result.error.issues[0];
    const where = issue ? issue.path.map(String) : [];
    throw new FilmTypeConfigError(`${FILM_TYPES_SETTING} is set but does not read as a list of film types.`, where.length ? where.join(".") : "(root)");
  }
  return { ...result.data, source: "setting" };
}

/** One film type's steps, in order, or null for a type the config does not list. */
export function filmTypeSteps(filmType: string, env: Record<string, string | undefined> = process.env): FilmTypeStep[] | null {
  const type = filmTypeConfig(env).filmTypes.find((t) => t.id === filmType);
  return type ? type.steps.map((s) => ({ ...s })) : null;
}
