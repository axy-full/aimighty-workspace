/**
 * The Make wall (05-mobile "Make (M4)", the repo's board M4) — as pure data.
 *
 * Make is the UNFILED wall: every generation in the open project that has not
 * been filed to a shot yet. Nothing here is written down. The header line
 * `UNFILED · 9 TAKES · 117 CR` is computed from the project library the Takes
 * page reads (GET /api/workbench/library), the day groups come from each
 * generation's own `createdAt`, and the cost on a card is the ledger's billed
 * figure — never an estimate, and absent while a render has not settled.
 *
 * The money rules are the ones lib/workspace/takes.ts already states, kept
 * identical so the wall and Takes can never disagree: a failed or cancelled
 * render is not billed and says so, a render in flight carries no figure, and
 * a generation paid for by a connected account is not counted in this
 * workspace's credits.
 */

import { engineLabel } from "./engines";

export type MakeKind = "video" | "images" | "audio";

/** Video / Images / Audio, in the order the design's segmented control shows. */
export const MAKE_TABS: readonly { id: MakeKind; label: string }[] = [
  { id: "video", label: "Video" },
  { id: "images", label: "Images" },
  { id: "audio", label: "Audio" },
];

/** Which `Generation.kind` each tab shows. */
export const MAKE_KIND_OF: Record<MakeKind, "video" | "image" | "audio"> = {
  video: "video",
  images: "image",
  audio: "audio",
};

export function isMakeKind(value: unknown): value is MakeKind {
  return value === "video" || value === "images" || value === "audio";
}

/**
 * The wall's tab and the composer's output type are one control, not two —
 * CLAUDE.md rule 5, and the drift it names. The composer's `ComposerType`
 * ("image") is the generation kind; the tab is the word for it ("Images").
 */
export function makeKindOfType(type: "image" | "video" | "audio"): MakeKind {
  return type === "image" ? "images" : type;
}

/**
 * What the wall reads from one generation. A structural type, not an import of
 * lib/jobs, so this module stays pure and the derivations are unit-tested
 * without a browser or a database.
 */
export type MakeSource = {
  id: string;
  kind: string;
  /** Which shot this is a take of. `null` is what "unfiled" means. */
  shotId: string | null;
  model: string;
  prompt: string;
  title: string | null;
  params: Record<string, unknown>;
  durationS: number | null;
  status: string;
  authorName: string | null;
  createdAt: number;
  creditsBilled: number | null;
  /** Present when a connected account paid: not this workspace's credits. */
  providerCreditQuote?: unknown;
  storedUrl: string | null;
};

/** Newest first. Unfiled means no shot; the tab decides the kind. */
export function unfiledTakes<T extends MakeSource>(generations: readonly T[], kind: MakeKind): T[] {
  const want = MAKE_KIND_OF[kind];
  return generations
    .filter((item) => item.shotId === null && item.kind === want)
    .slice()
    .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
}

/* ── The header line ──────────────────────────────────────────────────── */

const SETTLED = new Set(["succeeded", "failed", "cancelled"]);

/**
 * The credits this workspace was billed for a generation, or null while there
 * is no settled figure. Identical to takes.ts: failed and cancelled bill 0,
 * a render in flight has no figure, and a connected account's render is not
 * billed here at all.
 */
export function billedCredits(item: MakeSource): number | null {
  if (item.providerCreditQuote) return null;
  if (!SETTLED.has(item.status)) return null;
  if (item.status !== "succeeded") return 0;
  return item.creditsBilled ?? null;
}

export type MakeTotals = { takes: number; credits: number };

export function makeTotals(items: readonly MakeSource[]): MakeTotals {
  return {
    takes: items.length,
    credits: items.reduce((sum, item) => sum + (billedCredits(item) ?? 0), 0),
  };
}

const n = (value: number) => value.toLocaleString("en-US");

/**
 * `UNFILED · 9 TAKES · 117 CR`, as the segments the wall renders between its
 * dots. Both figures are derived from the library; an empty wall says so
 * rather than showing a zero price it cannot justify.
 */
export function makeHeader(items: readonly MakeSource[]): string[] {
  const totals = makeTotals(items);
  if (!totals.takes) return ["UNFILED", "NO TAKES"];
  return [
    "UNFILED",
    `${n(totals.takes)} ${totals.takes === 1 ? "TAKE" : "TAKES"}`,
    `${n(totals.credits)} CR`,
  ];
}

/* ── One card ─────────────────────────────────────────────────────────── */

const str = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : "");

/**
 * `SEEDANCE 2.5 · 16:9 · 6S` — the engine's own display name and the settings
 * the generation actually carries. The name is `engineLabel(...).long`, which
 * is lib/models `displayModelName`: a model integrated directly reads under
 * its real name and a connected-account model stays neutral, and neither is
 * decided here.
 */
