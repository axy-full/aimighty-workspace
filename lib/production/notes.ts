/**
 * The director's notes to the writer: Brief & Script's "Notes for the next
 * draft" and Beats' "Anything else for the writer". They live on the project
 * draft (`production.notes`) — the person's own copy, saved in the
 * workspace's database — so a reload keeps them and they never reach another
 * workspace. Notes leave their box only once the run that carries them is
 * held by the server; from then on that run keeps them
 * (DevelopmentJob.instructions), and a run that fails offers them back.
 */
export const NOTES_LIMIT = 5_000;
export type NotesBox = "draft" | "beats";
export type AgentNotes = Partial<Record<NotesBox, string>>;

type WithNotes = { production?: { notes?: AgentNotes } };

export function notesOf(project: WithNotes, box: NotesBox): string {
  return project.production?.notes?.[box] ?? "";
}

/** The project with this box's notes set; the same object when nothing changes. */
export function withNotes<T extends WithNotes>(project: T, box: NotesBox, text: string): T {
  const value = text.slice(0, NOTES_LIMIT);
  if (notesOf(project, box) === value) return project;
  return { ...project, production: { ...project.production, notes: { ...project.production?.notes, [box]: value } } };
}

/** These notes went with this request: its instructions are the notes as they stand now. */
export function notesSent(input: { instructions?: string } | null | undefined, notes: string): boolean {
  const said = notes.trim();
  return Boolean(input && said && (input.instructions ?? "").trim() === said);
}

/** Empties the box once the run carrying its notes is held — unless the director has written more since. */
export function clearSentNotes<T extends WithNotes>(project: T, box: NotesBox, sent: { instructions?: string } | null | undefined): T {
  return notesSent(sent, notesOf(project, box)) ? withNotes(project, box, "") : project;
}

/**
 * A failed run's notes, back in the box: as they were in an empty box, after
 * what is there otherwise — never over it. Null when they are already there,
 * or would not fit.
 */
export function notesBack(current: string, sent: string): string | null {
  const back = sent.trim();
  if (!back || current.includes(back)) return null;
  const joined = current.trim() ? `${current.replace(/\s+$/, "")}\n\n${back}` : back;
  return joined.length > NOTES_LIMIT ? null : joined;
}
