import { db, ready } from "../db";
import { parseSampleMark, SAMPLE_LINE, SAMPLE_SETTING_KEY } from "./sample";

/**
 * S12.4: nothing paid is ever made on the sample production, whoever asks (a person, Atomik, an outside agent, a
 * token) and whichever door it comes in by. A job filed under the production the workspace marked as the sample
 * (lib/demo/mark.server.ts), by its project or by one of its shots, is refused in the sample's own words. It is asked
 * where a render is admitted (before it can be held, so nothing waits to start when credits arrive) and where every
 * platform-paid job is reserved (lib/generationRequests.ts reserveGenerationSpend), so a door that skips admission
 * still stops at the reservation. A quote is not a job: prices keep working. Free actions are untouched.
 */
export async function sampleSpendRefusal(projectId: string | null | undefined, shotId?: string | null): Promise<string | null> {
  await ready();
  /* Read straight from the workspace's settings, so this file pulls in nothing heavy: it sits under every reservation. */
  const stored = (await db().execute({ sql: `SELECT value FROM settings WHERE key = ?`, args: [SAMPLE_SETTING_KEY] })).rows[0];
  const mark = stored ? guardMark(stored.value) : null;
  if (!mark) return null;
  if (mark === "unreadable") return SAMPLE_LINE;
  if (projectId && projectId === mark.projectId) return SAMPLE_LINE;
  if (shotId) {
    const row = (await db().execute({ sql: `SELECT project_id FROM shots WHERE id = ?`, args: [shotId] })).rows[0];
    if (row && String(row.project_id) === mark.projectId) return SAMPLE_LINE;
  }
  return null;
}

/**
 * The stored mark as the guard reads it, failing closed: a mark that is there but is not one this code wrote (it does
 * not parse, or has another version or shape) is never read as "no sample". If it still names its production, that
 * production is the sample; if it names none, nobody can tell which production is, so every paid job is refused
 * ("unreadable") until an owner marks the sample again, which replaces the bad row (undo cannot clear it: it skips a
 * mark it cannot read). Only an undone mark (`hiddenAt` set) reads as none, whatever else its shape.
 */
function guardMark(stored: unknown): { projectId: string } | "unreadable" | null {
  const mark = parseSampleMark(String(stored));
  if (mark) return mark;
  let value: unknown;
  try { value = JSON.parse(String(stored)); } catch { return "unreadable"; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return "unreadable";
  const m = value as Record<string, unknown>;
  if (typeof m.hiddenAt === "number" && m.hiddenAt > 0) return null;
  return typeof m.projectId === "string" && m.projectId ? { projectId: m.projectId } : "unreadable";
}
