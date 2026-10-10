"use client";
import { seededProject } from "@/lib/shell/create-project";
import { workbenchScopeFor } from "@/lib/workbench/request-scope";
import { clearGuestBrief, firstBoard, readGuestBrief } from "./brief";

/**
 * Right after an account and its workspace exist (the sign-up or verification answer set the session), the brief a
 * guest typed becomes the person's first board: today's create path (PUT /api/workbench/projects with a seeded
 * project), free, nothing thinks or renders. The key is cleared only once the board is saved; a failure keeps it
 * and never blocks sign-up. Same browser only.
 */
export async function makeFirstBoardFromGuestBrief(): Promise<{ id: string } | null> {
  const draft = readGuestBrief();
  if (!draft || !draft.text.trim()) return null;
  try {
    const me = (await fetch("/api/me", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null))) as { id?: string; workspace?: { id?: string } } | null;
    if (!me?.id || !me.workspace?.id) return null;
    const { name, seed } = firstBoard(draft);
    const project = seededProject(name, seed);
    const saved = await fetch("/api/workbench/projects", {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Workbench-Scope": workbenchScopeFor(me.workspace.id, me.id) },
      body: JSON.stringify({ project, revision: 0 }),
    });
    if (!saved.ok) return null;
    clearGuestBrief();
    return { id: project.id };
  } catch {
    return null;
  }
}
