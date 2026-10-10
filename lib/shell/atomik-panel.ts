import { parseMemoryCommand } from "@/lib/atomikMemoryText";
import { BATCH_UNDER_DEFAULT, cleanUnder } from "@/lib/control-room/queue";
import { priceWords, upTo, FREE, type PriceValue } from "./price-words";

/**
 * Atomik in the new interface (design/particl-graphite/README.md § 1, § 3.4):
 * what a line typed to Atomik is, in ⌘K, in Atomik's panel and in the phone's
 * Atomik sheet, and what its button says. Pure, apart from the panel's letterbox
 * and ⌘K's first query, which only touch `window` when called.
 *
 * A line is one of:
 *  - a command: "go to cast", "make shot 2 warmer", "approve everything under
 *    10 cr", "remember …" / "forget …". Commands never spend: they navigate,
 *    fill Make (the person presses Make), list approvals (the person confirms),
 *    or keep or archive a memory line (a person confirms);
 *  - a question about Particl ("how do I …?"), answered free from
 *    lib/shell/atomik-how.ts;
 *  - a request, which is a planning turn in the open project's Atomik thread,
 *    at the turn's own quote ("Ask · up to N cr"). The price on the button is
 *    the approval: it is sent as the turn's ceiling (maxCredits).
 */

export type AtomikIntent =
  | { kind: "empty" }
  | { kind: "how"; text: string }
  | { kind: "approve"; text: string; under: number }
  | { kind: "make"; text: string; words: string }
  | { kind: "go"; text: string; place: string }
  | { kind: "memory"; text: string; verb: "remember" | "forget"; subject: string }
  | { kind: "ask"; text: string };

/** A question about Particl, as the master reads one: it opens with a question word, or ends with "?". */
export function isHowQuestion(text: string): boolean {
  return /^(how|what|where|why|can i|does|is there|which)\b|\?\s*$/i.test(text.trim());
}

/** What a line typed to Atomik is (see above). Commands are matched before questions, and questions before requests. */
export function atomikIntent(raw: string): AtomikIntent {
  const text = raw.trim();
  if (!text) return { kind: "empty" };
  const lower = text.toLowerCase();
  if (/^approve\b/.test(lower)) {
    const under = /under\s+(\d+)/.exec(lower);
    return { kind: "approve", text, under: under ? cleanUnder(under[1]) : BATCH_UNDER_DEFAULT };
  }
  if (/^make\s+\S/.test(lower)) return { kind: "make", text, words: text.slice(4).trim() };
  if (/^go\s+to\s+\S/.test(lower)) return { kind: "go", text, place: lower.replace(/^go\s+to\s+/, "").replace(/^the\s+/, "").replace(/[.?!]+$/, "").trim() };
  const memory = parseMemoryCommand(text);
  if (memory) return { kind: "memory", text, verb: memory.verb, subject: memory.subject };
  if (isHowQuestion(text)) return { kind: "how", text };
  return { kind: "ask", text };
}

/** Lines that cost nothing to send: everything but a request. */
export const isFreeIntent = (intent: AtomikIntent) => intent.kind !== "ask";

/** A request's quote as the composer holds it: the figure the server quoted, or why there is none. */
export type AskQuote = { credits: number | null; loading: boolean; error: string | null };

/**
 * The Ask button: "Ask · free" for a free line (or an empty box), "Ask · up to N cr" for a request with
 * its quote, and a disabled "Ask" with the reason while a request has no figure. Never a design figure.
 */
export function askButton(intent: AtomikIntent, quote: AskQuote): { label: string; price: PriceValue | null; disabled: boolean; reason: string | null } {
  if (intent.kind !== "ask") return { label: "Ask · free", price: FREE, disabled: false, reason: null };
  const price = upTo(quote.credits);
  const words = priceWords(price);
  if (price && words) return { label: `Ask · ${words}`, price, disabled: false, reason: null };
  if (quote.loading) return { label: "Ask", price: null, disabled: true, reason: "Pricing Atomik's thinking…" };
  return { label: "Ask", price: null, disabled: true, reason: quote.error ?? "Atomik's thinking has no price right now, so nothing can be sent." };
}

