import type { ComposerType } from "@/lib/workspace/composer";
import { resolvePageId, resolveSuite, suiteOfPage } from "@/lib/workspace/pages";
import type { ScreenModule } from "./screens";

/**
 * Make (design/particl-graphite/README.md § 1.1, § 3.2): a panel over any
 * screen, addressed by `make=` on the shell's own URL. `video`, `image` and
 * `audio` are its type; `recent` is its Recent tab; `motion`, `swap` and `upscale` are
 * its quick tools (Motion transfer, Object swap, Upscale); `1` is "the last type".
 * `change` opens it on the last type with the engine list open (the new
 * interface draws that list; today's panel opens on the type). `fill` and
 * `made` are states of the panel, never addresses.
 */
export type MakeTool = "motion" | "swap" | "upscale";
export type MakeTab = ComposerType | "recent" | MakeTool;
export const MAKE_PARAM = "make";
/** `make=change`: Make on the last type, its engine list open (README § 3.2). */
export const MAKE_CHANGE = "change";
const TABS: readonly MakeTab[] = ["video", "image", "audio", "recent", "motion", "swap", "upscale"];

export const isMakeTab = (value: unknown): value is MakeTab => TABS.includes(value as MakeTab);
export const isMakeTool = (value: unknown): value is MakeTool => value === "motion" || value === "swap" || value === "upscale";
/** The composer's type a tab names, or null for Recent and the quick tools. */
export const makeType = (tab: MakeTab | null | undefined): ComposerType | null => (tab && tab !== "recent" && !isMakeTool(tab) ? tab : null);

/** `make=` as the address carries it: a tab, "last" for `make=1` (and `make=change`), or null (closed, or a value Make does not have). */
export function readMake(search: string | URLSearchParams): MakeTab | "last" | null {
  const value = new URLSearchParams(search).get(MAKE_PARAM);
  if (isMakeTab(value)) return value;
  return value === "1" || value === MAKE_CHANGE ? "last" : null;
}

/** Whether the address asks for Make's engine list open (`make=change`). */
export const wantsChange = (search: string | URLSearchParams): boolean => new URLSearchParams(search).get(MAKE_PARAM) === MAKE_CHANGE;

/* The master's word lists (design/particl-graphite/Particl Suites.dc.html › mkType): a still, or a sound. */
const STILL_WORDS = /\b(still|image|photo|poster|frame|key ?art)\b/i;
const SOUND_WORDS = /\b(voice|line|music|sound|narration|score|sfx)\b/i;

/**
 * The type Make infers from the words, while the person has not picked one (README § 0 rule 2, "type inferred"):
 * a still, a sound, else video. Null for no words: the type stays as it is. Never a sound while references are
 * attached, because sound takes none and switching would drop them.
 */
export function inferType(words: string, opts: { references?: number } = {}): ComposerType | null {
  const text = words.trim();
  if (!text) return null;
  if (STILL_WORDS.test(text)) return "image";
  if (SOUND_WORDS.test(text) && !(opts.references ?? 0)) return "audio";
  return "video";
}

/** The note beside the type switch: how Make chose it. None once the person picked the type. */
export function typeNote(words: string, picked: boolean): string | null {
  if (picked) return null;
  return words.trim() ? "from your words" : "inferred from your words";
}

/** Where a result goes: the project's Library, and the board when one is open (README § 3.2). */
export function makeDest(project: string | null | undefined, onBoard: boolean): string {
  return `To ${project?.trim() || "a new project"} · Library${onBoard ? " and the board" : ""}`;
}

/** Recent's chips, as the master draws them (README § 7: the takes wall is Make › Recent). */
export const RECENT_CHIPS = ["All", "Takes", "Unfiled", "Filed"] as const;
export type RecentChip = (typeof RECENT_CHIPS)[number];
/** What Recent reads of a library card: a take or an upload, and the shot a take is filed on. */
type RecentEntry = { take: { kind: "GEN" | "UPLOAD" }; asset: { origin: "generation" | "upload"; value: object } };
const shotOf = (entry: RecentEntry): string | null => {
  if (entry.asset.origin !== "generation") return null;
  const shot = (entry.asset.value as { shotId?: unknown }).shotId;
  return typeof shot === "string" && shot ? shot : null;
};

/**
 * The cards a chip shows, in the Library's order (newest first): All is every take and upload; Takes the
 * generations; Unfiled the takes on no shot; Filed the takes on a shot.
 */
