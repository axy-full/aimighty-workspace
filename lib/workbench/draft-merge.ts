import { identityKey, merge3, sameJson, type MergeOptions } from "./merge";
import { NODE_INPUTS } from "./node-graph";
import type { Asset, CanvasNode, Project } from "./studio";
import { trimVersions } from "../production/script-versions";
import { saveSchema } from "./studio-schema";

/**
 * Two saves of one project draft merged into one draft the server takes:
 * merge3 (lib/workbench/merge.ts), then what only a whole project can say.
 *
 *  - What the other side took out since base of the records made from a
 *    shared source (Project.takenOut) stays out when this side made the same
 *    again and left it as made.
 *  - A merge that took one side's content whole combined nothing: it is
 *    returned as it is, without the repairs and the check below (so the
 *    rebase of every save made while typing stays cheap on a feature).
 *  - An original the merged draft still uses is never dropped: an asset one
 *    side deleted (a line drawing, say) stays while the other side's Rig
 *    input, product profile, bin or clip points at it.
 *  - A link never points at a node the merge dropped. An input node one side
 *    took out only because nothing else used it (Delete shot takes such
 *    inputs with it) stays when the other side has wired it into something;
 *    a link to any other node that is gone goes with that node.
 *  - Wires each side was allowed to make still obey the graph once merged: a
 *    node takes no more inputs than it holds (mine's first), and a wire from
 *    the other side that would close a loop is left out.
 *  - A sound clip whose fades both sides changed keeps this side's fade and
 *    shortens the other to fit the clip; sound clips past what an edit holds
 *    (a legacy soundtrack counts) keep the saved version's, then this side's;
 *    two bins given one name keep both, this side's renamed; an imported
 *    screenplay whose text the merge changed is marked edited, as typing into
 *    it would; OCR pages asked for in two windows are all asked for.
 *  - A list merged past what the project holds is fitted the way its own
 *    stage fits it: takes and plates keep the newest (renders in flight have
 *    no count limit, so every one is kept), and any other list keeps what the
 *    saved version already had, then what this side added, up to its limit —
 *    and says, in `notes`, what of this side's did not fit. Text merged past
 *    its limit is the saved version's, and this side is told.
 *
 * Each side was a valid save, so the merge is one as well. A rule no repair
 * above covers puts the saved version back where the merge broke it, the
 * smallest part first (a record, a field, the whole field), and tells this
 * side what of its own did not stand: another window's saved edit is never
 * undone without a word.
 */
export type DraftMergeOptions = MergeOptions & {
  /** Filled with what this side added that the merged draft had no room for, said plainly. */
  notes?: string[];
  /** How long the last resort may look for a part to put back (ms): each look is a full check of the draft. */
  lastResortMs?: number;
};

export function mergeDraft(base: Project, mine: Project, theirs: Project, options: DraftMergeOptions = {}): Project {
  const { notes, lastResortMs = LAST_RESORT_MS, ...rest } = options;
  const grew = { value: false };
  /* What the other side took out since base, of records made from a shared source: made again here from a stale copy, it stays out. */
  const known = new Set(base.takenOut ?? []);
  const takenOut = new Set((theirs.takenOut ?? []).filter((id) => !known.has(id)));
  let merged = merge3(base, mine, theirs, { ...rest, grew, takenOut });
  /* One side's content whole (the other changed nothing but what the server keeps): nothing was combined, so nothing to repair or check. */
  if (wholeSide(merged, mine) || wholeSide(merged, theirs)) return merged;
  merged = keepUsedOriginals(merged, mine, theirs, notes);
  merged = keepLinkedInputs(merged, mine, theirs);
  merged = obeyGraph(merged, mine);
  merged = fitFades(merged, base, mine);
  merged = fitClips(merged, theirs, notes);
  merged = distinctBins(merged, theirs);
  merged = markEditedScript(merged);
  merged = fitScriptVersions(merged);
  merged = recognizedPages(merged);
  if (valid(merged)) return merged;
  merged = fitDraft(merged, mine, theirs, notes);
  merged = keepLinkedInputs(merged, mine, theirs, false);
  return valid(merged) ? merged : lastResort(merged, mine, theirs, notes, performance.now() + lastResortMs);
}

