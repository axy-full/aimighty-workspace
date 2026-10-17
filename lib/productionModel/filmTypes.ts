import { z } from "zod";

/**
 * Film types and the steps each one starts with (v30 data model, docs/plans/v30-data-model.md § 2.1–2.2, PR A1).
 *
 * Server config, read by name and nowhere else: the steps a new v30 production is made with come from here, so no other
 * file names a film type or lists a step. The list is the platform's default, the same for every workspace, and names no
 * workspace, client or person (ground rule 3).
 *
 * The owner has not yet given the film types or their step lists (plan question Q1). Until he does:
 *   - the deployment's `V30_FILM_TYPES` setting (JSON, the shape of `filmTypeConfigSchema`) is the list when it is set;
 *   - otherwise the list is `FILM_TYPES_PLACEHOLDER`, ONE sample type, flagged `placeholder: true`, so nothing can read
 *     it as the owner's.
 * A setting that is set but does not read is refused, never silently swapped for the placeholder.
 *
 * Only flag-on code (lib/productionModel/flag.ts, `V30_PRODUCTION_MODEL`) reads this. Server only: nothing here is for a
 * client bundle.
 */

/** The name of the deployment setting that holds the list. Read by name; the value is never logged. */
export const FILM_TYPES_SETTING = "V30_FILM_TYPES";

/** A step's kind and a film type's id: the same grammar, so a kind is safe as the start of a page id. */
export const STEP_KIND = /^[a-z][a-z0-9_]{0,31}$/;

const stepSchema = z.object({
  kind: z.string().regex(STEP_KIND),
  label: z.string().trim().min(1).max(60),
  /** A document step (Brief, Script) is read and edited in the document reader and has no frame; a canvas step is one frame. */
  surface: z.enum(["document", "canvas"]),
});

const filmTypeSchema = z.object({
  id: z.string().regex(STEP_KIND),
  label: z.string().trim().min(1).max(60),
  steps: z.array(stepSchema).min(1).max(24),
});

export const filmTypeConfigSchema = z
  .object({
    /** True only for the stand-in list below. The owner's list sets it false (or leaves it out). */
    placeholder: z.boolean().default(false),
    filmTypes: z.array(filmTypeSchema).min(1).max(24),
  })
  .superRefine((config, ctx) => {
    const ids = new Set<string>();
    for (const type of config.filmTypes) {
      if (ids.has(type.id)) ctx.addIssue({ code: "custom", message: `Film type ${type.id} is listed twice.` });
      ids.add(type.id);
    }
  });

export type FilmTypeStep = z.infer<typeof stepSchema>;
export type FilmType = z.infer<typeof filmTypeSchema>;
export type FilmTypeConfig = z.infer<typeof filmTypeConfigSchema> & { source: "setting" | "placeholder" };

/**
 * PLACEHOLDER, not the owner's list (plan Q1). One sample film type whose steps are the ones the 17 Oct brief names
 * (Brief and Script as documents; the rest as canvas frames). Replace it by setting `V30_FILM_TYPES`, or by editing this
 * one constant once the owner answers Q1.
 */
export const FILM_TYPES_PLACEHOLDER = {
  placeholder: true,
  filmTypes: [
    {
      id: "placeholder_film",
      label: "Film (placeholder)",
      steps: [
        { kind: "brief", label: "Brief", surface: "document" },
        { kind: "script", label: "Script", surface: "document" },
        { kind: "look", label: "Look", surface: "canvas" },
        { kind: "cast", label: "Cast", surface: "canvas" },
        { kind: "storyboard", label: "Storyboard", surface: "canvas" },
        { kind: "shots", label: "Shots", surface: "canvas" },
        { kind: "deliver", label: "Deliver", surface: "canvas" },
      ],
    },
  ],
} as const satisfies z.input<typeof filmTypeConfigSchema>;

export class FilmTypeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FilmTypeConfigError";
  }
}

/** The film types in force: the deployment's setting when it is set, else the flagged placeholder. */
export function filmTypeConfig(env: Record<string, string | undefined> = process.env): FilmTypeConfig {
  const raw = env[FILM_TYPES_SETTING];
  if (raw === undefined || raw.trim() === "") {
    return { ...filmTypeConfigSchema.parse(FILM_TYPES_PLACEHOLDER), source: "placeholder" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new FilmTypeConfigError(`${FILM_TYPES_SETTING} is set but is not JSON.`);
  }
  const result = filmTypeConfigSchema.safeParse(parsed);
  if (!result.success) throw new FilmTypeConfigError(`${FILM_TYPES_SETTING} is set but does not read as a list of film types.`);
  return { ...result.data, source: "setting" };
}

/** One film type's steps, in order, or null for a type the config does not list. */
export function filmTypeSteps(filmType: string, env: Record<string, string | undefined> = process.env): FilmTypeStep[] | null {
  const type = filmTypeConfig(env).filmTypes.find((t) => t.id === filmType);
  return type ? type.steps.map((s) => ({ ...s })) : null;
}
