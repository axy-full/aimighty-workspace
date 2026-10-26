import { z } from "zod";
import { ELEMENT_KINDS } from "./copy";

/**
 * The Director's engine list per element kind (owner, 25 Oct 2026; SOW v2 §9 Elements, Part II.4, cited only): the inspector's
 * engine picker on an element shows only the engines the private policy routes for that kind, never the whole catalogue and never
 * a generic option list. Which engines those are is the policy's, not the repo's: the mapping lives in Coolify as
 * `ENGINES_BY_KIND`, a JSON object from kind to engine ids, and the code holds only the eight kinds. A kind the variable leaves
 * out, or lists empty, shows nothing; a variable that is missing or not the shape below shows nothing for every kind. Never a
 * default.
 *
 * Read when asked, never at start, so a change in Coolify applies on the next request. Director mode only: Agent mode never
 * names an engine (§5), and nothing here is shown to a person; the picker labels each id through the engine registry. No screen
 * reads it yet (the Elements inspector waits for v31.17).
 */

/** The eight kinds, as the copy table names them ("What is it?"). */
export const ELEMENT_KIND_IDS = ["cast", "prop", "environment", "vehicle", "wardrobe", "product", "words", "world"] as const satisfies readonly Exclude<keyof typeof ELEMENT_KINDS, "question">[];
export type ElementKindId = (typeof ELEMENT_KIND_IDS)[number];
export const isElementKind = (value: unknown): value is ElementKindId => typeof value === "string" && (ELEMENT_KIND_IDS as readonly string[]).includes(value);

/** The most engines one kind lists. */
const MAX_PER_KIND = 12;
const engineId = z.string().regex(/^[a-z0-9][a-z0-9._:/-]{0,119}$/);

/** The variable's shape: known kinds only, each an ordered list of engine ids. */
const byKind = z.object(Object.fromEntries(ELEMENT_KIND_IDS.map((kind) => [kind, z.array(engineId).max(MAX_PER_KIND).optional()]))).strict();

/** The policy's lists, by kind, or null when the variable is missing or not that shape (every kind then shows nothing). */
export function enginesByKind(env: Readonly<Record<string, string | undefined>> = process.env): Readonly<Record<ElementKindId, readonly string[]>> | null {
  const raw = env.ENGINES_BY_KIND?.trim();
  if (!raw) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  const checked = byKind.safeParse(parsed);
  if (!checked.success) return null;
  const lists = checked.data as Partial<Record<ElementKindId, string[]>>;
  return Object.freeze(Object.fromEntries(ELEMENT_KIND_IDS.map((kind) => [kind, Object.freeze([...new Set(lists[kind] ?? [])])]))) as Record<ElementKindId, readonly string[]>;
}

/**
 * The engines the picker offers for one kind: the policy's list for it, in the policy's order, less any id this deployment does
 * not offer (`offered`, the engine registry's ids). Empty when the kind is unknown, unlisted or empty, or the variable is unset.
 */
export function enginesForKind(kind: unknown, offered: ReadonlySet<string>, env: Readonly<Record<string, string | undefined>> = process.env): readonly string[] {
  if (!isElementKind(kind)) return [];
  const lists = enginesByKind(env);
  if (!lists) return [];
  return lists[kind].filter((id) => offered.has(id));
}