/**
 * The local draft once the server holds `saved` for the draft `sent`: edits
 * made while the save was out (`local` moved on from `sent`) are merged over
 * `saved` (mergeDraft) rather than lost; with none, the draft is exactly `saved`.
 */
export function rebaseProject(sent: Project, local: Project, saved: Project): Project {
  return local === sent ? saved : mergeDraft(sent, local, saved);
}

/**
 * Earlier scripts (lib/production/script-versions.ts) after two sides each added some: newest first by their dates, each once, and trimmed to the limits (the oldest go),
 * so the list can never be what makes the merged draft unsavable. The same project when there is no list, or it is already as it should be.
 */
function fitScriptVersions(project: Project): Project {
  const list = project.scriptVersions;
  if (!list) return project;
  const seen = new Set<string>();
  const ordered = [...list].filter((v) => (seen.has(v.id) ? false : (seen.add(v.id), true))).sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  const kept = trimVersions(ordered);
  return kept.length === list.length && kept.every((v, i) => v === list[i]) ? project : { ...project, scriptVersions: kept.length ? kept : undefined };
}

const valid = (project: Project) => saveSchema.safeParse({ project, revision: 0 }).success;

/** What the server sets on every save: never an edit either side made. */
const SERVER_KEYS = new Set(["productionProjectId", "shotMappings"]);
/** Whether the merge took `side`'s content whole — every field but the server's own is that side's value (merge3 hands values on as they are). */
function wholeSide(merged: Project, side: Project): boolean {
  const a = merged as Record<string, unknown>, b = side as Record<string, unknown>;
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) if (!SERVER_KEYS.has(key) && a[key] !== b[key]) return false;
  return true;
}

/** Lists that list records of their own (or ids of records taken out), not uses of an original. */
const NOT_USES = new Set(["assets", "sharedAssets", "sharedAssetIds", "sharedNodes", "sharedNodeIds", "takenOut"]);

/** Every string value in `value` (keys skipped at the top level named in `skip`). */
function strings(value: unknown, into: Set<string>, skip?: ReadonlySet<string>) {
  if (typeof value === "string") into.add(value);
  else if (Array.isArray(value)) for (const item of value) strings(item, into);
  else if (value && typeof value === "object")
    for (const [key, item] of Object.entries(value)) if (!skip?.has(key)) strings(item, into);
}

/** Inserts `item` into `list` after the nearest item that precedes it in `order` and is in `list` (else first). */
function placeAfter<T extends { id: string }>(list: T[], item: T, order: readonly T[]): T[] {
  const at = order.findIndex((x) => x.id === item.id);
  for (let i = at - 1; i >= 0; i--) {
    const j = list.findIndex((x) => x.id === order[i].id);
    if (j >= 0) return [...list.slice(0, j + 1), item, ...list.slice(j + 1)];
  }
  return [item, ...list];
}

/** An asset one side deleted, which the merged draft still uses (a Rig input, a product profile, a bin, a clip): kept — and this side told, when it was this side's delete. */
function keepUsedOriginals(merged: Project, mine: Project, theirs: Project, notes?: string[]): Project {
  const present = new Set(merged.assets.map((a) => a.id));
  const dropped = new Map<string, { asset: Asset; order: Asset[] }>();
  for (const side of [theirs, mine]) for (const asset of side.assets) if (!present.has(asset.id) && !dropped.has(asset.id)) dropped.set(asset.id, { asset, order: side.assets });
  if (!dropped.size) return merged;
  const used = new Set<string>();
  strings(merged, used, NOT_USES);
  for (const asset of merged.assets) strings({ ...asset, id: undefined }, used);
  let assets = merged.assets;
  for (let restored = true; restored;) {
    restored = false;
    for (const [id, { asset, order }] of dropped) {
      if (!used.has(id)) continue;
      assets = placeAfter(assets, asset, order);
      dropped.delete(id);
      if (!mine.assets.some((a) => a.id === id)) notes?.push(`${asset.name} stays in the project: another window uses it now.`);
      strings({ ...asset, id: undefined }, used);
      restored = true;
    }
  }
  return assets === merged.assets ? merged : { ...merged, assets };
}

