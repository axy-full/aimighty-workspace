import { boardShots } from "@/lib/production/boards";
import type { Project } from "@/lib/workbench/studio";
import type { RigShot } from "@/lib/workspace/shots";

/*
 * The board as an ordered shot list (README § 1.1: "List is the same board as
 * an ordered shot list"; the master's columns # · Time · Action · Size ·
 * Camera · State). The beat sheet's shots when there is one, each joined to
 * the board shot built from it; else the board's shots in draft order. Lens
 * is not a field the code keeps, so the camera column says the movement only.
 * Stream 4 owns the drawn table (lead decision 28); this is the plain one the
 * board shows until it lands, and the rows it can reuse.
 */
export type ShotRow = {
  id: string;
  /** The card this row selects (a board shot), when there is one. */
  cardId: string | null;
  number: string;
  /** Where the shot starts in the film ("0:04"), when every shot before it has a length. */
  start: string | null;
  seconds: number | null;
  action: string;
  size: string;
  camera: string;
  state: string;
  tone: "green" | "gold" | "red" | "floor";
};

const STATE: Record<string, [string, ShotRow["tone"]]> = {
  approved: ["Approved", "green"], queued: ["Rendering", "gold"], ready: ["Ready", "gold"], failed: ["Failed", "red"], draft: ["Draft", "floor"],
};
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

export function shotRows(project: Pick<Project, "production" | "nodes">, shots: readonly RigShot[]): ShotRow[] {
  const beats = boardShots(project.production?.beats);
  const frames = project.production?.boards?.frames ?? {};
  let at: number | null = 0;
  const timed = (seconds: number | null) => {
    const start = at === null ? null : clock(at);
    at = at !== null && seconds !== null ? at + seconds : null;
    return start;
  };
  if (beats.length) {
    return beats.map((beat) => {
      const node = project.nodes.find((n) => n.boardShotId === beat.id);
      const shot = node ? shots.find((s) => s.id === node.id) : undefined;
      const seconds = shot?.durationS ?? beat.shot.duration ?? null;
      const framed = !!frames[beat.id]?.takes.length;
      const [state, tone] = shot ? STATE[shot.status] ?? STATE.draft : framed ? ["Storyboarded", "floor" as const] : STATE.draft;
      return {
        id: beat.id, cardId: node?.id ?? null, number: beat.number, start: timed(seconds), seconds,
        action: beat.shot.description || beat.scene, size: beat.shot.framing, camera: beat.shot.movement, state, tone,
      };
    });
  }
  return shots.map((shot) => {
    const seconds = shot.durationS ?? null;
    const [state, tone] = STATE[shot.status] ?? STATE.draft;
    return {
      id: shot.id, cardId: shot.id, number: String(shot.index).padStart(2, "0"), start: timed(seconds), seconds,
      action: shot.note || shot.name, size: "", camera: "", state, tone,
    };
  });
}
