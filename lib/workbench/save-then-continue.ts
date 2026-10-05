/**
 * Work saves itself. A paid or agent action that needs the project on the
 * server (an Atomik estimate, an identity, a development run) never asks the
 * person to save first: it saves through the project's own save path (the
 * Studio draft save, or the suites' draft editor), and only then goes on.
 *
 * Saving is free and changes nothing about what anything costs. A save that
 * does not land stops the action with one line, "Couldn't save · Try again";
 * the action never goes on with data the server does not hold, and nothing the
 * person made is dropped (the edits stay on screen and keep trying to save).
 */

/** The one line shown when the project could not be saved. */
export const SAVE_FAILED = "Couldn't save · Try again";

export class SaveFailedError extends Error {
  constructor() {
    super(SAVE_FAILED);
    this.name = "SaveFailedError";
  }
}

/**
 * Saves, then continues: `next` runs only once `save` says the project is
 * saved. A save that says no, or throws, ends here with {@link SaveFailedError}.
 */
export async function saveThenContinue<T>(save: () => Promise<boolean>, next: () => Promise<T> | T): Promise<T> {
  let saved = false;
  try {
    saved = (await save()) === true;
  } catch {
    saved = false;
  }
  if (!saved) throw new SaveFailedError();
  return next();
}

/** True once the project has landed on the server, which links its production (the first save does that). */
export const isSavedProject = (project: { productionProjectId?: string | null } | null | undefined): boolean => Boolean(project?.productionProjectId);

/**
 * The server's older "Save this project before …" refusals (a project it does
 * not hold yet). They ask the person to do something the app does for them, so
 * they read as the save line instead.
 */
const SAVE_FIRST = /^\s*save (this|the|your|current)( current| latest)? (project|work)\b/i;

/** `message` as shown: the save line for a save-first refusal, otherwise unchanged. */
export const saveMessage = (message: string): string => (SAVE_FIRST.test(message) ? SAVE_FAILED : message);

/** An error, or anything thrown, as the line to show; save-first refusals read as the save line. */
export const describeError = (cause: unknown, fallback: string): string => saveMessage(cause instanceof Error && cause.message ? cause.message : fallback);
