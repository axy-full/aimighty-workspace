import type { Note, Scene } from "./atomikDocs";

/**
 * Merging two people's edits to one treatment (client-safe: no database).
 *
 * A save is refused when the treatment changed since it was loaded, and the
 * page then merges three copies: the one it loaded (`base`), what is on
 * screen (`mine`) and what was saved in between (`theirs`). Whatever only one
 * side changed is taken from that side; notes are merged by id, so a note
 * one person added is never dropped by the other's save. Where both changed
 * the same thing differently, the screen wins and `keptTheirs` is set, so the
 * save that follows keeps their copy as an earlier draft instead of erasing it.
 */
export type TreatmentDoc = { title: string; logline: string; setup: Record<string, string>; scenes: Scene[]; notes: Note[] };

export const EMPTY_TREATMENT: TreatmentDoc = { title: "", logline: "", setup: {}, scenes: [], notes: [] };

/** Notes by id, the newest first: the union of two lists, so neither side's notes are dropped. */
export function unionNotes(a: readonly Note[], b: readonly Note[]): Note[] {
  const byId = new Map<string, Note>();
  for (const note of [...a, ...b]) if (note && typeof note.id === "string" && !byId.has(note.id)) byId.set(note.id, note);
  return [...byId.values()].sort((x, y) => Number(y.at ?? 0) - Number(x.at ?? 0));
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export function mergeTreatment(base: TreatmentDoc, mine: TreatmentDoc, theirs: TreatmentDoc): { doc: TreatmentDoc; keptTheirs: boolean } {
  let keptTheirs = false;
  const choose = <T,>(b: T, m: T, t: T): T => {
    if (same(m, b)) return t;
    if (!same(t, b) && !same(m, t)) keptTheirs = true;
    return m;
  };

  const setup: Record<string, string> = {};
  for (const key of new Set([...Object.keys(base.setup), ...Object.keys(mine.setup), ...Object.keys(theirs.setup)])) {
    const value = choose(base.setup[key], mine.setup[key], theirs.setup[key]);
    if (value !== undefined) setup[key] = value;
  }

  /* Scenes renumber when one is removed, so they merge scene by scene only
     while both sides kept the same count; otherwise the screen's scenes stand
     and theirs are kept as a draft. */
  let scenes: Scene[];
  if (same(mine.scenes, base.scenes)) scenes = theirs.scenes;
  else if (same(theirs.scenes, base.scenes) || same(theirs.scenes, mine.scenes)) scenes = mine.scenes;
  else if (mine.scenes.length === base.scenes.length && theirs.scenes.length === base.scenes.length)
    scenes = base.scenes.map((b, i) => choose(b, mine.scenes[i], theirs.scenes[i]));
  else { scenes = mine.scenes; keptTheirs = true; }

  const loaded = new Set(base.notes.map((n) => n.id));
  const onScreen = new Set(mine.notes.map((n) => n.id));
  const added = mine.notes.filter((n) => !loaded.has(n.id));
  const removed = new Set([...loaded].filter((id) => !onScreen.has(id)));
  const notes = unionNotes(added, theirs.notes.filter((n) => !removed.has(n.id)));

  return {
    doc: { title: choose(base.title, mine.title, theirs.title), logline: choose(base.logline, mine.logline, theirs.logline), setup, scenes, notes },
    keptTheirs,
  };
}
