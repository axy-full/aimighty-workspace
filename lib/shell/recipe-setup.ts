import { CATEGORIES, composePrompt, craftModules, sceneLine, type ShotSpec } from "../studio";

/**
 * A recreated take's shot setup (params.shotSpec) in Gen. Gen has no shot
 * controls: the setup travels the way the shot composer always sent it, as
 * the words it composes into (lib/studio.ts › composePrompt). Loaded only
 * when a recipe carries a setup, so the camera bank stays out of Gen's bundle.
 */

/** Each chosen control by its bank label, in the bank's order; an unknown value reads as itself. */
export function setupLabels(spec: Record<string, string>): string[] {
  const known = CATEGORIES.flatMap((category) => {
    const value = spec[category.key];
    if (!value) return [];
    return [category.options.find((o) => o.value === value)?.label ?? value];
  });
  const other = Object.entries(spec).filter(([key, value]) => value && !CATEGORIES.some((c) => c.key === key)).map(([, value]) => value);
  return [...known, ...other];
}

/** The setup's words, when the bank has any for it. */
function setupWords(spec: ShotSpec): string[] {
  return [sceneLine(spec), craftModules(spec)].filter(Boolean);
}

/** True when the words already carry the setup (a take from the shot composer sent it composed). */
export function setupInWords(prompt: string, spec: Record<string, string>): boolean {
  const words = setupWords(spec);
  return words.length > 0 && words.every((w) => prompt.includes(w));
}

/** True when the bank can write this setup as words at all. */
export function setupWritable(spec: Record<string, string>): boolean {
  return setupWords(spec).length > 0;
}

/** The words with the setup composed in, as the shot composer sends them. */
export function withSetup(prompt: string, spec: Record<string, string>): string {
  return composePrompt(prompt, spec);
}
