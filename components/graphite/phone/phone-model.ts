/**
 * The phone (design/particl-graphite/README.md § 3.6, "Phone frames.dc.html"): the parts with no React and
 * no fetch. Which screen an address opens, the order of "Needs you", the review queue, what a swipe means,
 * and the judgements an offline phone keeps until it is back.
 *
 * Every figure the phone shows is the server's (a take's settled credits, a queue item's price); nothing
 * here invents one or words a price by hand (lib/shell/price-words.ts does).
 */
import type { LibraryEntry } from "@/lib/workspace/library";
import type { ReviewState } from "@/lib/workspace/takes";

/* ── Addresses ─────────────────────────────────────────────────────────── */

const ID = /^[A-Za-z0-9_-]{1,100}$/;

/** The design's phone screens (README § 1.1). */
export const PHONE_SCREENS = ["home", "plan", "review", "fix", "record", "make", "atomik", "states", "consent"] as const;
export type PhoneScreen = (typeof PHONE_SCREENS)[number];

/** The URL params the phone owns (the shell keeps them, with the switch on only). */
export const PHONE_PARAMS = ["screen", "device", "from", "run", "take", "cast"] as const;

/**
 * The screens this build draws: the design's eight, and the consent step (Gaps A). An address for one this build does not draw opens Home,
 * never an empty screen.
 */
export const DRAWN_SCREENS: ReadonlySet<PhoneScreen> = new Set<PhoneScreen>(["home", "plan", "review", "fix", "record", "make", "atomik", "states", "consent"]);

export const isPhoneScreen = (value: unknown): value is PhoneScreen => PHONE_SCREENS.includes(value as PhoneScreen);

export type PhoneRoute = {
  /** The screen asked for, as the address names it (or as an old link on a phone maps it). */
  asked: PhoneScreen;
  /** The screen drawn: what was asked, or Home while that screen is not in this build. */
  screen: PhoneScreen;
  /** `device=phone`: the phone's screens in a centred 390 px frame at any width (DECISIONS 11). */
  framed: boolean;
  /** `from=notification`: the screen was opened from a push. */
  fromNotification: boolean;
  /** The take a review opens on (`take=`, a generation id). */
  take: string | null;
  /** The Atomik run a plan opens on (`run=`). */
  run: string | null;
  /** The cast member the consent step records for (`cast=`, the Cast card's id). */
  cast: string | null;
  /**
   * The address is one of the phone's own screens. Otherwise (Settings, an old page) the shell's page for it
   * renders under the phone's header, with a back to Home (DECISIONS 11).
   */
  own: boolean;
  /**
   * The address is a control-room page the phone has no screen for (Activity, Memory, Skills). Until after the
   * demo it opens a plain "Open this on a larger screen" page, never a broken layout or Home with no word.
   */
  larger: LargerPage | null;
};

/** The control room's pages with no phone screen yet. */
export type LargerPage = "activity" | "memory" | "skills";
export const LARGER_TITLES: Record<LargerPage, string> = { activity: "Activity", memory: "Memory", skills: "Skills" };

/**
 * Activity (`page=runs`), Skills (`page=saved-skills`) and Memory (`page=memory`) are the control room's pages; Memory and
 * Skills also live under Agent's backing page (`page=agent&sp=memory|saved-skills`), where the shell writes them.
 */
export function largerPage(q: URLSearchParams): LargerPage | null {
  if (q.get("suite") !== "atomik" || q.get("view") || q.has("screen")) return null;
  const page = q.get("page"), sp = q.get("sp");
  const which = page === "agent" ? sp : page;
  return which === "runs" ? "activity" : which === "memory" ? "memory" : which === "saved-skills" ? "skills" : null;
}

/** The Studio's old stages: each is a region of the board (lib/board/routes.ts), and on a phone the board is its project's Record. */
const BOARD_PAGES: ReadonlySet<string> = new Set(["rig", "brief", "boards", "cast", "takes", "astra", "edit", "deliver"]);
const isOverview = (q: URLSearchParams) => q.get("suite") === "particl" && q.get("page") === "brief" && (q.get("sp") === "stages" || q.get("sp") === "home");
/* `view=home` is Home whatever else the shell wrote beside it: it adds `suite=particl&page=brief` (the default page) to every address it lands, and those two alone name the board's Record. */
const isBoard = (q: URLSearchParams) => q.get("view") !== "home" && (q.get("view") === "board" || (q.get("suite") === "particl" && BOARD_PAGES.has(q.get("page") ?? "") && !isOverview(q)));

