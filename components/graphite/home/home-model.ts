/**
 * Home (design/particl-graphite/README.md § 1.1, the master's `?view=home`): the
 * parts with no React and no fetch — the templates, the chips, a new project's
 * name and seed, the project cards' lines. Every figure is the workspace's own;
 * nothing here is sample data.
 */
import { moving, type TrayJob } from "@/lib/jobsTray";
import { savedAt } from "@/lib/shell/studio-home";
import { ago } from "@/lib/workspace/activity";
import type { ProjectSummary } from "@/lib/workspace/data";
import type { QueueItem } from "@/lib/control-room/queue";

/** A board's kind: the template that started it (stream 3's `BoardKind`, the same three words). */
export type BoardKind = "studio" | "ads" | "social";

/** The master's 16-unit glyphs (GLYPH in `Particl Suites.dc.html`), stroked at 1.4. */
export const GLYPHS = {
  doc: "M4 2h6l3 3v9H4zM10 2v3h3M6 8h4M6 11h4",
  image: "M2 3h12v10H2zM2 10l4-3 3 3 2-2 3 3",
  frame: "M2 4h12v8H2zM2 7h12M5 4v8",
  tag: "M2 8.5V2.5h6L14 8.5 8.5 14zM5.2 5.2h.01",
  video: "M2 4h8v8H2zM10 7l4-2v6l-4-2",
} as const;

export type TemplateId = "film" | "ads" | "social" | "script" | "blank";
export type Template = {
  id: TemplateId;
  label: string;
  kind: BoardKind;
  /** The new project's name when the box says nothing. */
  untitled: string;
  glyph: string;
  /** Start from a script: the board opens where the script is imported. */
  start?: "script";
};

/** Studio, Ads and Social are templates picked on Home, not destinations (README § 1). */
export const TEMPLATES: readonly Template[] = [
  { id: "film", label: "Film", kind: "studio", untitled: "Untitled film", glyph: GLYPHS.frame },
  { id: "ads", label: "Ad campaign", kind: "ads", untitled: "Untitled ad campaign", glyph: GLYPHS.tag },
  { id: "social", label: "Social clips", kind: "social", untitled: "Untitled social clips", glyph: GLYPHS.video },
  { id: "script", label: "Start from a script", kind: "studio", untitled: "Untitled script", glyph: GLYPHS.doc, start: "script" },
];
/** "+ New project": an empty Studio board. */
export const BLANK: Template = { id: "blank", label: "New project", kind: "studio", untitled: "Untitled project", glyph: GLYPHS.frame };

export const ASPECTS = ["16:9", "9:16", "1:1"] as const;
export const LENGTHS = ["6 s", "15 s", "30 s", "60 s"] as const;
export const DEFAULT_ASPECT = "16:9";
export const DEFAULT_LENGTH = "15 s";
/** The longest brief a draft saves (lib/workbench/studio-schema.ts › brief). */
export const BRIEF_MAX = 30_000;
/** The longest project name a draft saves (components/graphite/ProjectHead.tsx › PROJECT_NAME_MAX). */
export const NAME_MAX = 100;

/**
 * The box as it saves itself (lib/useDraft.ts): the words, and a chip only when it differs from its default,
 * so a box nobody touched is a blank draft and leaves nothing in storage.
 */
export type HomeDraft = { text: string; aspect: string | null; length: string | null };
export const EMPTY_DRAFT: HomeDraft = { text: "", aspect: null, length: null };

const oneOf = <T extends string>(list: readonly T[], value: unknown): value is T => typeof value === "string" && (list as readonly string[]).includes(value);
export const draftAspect = (draft: HomeDraft): string => (oneOf(ASPECTS, draft.aspect) ? draft.aspect : DEFAULT_ASPECT);
export const draftLength = (draft: HomeDraft): string => (oneOf(LENGTHS, draft.length) ? draft.length : DEFAULT_LENGTH);
/** A chip pressed: stored only when it is not the default. */
export const withAspect = (draft: HomeDraft, aspect: string): HomeDraft => ({ ...draft, aspect: aspect === DEFAULT_ASPECT ? null : aspect });
export const withLength = (draft: HomeDraft, length: string): HomeDraft => ({ ...draft, length: length === DEFAULT_LENGTH ? null : length });