/**
 * Links never point at a node the merge dropped: an input one side removed as
 * unused, now used, is back (with `restore`); any other link to a node that is
 * gone goes, and so does a switch's choice of it.
 */
function keepLinkedInputs(merged: Project, mine: Project, theirs: Project, restore = true): Project {
  if (!Array.isArray(merged.nodes)) return merged;
  const present = new Set(merged.nodes.map((n) => n.id));
  const linked = new Set(merged.nodes.flatMap((n) => n.linked ?? []));
  const back: CanvasNode[] = [];
  if (restore)
    for (const side of [theirs, mine])
      for (const n of side.nodes ?? [])
        if (n.type === "media" && !present.has(n.id) && linked.has(n.id)) { back.push(n); present.add(n.id); }
  const dangling = merged.nodes.some((n) => (n.linked ?? []).some((id) => !present.has(id)) || (n.activeInput && !present.has(n.activeInput)));
  if (!back.length && !dangling) return merged;
  const nodes = [...merged.nodes, ...back].map((n) => {
    const links = (n.linked ?? []).filter((id) => present.has(id));
    const lost = n.activeInput !== undefined && !present.has(n.activeInput);
    if (links.length === (n.linked ?? []).length && !lost) return n;
    const next: CanvasNode = { ...n, linked: links };
    if (lost) delete next.activeInput;
    return next;
  });
  return { ...merged, nodes };
}

/**
 * Wires each side made under the graph's rules, merged, obey them too: a node
 * keeps at most the inputs its kind takes (this side's first, then the rest in
 * order), and a wire this side does not hold that would close a loop is left
 * out — this side's wiring stands, as any change both made to one thing does.
 */
function obeyGraph(merged: Project, mine: Project): Project {
  if (!Array.isArray(merged.nodes) || !merged.nodes.some((n) => n.linked?.length)) return merged;
  const own = new Map((mine.nodes ?? []).map((n) => [n.id, new Set(n.linked ?? [])]));
  let changed = false;
  const byId = new Map<string, CanvasNode>();
  for (const n of merged.nodes) {
    const max = NODE_INPUTS[n.type]?.max ?? Infinity;
    const links = n.linked ?? [];
    if (links.length <= max) { byId.set(n.id, n); continue; }
    const mineHolds = own.get(n.id) ?? new Set<string>();
    const keep = new Set([...links.filter((id) => mineHolds.has(id)), ...links.filter((id) => !mineHolds.has(id))].slice(0, max));
    byId.set(n.id, { ...n, linked: links.filter((id) => keep.has(id)) });
    changed = true;
  }
  /* A wire a node takes from `source` closes a loop when `source` already draws on that node. */
  const drawsOn = (from: string, target: string) => {
    const seen = new Set<string>();
    const walk = (id: string): boolean => {
      if (id === target) return true;
      if (seen.has(id)) return false;
      seen.add(id);
      return (byId.get(id)?.linked ?? []).some(walk);
    };
    return walk(from);
  };
  for (const n of merged.nodes) {
    const current = byId.get(n.id)!;
    const mineHolds = own.get(n.id) ?? new Set<string>();
    for (const source of current.linked ?? []) {
      if (mineHolds.has(source) || !drawsOn(source, n.id)) continue;
      const now = byId.get(n.id)!;
      byId.set(n.id, { ...now, linked: now.linked.filter((id) => id !== source) });
      changed = true;
    }
  }
  return changed ? { ...merged, nodes: merged.nodes.map((n) => byId.get(n.id)!) } : merged;
}

