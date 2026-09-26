import { merge3, type MergeOptions } from "./merge";
import type { CanvasNode, Project } from "./studio";
import { saveSchema } from "./studio-schema";

/**
 * Two saves of one project draft merged into one draft the server takes:
 * merge3 (lib/workbench/merge.ts), then what only a whole project can say.
 *
 *  - A link never points at a node the merge dropped. An input node one side
 *    took out only because nothing else used it (Delete shot takes such
 *    inputs with it) stays when the other side has wired it into something;
 *    a link to any other node that is gone goes with that node.
 *  - A list merged past what the project holds is fitted the way its own
 *    stage fits it: takes and plates keep the newest (what each side filed,
 *    then the rest), renders in flight keep the latest five, and any other
 *    list keeps what the saved version already had, then what this side
 *    added, up to its limit. Text merged past its limit is this side's.
 *
 * Each side was a valid save, so the merge is one as well.
 */
export function mergeDraft(base: Project, mine: Project, theirs: Project, options: MergeOptions = {}): Project {
  const grew = { value: false };
  const merged = keepLinkedInputs(merge3(base, mine, theirs, { ...options, grew }), mine, theirs);
  /* Only a list or text the merge made longer than either side's can be past a limit. */
  return grew.value ? fitDraft(merged, mine, theirs) : merged;
}

/**
 * The local draft once the server holds `saved` for the draft `sent`: edits
 * made while the save was out (`local` moved on from `sent`) are merged over
 * `saved` (mergeDraft) rather than lost; with none, the draft is exactly `saved`.
 */
export function rebaseProject(sent: Project, local: Project, saved: Project): Project {
  return local === sent ? saved : mergeDraft(sent, local, saved);
}

function keepLinkedInputs(merged: Project, mine: Project, theirs: Project): Project {
  if (!Array.isArray(merged.nodes)) return merged;
  const present = new Set(merged.nodes.map((n) => n.id));
  const linked = new Set(merged.nodes.flatMap((n) => n.linked ?? []));
  /* An input one side removed as unused, now used: back, as the side that kept it has it. */
  const back: CanvasNode[] = [];
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

/** What the saved version (theirs) already had first, then what this side added; `last` keeps the end (renders in flight). */
function fitted(list: unknown[], saved: unknown, limit: number, order: "saved-first" | "newest-first" | "last"): unknown[] {
  const merged = new Map(list.map((item) => [identity(item), item]));
  const known = (Array.isArray(saved) ? saved : []).map(identity);
  /* The saved version's items in its own order (as merged), then what this side added. */
  const kept = known.filter((id) => merged.has(id)).map((id) => merged.get(id)), added = list.filter((item) => !known.includes(identity(item)));
  if (order === "newest-first") return [...added, ...kept].slice(0, limit);
  if (order === "last") return [...kept, ...added].slice(-limit);
  return [...kept, ...added].slice(0, limit);
}

/** Where a list is a history the stage trims itself: takes and plates newest first, renders in flight the latest. */
function orderOf(path: Path): "newest-first" | "last" | "saved-first" {
  const key = path[path.length - 1];
  if (key === "pending") return "last";
  if ((key === "takes" || key === "plates") && path[0] === "production") return "newest-first";
  return "saved-first";
}

function fitDraft(merged: Project, mine: Project, theirs: Project): Project {
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
        out = setAt(out, path, fitted(value, at(theirs, path), limit, orderOf(path)));
        changed = true;
      } else if (typeof value === "string") {
        const own = at(mine, path), saved = at(theirs, path);
        out = setAt(out, path, typeof own === "string" && own.length <= limit ? own : typeof saved === "string" ? saved : value.slice(0, limit));
        changed = true;
      }
    }
    if (!changed) return out;
  }
  return out;
}
