import { z } from "zod";

/**
 * Film types and the steps each one starts with (v30 data model, docs/plans/v30-data-model.md § 2.1–2.2 and 2.10; PRs A1
 * and A1b).
 *
 * Server config, read by name and nowhere else: the steps a new v30 production is made with come from here, so no other
 * file names a film type or lists a step. The list is the platform's default, the same for every workspace, and names no
 * workspace, client or person (ground rule 3).
 *
 * Each film type lists its steps once, in rail order, each with `opened`:
 *   - opened (the default): a new production shows it, so `ensureSteps` makes its row;
 *   - not opened: it is listed, in its place, but behind the + tile (Sound · Edit · Deliver where the owner put them
 *     behind +, and Treatment where it is optional). A person opens it from the + tile; `add` then puts it at its place.
 * `add` takes a kind the type lists and nothing else (plan § 2.10).
 *
 *   - `FILM_TYPES_DEFAULT` below is the owner's final list for A1b (docs/redesign-plan.md, "Owner, 19 Oct 2026, ~00:20
 *     IST": Q16–Q20 and "The ten lists, final for A1b"). It replaces his 17 Oct list (plan Q1).
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
 * (Deliver) is a table; a `deck` step (Treatment) is a deck of pages, its content kept in `treatments` and
 * `treatment_versions`, never as cards on the canvas (owner, 19 Oct 2026, Q19). None of those three has a frame. A
 * `canvas` step is one frame on the production's canvas.
 */
export const STEP_SURFACES = ["document", "canvas", "table", "deck"] as const;
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
  /** Shown in a new production (true), or behind the + tile until a person opens it (false). A setting written before
   *  A1b has no `opened`: every step it lists is opened, as it was. */
  opened: z.boolean().default(true),
});

