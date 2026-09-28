import { groupSiblings } from "../variations";
import { entryFace, entryKind, type LibraryEntry } from "./library";
import { DESK_FILTERS, inDeskFilter, type DeskFilter } from "./takes";
import { SHOT_NODE_TYPES, type Project } from "../workbench/studio";

/**
 * Studio › Takes as a review desk: every take of the project once, filtered
 * by its review status (the chips' own fields, lib/workspace/takes.ts), by
 * kind and by a search, grouped by the shot it is filed on and, inside a
 * shot, by the batch it was rendered in. Pure: the page renders these rows.
 */

/** The kind chips. A take is filed by what it is, whether or not it rendered (Library › Assets reads it the same way). */
export type DeskKind = "video" | "image" | "audio" | "upload";
export const DESK_KINDS: readonly { id: DeskKind; label: string }[] = [
  { id: "video", label: "Video" },
  { id: "image", label: "Images" },
  { id: "audio", label: "Audio" },
  { id: "upload", label: "Uploads" },
];

export function inDeskKind(entry: Pick<LibraryEntry, "take" | "asset">, kind: DeskKind | null): boolean {
  if (!kind) return true;
  return kind === "upload" ? entry.take.kind === "UPLOAD" : entryKind(entry) === kind;
}

/** A search finds a take by its name, its prompt, its shot or who made it. */
export function inDeskSearch(entry: Pick<LibraryEntry, "take" | "asset">, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const g = entry.asset.origin === "generation" ? entry.asset.value : null;
  return [entry.take.name, g?.prompt, g?.shotCode, g?.shotTitle, g?.authorName].some((s) => typeof s === "string" && s.toLowerCase().includes(q));
}

export type DeskQuery = { filter: DeskFilter; kind: DeskKind | null; query: string };

export function inDesk(entry: LibraryEntry, q: DeskQuery): boolean {
  return inDeskFilter(entry.take, q.filter) && inDeskKind(entry, q.kind) && inDeskSearch(entry, q.query);
}

/** How many loaded takes each status chip would show, under the kind and search already chosen. */
export function deskCounts(entries: readonly LibraryEntry[], kind: DeskKind | null, query: string): Record<DeskFilter, number> {
  const out = Object.fromEntries(DESK_FILTERS.map((f) => [f.id, 0])) as Record<DeskFilter, number>;
  for (const entry of entries) {
    if (!inDeskKind(entry, kind) || !inDeskSearch(entry, query)) continue;
    for (const f of DESK_FILTERS) if (inDeskFilter(entry.take, f.id)) out[f.id]++;
  }
  return out;
}

/** A chip's count: "4", "4+" while older pages are not loaded yet (they may hold more), nothing for a zero that may not be one. */
export function countLabel(n: number, more: boolean): string {
  return more ? (n ? `${n.toLocaleString("en-US")}+` : "") : n.toLocaleString("en-US");
}

/**
 * The shots of a project in the Rig's order (its draft order), with the
 * name the Rig shows: shot id → [position, name]. A take filed on a shot
 * the Rig no longer maps goes after them, by its shot code.
 */
export function rigShotOrder(project: Pick<Project, "nodes" | "shotMappings"> | null): Map<string, { at: number; name: string }> {
  const out = new Map<string, { at: number; name: string }>();
  (project?.nodes ?? []).filter((node) => (SHOT_NODE_TYPES as readonly string[]).includes(node.type)).forEach((node, at) => {
    const shotId = project?.shotMappings?.[node.id];
    if (shotId && !out.has(shotId)) out.set(shotId, { at, name: node.title });
  });
  return out;
}

export type DeskItem =
  /** A shot's heading ("Not on a shot", "Uploads" for the rest). */
  | { type: "shot"; key: string; label: string; count: number }
  /** Takes rendered in one press, together: "Batch of 4 · pick one". */
  | { type: "strip"; key: string; label: string; count: number }
  /** One take. `run` keeps a batch's takes, and the singles between batches, on rows of their own; `first` starts that run's row. */
  | { type: "take"; key: string; entry: LibraryEntry; run: string; first: boolean };

type Group = { key: string; label: string; at: number; code: string; entries: LibraryEntry[] };
const LOOSE = Number.MAX_SAFE_INTEGER - 1, UPLOADS = Number.MAX_SAFE_INTEGER;

/** The batches with a take already picked or approved, read over every take (a filter may hide the one that was). */
export function decidedBatches(entries: readonly LibraryEntry[]): Set<string> {
  const out = new Set<string>();
  for (const entry of entries) {
    const id = entry.asset.origin === "generation" ? (entry.asset.value.params as { batchId?: unknown } | undefined)?.batchId : undefined;
    if (typeof id === "string" && (entry.take.status === "picked" || entry.take.status === "approved")) out.add(id);
  }
  return out;
}

/**
 * Takes grouped by shot (the Rig's order, then shot code; takes on no shot,
 * then uploads, last), each shot's takes newest first, a batch's siblings
 * gathered into one strip at its newest take's place (lib/variations.ts). A
 * batch still to be decided says "pick one"; `decided` names the batches
 * that are not, when a filter shows only some of their takes.
 */