/** A clip whose fades together run past it: this side's fade stands (clamped to the clip), the other is shortened to fit. */
function fitFades(merged: Project, base: Project, mine: Project): Project {
  if (!merged.audioClips?.some((c) => c.fadeIn + c.fadeOut > c.duration)) return merged;
  const before = new Map((base.audioClips ?? []).map((c) => [c.id, c])), own = new Map((mine.audioClips ?? []).map((c) => [c.id, c]));
  return {
    ...merged,
    audioClips: merged.audioClips.map((c) => {
      if (c.fadeIn + c.fadeOut <= c.duration || c.duration < 1) return c;
      const was = before.get(c.id), mineClip = own.get(c.id);
      const mineOut = !!mineClip && mineClip.fadeOut === c.fadeOut && mineClip.fadeOut !== was?.fadeOut && !(mineClip.fadeIn === c.fadeIn && mineClip.fadeIn !== was?.fadeIn);
      if (mineOut) {
        const fadeOut = Math.min(c.fadeOut, c.duration);
        return { ...c, fadeOut, fadeIn: Math.min(c.fadeIn, c.duration - fadeOut) };
      }
      const fadeIn = Math.min(c.fadeIn, c.duration);
      return { ...c, fadeIn, fadeOut: Math.min(c.fadeOut, c.duration - fadeIn) };
    }),
  };
}

/** How many sound clips an edit holds (lib/workbench/audio.ts validateAudio), a legacy soundtrack included. */
const CLIPS_HELD = 64;

/** Sound clips added in two windows past what an edit holds: the saved version's all stay, then this side's additions, up to the limit — the rest named. */
function fitClips(merged: Project, theirs: Project, notes?: string[]): Project {
  const room = CLIPS_HELD - (merged.audioAssetId ? 1 : 0);
  const clips = merged.audioClips ?? [];
  if (clips.length <= room) return merged;
  const saved = new Set((theirs.audioClips ?? []).map((c) => c.id));
  let spare = room - clips.filter((c) => saved.has(c.id)).length;
  const kept = clips.filter((c) => saved.has(c.id) || spare-- > 0);
  const left = clips.length - kept.length;
  if (left) notes?.push(`An edit holds ${CLIPS_HELD} sound clips, and another window filled it first: ${left} of this window's clips ${left === 1 ? "was" : "were"} not added.`);
  return { ...merged, audioClips: kept };
}

/** OCR of screenplay pages asked for in two windows: every page recognized in the merge is one asked for (each side's were). */
function recognizedPages(merged: Project): Project {
  const ocr = merged.scriptSource?.ocr;
  if (!ocr) return merged;
  const pages = [...new Set(ocr.pages.map((p) => p.page))].sort((a, b) => a - b);
  if (sameJson([...ocr.requestedPages].sort((a, b) => a - b), pages) && new Set(ocr.requestedPages).size === ocr.requestedPages.length) return merged;
  return { ...merged, scriptSource: { ...merged.scriptSource!, ocr: { ...ocr, requestedPages: pages } } };
}

/** Two bins given one name in two windows: both kept, the one the saved version did not have renamed. */
function distinctBins(merged: Project, theirs: Project): Project {
  const bins = merged.bins;
  if (!bins?.length) return merged;
  const name = (value: string) => value.trim().toLowerCase();
  if (new Set(bins.map((b) => name(b.name))).size === bins.length) return merged;
  const saved = new Set((theirs.bins ?? []).map((b) => b.id));
  const taken = new Set(bins.filter((b) => saved.has(b.id)).map((b) => name(b.name)));
  return {
    ...merged,
    bins: bins.map((bin) => {
      if (saved.has(bin.id) || !taken.has(name(bin.name))) { taken.add(name(bin.name)); return bin; }
      let n = 2;
      while (taken.has(name(`${bin.name} ${n}`))) n++;
      const renamed = `${bin.name.trim()} ${n}`;
      taken.add(name(renamed));
      return { ...bin, name: renamed };
    }),
  };
}

