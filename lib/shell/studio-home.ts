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
  const line: Record<string, [string, StageStatus]> = {
    brief: brief ? [`${plural(brief, "word")}${project?.script ? " · script" : ""}`, "done"] : ["empty", "ready"],
    boards: frames ? [plural(frames, "frame"), "done"] : ["no frames yet", "ready"],
    cast: cast || elements ? [`${plural(cast, "identity", "identities")} · ${plural(elements, "element")}`, "done"] : ["no identity yet", "ready"],
    astra: project?.astraBlender ? ["scene set", "done"] : ["block on desktop", "ready"],
    rig: shots ? [`${plural(shots, "shot")} · ${rendered} rendered`, rendered >= shots ? "done" : "progress"] : ["no shots yet", "ready"],
    takes: takes ? [plural(takes, "take"), "done"] : ["nothing rendered yet", "ready"],
    edit: clips ? [plural(clips, "clip"), "done"] : ["no stems yet", "ready"],
    deliver: [project ? `${project.aspect} · ${project.fps} fps` : "no spec", "ready"],
  };
  return studioStages().map((p) => {
    const [meta, status] = line[p.id] ?? ["", "ready"];
    return { id: p.id, n: p.n, label: p.label, meta, status };
  });
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
