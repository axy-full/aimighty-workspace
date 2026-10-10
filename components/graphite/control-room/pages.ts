/**
 * Atomik's control room, four places (design/particl-graphite/README.md § 1.1,
 * § 3.4; Atomik frames g–j): the page strip's labels, and each page's title
 * and hint as the frames have them. The shell's strip and its mount read this
 * list; the URLs are
 * `?suite=atomik&page=<id>`.
 */
export const CONTROL_ROOM_PAGES = [
  { id: "approvals", label: "Approvals", title: "Approvals", hint: "One queue across projects" },
  { id: "runs", label: "Activity", title: "Activity", hint: "Runs and spend · settled cost per run and project" },
  { id: "saved-skills", label: "Skills", title: "Skills", hint: "Saved runs, run again with new words" },
  { id: "memory", label: "Memory", title: "Memory", hint: "Brand, audience, references and cast" },
] as const;

export type ControlRoomPage = (typeof CONTROL_ROOM_PAGES)[number];
export type ControlRoomPageId = ControlRoomPage["id"];

export function isControlRoomPage(value: unknown): value is ControlRoomPageId {
  return CONTROL_ROOM_PAGES.some((p) => p.id === value);
}

export function controlRoomPage(id: ControlRoomPageId): ControlRoomPage {
  return CONTROL_ROOM_PAGES.find((p) => p.id === id)!;
}