export function recentEntries<T extends RecentEntry>(entries: readonly T[], chip: RecentChip): T[] {
  if (chip === "All") return [...entries];
  return entries.filter((entry) => {
    if (entry.take.kind !== "GEN" || entry.asset.origin !== "generation") return false;
    if (chip === "Takes") return true;
    return chip === "Filed" ? shotOf(entry) !== null : shotOf(entry) === null;
  });
}

/**
 * A result landing (README § 3.2, `make=made`; "Make frames" 9): Make files every take on a new shot node in the project's
 * draft, so a result is on the board as a card already. When the server has accepted a press, Make closes, toasts, and tells
 * the board, which glides to that card, lights it, and opens the Library on the take. The board's side is
 * lib/board/made.ts (`useMadeOnBoard`); it hears this window event, so Make imports nothing of the board.
 */
export const MADE_EVENT = "particl:board-made";
export type Made = { projectId: string; nodeId: string; name: string };

/** What a press that was accepted tells the shell, as one sentence for the toast: "‹name› · 43 cr · rendering". */
export function madeLine(name: string, priceText: string | null, takes = 1): string {
  return [name, priceText, takes > 1 ? `${takes} takes` : null, "rendering"].filter(Boolean).join(" · ");
}

/** Tells a board on screen that a result was made for `projectId`, filed on `nodeId` (no board, no listener: nothing happens). */
export function announceMade(made: Made): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<Made>(MADE_EVENT, { detail: made }));
}

/** The old Gen page's `mode=` (lib/genRoute.ts spells images in the plural). */
const MODE_TYPE: Record<string, ComposerType> = { video: "video", images: "image", image: "image", audio: "audio" };

/**
 * The old Gen page (`?view=gen`, with its `mode=` and `sheet=1`) as the Make
 * panel's address: the same query without them, plus `make=<type>`, so it
 * lands on the page the rest of the query names (Studio when it names none)
 * with Make open over it. Null when the query is not a Gen link.
 */
export function fromGenLink(search: string | URLSearchParams): string | null {
  const q = new URLSearchParams(search);
  if (q.get("view") !== "gen") return null;
  const type = MODE_TYPE[q.get("mode") ?? ""] ?? "video";
  q.delete("view");
  q.delete("mode");
  q.delete("sheet");
  if (!isMakeTab(q.get(MAKE_PARAM))) q.set(MAKE_PARAM, type);
  return q.toString();
}

/**
 * The quick tool an old Viral page link names (README § 1.2): `?suite=subatomik|viral&page=motion|swap[&sp=…]`, the
 * shell's `sp=motion|swap`, and the bare suite, which opened on Motion Transfer. A page wins over `sp`, as it does in
 * the shell. Null for History (still a page) and anything that is not Viral.
 */
export function viralTool(search: string | URLSearchParams): MakeTool | null {
  const q = new URLSearchParams(search);
  const named = resolvePageId(q.get("page"));
  if ((named ? suiteOfPage(named) : resolveSuite(q.get("suite"))) !== "subatomik") return null;
  if (named) return isMakeTool(named) ? named : null;
  const sp = q.get("sp");
  return isMakeTool(sp) ? sp : sp === null ? "motion" : null;
}

/**
 * An old Motion Transfer or Object Swap link as Make's address: the same query without the Viral page
 * (`suite`, `page`, `sp`, `sel`), plus `make=motion|swap`, so it lands on Studio with the tool open over it.
 * Null when the query is not one.
 */
export function fromViralLink(search: string | URLSearchParams): string | null {
  const tool = viralTool(search);
  if (!tool) return null;
  const q = new URLSearchParams(search);
  for (const key of ["suite", "page", "sp", "sel"]) q.delete(key);
  q.set(MAKE_PARAM, tool);
  return q.toString();
}

/** Either old address (Gen, or a Viral quick tool) as Make's, or null. */
export const fromMakeLink = (search: string | URLSearchParams): string | null => fromGenLink(search) ?? fromViralLink(search);

/**
 * Make's entry in the screen registry (lib/shell/screens.ts). Make is a panel over any screen and has been live
 * since D0, so it is landed from the start; its addresses (`make=…`, and the old Gen and Viral tool links, see
 * `fromMakeLink`) are read in the spelling step, so it adds no rows. Stream 6 owns this export from here.
 *
 * `params` stays empty on purpose: `make` is one of the shell's own params (SHELL_PARAMS), which it reads and writes
 * itself. Listed here too, the shell would also hold the address's raw `make` as a screen param, and write it back
 * over the type a pick or Auto had just moved to (`make=1` would stay `make=1`).
 */
export const MAKE_SCREEN: ScreenModule = { id: "make", landed: true, params: [], rows: [], fallback: [] };
