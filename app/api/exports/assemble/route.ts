import { requireRender, withTenant } from "@/lib/auth";
import { readBoundedText } from "@/lib/requestBody";
import { sampleWorkspaceOff } from "@/lib/demo/spend-guard.server";
import { assembleSchema, assembleToExport } from "@/lib/exports/assemble";
import { failure, reply, whenOn } from "@/lib/exports/http";
import { createExport } from "@/lib/exports/jobs";
import { scheduleExport } from "@/lib/exports/schedule";

/**
 * Assemble a film: one timeline of shots, voice lines, music, titles and words cut into an MP4 on the export worker (the
 * `assemble_film` tool, lib/exports/tool.ts). It is an export (the `final` template), so everything about exports holds: off
 * unless REMOTION_EXPORTS is on, off for a workspace that is not on the engines list, media named by handle and resolved in
 * the caller's own workspace, the same queue and the same hourly share, free (0 cr), and the same `requestId` returns the
 * same job. `GET /api/exports/{id}` collects it.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

export const POST = whenOn(withTenant(async (req: Request) => {
  const auth = await requireRender();
  if (auth.response) return auth.response;
  try {
    const input = assembleSchema.parse(JSON.parse(await readBoundedText(req, 64 * 1024)));
    const sample = await sampleWorkspaceOff();
    if (sample) return sample;
    const result = await createExport(assembleToExport(input), { id: auth.user.id, role: auth.user.role });
    if (result.scheduled && !result.duplicate) await scheduleExport(result.job.id);
    return reply({ job: result.job }, result.duplicate ? 200 : 202);
  } catch (error) {
    return failure(error);
  }
}));
