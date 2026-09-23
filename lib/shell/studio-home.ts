/**
 * The phone's Studio home (Particl Mobile.dc.html › STUDIO HOME): the eight
 * stages as cards with a live line each, the next shot to generate, and the
 * recent takes. Pure: every figure comes from the project and the library,
 * never from sample data.
 */
import type { Project } from "@/lib/workbench/studio";
import type { LibraryEntry } from "@/lib/workspace/library";
import { shellSuite, type ShellPage } from "./ia";

export type StageStatus = "done" | "progress" | "ready" | "waiting";
export type StageCard = { id: string; n: string; label: string; meta: string; status: StageStatus };

const words = (text: string | undefined) => (text ?? "").trim().split(/\s+/).filter(Boolean).length;
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** The studio pages that have a card: every page of the strip, never the home itself. */
export function studioStages(): ShellPage[] {
  return shellSuite("studio").pages.filter((p) => !p.phoneOnly);
}

const COUNT_WORDS: Record<number, string> = { 8: "eight", 9: "nine", 10: "ten", 11: "eleven" };

export function stageCards(project: Project | null, items: readonly LibraryEntry[]): StageCard[] {
  const takes = items.filter((e) => e.take.kind === "GEN").length;
  const shots = project?.shots.length ?? 0;
  const rendered = project?.shots.filter((s) => Boolean(s.assetId)).length ?? 0;
  const assets = project?.assets ?? [];
  const frames = assets.filter((a) => /board|frame/i.test(String(a.category ?? ""))).length;
  const cast = assets.filter((a) => a.category === "Character").length;
  const elements = assets.filter((a) => a.category === "Element").length;
  const clips = project?.audioClips?.length ?? 0;
  const brief = words(project?.brief) + words(project?.script);
  const beatScenes = project?.production?.beats?.scenes.length ?? 0;
  const beatShots = project?.production?.beats?.scenes.reduce((n, s) => n + s.shots.length, 0) ?? 0;
  const line: Record<string, [string, StageStatus]> = {
    brief: brief ? [`${plural(brief, "word")}${project?.script ? " · script" : ""}`, "done"] : ["empty", "ready"],
    beats: beatShots ? [`${plural(beatScenes, "scene")} · ${plural(beatShots, "shot")}`, "done"] : ["no beats yet", "ready"],
    boards: frames ? [plural(frames, "frame"), "done"] : ["no frames yet", "ready"],
    cast: cast || elements ? [`${plural(cast, "identity", "identities")} · ${plural(elements, "element")}`, "done"] : ["no identity yet", "ready"],
    astra: project?.astraBlender ? ["scene set", "done"] : ["block on desktop", "ready"],
    rig: shots ? [`${plural(shots, "shot")} · ${rendered} rendered`, rendered >= shots ? "done" : "progress"] : ["no shots yet", "ready"],
    takes: takes ? [plural(takes, "take"), "done"] : ["nothing rendered yet", "ready"],
    edit: shots || clips ? [`${plural(shots, "shot")} · ${plural(clips, "clip")}`, "done"] : ["empty cut", "ready"],
    deliver: [project ? `${project.aspect} · ${project.fps} fps` : "no spec", "ready"],
  };
  return studioStages().map((p) => {
    const [meta, status] = line[p.id] ?? ["", "ready"];
    return { id: p.id, n: p.n, label: p.label, meta, status };
  });
}

/** GLASS_SPEC §3 › Home: one tile per suite, its colour, its line (verbatim) and a live fact in mono. */
export type SuiteTile = { id: "studio" | "gen" | "business" | "viral" | "atomik" | "crew"; label: string; color: string; line: string; fact: string };
export type HomeFacts = {
  /** Generations in flight (the running pill) and the default video engine's name. */
  rendering: number; videoEngine: string;
  /** Business › Ads defaults: the mode's label and the duration. */
  adMode: string; adSeconds: number;
  /** Viral defaults. */
  viralResolution: string;
  /** Plans waiting for the owner's word. */
  awaiting: number;
  /** Crew seats in this project; null until the roster answers. */
  seats: number | null;
};

export function suiteTiles(cards: readonly StageCard[], facts: HomeFacts): SuiteTile[] {
  const done = cards.filter((c) => c.status === "done").length;
  return [
    /* The prototype said "eight stages"; the owner's Production brief (23 September) sets the count, so it is read from the strip. */
    { id: "studio", label: "Studio", color: "#0A84FF", line: `Brief to delivery, ${COUNT_WORDS[cards.length] ?? cards.length} stages.`, fact: `${done} of ${cards.length} done` },
    { id: "gen", label: "Gen", color: "#BF5AF2", line: "Video, images, audio, 3D — one composer.", fact: facts.rendering ? `${facts.rendering} rendering` : `${facts.videoEngine} ready` },
    { id: "business", label: "Business", color: "#FF9F0A", line: "Marketing Studio: product, presenter, ad.", fact: `${facts.adMode} · ${facts.adSeconds} s · quoted in Ads` },
    { id: "viral", label: "Viral", color: "#FF453A", line: "Genjutsu: motion transfer, object swap.", fact: `${facts.viralResolution} · quoted on the source` },
    { id: "atomik", label: "Atomik", color: "#30D158", line: "Plans, prices, waits for your word.", fact: `${facts.awaiting} awaiting approval` },
    { id: "crew", label: "Crew", color: "#BF5AF2", line: "One Grok agent per department.", fact: facts.seats == null ? "seats loading" : `${facts.seats} ${facts.seats === 1 ? "seat" : "seats"}` },
  ];
}

/** The Assets row under the tiles: `n in <project>`. */
export function assetsRowLabel(items: readonly LibraryEntry[], projectName: string | null): string {
  return `${items.length.toLocaleString("en-US")} in ${projectName ?? "this project"}`;
}

/** The first shot without a render, for the *Up next* card; null when every shot has one (or there are none). */
export function upNext(project: Project | null): { id: string; index: number; name: string } | null {
  if (!project) return null;
  const index = project.shots.findIndex((s) => !s.assetId);
  if (index < 0) return null;
  const shot = project.shots[index];
  return { id: shot.id, index: index + 1, name: shot.name || `Shot ${String(index + 1).padStart(2, "0")}` };
}

/** Newest generated takes first, at most six, for the row. */
export function recentTakes(items: readonly LibraryEntry[], limit = 6): LibraryEntry[] {
  return items.filter((e) => e.take.kind === "GEN").slice(0, limit);
}