/** Pages a phone answers with its own screens: Home, the board (its Record) and the control room's Approvals (Home). */
function ownAddress(q: URLSearchParams): boolean {
  if (q.has("screen") || q.get("make") || q.get("atomik")) return true;
  const view = q.get("view");
  if (view === "home" || view === "board") return true;
  if (view) return false;
  const suite = q.get("suite"), page = q.get("page");
  if (!suite && !page) return true;
  /* Today's Studio overview and the old phone Home are what Home replaces (components/graphite/home/routes.ts rows). */
  if (isOverview(q) || isBoard(q)) return true;
  return suite === "atomik" && (page === "approvals" || q.get("sp") === "approvals");
}

/**
 * The screen an address opens on a phone (DECISIONS 11):
 *  - `screen=` names it;
 *  - `make=` is Make and `atomik=` is Atomik, over the page;
 *  - the board is its project's Record;
 *  - the control room's Approvals is Home ("Needs you" is the same queue);
 *  - anything else opens Home.
 */
export function readPhone(search: string | URLSearchParams): PhoneRoute {
  const q = new URLSearchParams(search);
  const named = q.get("screen");
  const asked: PhoneScreen = isPhoneScreen(named) ? named
    : q.get("make") ? "make"
    : q.get("atomik") ? "atomik"
    : isBoard(q) ? "record"
    : "home";
  const take = q.get("take");
  return {
    asked,
    screen: DRAWN_SCREENS.has(asked) ? asked : "home",
    framed: q.get("device") === "phone",
    fromNotification: q.get("from") === "notification",
    take: take && ID.test(take) ? take : null,
    run: q.get("run") && ID.test(q.get("run")!) ? q.get("run") : null,
    cast: q.get("cast") && /^[A-Za-z0-9_.:-]{1,160}$/.test(q.get("cast")!) ? q.get("cast") : null,
    own: ownAddress(q),
    larger: largerPage(q),
  };
}

/**
 * The search with the phone's own params changed and every other param kept. `null` removes a param;
 * Home drops `screen` (it is the default), and leaving a screen drops what belonged to it.
 */
const PLACE_PARAMS = ["view", "suite", "page", "sp", "kind", "region", "list", "drawer", "frame", "start", "review", "make", "atomik"] as const;
export function phoneSearch(current: string, patch: Partial<Record<(typeof PHONE_PARAMS)[number], string | null>>): string {
  const q = new URLSearchParams(current);
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === undefined || (key === "screen" && value === "home")) q.delete(key);
    else q.set(key, value);
  }
  if (patch.screen !== undefined) {
    /* Moving to one of the phone's screens leaves the address it came in on (the board's, an old stage's). */
    for (const key of PLACE_PARAMS) q.delete(key);
    if (patch.screen !== "review" && patch.screen !== "fix" && patch.take === undefined) q.delete("take");
    if (patch.from === undefined) q.delete("from");
    if (patch.screen !== "plan" && patch.run === undefined) q.delete("run");
    if (patch.screen !== "consent" && patch.cast === undefined) q.delete("cast");
  }
  const text = q.toString();
  return text ? `?${text}` : "";
}

/* ── Review ────────────────────────────────────────────────────────────── */

/** A finished picture or video nobody has judged yet (or one picked for a decision). */
export function awaitsReview(entry: LibraryEntry): boolean {
  if (entry.asset.origin !== "generation") return false;
  if (entry.take.status !== "review" && entry.take.status !== "picked") return false;
  return Boolean(entry.url) && (entry.media === "image" || entry.media === "video");
}

/** What waits to be judged in the project, oldest first: the earliest shot is judged first (DECISIONS 20). */
export function reviewQueue(entries: readonly LibraryEntry[]): LibraryEntry[] {
  return entries.filter(awaitsReview).sort((a, b) => a.take.createdAt - b.take.createdAt || a.take.id.localeCompare(b.take.id));
}

const generationOf = (entry: LibraryEntry) => (entry.asset.origin === "generation" ? entry.asset.value : null);

/** The takes of the same shot that can be shown (v1, v2…), in version order; just this one when it is on no shot. */
export function versionsOf(entry: LibraryEntry, entries: readonly LibraryEntry[]): LibraryEntry[] {
  const shot = generationOf(entry)?.shotId ?? null;
  if (!shot) return [entry];
  const same = entries.filter((e) => generationOf(e)?.shotId === shot && Boolean(e.url) && (e.media === "image" || e.media === "video"));
  const list = same.some((e) => e.take.id === entry.take.id) ? same : [...same, entry];
  return [...list].sort((a, b) => (generationOf(a)?.version ?? 0) - (generationOf(b)?.version ?? 0) || a.take.createdAt - b.take.createdAt);
}

