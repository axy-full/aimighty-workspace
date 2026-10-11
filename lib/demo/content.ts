import type { Project } from "../workbench/studio";

/*
 * What the sample's cast, takes and cut show: the owner's own words and his own cut, read from the finished draft.
 * Pure. Nothing is added or reworded: a cast line is the entry's name and its description as he wrote them, and the
 * takes and the cut come from `project.shots` (the sequence) and the assets it points at.
 */

export type SampleCastLine = { id: string; name: string; kind: "character" | "element"; line: string };

/** "Lead · ivory suit, short dark bob": the entry's name, then its description on one line. */
export function castLine(name: string, description: string): string {
  const n = name.replace(/\s+/g, " ").trim();
  const d = description.replace(/\s+/g, " ").trim();
  return n && d ? `${n} · ${d}` : n || d;
}

export function sampleCast(project: Pick<Project, "production">): SampleCastLine[] {
  return (project.production?.cast?.entries ?? [])
    .map((e) => ({ id: e.id, name: e.name.trim(), kind: e.kind, line: castLine(e.name, e.description) }))
    .filter((c) => c.line);
}

export type SampleCutShot = {
  index: number;
  id: string;
  name: string;
  /** The slot's length in seconds, from the cut's frames. */
  seconds: number;
  /** The take it holds (the asset's id and, when it was made here, its generation), or null while the slot waits. */
  assetId: string | null;
  generationId: string | null;
  /** The take is approved: the asset is Selected, or its generation is in the approved set. */
  approved: boolean;
};

export type SampleCut = { shots: SampleCutShot[]; approved: number; seconds: number; approvedSeconds: number; waiting: number };

const tenth = (n: number) => Math.round(n * 10) / 10;

export function sampleCut(project: Pick<Project, "shots" | "assets" | "fps">, approvedGenerations: ReadonlySet<string> = new Set()): SampleCut {
  const fps = project.fps > 0 ? project.fps : 24;
  const shots = project.shots.map((s, i): SampleCutShot => {
    const asset = s.assetId ? project.assets.find((a) => a.id === s.assetId) ?? null : null;
    const video = asset && asset.kind === "video" ? asset : null;
    const generationId = video?.generationId ?? null;
    return {
      index: i + 1, id: s.id, name: s.name, seconds: tenth(s.duration / fps),
      assetId: video?.id ?? null, generationId,
      approved: Boolean(video && (video.status === "Selected" || (generationId && approvedGenerations.has(generationId)))),
    };
  });
  const approvedShots = shots.filter((s) => s.approved);
  return {
    shots,
    approved: approvedShots.length,
    seconds: tenth(shots.reduce((n, s) => n + s.seconds, 0)),
    approvedSeconds: tenth(approvedShots.reduce((n, s) => n + s.seconds, 0)),
    waiting: shots.filter((s) => !s.approved).length,
  };
}

/** m:ss, whole seconds, rounded: 10 → "0:10". */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