export function deskItems(entries: readonly LibraryEntry[], shots: ReadonlyMap<string, { at: number; name: string }> = new Map(), decided: ReadonlySet<string> = decidedBatches(entries)): DeskItem[] {
  const groups = new Map<string, Group>();
  for (const entry of entries) {
    const g = entry.asset.origin === "generation" ? entry.asset.value : null;
    const shot = g?.shotId ? shots.get(g.shotId) : undefined;
    const key = !g ? "uploads" : g.shotId ? `shot:${g.shotId}` : "loose";
    let group = groups.get(key);
    if (!group) {
      const label = !g ? "Uploads" : !g.shotId ? "Not on a shot" : [g.shotCode, shot?.name || g.shotTitle].filter(Boolean).join(" · ") || "A shot";
      group = { key, label, at: !g ? UPLOADS : !g.shotId ? LOOSE : shot?.at ?? LOOSE - 1, code: g?.shotCode ?? "", entries: [] };
      groups.set(key, group);
    }
    group.entries.push(entry);
  }
  const ordered = [...groups.values()].sort((a, b) => a.at - b.at || a.code.localeCompare(b.code, "en", { numeric: true }) || a.label.localeCompare(b.label));
  const out: DeskItem[] = [];
  for (const group of ordered) {
    out.push({ type: "shot", key: `head:${group.key}`, label: group.label, count: group.entries.length });
    let singles = 0, open = false;
    for (const strip of groupSiblings(group.entries.map((entry) => ({ entry, params: entry.asset.origin === "generation" ? entry.asset.value.params : undefined })))) {
      if (strip.kind === "one") {
        const run = `${group.key}#${singles}`;
        out.push({ type: "take", key: strip.take.entry.take.id, entry: strip.take.entry, run, first: !open });
        open = true;
        continue;
      }
      out.push({ type: "strip", key: `strip:${strip.batchId}`, label: `Batch of ${strip.takes.length}${decided.has(strip.batchId) ? "" : " · pick one"}`, count: strip.takes.length });
      strip.takes.forEach(({ entry }, i) => out.push({ type: "take", key: entry.take.id, entry, run: `strip:${strip.batchId}`, first: i === 0 }));
      /* The singles after a batch start a row of their own. */
      singles++; open = false;
    }
  }
  return out;
}

/** The takes of a desk, in the order it shows them. */
export function deskTakes(items: readonly DeskItem[]): LibraryEntry[] {
  return items.flatMap((item) => (item.type === "take" ? [item.entry] : []));
}

/**
 * A take the editor below can open: a still or a clip with its picture, a
 * sound with its audio (for its transcript). A take that did not render,
 * waits, or has no stored copy is not.
 */
export function openable(entry: Pick<LibraryEntry, "url" | "media">): boolean {
  return Boolean(entry.url) && (entry.media === "video" || entry.media === "image" || entry.media === "audio");
}

/**
 * A take that can be picked, approved or sent back: a finished generation
 * whose picture (or, for a sound, its audio) is here to judge. An upload is a
 * source and carries no review; a take whose stored copy has not landed is
 * judged once it has.
 */
export function reviewable(entry: Pick<LibraryEntry, "take" | "asset" | "url" | "media">): boolean {
  if (entry.asset.origin !== "generation") return false;
  const face = entryFace(entry);
  return face === "media" || face === "audio";
}

/**
 * The next (or previous) take the editor can open after `current`, among the
 * takes shown, in the desk's order. A take that has just left the filter (it
 * was approved under Needs review, say) still has its place in the full
 * order, so Next goes on from there.
 */
export function stepTake(all: readonly LibraryEntry[], shown: ReadonlySet<string>, current: string | null, step: 1 | -1): LibraryEntry | null {
  const at = current ? all.findIndex((e) => e.take.id === current) : -1;
  if (at < 0) {
    const pool = all.filter((e) => shown.has(e.take.id) && openable(e));
    return (step === 1 ? pool[0] : pool.at(-1)) ?? null;
  }
  for (let i = at + step; i >= 0 && i < all.length; i += step) {
    const e = all[i];
    if (shown.has(e.take.id) && openable(e)) return e;
  }
  return null;
}

/** What the grid says when a filter leaves nothing: which takes there are none of, and whether older pages might hold some. */
export function deskEmpty(q: DeskQuery, loaded: number, more: boolean): string {
  const where = more ? ` in the ${loaded.toLocaleString("en-US")} loaded` : "";
  const status = DESK_FILTERS.find((f) => f.id === q.filter)!;
  if (q.query.trim()) return `Nothing matches “${q.query.trim()}”${q.filter === "all" ? "" : ` under ${status.label}`}${where}.`;
  switch (q.filter) {
    case "review": return `No takes need review${where}.`;
    case "picked": return `No picked takes${where}.`;
    case "approved": return `No approved takes${where}.`;
    case "changes": return `No takes are waiting on changes${where}.`;
    case "held": return `No held takes${where}.`;
    case "failed": return `No failed takes${where}.`;
    default: return q.kind ? `No ${DESK_KINDS.find((k) => k.id === q.kind)!.label.toLowerCase()} here${where}.` : `Nothing here${where}.`;
  }
}