/** An imported screenplay whose text the merge changed no longer matches its page map: marked edited, as typing into it marks it. */
function markEditedScript(merged: Project): Project {
  const source = merged.scriptSource;
  if (!source || source.edited || !source.pages.length || source.pages[source.pages.length - 1].end === (merged.script ?? "").length) return merged;
  return { ...merged, scriptSource: { ...source, edited: true } };
}

type Path = (string | number)[];
const at = (value: unknown, path: Path): unknown => path.reduce<unknown>((node, key) => (node && typeof node === "object" ? (node as Record<string | number, unknown>)[key] : undefined), value);
function setAt<T>(value: T, path: Path, next: unknown): T {
  if (!path.length) return next as T;
  const [key, ...rest] = path;
  if (Array.isArray(value)) return value.map((item, i) => (i === key ? setAt(item, rest, next) : item)) as T;
  const row = (value ?? {}) as Record<string | number, unknown>;
  return { ...row, [key]: setAt(row[key], rest, next) } as T;
}
const identity = (item: unknown) => (item && typeof item === "object" ? JSON.stringify(["genId", "jobId", "assetId", "id"].map((key) => (item as Record<string, unknown>)[key])) : JSON.stringify(item));

/** Where a list is a history the stage trims itself: takes and plates newest first, renders in flight and what was taken out (newest last) the latest. */
function orderOf(path: Path): "newest-first" | "last" | "saved-first" {
  const key = path[path.length - 1];
  if (key === "pending" || (key === "takenOut" && path.length === 1)) return "last";
  if ((key === "takes" || key === "plates") && path[0] === "production") return "newest-first";
  return "saved-first";
}

/** What the saved version (theirs) already had first, then what this side added; `newest-first` puts this side's additions first, `last` keeps the end (renders in flight). */
function fitted(list: unknown[], saved: unknown, limit: number, order: "saved-first" | "newest-first" | "last"): unknown[] {
  const merged = new Map(list.map((item) => [identity(item), item]));
  const known = (Array.isArray(saved) ? saved : []).map(identity);
  const kept = known.filter((id) => merged.has(id)).map((id) => merged.get(id)), added = list.filter((item) => !known.includes(identity(item)));
  if (order === "newest-first") return [...added, ...kept].slice(0, limit);
  if (order === "last") return [...kept, ...added].slice(-limit);
  return [...kept, ...added].slice(0, limit);
}

function fitDraft(merged: Project, mine: Project, theirs: Project, notes?: string[]): Project {
  let out = merged;
  for (let pass = 0; pass < 4; pass++) {
    const parsed = saveSchema.safeParse({ project: out, revision: 0 });
    if (parsed.success) return out;
    let changed = false;
    for (const issue of parsed.error.issues) {
      if (issue.code !== "too_big" || issue.path[0] !== "project") continue;
      const path = issue.path.slice(1) as Path, value = at(out, path);
      const limit = Number((issue as { maximum?: number | bigint }).maximum);
      if (Array.isArray(value) && Number.isFinite(limit)) {
        const order = orderOf(path), kept = fitted(value, at(theirs, path), limit, order);
        if (order === "saved-first") {
          const left = new Set(kept.map(identity)), mineHad = new Set((Array.isArray(at(mine, path)) ? (at(mine, path) as unknown[]) : []).map(identity));
          const lost = value.filter((item) => !left.has(identity(item)) && mineHad.has(identity(item)));
          if (lost.length) notes?.push(fitNote(out, mine, path, limit, lost));
        }
        out = setAt(out, path, kept);
        changed = true;
      } else if (typeof value === "string") {
        /* The saved text stands — never this side's over the other window's saved words — and this side is told. */
        const own = at(mine, path), saved = at(theirs, path);
        const next = typeof saved === "string" && saved.length <= limit ? saved : typeof own === "string" && own.length <= limit ? own : value.slice(0, limit);
        if (next !== own) notes?.push(`${labelOf(path)} holds ${limit.toLocaleString("en-US")} characters, and another window's text filled it first: your edit to it was not added.`);
        out = setAt(out, path, next);
        changed = true;
      }
    }
    if (!changed) return out;
  }
  return out;
}

