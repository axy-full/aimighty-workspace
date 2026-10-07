import { getModel } from "@/lib/models";
import { DEFAULT_BOARDS, type Boards } from "@/lib/production/boards";
import { LOOK_LIMITS, LOOK_MODEL, LOOK_PRESETS, lookPrompt, type Look, type LookPending, type LookPreset } from "@/lib/production/looks";
import { PROJECT_LIMITS } from "@/lib/workbench/project-limits";
import type { Asset, Project } from "@/lib/workbench/studio";
import type { RegionState } from "../storyboard/model";

/*
 * The Looks group (design/particl-graphite/README.md § 3.1 c): four looks of the film, ticked to pick one.
 * Read from the draft (`production.boards.looks`, `production.boards.look`). Pure: what to draw, which looks are
 * still to make, and the draft once one is sent, lands or is picked.
 */

export type LookTile = { id: string; name: string; meta: string; genId: string | null; rendering: boolean; picked: boolean };

export type Looks = {
  title: string;
  /** "pick one, or tell Atomik what to change", or "<name> picked". */
  meta: string;
  tiles: LookTile[];
  /** The looks still to make: none made yet, or one that did not render. */
  toMake: LookPreset[];
  /** The picked look's name, for the storyboard's title. */
  picked: string | null;
  state: RegionState;
  summary: string;
};

/** "Nano Banana Pro · 1K": the engine and size the looks are made at. */
export function lookMeta(): string {
  return `${getModel(LOOK_MODEL).label} · 1K`;
}

/** A look's picture: its pick when it still has it, else its newest take. */
function picture(look: Look): string | null {
  if (!look.takes.length) return null;
  return look.selected && look.takes.some((t) => t.genId === look.selected) ? look.selected : look.takes[0].genId;
}

const plural = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;

export function looks(project: Project): Looks {
  const boards = project.production?.boards ?? DEFAULT_BOARDS;
  const kept = boards.looks ?? {};
  const meta = lookMeta();
  const tiles: LookTile[] = LOOK_PRESETS.filter((p) => kept[p.id]).map((p) => {
    const look = kept[p.id];
    return { id: p.id, name: look.name, meta, genId: picture(look), rendering: Boolean(look.pending?.length), picked: boards.look === p.id };
  });
  const toMake = LOOK_PRESETS.filter((p) => !kept[p.id] || (!kept[p.id].takes.length && !kept[p.id].pending?.length));
  const picked = tiles.find((t) => t.picked && t.genId)?.name ?? null;
  const rendering = tiles.filter((t) => t.rendering).length;
  const drawn = tiles.filter((t) => t.genId).length;
  const state: RegionState = !tiles.length ? "empty" : picked ? "done" : rendering ? "working" : drawn ? "needs" : "empty";
  const summary = picked ? `${picked} picked` : rendering ? `Drawing ${plural(rendering, "look")}` : drawn ? `${plural(drawn, "look")} · pick one` : "Nothing yet";
  return { title: "Looks", meta: picked ? `${picked} picked` : "pick one, or tell Atomik what to change", tiles, toMake, picked, state, summary };
}

function withLooks(project: Project, change: (boards: Boards) => Boards): Project {
  const boards = project.production?.boards ?? DEFAULT_BOARDS;
  const next = change(boards);
  return next === boards ? project : { ...project, production: { ...project.production, boards: next } };
}

/** The draft once a look was sent: its name and prompt, and the job on its way. Unchanged when that job is there already. */
export function withPendingLook(project: Project, preset: LookPreset, prompt: string, pending: LookPending): Project {
  return withLooks(project, (boards) => {
    const was = boards.looks?.[preset.id];
    if (was?.pending?.some((p) => p.jobId === pending.jobId)) return boards;
    const look: Look = { name: preset.name.slice(0, LOOK_LIMITS.name), prompt: prompt.slice(0, LOOK_LIMITS.prompt), takes: was?.takes ?? [], ...(was?.selected ? { selected: was.selected } : {}),
      pending: [...(was?.pending ?? []), pending].slice(-LOOK_LIMITS.pending) };
    return { ...boards, looks: { ...boards.looks, [preset.id]: look } };
  });
}

/** The draft once a look's job ended: off the pending list, and when it rendered, its picture, filed as a Look asset once. */
export function withLandedLook(project: Project, id: string, jobId: string, genId: string | null, at: string): Project {
  const look = project.production?.boards?.looks?.[id];
  if (!look?.pending?.some((p) => p.jobId === jobId)) return project;
  const next = withLooks(project, (boards) => ({
    ...boards,
    looks: { ...boards.looks, [id]: { ...look, pending: look.pending!.filter((p) => p.jobId !== jobId), ...(genId ? { takes: [{ genId, at }, ...look.takes].slice(0, LOOK_LIMITS.takes), selected: genId } : {}) } },
  }));
  if (!genId || next.assets.some((a) => a.id === genId) || next.assets.length >= PROJECT_LIMITS.assets) return next;
  const asset: Asset = { id: genId, generationId: genId, kind: "image", category: "Look", name: `Look · ${look.name}`, url: `/api/media/${genId}`, description: "", prompt: look.prompt, status: "Draft", locked: false, version: look.takes.length + 1, refs: [] };
  return { ...next, assets: [...next.assets, asset] };
}

/** The draft with one look picked (picking it again leaves it picked: the storyboard needs one). Free. */
export function withPickedLook(project: Project, id: string): Project {
  if (!project.production?.boards?.looks?.[id]) return project;
  return withLooks(project, (boards) => (boards.look === id ? boards : { ...boards, look: id }));
}

/** Every look job on its way. */
export function pendingLooks(project: Project): { id: string; jobId: string }[] {
  return Object.entries(project.production?.boards?.looks ?? {}).flatMap(([id, look]) => (look.pending ?? []).map((p) => ({ id, jobId: p.jobId })));
}

/** The picked look's still and words, for the storyboard's frames to follow; null when none is picked or drawn. */
export function pickedLook(project: Project): { name: string; asset: Asset | null; words: string } | null {
  const boards = project.production?.boards;
  const id = boards?.look;
  const look = id ? boards?.looks?.[id] : undefined;
  const preset = LOOK_PRESETS.find((p) => p.id === id);
  if (!look || !preset) return null;
  const genId = picture(look);
  const asset = genId ? project.assets.find((a) => a.id === genId) ?? null : null;
  return { name: look.name, asset, words: preset.words };
}

export { lookPrompt };