/** The line under a request in ⌘K and on the phone: what thinking may cost, or that how-to answers are free. */
export function thinkingLine(intent: AtomikIntent, credits: number | null): string {
  if (intent.kind !== "ask") return "A question about Particl · answered free";
  const words = priceWords(upTo(credits));
  return words
    ? `Atomik’s thinking may cost ${words} · it plans and prices first; nothing is spent without your approval`
    : "Atomik plans and prices first; nothing is spent without your approval";
}

/* ── The panel's letterbox (the address, `&atomik=1` and `&atomik=how`, is the shell's: shell.openAtomik) ───────── */

/** Said on the window when words are handed to the panel, for one that is already open. */
export const ATOMIK_PANEL_EVENT = "particl:atomik-panel";

/** Words handed to the panel before it is on screen: they land in its box as soon as it mounts. `send`: ask them at once. */
type Handed = { text: string; send: boolean; approved: number | null };
let handed: Handed | null = null;
/** The words handed to the panel, once: the panel takes them when it mounts or when it is told. */
export function takeHanded(): Handed | null {
  const words = handed;
  handed = null;
  return words;
}

/**
 * Hands words to Atomik's panel: from ⌘K, Settings, a card. The caller then opens the panel (shell.openAtomik), or
 * one already open takes them at once. With `send`, a free line is answered at once. A request is sent at once only
 * with `approved`, the figure on the button the person pressed (⌘K's "Ask · up to N cr"), and only if the panel's own
 * quote is no higher; otherwise it waits in the box at its new price.
 */
export function handAtomik(text: string, opts: { send?: boolean; approved?: number | null } = {}) {
  handed = { text, send: Boolean(opts.send), approved: opts.approved ?? null };
  if (typeof window !== "undefined") window.dispatchEvent(new Event(ATOMIK_PANEL_EVENT));
}

/* ── ⌘K's first query (`&palette=1&q=…`, or handed by an offer) ───────────────────────────── */

let paletteQuery: string | null = null;
let addressRead: { words: string; at: number } | null = null;
/** Words ⌘K opens with next time it opens (Atomik's "Open ⌘K" offer). */
export function handPaletteQuery(query: string) {
  paletteQuery = query;
}
/**
 * What ⌘K opens with: words handed to it, else the address's `q` (a link such as `?find=1&q=go%20to%20cast`). Once;
 * the caller then drops `q` from the address through the shell (shell.setScreenParams), so a reload does not type it again.
 */
export function takePaletteQuery(): string {
  if (paletteQuery !== null) {
    const words = paletteQuery;
    paletteQuery = null;
    return words;
  }
  /* The address is read once a page load: Next may write its own copy of the address back, `q` and all. */
  if (typeof window === "undefined") return "";
  /* (A dev render may ask twice at once; the same answer.) */
  if (addressRead) return Date.now() - addressRead.at < 1500 ? addressRead.words : "";
  const words = new URLSearchParams(window.location.search).get("q");
  addressRead = { words: words === null ? "" : words.slice(0, 500), at: Date.now() };
  return addressRead.words;
}

/* ── Board places ("go to cast") ─────────────────────────────────────────────────────────────── */

/** The place a "go to" names, among a board's rail entries (by id or label, case-insensitive), or null. */
export function matchPlace<E extends { id: string; label: string }>(place: string, rail: readonly E[]): E | null {
  const want = place.trim().toLowerCase();
  if (!want) return null;
  return rail.find((e) => e.id === want || e.label.toLowerCase() === want)
    ?? rail.find((e) => e.label.toLowerCase().startsWith(want) || want.startsWith(e.label.toLowerCase()))
    ?? null;
}
