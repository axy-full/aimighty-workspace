import { db, ready } from "../db";
import { liftLetsThrough, type LiftScope } from "./lift.server";
import { parseSampleMark, SAMPLE_LINE, SAMPLE_SETTING_KEY } from "./sample";

/**
 * S12.4, widened by the owner (6 Oct): the sample workspace spends nothing. A workspace that holds a sample mark
 * (lib/demo/mark.server.ts; the "Particl sample" workspace Guest Home reads from) is the sample workspace, and every
 * paid job in it is refused in the sample's own words, whoever asks (a person, Atomik, an outside agent, a token),
 * by whichever door, and whatever project or shot the request names or leaves out: a job filed under another
 * production, or filed nowhere (Make's Enhance, Atomik's ideas, a chat turn, a memory read, an identity, a
 * transcription with no project), is refused like one on the sample itself. Guests find nothing that spends.
 *
 * Each paid door asks before anything is claimed, held, reserved, metered or sent (`sampleWorkspaceOff` for a
 * route, `sampleWorkspaceRefusal` inside admission), and the reservation every platform-paid job passes
 * (lib/generationRequests.ts reserveGenerationSpend) asks again, so a door that skips the first check still stops
 * there. A quote is not a job: prices keep answering. Free actions are untouched. Undoing the mark lifts it all.
 *
 * The one exception (owner, 7 Oct): while an owner or admin has lifted the mark for one Atomik run
 * (lib/demo/lift.server.ts), a request that names that run (`scope.runId`), or the lifter's own ask that makes it
 * (`scope.ask`), passes. Everything else, including a request that names no run, is refused as before. The lift and
 * its run are read afresh on every call, so the mark is back the moment the run ends or the lift runs out. A mark that
 * cannot be read is never lifted.
 */
export async function sampleWorkspaceRefusal(scope: LiftScope = {}): Promise<string | null> {
  await ready();
  /* Read straight from the workspace's settings, so this file pulls in nothing heavy: it sits under every reservation. */
  const stored = (await db().execute({ sql: `SELECT value FROM settings WHERE key = ?`, args: [SAMPLE_SETTING_KEY] })).rows[0];
  const mark = stored ? guardMark(stored.value) : null;
  if (!mark) return null;
  if (mark !== "unreadable" && (scope.runId || scope.ask) && (await liftLetsThrough(scope))) return null;
  return SAMPLE_LINE;
}

/** What a route answers in the sample workspace: 409 with the sample's line and nothing charged. */
export function sampleWorkspaceReply(line: string = SAMPLE_LINE): Response {
  return Response.json({ error: line, charged: 0 }, { status: 409, headers: { "Cache-Control": "no-store" } });
}

/**
 * A paid route's first question, asked before it claims, holds, reserves or sends anything: null to carry on, else
 * the reply. It fails closed: a workspace whose mark cannot be read at all (the database did not answer) spends
 * nothing on this request either.
 */
export async function sampleWorkspaceOff(scope: LiftScope = {}): Promise<Response | null> {
  try {
    const line = await sampleWorkspaceRefusal(scope);
    return line ? sampleWorkspaceReply(line) : null;
  } catch (error) {
    console.error("The sample check could not read this workspace:", error);
    return Response.json(
      { error: "This workspace could not be checked just now. Nothing was charged. Try again.", charged: 0 },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}

/**
 * The stored mark as the guard reads it, failing closed: a mark that is there but is not one this code wrote (it does
 * not parse, or has another version or shape) is never read as "no sample". Whether it still names its production or
 * names none, the workspace holding it is the sample workspace until an owner marks the sample again, which replaces
 * the bad row (undo cannot clear it: it skips a mark it cannot read). Only an undone mark (`hiddenAt` set) reads as
 * none, whatever else its shape.
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
