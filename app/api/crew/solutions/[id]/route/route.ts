import { withTenant } from "@/lib/auth";
import { NO_STORE, crewCaller, crewFailure } from "@/lib/crew/http";
import { CrewError, readSolution, setSolutionStatus } from "@/lib/crew/store";
import { readDraft, saveDraft, workbenchReady } from "@/lib/workbench/records";
import { uid, type CanvasNode } from "@/lib/workbench/studio";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/**
 * POST { to: 'brief' | 'boards' | 'gen' } — send a solution onward. The only
 * three things Crew does outside its own tables, all through the project's
 * existing draft save (revision-checked, so a project open elsewhere is
 * never overwritten):
 *   brief  → appended to the Brief document
 *   boards → a new draft frame on Boards, carrying the solution as its text
 *   gen    → nothing is written; the text is handed back as Gen's prompt
 */
export const POST = withTenant(async (req: Request, { params }: Ctx) => {
  const caller = await crewCaller(req);
  if (caller.response) return caller.response;
  try {
    const solution = await readSolution(caller.userId, (await params).id);
    if (!solution) throw new CrewError("That solution is not in this workspace.", 404);
    const to = (await req.json().catch(() => ({}))).to;
    if (to === "gen") {
      await setSolutionStatus(solution.id, "generated");
      return Response.json({ to, status: "generated", prompt: solution.text }, { headers: NO_STORE });
    }
    if (to !== "brief" && to !== "boards") throw new CrewError("Choose Brief, Boards or Gen.", 400);
    await workbenchReady();
    const draft = await readDraft(caller.userId, solution.projectId);
    if (!draft) throw new CrewError("Save your project first.", 404);
    const project = { ...draft.project };
    if (to === "brief") project.brief = `${project.brief.trimEnd()}${project.brief.trim() ? "\n\n" : ""}Crew · ${solution.text}`;
    else {
      const [title, ...rest] = solution.text.split(" — ");
      const node: CanvasNode = {
        id: uid("node"), title: title.trim().slice(0, 80) || "Crew solution", type: "scene", text: (rest.join(" — ") || solution.text).trim(),
        x: 50, y: Math.max(0, ...project.nodes.map((n) => n.y + 290)), width: 300, linked: [], status: "draft",
      };
      project.nodes = [...project.nodes, node];
    }
    try { await saveDraft(caller.userId, project, draft.revision); }
    catch (error) { throw new CrewError(error instanceof Error ? error.message : "The project changed in another window. Reload and try again.", 409); }
    const status = to === "brief" ? "sent_to_brief" : "boarded";
    await setSolutionStatus(solution.id, status);
    return Response.json({ to, status }, { headers: NO_STORE });
  } catch (error) { return crewFailure(error); }
});
