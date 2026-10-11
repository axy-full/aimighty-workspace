import { initialsOf } from "./history";
import type { RoomPeer } from "@/lib/workbench/team-canvas-model";

/*
 * The who's-here row's words (live presence on the board; the design draws none, so it follows History's avatars,
 * README § 3.1 frame p): the people in the room, up to five faces and a count, and Atomik first while it works.
 * Pure: the row (components/graphite/board/Presence.tsx) draws what this says.
 */
export type HereFace = { key: string; initials: string; title: string; colour: string | null; agent: boolean };
export type Here = { label: string; faces: HereFace[]; more: { count: number; title: string } | null };
export const HERE_FACES = 5;

export function whoIsHere(peers: readonly RoomPeer[]): Here | null {
  if (!peers.length) return null;
  const people = peers.filter((p) => !p.agent), agent = peers.find((p) => p.agent);
  const faces: HereFace[] = [
    ...(agent ? [{ key: "atomik", initials: "AT", title: `Atomik · ${agent.doing ?? "working on the board"}`, colour: null, agent: true }] : []),
    ...people.slice(0, HERE_FACES).map((p) => ({ key: String(p.id), initials: initialsOf(p.name), title: p.name, colour: p.color, agent: false })),
  ];
  const rest = people.length - HERE_FACES;
  return {
    label: `On this board: ${[...people.map((p) => p.name), ...(agent ? ["Atomik"] : [])].join(", ")}`,
    faces,
    more: rest > 0 ? { count: rest, title: `${rest} more` } : null,
  };
}
