/**
 * The new interface's still tools, as the board calls them (demo plan PR 14 + 15 and PR 18; rule 11): a character's portrait, its sheet of
 * eight angles, and a storyboard's panels. Each is a quote (nothing reserved, nothing called) and a run a person approves at the figure shown.
 * Pure: no React, no fetch (tests/unit/v12-stills.spec.ts).
 *
 * WHAT RUNS THEM. The real engines are lane B's, on approved branches that are not on release/1 yet: a portrait is `flux2_image`
 * (POST /api/bfl { tool: "image" }, #778/#785), a sheet's angles are `flux2_edit` of the portrait (or one priced recipe, v25 PR 15), a storyboard
 * panel is Recraft (#786, POST /api/recraft) or Nano Banana (#784). Until they merge the endpoint is a STAND-IN that answers under ENGINE_MOCK=1
 * alone ("no such tool" everywhere else, so it cannot bill) with the repo's sample stills. When they merge only `STILLS_ENDPOINT` and the body
 * builders change; the screens, the quote and the reply shape do not.
 */
export const STILLS_ENDPOINT = "/api/v12/stills-stand-in";

export type StillTool = "portrait" | "sheet" | "panel";
/** The real tool each stands for (rule 16: provider API keys only; these are BFL's and Recraft's own APIs). */
export const STILL_ENGINE: Record<StillTool, string> = { portrait: "flux2_image", sheet: "flux2_edit", panel: "recraft" };

/** The most stills one request makes: a sheet's eight, a storyboard of up to two dozen panels. */
export const STILL_LIMITS = { portrait: 1, sheet: 8, panel: 24 } as const;
export const PROMPT_MAX = 2000;

export type StillItem = { /** What the still is for: "portrait", an angle id, a shot id. */ key: string; prompt: string };
export type StillAsk = {
  tool: StillTool;
  /** The production the takes are filed under, once the board has one. */
  projectId: string | null;
  items: readonly StillItem[];
  /** A sheet's angles follow this take (the portrait). */
  referenceGenId?: string | null;
  /** A storyboard's drawing style. */
  style?: string | null;
};

/** Why this cannot be asked, or null. */
export function stillProblem(ask: StillAsk): string | null {
  if (!ask.items.length) return "There is nothing to make yet.";
  if (ask.items.length > STILL_LIMITS[ask.tool]) return `Up to ${STILL_LIMITS[ask.tool]} at a time.`;
  if (ask.items.some((i) => !i.prompt.trim())) return "Say what each one is.";
  return null;
}

const clean = (ask: StillAsk) => ({
  tool: ask.tool, projectId: ask.projectId ?? null,
  items: ask.items.map((i) => ({ key: i.key.slice(0, 80), prompt: i.prompt.trim().slice(0, PROMPT_MAX) })),
  ...(ask.referenceGenId ? { referenceGenId: ask.referenceGenId } : {}), ...(ask.style ? { style: ask.style.slice(0, 40) } : {}),
});

/** The body of a quote: what it would cost, nothing reserved. */
export const quoteBody = (ask: StillAsk) => ({ ...clean(ask), mode: "quote" as const });
/** The body of a run: a person's press, approving up to `approved`, the very figure the button showed, in the unit it showed. */
export const runBody = (ask: StillAsk, approved: number) => ({ ...clean(ask), mode: "run" as const, approved });

export type StillTake = { key: string; genId: string };
export type StillResult = { ok: true; takes: StillTake[]; charged: number } | { ok: false; error: string; free: true };

/** A run's reply as the screen reads it; a refusal that cost nothing says so. */
export function stillsFromResponse(ok: boolean, body: unknown): StillResult {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  if (ok && b.ok === true && Array.isArray(b.takes)) {
    const takes = (b.takes as unknown[]).flatMap((t) => {
      const r = t as Record<string, unknown> | null;
      return r && typeof r.key === "string" && typeof r.genId === "string" ? [{ key: r.key, genId: r.genId }] : [];
    });
    return { ok: true, takes, charged: typeof b.estimatedCredits === "number" ? b.estimatedCredits : 0 };
  }
  const said = typeof b.error === "string" && b.error.trim() ? b.error.trim() : "The pictures could not be made.";
  return { ok: false, error: /nothing (was )?billed/i.test(said) ? said : `${said} Nothing billed.`, free: true };
}
