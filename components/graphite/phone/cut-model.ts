import type { Project } from "@/lib/workbench/studio";
import { cutMeta, secondsWords, type CutData } from "../board/cards/cut/cut-model";
import { judgeable, type ShotTakes } from "../board/cards/take/take-model";
import { LOUDNESS_TARGETS, lufsWords, loudnessVerdict, type LoudnessTarget } from "@/lib/workbench/loudness";
import { audioClips } from "@/lib/workbench/audio";

/*
 * The phone's Cut (Gaps A frames, `screen=cut`): watch the cut and approve it, nothing else. Pure.
 *
 * "Approve the cut" is the takes in the cut that still wait for a person: each is the review trail's own free approval
 * (the same write the phone's review makes); a take already approved is left as it is. Editing, trims, sound and the export
 * are the desktop's Edit & Sound.
 */
export type PendingTake = { genId: string; label: string };

/** The takes in the cut that a person can judge and has not approved, in the cut's order. */
export function pendingTakes(project: Project, rows: readonly ShotTakes[], cut: CutData): PendingTake[] {
  const assets = new Map([...project.assets, ...(project.sharedAssets ?? [])].map((a) => [a.id, a] as const));
  const out: PendingTake[] = [];
  project.shots.forEach((s, i) => {
    const genId = assets.get(s.assetId)?.generationId;
    const info = cut.clips[i];
    if (!genId || !info || info.approved) return;
    const version = rows.flatMap((r) => r.versions).find((v) => v.genId === genId);
    if (version && judgeable(version) && version.status !== "approved") out.push({ genId, label: info.label });
  });
  return out;
}

/** "Approve the cut" when takes wait, else the word for where the cut stands. */
export function approveWords(pending: readonly PendingTake[], cut: CutData): { label: string; enabled: boolean; line: string } {
  if (!cut.clips.length) return { label: "Approve the cut", enabled: false, line: "No takes in the cut yet." };
  if (pending.length) return { label: "Approve the cut", enabled: true, line: pending.length === 1 ? `1 take in the cut waits for you.` : `${pending.length} takes in the cut wait for you.` };
  return { label: "The cut is approved", enabled: false, line: cut.waiting.length ? `${cut.waiting.map((w) => `Shot ${w.shot} ${w.word}`).join(" · ")}.` : "Every take in the cut is approved." };
}

/** "The cut" sub-line: "2 approved takes · 0:10". */
export const cutLine = (cut: CutData) => cutMeta(cut);

/** The rows under the player: loudness against the chosen target, the music lane, and how long the cut runs. No captions row: Cut cannot show captions. */
export function cutRows(project: Project, cut: CutData, target: LoudnessTarget, lufs: number | null | undefined): { key: string; label: string; value: string }[] {
  const music = audioClips(project).filter((c) => c.lane === "music");
  const loud = lufs === undefined ? "Not checked" : lufs === null ? "No sound" : `${lufsWords(lufs)} LUFS${loudnessVerdict(lufs, target).kind === "ok" ? " ✓" : ""}`;
  return [
    { key: "loudness", label: `Loudness · ${target.short}`, value: loud },
    { key: "music", label: "Music", value: music.length ? `${music.length} ${music.length === 1 ? "clip" : "clips"} · ${secondsWords(music.reduce((n, c) => n + c.duration, 0) / Math.max(1, project.fps))}` : "none" },
  ];
}
export { LOUDNESS_TARGETS };
