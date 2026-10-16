import { requireRender, requireUser, withTenant } from "@/lib/auth";
import { readBoundedText } from "@/lib/requestBody";
import { sampleWorkspaceOff } from "@/lib/demo/spend-guard.server";
import { exportRequestSchema } from "@/lib/exports/contract";
import { failure, reply, whenOn } from "@/lib/exports/http";
import { createExport, listExports } from "@/lib/exports/jobs";
import { scheduleExport } from "@/lib/exports/schedule";

/**
 * Exports: our own Remotion templates rendered on our own worker. FREE to customers (0 cr). Off unless
 * REMOTION_EXPORTS is on: off, every method answers 404 before anything is read, written or dispatched. On, it is
 * still off for a workspace that is not the house workspace and not listed in the site setting `enginesOnWorkspaces`
 * (lib/engineGate.ts): that workspace gets the same 404 from the job functions (lib/exports/access.ts).
 * `GET` lists the caller's exports; `POST` admits one and answers 202 with the job.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

export const GET = whenOn(withTenant(async () => {
  const auth = await requireUser();
  if (auth.response) return auth.response;
  try {
    return reply({ price: { credits: 0, label: "Free" }, exports: await listExports(auth.user.id) });
  } catch (error) {
    return failure(error);
  }
}));

export const POST = whenOn(withTenant(async (req: Request) => {
  const auth = await requireRender();
  if (auth.response) return auth.response;
  try {
    const input = exportRequestSchema.parse(JSON.parse(await readBoundedText(req, 64 * 1024)));
    const sample = await sampleWorkspaceOff();
    if (sample) return sample;
    const result = await createExport(input, { id: auth.user.id, role: auth.user.role });
    if (result.scheduled && !result.duplicate) await scheduleExport(result.job.id);
    return reply({ job: result.job }, result.duplicate ? 200 : 202);
  } catch (error) {
    return failure(error);
  }
}));