/** What of this side's did not fit a full list, in the words the page uses. */
function fitNote(project: Project, mine: Project, path: Path, limit: number, lost: unknown[]): string {
  /* Sound clips have no names to give: how many. */
  if (path.length === 1 && path[0] === "audioClips")
    return `An edit holds ${CLIPS_HELD} sound clips, and another window filled it first: ${lost.length} of this window's clips ${lost.length === 1 ? "was" : "were"} not added.`;
  const assets = new Map([...mine.assets, ...project.assets].map((a) => [a.id, a]));
  const named = lost.map((item) => {
    if (typeof item === "string") return assets.get(item)?.name ?? `“${item.slice(0, 60)}”`;
    const row = (item ?? {}) as Record<string, unknown>;
    const label = [row.name, row.title, row.heading, row.text, row.description, row.id].find((value) => typeof value === "string" && value.trim());
    return String(label ?? "an item").slice(0, 60);
  });
  const key = path[path.length - 1];
  const owner = path[0] === "production" && path[1] === "environment" && typeof path[3] === "number"
    ? (at(project, path.slice(0, 4)) as { name?: string } | undefined)?.name
    : null;
  const what =
    key === "references" ? `${owner || "This place"} holds ${limit} references` :
    key === "productAssetIds" ? `The product holds ${limit} pictures` :
    key === "castAssetIds" ? `The cast holds ${limit} pictures` :
    key === "hooks" ? `A campaign holds ${limit} hooks` :
    key === "nodes" ? `A project holds ${limit.toLocaleString("en-US")} Rig nodes` :
    key === "assets" ? `A project holds ${limit.toLocaleString("en-US")} assets` :
    `This list holds ${limit}`;
  return `${what}, and another window filled it first: ${named.join(", ")} not added.`;
}

/** A field of the project, in the words the page uses. */
function labelOf(path: Path): string {
  /* Brief's and Beats' notes to the writer (production.notes.draft / .beats): named as the box, not as its key. */
  if (path[0] === "production" && path[1] === "notes") return "The notes box";
  const key = String(path[path.length - 1] ?? path[0]);
  const words: Record<string, string> = { brief: "The brief", script: "The script", notes: "The notes", text: "The shot's text", description: "The description", prompt: "The prompt", world: "The world" };
  return words[key] ?? `The ${key.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase()}`;
}

/** The project fields the server would refuse, and how many problems it finds. */
function problems(project: Project): { keys: string[]; count: number } {
  const parsed = saveSchema.safeParse({ project, revision: 0 });
  if (parsed.success) return { keys: [], count: 0 };
  const issues = parsed.error.issues.filter((issue) => issue.path[0] === "project");
  return { keys: [...new Set(issues.filter((issue) => typeof issue.path[1] === "string").map((issue) => issue.path[1] as string))], count: parsed.error.issues.length };
}

/** A part of the merged draft that differs from the saved version, and how to put the saved version back there. */
type Part = { label: string; mine: boolean; whole: boolean; apply: (project: Project) => Project };

