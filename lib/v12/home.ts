/**
 * Home in the new interface (redesign plan C2; docs/redesign/inventory.md § 5.9), the parts with no React and no
 * fetch: the wall's tiles and their layout, the boards' kind filters, the Waiting strip's count, and what a picked tile
 * asks Atomik. Every tile and board is the workspace's own (plan decision 4): nothing here is sample data.
 */
import type { Generation } from "@/lib/jobs";
import type { ProjectSummary } from "@/lib/workspace/data";
import { displayModelName } from "@/lib/models";
import { recipePrompt, recreateBlock } from "@/lib/shell/recipe";
import { GOAL_MAX, type BoardKind } from "@/components/graphite/home/home-model";
import { upTo } from "@/lib/shell/price-words";
import { IDLE, LOADING, NO_DOLLAR_PRICE, knownQuote, priceDisplay, type Quote } from "./quote";

/* ── The wall ─────────────────────────────────────────────────────────── */

/** How many tiles the wall shows: the prototype's mosaic. */
export const WALL_TILES = 6;
/** How many finished takes are read for it (a few more than shown, as some are sounds or not stored yet). */
export const WALL_READ = 24;

export type WallTile = {
  id: string;
  /** Particl's own media path for the stored take. */
  url: string;
  media: "image" | "video";
  /** The small line: what it is ("Video · 5 s", "Still · 16:9"). */
  type: string;
  /** The big line: its name, else its words, else its board's. */
  title: string;
  /** Its words as typed, for "Make one like this". */
  prompt: string;
  /** Remix (Make with this take's recipe), or why it cannot be (lib/shell/recipe recreateBlock). */
  remixBlock: string | null;
  /** The take as Make's Recreate reads it. */
  source: Generation;
};

const clean = (text: unknown) => (typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "");
/** Text cut at a word to `max` characters, with an ellipsis; whole when it fits. Never cut by the stylesheet, which cuts mid-word. */
export const cut = (text: string, max: number) => {
  if (text.length <= max) return text;
  const head = text.slice(0, max + 1);
  const at = head.lastIndexOf(" ");
  return `${(at > max / 2 ? head.slice(0, at) : text.slice(0, max)).replace(/[\s,;:·–—-]+$/u, "")}…`;
};

/** A stored still or clip, as a wall tile; null for anything the wall does not show (a sound, a take not stored). */
export function wallTile(g: Generation): WallTile | null {
  if (g.status !== "succeeded" || (g.kind !== "image" && g.kind !== "video") || !g.storedUrl) return null;
  /* Particl's own media route only: never a provider's address. */
  const url = g.storedUrl.startsWith("/api/media/") ? g.storedUrl : `/api/media/${encodeURIComponent(g.id)}`;
  const params = (g.params ?? {}) as Record<string, unknown>;
  const seconds = Number(g.durationS ?? params.duration);
  const ratio = clean(params.ratio);
  const type = g.kind === "video"
    ? ["Video", Number.isFinite(seconds) && seconds > 0 ? `${Math.round(seconds)} s` : null].filter(Boolean).join(" · ")
    : ["Still", ratio || null].filter(Boolean).join(" · ");
  /* The words as the person typed them (`rawPrompt`), not with the platform's rules added for the engine. */
  const prompt = clean(recipePrompt(g));
  const title = cut(clean(g.title) || prompt || clean(g.projectName) || displayModelName(g.model), 40);
  return { id: g.id, url, media: g.kind, type, title, prompt, remixBlock: recreateBlock(g), source: g };
}

/** The newest stored stills and clips, newest first, at most WALL_TILES. */
export function wallTiles(list: readonly Generation[]): WallTile[] {
  const seen = new Set<string>();
  const out: WallTile[] = [];
  for (const g of [...list].sort((a, b) => b.createdAt - a.createdAt)) {
    if (seen.has(g.id)) continue;
    seen.add(g.id);
    const tile = wallTile(g);
    if (tile) out.push(tile);
    if (out.length === WALL_TILES) break;
  }
  return out;
}

/** A tile's place on the 6-column grid ("1 / span 2" style, as CSS grid-column / grid-row take them). */
export type WallCell = { col: string; row: string };

/**
 * Where each tile sits. Six tiles are the prototype's mosaic (a tall film, a wide ad, a tall social clip, two looks and
 * a storyboard). Fewer keep the same four-row height, split evenly, so a new workspace's wall never has holes.
 */
export function wallLayout(n: number): WallCell[] {
  const at = (c: number, cw: number, r: number, rh: number): WallCell => ({ col: `${c} / span ${cw}`, row: `${r} / span ${rh}` });
  switch (Math.max(0, Math.min(WALL_TILES, Math.floor(n)))) {
    case 6: return [at(1, 2, 1, 4), at(3, 2, 1, 2), at(5, 1, 1, 4), at(6, 1, 1, 2), at(3, 2, 3, 2), at(6, 1, 3, 2)];
    case 5: return [at(1, 2, 1, 4), at(3, 2, 1, 2), at(5, 2, 1, 2), at(3, 2, 3, 2), at(5, 2, 3, 2)];
    case 4: return [at(1, 2, 1, 4), at(3, 2, 1, 4), at(5, 2, 1, 2), at(5, 2, 3, 2)];
    case 3: return [at(1, 2, 1, 4), at(3, 2, 1, 4), at(5, 2, 1, 4)];
    case 2: return [at(1, 3, 1, 4), at(4, 3, 1, 4)];
    case 1: return [at(1, 3, 1, 4)];
    default: return [];
  }
}

/** The wall's row height: 100 px, or 118 when the Waiting strip is not there (the prototype's). */
export const wallRow = (waitingShown: boolean): number => (waitingShown ? 100 : 118);