/** A stored draft from an older build or another tab, read safely. */
export function cleanDraft(value: unknown): HomeDraft {
  if (!value || typeof value !== "object") return EMPTY_DRAFT;
  const v = value as Partial<Record<keyof HomeDraft, unknown>>;
  return {
    text: typeof v.text === "string" ? v.text.slice(0, BRIEF_MAX) : "",
    aspect: oneOf(ASPECTS, v.aspect) && v.aspect !== DEFAULT_ASPECT ? v.aspect : null,
    length: oneOf(LENGTHS, v.length) && v.length !== DEFAULT_LENGTH ? v.length : null,
  };
}

/** Words added to the box (an attached brief): after what is there, a blank line between, never past the limit. */
export function appendBrief(text: string, more: string): { text: string; cut: boolean } {
  const add = more.replace(/\r\n?/g, "\n").trim();
  if (!add) return { text, cut: false };
  const joined = text.trim() ? `${text.replace(/\s+$/, "")}\n\n${add}` : add;
  return joined.length > BRIEF_MAX ? { text: joined.slice(0, BRIEF_MAX), cut: true } : { text: joined, cut: false };
}

/**
 * A project's name from its brief: the first sentence, cut at a word under `max` characters.
 * Null when the brief says nothing, so the template's neutral name is used.
 */
export function nameFromBrief(text: string, max = 48): string | null {
  const first = text.split(/[\n.!?]+/).map((part) => part.replace(/\s+/g, " ").trim()).find((part) => /[\p{L}\p{N}]/u.test(part));
  if (!first) return null;
  if (first.length <= max) return first;
  const cut = first.slice(0, max + 1);
  const at = cut.lastIndexOf(" ");
  return (at >= Math.floor(max / 3) ? cut.slice(0, at) : first.slice(0, max)).replace(/[\s,;:·–—-]+$/u, "");
}

/** What a new project starts with: everything the box set, so nothing is asked again (README § 0, rule 3). */
export type HomeSeed = { brief?: string; aspect: string; deliverables: string; boardKind: BoardKind };

export function newProjectFor(template: Template, draft: HomeDraft): { name: string; seed: HomeSeed } {
  const brief = draft.text.trim().slice(0, BRIEF_MAX);
  const name = (nameFromBrief(brief) ?? template.untitled).slice(0, NAME_MAX);
  return {
    name,
    seed: { ...(brief ? { brief } : {}), aspect: draftAspect(draft), deliverables: draftLength(draft), boardKind: template.kind },
  };
}

/** A project this tab made from a template (kept for the tab's session). */
export type MadeHere = { id: string; template: TemplateId; at: number };
/** Nobody has saved a project since it was made: the first save is revision 1 (lib/workbench/records.ts › saveDraft). */
export const untouched = (project: Pick<ProjectSummary, "revision"> | undefined): boolean => project?.revision === 1;

/**
 * The project to open instead of making another (lead decision 23): one this tab made from the same template
 * that is still untouched, newest first. Only when the box adds nothing to it.
 */
export function reusable(made: readonly MadeHere[], template: TemplateId, projects: readonly ProjectSummary[]): string | null {
  for (const entry of [...made].sort((a, b) => b.at - a.at)) {
    if (entry.template !== template) continue;
    const project = projects.find((p) => p.id === entry.id);
    if (untouched(project)) return entry.id;
  }
  return null;
}

