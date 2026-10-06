import { z } from "zod";
import { MAX_SCRIPT_CHARS } from "../workbench/screenplay";
import { uid, type Project } from "../workbench/studio";

/*
 * Earlier scripts (owner decision 11): when a script is replaced by something else (Transcribe's "Use as script", or a restore), the script it replaces is kept as a
 * version, so a person can go back to it after the Undo toast has gone. A bounded, optional list on the project body (`scriptVersions`, newest first): at most
 * MAX_VERSIONS, and no more than MAX_TOTAL characters in all (the oldest go first; a list is trimmed, never refused). Additive: a project saved without it parses exactly as it did. Pure and server-safe.
 */
export const MAX_VERSIONS = 10;
export const MAX_TOTAL = 3_000_000;

export const scriptVersionSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9-]{1,100}$/),
  text: z.string().max(MAX_SCRIPT_CHARS),
  at: z.string().datetime(),
  /** Why it was kept, in a few words: "Replaced by a transcript", "Before restoring an earlier script". */
  note: z.string().max(120),
}).strict();
export type ScriptVersion = z.infer<typeof scriptVersionSchema>;

const total = (list: readonly ScriptVersion[]) => list.reduce((n, v) => n + v.text.length, 0);

/**
 * The list as it may be kept, newest first: at most MAX_VERSIONS, and the oldest dropped until no more than MAX_TOTAL characters are held in all.
 * A script that alone is longer than the whole limit is kept as no version (it stays the current script, which has its own limit). The list never
 * makes a save fail: every write path trims with this before it saves, the three-way merge trims what it merged, and the schema itself trims what it is given
 * (below), so a list that is too long or too big is shortened, never refused.
 */
export function trimVersions(list: readonly ScriptVersion[]): ScriptVersion[] {
  const out = list.slice(0, MAX_VERSIONS);
  while (out.length && total(out) > MAX_TOTAL) out.pop();
  return out;
}

/** An array of valid entries, trimmed to the limits (an entry that is not valid is still refused: nothing writes one). */
export const scriptVersionsSchema = z.array(scriptVersionSchema).transform((list) => trimVersions(list));

export const versionsOf = (project: Pick<Project, "scriptVersions">): readonly ScriptVersion[] => project.scriptVersions ?? [];

/** The project with its current script kept as a version (when it has words, and is not already the newest kept one). Same project when nothing is kept. */
export function keepScript(project: Project, note: string, at = new Date().toISOString()): Project {
  const text = project.script ?? "";
  if (!text.trim() || versionsOf(project)[0]?.text === text) return project;
  const entry: ScriptVersion = { id: uid("script"), text, at, note: note.slice(0, 120) };
  return { ...project, scriptVersions: trimVersions([entry, ...versionsOf(project)]) };
}

/** A new script in place of the current one: the current one is kept first. */
export function withScript(project: Project, script: string, note: string, at?: string): Project {
  return { ...keepScript(project, note, at), script };
}

/**
 * Goes back to an earlier script. The script it replaces is kept as a version too (so a restore can be undone by another), and the restored one leaves the list
 * (it is the current script now). Null when that version is not there.
 */
export function restoreScript(project: Project, id: string, at?: string): Project | null {
  const version = versionsOf(project).find((v) => v.id === id);
  if (!version) return null;
  const without: Project = { ...project, scriptVersions: versionsOf(project).filter((v) => v.id !== id) };
  return { ...keepScript(without, "Before restoring an earlier script", at), script: version.text };
}