/** The parts of `key` where the merge differs from the saved version, smallest first: each record of a list (by its identity), each field of a record or group, then the whole field. */
function partsOf(key: string, merged: Project, mine: Project, theirs: Project): Part[] {
  const parts: Part[] = [];
  const name = (row: unknown, fallback: string) => {
    const r = (row ?? {}) as Record<string, unknown>;
    const said = [r.name, r.title, r.hook, r.heading, r.id].find((value) => typeof value === "string" && value.trim());
    return said ? `“${String(said).slice(0, 60)}”` : fallback;
  };
  const walk = (path: Path, now: unknown, saved: unknown, own: unknown, depth: number) => {
    if (sameJson(now, saved)) return;
    if (Array.isArray(now) && Array.isArray(saved) && depth < 3) {
      const key = identityKey(now, saved);
      if (key) {
        const savedBy = new Map(saved.map((row) => [String((row as Record<string, unknown>)[key]), row]));
        const ownBy = new Map((Array.isArray(own) ? own : []).map((row) => [String((row as Record<string, unknown>)[key]), row]));
        for (const row of now) {
          const id = String((row as Record<string, unknown>)[key]), was = savedBy.get(id);
          if (was !== undefined && sameJson(row, was)) continue;
          parts.push({
            label: name(row, labelOf([...path, 0]).toLowerCase()),
            mine: ownBy.has(id) && !sameJson(ownBy.get(id), was),
            whole: false,
            apply: (project) => setAt(project, path, (at(project, path) as unknown[]).flatMap((item) => (String((item as Record<string, unknown>)[key]) !== id ? [item] : was === undefined ? [] : [was]))),
          });
        }
      }
    } else if (now && saved && typeof now === "object" && typeof saved === "object" && !Array.isArray(now) && !Array.isArray(saved) && depth < 3) {
      for (const field of new Set([...Object.keys(now), ...Object.keys(saved)])) {
        const a = (now as Record<string, unknown>)[field], b = (saved as Record<string, unknown>)[field];
        walk([...path, field], a, b, own && typeof own === "object" ? (own as Record<string, unknown>)[field] : undefined, depth + 1);
      }
    }
    parts.push({ label: labelOf(path).toLowerCase(), mine: !sameJson(own, saved), whole: depth === 0, apply: (project) => setAt(project, path, saved) });
  };
  walk([key], merged[key as keyof Project], theirs[key as keyof Project], mine[key as keyof Project], 0);
  return parts;
}

/** How many parts are tried one by one before whole fields are put back: each try is a full check of the draft. */
const PARTS_TRIED = 24;
/** How long the last resort looks, at most (a feature's full check takes about 300 ms): past it, the merge is left as it was. */
const LAST_RESORT_MS = 1500;

/**
 * A rule no repair above covers. The saved version is put back where the merge
 * broke it, the smallest part first — a record, a field, then the whole field
 * — never this side's value over another window's saved edit without a word,
 * and this side is told what of its own did not stand. When the field a rule
 * names already holds the saved version, what the merge did elsewhere broke
 * it, and those parts are put back instead. A draft no part fixes is left as
 * it is: the save is refused, and the edits stay here, unsaved, saying why.
 */
function lastResort(merged: Project, mine: Project, theirs: Project, notes: string[] | undefined, deadline: number): Project {
  let out = merged;
  let found = problems(out);
  const told: string[] = [];
  for (let round = 0; round < 4 && found.count; round++) {
    const named = found.keys.filter((key) => !sameJson(out[key as keyof Project], theirs[key as keyof Project]));
    const scope = named.length ? named : Object.keys(out).filter((key) => !SERVER_KEYS.has(key) && !sameJson(out[key as keyof Project], theirs[key as keyof Project]));
    const parts = scope.flatMap((key) => partsOf(key, out, mine, theirs));
    let fixed = false;
    for (const part of [...parts.filter((part) => !part.whole).slice(0, PARTS_TRIED), ...parts.filter((part) => part.whole)]) {
      /* Out of time: the main thread is the person's; the merge is left as it was (the save is refused, the edits stay here). */
      if (performance.now() > deadline) return merged;
      const next = part.apply(out), now = problems(next);
      if (now.count >= found.count || now.keys.some((key) => !found.keys.includes(key))) continue;
      if (part.mine) told.push(`Your change to ${part.label} could not be combined with another window's; the saved version is kept.`);
      out = next;
      found = now;
      fixed = true;
      break;
    }
    if (!fixed) break;
  }
  /* Only a save the server takes is worth putting anything back for; otherwise the merge is left exactly as it was. */
  if (found.count) return merged;
  notes?.push(...told);
  return out;
}
