/**
 * A project draft was written somewhere other than the Rig (a Crew solution
 * sent to the Brief or the Rig, a Brief breakdown turned into scene nodes).
 * The Rig holds its own copy of the draft above the shell; this tells it to
 * read the saved version again, so what a confirmation says is on the Rig is
 * there when it is opened — and the Rig's next save is not refused as stale.
 */
export const DRAFT_WRITTEN = "particl:draft-written";
export type DraftWritten = { projectId: string };

export function announceDraftWritten(projectId: string): void {
  if (typeof window === "undefined" || !projectId) return;
  window.dispatchEvent(new CustomEvent<DraftWritten>(DRAFT_WRITTEN, { detail: { projectId } }));
}

export function writtenProject(event: Event): string | null {
  const detail = (event as CustomEvent<Partial<DraftWritten> | null>).detail;
  return detail && typeof detail.projectId === "string" && detail.projectId ? detail.projectId : null;
}