/**
 * What Start asks for a picked tile: what the person added, then the tile's own words. The project's brief holds the
 * same. Cut at a word to Atomik's limit (the aspect and length are added by the start path).
 */
export function pickedBrief(tile: Pick<WallTile, "title" | "prompt">, added: string): string {
  const own = clean(added);
  const like = tile.prompt ? `Make one like “${tile.title}”: ${tile.prompt}` : `Make one like “${tile.title}”.`;
  const text = own ? `${own}\n\n${like}` : like;
  const room = GOAL_MAX - 40;
  return text.length <= room ? text : cut(text, room);
}

/* ── Start's price ───────────────────────────────────────────────────── */

/**
 * Start's price as the quote layer draws it, from the one figure Start approves when pressed (use-home-start
 * `figureFor`): "up to N cr", or for the house workspace, which pays in dollars, that figure's dollars (N × the price
 * of a credit, the same sum the board-start quote makes, lib/v12/quote.ts). One figure, so shown always equals approved.
 */
export function startQuote({ spendOff, figure, thinking, dollars, creditUsd }: {
  spendOff: boolean;
  figure: number | null;
  thinking: { state: string; message?: string };
  dollars: boolean;
  creditUsd: number | null;
}): Quote {
  if (spendOff) return IDLE;
  if (figure != null) {
    if (!dollars) return knownQuote(upTo(figure));
    return creditUsd ? { state: "ready", price: { unit: "usd", usd: figure * creditUsd, upTo: true } } : { state: "error", message: NO_DOLLAR_PRICE };
  }
  if (thinking.state === "loading") return LOADING;
  return { state: "error", message: thinking.state === "error" && thinking.message ? thinking.message : thinking.state === "off" ? "Atomik isn't on for this workspace yet." : "Atomik's thinking can't be priced right now." };
}

/* ── Your boards ──────────────────────────────────────────────────────── */

export type BoardFilter = "all" | BoardKind;
/**
 * The kind filters, in the prototype's words. "Pre-vis" waits for the board kinds P2 adds (nothing marks a board as
 * pre-vis today, so its filter would always be empty).
 */
export const BOARD_FILTERS: readonly { id: BoardFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "studio", label: "Films" },
  { id: "ads", label: "Campaigns" },
  { id: "social", label: "Social" },
];

/** A board's kind as the list carries it; a board from before kinds were kept opens as a film (lib/board/kind.ts). */
export const boardKindIn = (p: Pick<ProjectSummary, "kind">): BoardKind => (p.kind === "ads" || p.kind === "social" ? p.kind : "studio");

export const filterBoards = <T extends Pick<ProjectSummary, "kind">>(list: readonly T[], filter: BoardFilter): T[] =>
  filter === "all" ? [...list] : list.filter((p) => boardKindIn(p) === filter);

/** How many board cards show before "Show all": two rows of six. */
export const FIRST_BOARDS = 12;

/* ── Waiting for you ─────────────────────────────────────────────────── */

/** Items the strip shows inline: two from 1400 px wide, else one (the prototype's). */
export const waitingShown = (wide: boolean): number => (wide ? 2 : 1);

/**
 * How the strip makes its items fit, from the roomiest to the barest: `shown` items inline, each name (and where it is)
 * cut at a word to `budget` characters. The last level drops "where it is" so one item always shows with its action whole.
 * The strip takes the first level whose items fit its width (measured), and "+N more" counts the rest.
 */
export type WaitingLevel = { shown: number; budget: number; where: boolean };
const WAITING_BUDGETS = [60, 40, 28, 20, 14] as const;
export function waitingLevels(max: number): WaitingLevel[] {
  const out: WaitingLevel[] = [];
  for (let shown = Math.max(1, Math.floor(max)); shown >= 1; shown--) for (const budget of WAITING_BUDGETS) out.push({ shown, budget, where: true });
  out.push({ shown: 1, budget: WAITING_BUDGETS[WAITING_BUDGETS.length - 1], where: false });
  return out;
}

/** The word a strip item's name and place read as at a level: the name and "· board · place", each cut at a word. */
export function waitingWords(item: { title: string; where: string }, level: Pick<WaitingLevel, "budget" | "where">): { name: string; where: string } {
  return { name: cut(clean(item.title), level.budget), where: level.where && item.where ? cut(clean(item.where), level.budget) : "" };
}

/**
 * Words that fit a width, cut at a word. `width` measures a string in px; `avail` is the room. Whole when it fits; else
 * the most whole words plus an ellipsis; only a first word wider than the room is cut inside the word.
 */
export function fitWords(text: string, avail: number, width: (text: string) => number): string {
  const full = clean(text);
  if (!full || avail <= 0 || width(full) <= avail) return full;
  const words = full.split(" ");
  for (let n = words.length - 1; n >= 1; n--) {
    const head = `${words.slice(0, n).join(" ").replace(/[\s,;:·–—-]+$/u, "")}…`;
    if (width(head) <= avail) return head;
  }
  let head = words[0];
  while (head.length > 1 && width(`${head}…`) > avail) head = head.slice(0, -1);
  return `${head}…`;
}

/**
 * The words a start button's hover and marker carry for the figure Start approves: what <Price> draws ("up to 14 cr", or
 * the house workspace's dollars), so the marker, the button and the note always say the same unit. Null: nothing priced yet.
 */
export function startWords(quote: Quote, env: { creditUsd: number | null; dollars: (usd: number) => string }): string | null {
  const shown = priceDisplay(quote, undefined, env);
  return shown && shown.state === "ready" ? shown.text : null;
}