export function specChip(item: MakeSource): string {
  const seconds = item.durationS ?? (typeof item.params.duration === "number" ? item.params.duration : null);
  const parts = [
    engineLabel(item.model).long,
    str(item.params.ratio) || str(item.params.resolution),
    seconds != null && seconds > 0 ? `${Math.round(seconds * 10) / 10}s` : "",
  ].filter(Boolean);
  return parts.join(" · ").toUpperCase();
}

const MINUTE = 60_000;

/**
 * "12 min" inside the hour, then the clock time on the same day, then the
 * date. Written from the generation's own timestamp; `now` is passed in so
 * the wall's ages are testable.
 */
export function takeAge(createdAt: number, now: number): string {
  const ms = Math.max(0, now - createdAt);
  if (ms < MINUTE) return "just now";
  if (ms < 60 * MINUTE) {
    const mins = Math.round(ms / MINUTE);
    return `${mins} min`;
  }
  const made = new Date(createdAt);
  if (sameDay(made, new Date(now)))
    return made.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
  return made.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function sameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export type MakeCard = {
  id: string;
  name: string;
  /** `MOTION 2.5 · 16:9 · 6S`. */
  spec: string;
  prompt: string;
  /** "You · 12 min", or just the age when the render has no recorded author. */
  by: string;
  /** "19 cr", "not billed" on a failure, or null while nothing has settled. */
  cost: string | null;
  /** The ring goes over this card's well. */
  rendering: boolean;
  failed: boolean;
  kind: "image" | "video" | "audio";
  url: string | null;
};

export function makeCard(item: MakeSource, now: number): MakeCard {
  const settled = billedCredits(item);
  const failed = item.status === "failed" || item.status === "cancelled";
  const rendering = !SETTLED.has(item.status);
  const kind = item.kind === "image" || item.kind === "audio" ? item.kind : "video";
  const age = takeAge(item.createdAt, now);
  return {
    id: item.id,
    name: str(item.title) || str(item.prompt).slice(0, 60) || "Untitled take",
    spec: specChip(item),
    prompt: str(item.prompt),
    by: item.authorName ? `${item.authorName} · ${age}` : age,
    cost: failed ? "not billed" : settled === null ? null : `${n(settled)} cr`,
    rendering,
    failed,
    kind,
    url: item.storedUrl,
  };
}

/* ── The day groups ───────────────────────────────────────────────────── */

export type MakeDay = { key: string; day: string; count: string; items: MakeCard[] };

function dayKey(at: number) {
  const date = new Date(at);
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

/** TODAY, YESTERDAY, then the date — the design's own labels, uppercase. */
export function dayLabel(at: number, now: number): string {
  const made = new Date(at);
  const today = new Date(now);
  if (sameDay(made, today)) return "TODAY";
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (sameDay(made, yesterday)) return "YESTERDAY";
  return made.toLocaleDateString("en-US", { month: "short", day: "numeric" }).toUpperCase();
}

/**
 * The wall, grouped by the day each take was made, newest day first and
 * newest take first inside it.
 */
export function makeDays(items: readonly MakeSource[], now: number): MakeDay[] {
  const order: string[] = [];
  const byDay = new Map<string, MakeSource[]>();
  for (const item of items) {
    const key = dayKey(item.createdAt);
    if (!byDay.has(key)) {
      byDay.set(key, []);
      order.push(key);
    }
    byDay.get(key)!.push(item);
  }
  return order.map((key) => {
    const group = byDay.get(key)!;
    return {
      key,
      day: dayLabel(group[0].createdAt, now),
      count: `${n(group.length)} ${group.length === 1 ? "take" : "takes"}`,
      items: group.map((item) => makeCard(item, now)),
    };
  });
}

/* ── The docked composer and its primary ──────────────────────────────── */

/**
 * The composer card's eyebrow: `COMPOSER · MOTION 2.5 · 16:9 · 5S`. Written
 * from the composer's own live state, so it says exactly what would be sent.
 */
export function composerEyebrow(input: {
  model: string | null;
  ratio?: string;
  resolution?: string;
  duration?: number | null;
  seconds?: number | null;
  audio?: boolean;
}): string {
  const parts = [
    "COMPOSER",
    input.model ?? "",
    input.audio ? "" : input.ratio ?? "",
    input.audio
      ? input.seconds != null && input.seconds > 0 ? `${input.seconds}s` : ""
      : input.duration != null && input.duration > 0 ? `${input.duration}s` : input.resolution ?? "",
  ].filter(Boolean);
  return parts.join(" · ").toUpperCase();
}

/**
 * The pinned primary's label on Make: `Render · 19 CR · 5s`. The cost is the
 * live quote and nothing else — with no quote there is no figure, and the
 * action bar shows why it cannot run.
 */
export function renderPrimaryLabel(input: { credits: number | null; seconds: number | null }): { label: string; cost: string | null } {
  const cost = [
    input.credits === null ? null : `${n(input.credits)} cr`,
    input.seconds != null && input.seconds > 0 ? `${input.seconds}s` : null,
  ].filter((part): part is string => Boolean(part));
  return { label: "Render", cost: cost.length ? cost.join(" · ") : null };
}
