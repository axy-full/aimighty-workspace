import type { ComposerType } from "@/lib/workspace/composer";
import { resolvePageId, resolveSuite, suiteOfPage } from "@/lib/workspace/pages";

/**
 * Make (design/particl-graphite/README.md § 1.1, § 3.2): a panel over any
 * screen, addressed by `make=` on the shell's own URL. `video`, `image` and
 * `audio` are its type; `recent` is its Recent tab; `motion` and `swap` are
 * its quick tools (Motion transfer, Object swap); `1` is "the last type".
 * `change`, `fill` and `made` are states of the panel, never addresses.
 */
export type MakeTool = "motion" | "swap";
export type MakeTab = ComposerType | "recent" | MakeTool;
export const MAKE_PARAM = "make";
const TABS: readonly MakeTab[] = ["video", "image", "audio", "recent", "motion", "swap"];

export const isMakeTab = (value: unknown): value is MakeTab => TABS.includes(value as MakeTab);
export const isMakeTool = (value: unknown): value is MakeTool => value === "motion" || value === "swap";
/** The composer's type a tab names, or null for Recent and the quick tools. */
export const makeType = (tab: MakeTab | null | undefined): ComposerType | null => (tab && tab !== "recent" && !isMakeTool(tab) ? tab : null);

/** `make=` as the address carries it: a tab, "last" for `make=1`, or null (closed, or a value Make does not have). */
export function readMake(search: string | URLSearchParams): MakeTab | "last" | null {
  const value = new URLSearchParams(search).get(MAKE_PARAM);
  if (isMakeTab(value)) return value;
  return value === "1" ? "last" : null;
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
