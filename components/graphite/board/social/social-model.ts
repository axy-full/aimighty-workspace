import type { BoardCard, BoardSource, GroupData } from "@/lib/board/types";
import { SOURCE_SECONDS, viralMedia, viralTakes, type ViralMedia } from "@/lib/shell/viral";

/*
 * The Social board's cards, from the project's Library alone (README § 3.3, "Ads and Social frames" S1 and S2). What exists
 * today: the source video, and Motion transfer and Object swap, which are Make's quick tools (a source video of 4 to 30 s).
 * Clips, hook review, narrated video and posts have no engine here yet: each reads "Not in Particl yet", with no price and no
 * sample result. Pure and cheap.
 */
export const SOCIAL_GROUP = { source: "group:social-source", clips: "group:social-clips", hooks: "group:social-hooks", effects: "group:social-effects", posts: "group:social-posts" } as const;

export const CARD_W = 308;
export const SIZES = { source: { w: CARD_W, h: 336 }, effects: { w: CARD_W, h: 290 }, unavailable: { w: CARD_W, h: 92 } } as const;

export type SourceData = {
  id: string; name: string; url: string | null; origin: "upload" | "generation"; seconds: number | null; media: ViralMedia;
  /** The quick tools take one source of 4 to 30 s. */
  fits: boolean;
};
export type EffectsData = { sources: number };
export type UnavailableData = { title: string; line: string };

export const clock = (seconds: number | null): string => (seconds == null ? "" : `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, "0")}`);
export const fitsQuickTool = (seconds: number | null): boolean => seconds != null && seconds >= SOURCE_SECONDS.min && seconds <= SOURCE_SECONDS.max;

/** The project's videos, newest first, that can be a source: its uploads and Particl's own takes, not the Motion transfer and Object swap results. */
export function sources(library: BoardSource["library"]): SourceData[] {
  const results = new Set(viralTakes(library).map((t) => t.id));
  return library.flatMap((entry): SourceData[] => {
    if (entry.media !== "video" || !entry.url) return [];
    if (entry.asset.origin === "generation" && results.has(entry.asset.value.id)) return [];
    const media = viralMedia(entry);
    return media ? [{ id: entry.take.id, name: entry.take.name, url: entry.url, origin: entry.asset.origin, seconds: media.seconds, media, fits: fitsQuickTool(media.seconds) }] : [];
  });
}

const group = (id: string, region: BoardCard["region"], title: string, meta: string, columns: number, order: number): BoardCard<GroupData> => ({ id, kind: "group", region, order, state: "empty", data: { title, meta, columns } });
const off = (id: string, region: BoardCard["region"], group: string, order: number, title: string): BoardCard => ({
  id, kind: "social-unavailable", region, order, group, state: "empty", summary: "Not in Particl yet", data: { title, line: "Not in Particl yet" } satisfies UnavailableData,
});

export function socialCards(src: BoardSource): BoardCard[] {
  const list = sources(src.library);
  if (!list.length) return [];
  const cards: BoardCard[] = [
    group(SOCIAL_GROUP.source, "source", "Source", list.length === 1 ? "a long video in" : `${list.length} videos`, 3, 0),
    ...list.map((s, i): BoardCard => ({ id: `social:source:${s.id}`, kind: "social-source", region: "source", order: 1 + i, group: SOCIAL_GROUP.source, state: "done", summary: `${s.name}${s.seconds ? ` · ${clock(s.seconds)}` : ""}`, data: s })),
    group(SOCIAL_GROUP.clips, "clips", "Clips", "found clips, with a hook and captions", 1, 10),
    off("social:clips", "clips", SOCIAL_GROUP.clips, 11, "Find clips"),
    group(SOCIAL_GROUP.hooks, "hooks", "Hook review", "scored with reasons", 1, 20),
    off("social:hooks", "hooks", SOCIAL_GROUP.hooks, 21, "Hook review"),
    group(SOCIAL_GROUP.effects, "effects", "Effects", "quick tools, in Make", 1, 22),
    { id: "social:effects", kind: "social-effects", region: "effects", order: 23, group: SOCIAL_GROUP.effects, state: "empty", summary: "Motion transfer · Object swap", data: { sources: list.filter((s) => s.fits).length } satisfies EffectsData },
    group(SOCIAL_GROUP.posts, "posts", "Posts", "every post is approved by a person", 2, 30),
    off("social:narrated", "posts", SOCIAL_GROUP.posts, 31, "Narrated video"),
    off("social:posts", "posts", SOCIAL_GROUP.posts, 32, "Posts"),
  ];
  return cards;
}