/** "Shot 2": a shot code's number said in words, never the code itself (DECISIONS 39: no SH-style ids in the UI). Null when it has none. */
export function shotWords(code: string | null | undefined): string | null {
  const n = /^SH0*(\d+)$/i.exec(code ?? "")?.[1];
  return n ? `Shot ${n}` : null;
}

/** "Shot 2 · v2": the shot and the version, as the review title reads (CHANGES 5); the take's own name off a shot. */
export function takeTitle(entry: LibraryEntry): string {
  const g = generationOf(entry);
  const shot = shotWords(g?.shotCode);
  return shot ? `${shot} · v${g?.version ?? 1}` : entry.take.name;
}

const seconds = (n: number) => `${Number.isInteger(n) ? n : Math.round(n * 10) / 10} s`;

/** The badge over the picture: its frame and length ("16:9 · 5 s"), or null when the take says neither. */
export function takeSpec(entry: LibraryEntry): string | null {
  const g = generationOf(entry);
  if (!g) return null;
  const ratio = typeof g.params.ratio === "string" ? g.params.ratio : typeof g.params.aspect === "string" ? g.params.aspect : null;
  const length = g.kind === "video" ? g.durationS ?? (typeof g.params.duration === "number" ? g.params.duration : null) : null;
  const parts = [ratio, length != null && length > 0 ? seconds(length) : null].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

/** The judgements a swipe can make, in the review trail's words (DECISIONS 11: left is "changes", sent back and kept). */
export type Judgement = Extract<ReviewState, "approved" | "changes">;

/** How far a drag must go sideways to judge, in CSS pixels (the master's 60). */
export const SWIPE_MIN = 60;

/**
 * What a drag means: right approves, left sends back, and anything short, or more up and down than
 * across (scrolling, a tap), means nothing. Swiping only judges; it never spends.
 */
export function swipeVerdict(dx: number, dy: number, min = SWIPE_MIN): Judgement | null {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null;
  if (Math.abs(dx) < min || Math.abs(dx) <= Math.abs(dy) * 1.2) return null;
  return dx > 0 ? "approved" : "changes";
}

/** The toast after a judgement: what happened and that nothing was spent (the master's words). */
export function judgedLine(title: string, verdict: Judgement, queued: boolean): string {
  /* "Reject" is the review trail's "changes" mark: the take is kept, and nothing more is spent on it. */
  const what = verdict === "approved" ? "approved" : "rejected";
  return queued ? `${title} ${what} · sent when you're back online` : `${title} ${what} · nothing spent`;
}

/* ── Offline judgements ────────────────────────────────────────────────── */

/**
 * A judgement made with no connection (README § 3.6 states: judging queues; spending waits). It is sent,
 * through the same route, when the phone is back online; a later judgement of the same take replaces it.
 */
export type QueuedJudgement = { projectId: string; generationId: string; state: ReviewState; at: number };

const REVIEW_STATES: readonly ReviewState[] = ["", "picked", "approved", "changes"];

/** The queue as stored: only well-formed rows survive a read, at most 200, oldest first. */
export function readQueued(raw: unknown): QueuedJudgement[] {
  if (!Array.isArray(raw)) return [];
  const out: QueuedJudgement[] = [];
  for (const row of raw) {
    const r = row as Partial<QueuedJudgement> | null;
    if (!r || typeof r.projectId !== "string" || !ID.test(r.projectId) || typeof r.generationId !== "string" || !ID.test(r.generationId)) continue;
    if (!REVIEW_STATES.includes(r.state as ReviewState) || typeof r.at !== "number" || !Number.isFinite(r.at)) continue;
    out.push({ projectId: r.projectId, generationId: r.generationId, state: r.state as ReviewState, at: r.at });
  }
  return out.sort((a, b) => a.at - b.at).slice(-200);
}

/** The queue with one more judgement: the newest word on a take is the one that is sent. */
export function queueJudgement(list: readonly QueuedJudgement[], next: QueuedJudgement): QueuedJudgement[] {
  return [...list.filter((j) => j.generationId !== next.generationId), next];
}

/* ── Words ─────────────────────────────────────────────────────────────── */

export const plural = (n: number, one: string, many: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** "3 takes to review". */
export const reviewCountLine = (n: number) => plural(n, "take to review", "takes to review");
/** "5 items". */
export const itemsLine = (n: number) => plural(n, "item", "items");