const filmTypeSchema = z
  .strictObject({
    id: z.string().regex(STEP_KIND),
    label: labelSchema,
    /** Every step the type has, opened or behind the + tile, in rail order. */
    steps: z.array(stepSchema).min(1).max(24),
  })
  .superRefine((type, ctx) => {
    const kinds = new Set<string>();
    type.steps.forEach((step, index) => {
      if (kinds.has(step.kind)) ctx.addIssue({ code: "custom", path: ["steps", index, "kind"], message: "A step kind is listed twice in one film type." });
      kinds.add(step.kind);
    });
    /* One deck per production (owner, 19 Oct 2026, Q18): a film type lists at most one deck step. */
    const decks = type.steps.flatMap((step, index) => (step.surface === "deck" ? [index] : []));
    if (decks.length > 1) ctx.addIssue({ code: "custom", path: ["steps", decks[1], "surface"], message: "A film type has at most one deck step." });
    /* A new production shows at least one step. */
    if (!type.steps.some((step) => step.opened)) ctx.addIssue({ code: "custom", path: ["steps"], message: "A film type opens at least one step." });
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

/* A step's kind is its label in lower-case snake_case ("Beat map" → beat_map, "Swap-ins" → swap_ins). Brief and Script
   are documents and Deliver is a table (owner, 17 Oct 2026); Treatment is a deck (19 Oct, Q19); every other step is a
   canvas step. */
const kindOf = (label: string) => label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
const NOT_CANVAS: Record<string, StepSurface> = { brief: "document", script: "document", deliver: "table", treatment: "deck" };
/* A step written "+Name" is listed but behind the + tile (not opened); every other step is opened. */
const filmType = (id: string, label: string, steps: string[]) => ({
  id,
  label,
  steps: steps.map((entry) => {
    const step = entry.replace(/^\+/, "");
    return { kind: kindOf(step), label: step, surface: NOT_CANVAS[kindOf(step)] ?? "canvas", opened: !entry.startsWith("+") };
  }),
});

/* "+ Sound · Edit · Deliver" (Q16): all three behind the + tile, after Shots. Owner, 19 Oct 2026 (~19:00 IST, R1): yes
   for Ad film, Feature, Short film, Music video, Product video and Microdrama; UGC, Trend clip, Social and Pre-vis have
   no + steps but Treatment, their last steps opened on the rail as in his lists. */
const PLUS = ["+Sound", "+Edit", "+Deliver"];

/**
 * The owner's ten film types, final for A1b (19 Oct 2026, ~00:20 IST), in his order. Labels exactly as he wrote them;
 * "+" marks a step behind the + tile. From his answers (docs/plans/v30-data-model.md § 2.10), with the plan's reading
 * R1 confirmed by him on 19 Oct 2026, ~19:00 IST ("R1 yes for Ad film, Feature, Short film, Music video, Product video
 * and Microdrama; no for UGC, Trend clip, Social and Pre-vis, whose last steps are on the rail as in the 19 Oct lists"):
 *   - Q16: Sound after Shots in every type with Shots and Edit, reached from the + tile (Sound · Edit · Deliver); all
 *     three are behind the + tile where he wrote "+ Sound · Edit · Deliver" (those six types). In UGC, Trend clip,
 *     Social and Pre-vis the last steps (Captions · Deliver, or Handoff) are opened on the rail;
 *   - Q17: Treatment on by default in Ad film, Feature, Short film and Music video; in the other six, "(Treatment
 *     optional)", it is behind the + tile, right after Script where the type has one, else right after the first step;
 *   - Q18: Pitch deck is gone from Ad film; its deck is the Treatment step. One deck per production;
 *   - Q19: Treatment's surface is `deck`;
 *   - Q20 and 18 Oct (d): Breakdown is no longer a step anywhere. Its beats are the Beats view inside Script, and Pre-vis
 *     gets a Script step (opened on that view) where it had Breakdown. Music video's Beat map and Trend clip's Format
 *     breakdown are other things and stay (Q22); Microdrama waits for Q21.
 *   - D3, 21 Oct 2026: Elements before Look. "The step order is Brief · Script · Treatment · Elements · Look · Storyboard ·
 *     Shots · Sound · Edit · Deliver (Elements before Look)." Every type that lists both has Elements first
 *     (tests/unit/productionSteps.spec.ts holds every type to that order). A production made before keeps its stored order:
 *     a step row is known by its id and page id, and its `position` is the person's own rail order.
 * Not here, by design: which steps commit by Kept and which by Sent (plan § 2.8; R3, confirmed 19 Oct: only Look and
 * Elements by Kept, every other step by Sent) is a later A1 follow-up, and nothing reads it yet. Where a Storyboard
 * panel lands (R2, answered 19 Oct: a frame of the shot's Storyboard card, entering a Shots node as its Start frame) is
 * a later PR's, not a step list's.
 * Feature, for later (nothing is built for it yet): its board is grouped by scene, and a representative scene is made
 * before the rest are scaled from it.
 */
export const FILM_TYPES_DEFAULT = {
  filmTypes: [
    filmType("ad_film", "Ad film", ["Brief", "Script", "Treatment", "Elements", "Look", "Storyboard", "Shots", ...PLUS]),
    filmType("feature", "Feature", ["Brief", "Script", "Treatment", "Elements", "Look", "Storyboard", "Shots", ...PLUS]),
    filmType("short_film", "Short film", ["Brief", "Script", "Treatment", "Elements", "Look", "Storyboard", "Shots", ...PLUS]),
    filmType("music_video", "Music video", ["Track", "Beat map", "Treatment", "Elements", "Look", "Storyboard", "Animatic", "Shots", ...PLUS]),
    filmType("product_video", "Product video", ["Brief", "+Treatment", "Product", "Look", "Storyboard", "Shots", ...PLUS]),
    filmType("ugc", "UGC", ["Brief", "Creator", "Hook", "Script", "+Treatment", "Shots", "Captions", "Deliver"]),
    filmType("microdrama", "Microdrama", ["Series bible", "+Treatment", "Episodes", "Elements", "Storyboard", "Shots", ...PLUS]),
    filmType("pre_vis", "Pre-vis", ["Brief", "Script", "+Treatment", "Set map", "Elements", "Storyboard", "Animatic", "Shots", "Handoff"]),
    filmType("trend_clip", "Trend clip", ["Source", "+Treatment", "Format breakdown", "Swap-ins", "Copy", "Shots", "Captions", "Deliver"]),
    filmType("social", "Social", ["Deliverables", "+Treatment", "Hook", "Copy", "Design", "Visuals", "Captions", "Deliver"]),
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

/**
 * Every step a film type lists, opened or behind the + tile, in rail order (each with `opened`), or null for a type the
 * config does not list. A new production gets the opened ones only.
 */
export function filmTypeSteps(filmType: string, env: Record<string, string | undefined> = process.env): FilmTypeStep[] | null {
  const type = filmTypeConfig(env).filmTypes.find((t) => t.id === filmType);
  return type ? type.steps.map((s) => ({ ...s })) : null;
}
