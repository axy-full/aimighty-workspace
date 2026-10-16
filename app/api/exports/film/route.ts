import { requireRender, withTenant } from "@/lib/auth";
import { z } from "zod";
import { readBoundedText } from "@/lib/requestBody";
import { sampleWorkspaceOff } from "@/lib/demo/spend-guard.server";
import { assembleToExport } from "@/lib/exports/assemble";
import { filmRequest } from "@/lib/exports/film";
import { failure, reply, whenOn } from "@/lib/exports/http";
import { createExport } from "@/lib/exports/jobs";
import { scheduleExport } from "@/lib/exports/schedule";
import { readDraft } from "@/lib/workbench/records";

/**
 * Export a board's film in one language (the `export_film` tool, lib/exports/tool.ts): the board's own draft decides the shots, the
 * voice lines of that language, the cards and the music (lib/exports/film.ts); the rest is `assemble_film`, so the switch, the
 * workspace list, the queue, the fair share, the media reach checks and the request id are exactly an export's. Free (0 cr). The
 * board is the caller's own: a board that is not theirs answers as one that does not exist.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

const bodySchema = z.object({
  board: z.string().regex(/^[A-Za-z0-9_-]{1,120}$/),
  language: z.string().regex(/^[a-z]{2,3}$/),
  requestId: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/),
}).strict();

export const POST = whenOn(withTenant(async (req: Request) => {
  const auth = await requireRender();
  if (auth.response) return auth.response;
  try {
    const input = bodySchema.parse(JSON.parse(await readBoundedText(req, 4 * 1024)));
    const sample = await sampleWorkspaceOff();
    if (sample) return sample;
    const draft = await readDraft(auth.user.id, input.board);
    if (!draft) return reply({ error: "That board isn't available in this workspace." }, 404);
    const film = filmRequest(draft.project, input.language, input.requestId);
    if (!film.ok) return reply({ error: film.error }, 422);
    const result = await createExport(assembleToExport(film.request), { id: auth.user.id, role: auth.user.role });
    if (result.scheduled && !result.duplicate) await scheduleExport(result.job.id);
    return reply({ job: result.job, shots: film.shots, voiceLines: film.voiceLines }, result.duplicate ? 200 : 202);
  } catch (error) {
    return failure(error);
  }
}));
