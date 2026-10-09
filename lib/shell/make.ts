import type { ComposerType } from "@/lib/workspace/composer";

/**
 * Make (design/particl-graphite/README.md § 1.1, § 3.2): a panel over any
 * screen, addressed by `make=` on the shell's own URL. `video`, `image` and
 * `audio` are its type; `recent` is its Recent tab; `1` is "the last type".
 * `change`, `fill` and `made` are states of the panel, never addresses.
 */
export type MakeTab = ComposerType | "recent";
export const MAKE_PARAM = "make";
const TABS: readonly MakeTab[] = ["video", "image", "audio", "recent"];

export const isMakeTab = (value: unknown): value is MakeTab => TABS.includes(value as MakeTab);

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
