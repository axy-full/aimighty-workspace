import type { ImportCounts, ImportSummary } from "../workbench/board-import-model";
import type { Project } from "../workbench/studio";

/*
 * Opening an old Rig board in the new Rig, as the browser sees it: the link on
 * the old board (it finds this person's own draft of the board's production, or
 * opens the production for them, and lands on its Rig with `import=<board>`),
 * and what the new Rig says while the board comes across. The import itself is
 * the server's (lib/workbench/board-import.ts), one batch per call. Free.
 */

/** The Suites URL param naming the old board a Rig brings across (kept by the shell until the person is done with it). */
export const IMPORT_PARAM = "import";
const BOARD_ID = /^[A-Za-z0-9_-]{1,100}$/;

/** The old board a URL asks the Rig to bring across, when it names exactly one plain board id. */
export function importParam(search: string | URLSearchParams): string | null {
  const query = typeof search === "string" ? new URLSearchParams(search) : search;
  const all = query.getAll(IMPORT_PARAM);
  return all.length === 1 && BOARD_ID.test(all[0]) ? all[0] : null;
}

/** The new Rig of this person's draft, bringing the board across. */
export function newRigHref(draftId: string, boardId: string): string {
  return `/suites?${new URLSearchParams({ project: draftId, page: "rig", [IMPORT_PARAM]: boardId }).toString()}`;
}

/** The same address with the import param taken out (the person is done with it); null when it has none. */
export function withoutImport(href: string): string | null {
  const url = new URL(href, "http://x");
  if (!url.searchParams.has(IMPORT_PARAM)) return null;
  url.searchParams.delete(IMPORT_PARAM);
  const query = url.searchParams.toString();
  return url.pathname + (query ? `?${query}` : "") + url.hash;
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
const reason = async (response: Response, fallback: string) => {
  const error = ((await response.json().catch(() => null)) as { error?: unknown } | null)?.error;
  return typeof error === "string" && error ? error : fallback;
};
export const OPEN_FAILED = "The new Rig could not be opened. Try again.";

/**
 * Where "Open in the new Rig" goes for a board of `production`: this person's
 * own newest draft of that production, or — when they have none — the
 * production opened as a new draft of theirs (the Suites' own explicit open:
 * it copies only the production's published context), saved, then its Rig.
 * Nobody else's draft is read.
 */
export async function newRigFor(input: { production: string; boardId: string; scope: string; fetch?: Fetch }): Promise<string> {
  const get = input.fetch ?? ((url, init) => fetch(url, init));
  const headers = { "X-Workbench-Scope": input.scope };
  const own = await get(`/api/workbench/projects?production=${encodeURIComponent(input.production)}`, { cache: "no-store", headers });
  if (!own.ok) throw new Error(await reason(own, OPEN_FAILED));
  const found = ((await own.json().catch(() => null)) as { id?: unknown } | null)?.id;
  if (typeof found === "string" && found) return newRigHref(found, input.boardId);
  const json = { ...headers, "Content-Type": "application/json" };
  const opened = await get("/api/workbench/projects", { method: "POST", headers: json, body: JSON.stringify({ action: "open", projectId: input.production }) });
  const body = (await opened.json().catch(() => null)) as { project?: Project; error?: string } | null;
  if (!opened.ok || !body?.project?.id) throw new Error(opened.status === 404 ? "This board’s production is not in this workspace." : body?.error ?? OPEN_FAILED);
  const saved = await get("/api/workbench/projects", { method: "PUT", headers: json, body: JSON.stringify({ project: body.project, revision: 0 }) });
  if (!saved.ok) throw new Error(await reason(saved, OPEN_FAILED));
  return newRigHref(body.project.id, input.boardId);
}

/* ── What the new Rig says while a board comes across ─────────────────── */

/** An import as the Rig shows it: `brought` adds up what came across in this run, over every batch. */
export type ImportView =
  | { phase: "waiting" }
  | { phase: "running"; answer: ImportSummary | null; brought: { cards: number; wires: number } }
  | { phase: "done"; answer: ImportSummary; brought: { cards: number; wires: number } }
  | { phase: "failed"; answer: ImportSummary | null; brought: { cards: number; wires: number }; error: string; final: boolean };

const n = (value: number) => value.toLocaleString("en-US");
const cards = (value: number) => `${n(value)} ${value === 1 ? "card" : "cards"}`;
const connections = (value: number) => `${n(value)} ${value === 1 ? "connection" : "connections"}`;
const of = (c: ImportCounts) => `${n(c.here)} of ${n(c.total)}`;

const FREE = "Free. The old board stays as it was.";
const AGAIN = "Trying again is free and brings only what is missing.";

/** The line the Rig shows for an import, and the notes under it. */
export function importCopy(view: ImportView): { line: string; notes: string[] } {
  if (view.phase === "waiting") return { line: "Bringing an old board across…", notes: [] };
  const answer = view.answer;
  const name = answer ? `“${answer.board.name}”` : null;
  if (view.phase === "running")
    return { line: answer && answer.cards.total ? `Bringing ${name} across · ${of(answer.cards)} cards` : `Bringing ${name ?? "the old board"} across…`, notes: [FREE] };
  if (view.phase === "failed") {
    if (view.final) return { line: `${name ?? "The old board"} can’t come across here. ${view.error}`, notes: [] };
    if (answer && (answer.cards.here > 0 || answer.wires.here > 0))
      return { line: `Part of ${name} came across: ${of(answer.cards)} cards and ${of(answer.wires)} connections. The rest didn’t reach the new Rig.`, notes: [AGAIN] };
    return { line: name ? `${name} didn’t come across. ${view.error}` : view.error, notes: [AGAIN] };
  }
  const notes: string[] = [];
  const { cards: c, wires: w } = view.answer;
  const line = c.total === 0 ? `${name} has no cards to bring across.`
    : view.brought.cards || view.brought.wires ? `${name} is on the new Rig: ${cards(c.here)} and ${connections(w.here)}.`
    : `Everything on ${name} is already on the new Rig. Nothing new came across.`;
  if (c.off) notes.push(`${cards(c.off)} someone took off the new Rig ${c.off === 1 ? "stays" : "stay"} off.`);
  if (c.refused) notes.push(`${cards(c.refused)} didn’t fit: the new Rig holds at most 4,000 cards.`);
  if (w.refused) notes.push(`${connections(w.refused)} couldn’t be made here: a loop, or a locked card.`);
  if (view.answer.filed) notes.push("Filing lines stay on the old board; their takes are in Takes.");
  notes.push(FREE);
  return { line, notes };
}