/** What waits in a project. `approvals` is null until the approval queue is read (stream 8's, in PR b). */
export type Needs = { approvals: number | null; rendering: number };
export type NeedsTone = "waiting" | "live" | "quiet";
const plural = (n: number, one: string, many: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/**
 * The card's line ("2 approvals waiting · 1 rendering"), coloured by what matters most. While approvals are not
 * counted it says only what is rendering, never "Nothing waiting" (decision 2: the copy says what the code knows).
 */
export function needsLine(needs: Needs): { text: string; tone: NeedsTone } | null {
  const rendering = needs.rendering > 0 ? plural(needs.rendering, "rendering", "rendering") : null;
  if (needs.approvals === null) return rendering ? { text: rendering, tone: "live" } : null;
  const approvals = needs.approvals > 0 ? plural(needs.approvals, "approval waiting", "approvals waiting") : null;
  const text = [approvals, rendering].filter(Boolean).join(" · ");
  if (!text) return { text: "Nothing waiting", tone: "quiet" };
  return { text, tone: approvals ? "waiting" : "live" };
}

/** Takes rendering per project (the jobs tray's rows, counted as its pill counts them: submitting, rendering, confirming). */
export function renderingByProject(jobs: readonly Pick<TrayJob, "draftId" | "stage">[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const job of jobs) if (job.draftId && moving(job)) out.set(job.draftId, (out.get(job.draftId) ?? 0) + 1);
  return out;
}

/** "Edited 2 hr ago", from the list's save time; empty when the list carries none. */
export function editedLine(project: Pick<ProjectSummary, "updatedAt">, now: number): string {
  const at = savedAt(project);
  if (!at) return "";
  const when = ago(at, now);
  return when === "just now" ? "Edited just now" : `Edited ${when} ago`;
}

/** The draft of the workspace's starter production (lib/workbench/starter-draft.ts › starterDraftId). */
export const isStarterDraft = (id: string): boolean => id.startsWith("starter-");

/** How many cards show before "Show all". */
export const FIRST_CARDS = 9;
export function shownProjects<T>(projects: readonly T[], all: boolean): { shown: T[]; hidden: number } {
  if (all || projects.length <= FIRST_CARDS) return { shown: [...projects], hidden: 0 };
  return { shown: projects.slice(0, FIRST_CARDS), hidden: projects.length - FIRST_CARDS };
}

/** The longest request Atomik takes (lib/workbench/rig-agent-plan.ts › PLAN_LIMITS.goal), and the shortest. */
export const GOAL_MAX = 2000;
export const GOAL_MIN = 3;
/**
 * What Start asks Atomik: the brief, with the aspect and length the chips set, as the master asks it
 * ("… · 16:9 · 15 s"). The project holds the whole brief; the request is cut to fit, at a word.
 * Null when there is nothing to ask.
 */
export function goalFor(draft: HomeDraft): string | null {
  const text = draft.text.replace(/\s+/g, " ").trim();
  if (text.length < GOAL_MIN) return null;
  const tail = ` · ${draftAspect(draft)} · ${draftLength(draft)}`;
  const room = GOAL_MAX - tail.length;
  if (text.length <= room) return text + tail;
  const cut = text.slice(0, room + 1);
  const at = cut.lastIndexOf(" ");
  return (at > room / 2 ? cut.slice(0, at) : text.slice(0, room)).trimEnd() + tail;
}

/** When an item started waiting: the clock today ("09:40"), else the day ("4 Oct"). */
export function waitedAt(at: number, now: number): string {
  const when = new Date(at), today = new Date(now);
  const sameDay = when.getFullYear() === today.getFullYear() && when.getMonth() === today.getMonth() && when.getDate() === today.getDate();
  return sameDay
    ? when.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false })
    : when.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

/** A waiting row's line (the master's): "project · where · time", with a plan's step when it is one. */
export function waitingLine(item: Pick<QueueItem, "project" | "where" | "step" | "at">, now: number): string {
  return [item.project.name || "No project", item.where, item.step ? `step ${item.step.n} of ${item.step.of}` : null, waitedAt(item.at, now)].filter(Boolean).join(" · ");
}
