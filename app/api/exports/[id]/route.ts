import { z } from "zod";
import { requireRender, requireUser, withTenant } from "@/lib/auth";
import { readBoundedText } from "@/lib/requestBody";
import { ExportError } from "@/lib/exports/contract";
import { cancelExport, getExport, retryExport } from "@/lib/exports/jobs";
import { scheduleExport } from "@/lib/exports/schedule";
import { failure, reply, whenOn } from "@/lib/exports/http";

/** One export: `GET` its state (In queue, Rendering, Saving, Ready, Failed), `PATCH` to cancel or retry. 404 while the switch is off. */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

const ID = /^export_[a-f0-9]{32}$/;

type Ctx = { params: Promise<{ id: string }> };

export const GET = whenOn(withTenant(async (_req: Request, ctx: Ctx) => {
  const auth = await requireUser();
  if (auth.response) return auth.response;
  try {
    const { id } = await ctx.params;
    if (!ID.test(id)) throw new ExportError("That export was not found.", 404);
    return reply({ job: await getExport(auth.user.id, id) });
  } catch (error) {
    return failure(error);
  }
}));

export const PATCH = whenOn(withTenant(async (req: Request, ctx: Ctx) => {
  const auth = await requireRender();
  if (auth.response) return auth.response;
  try {
    const { id } = await ctx.params;
    if (!ID.test(id)) throw new ExportError("That export was not found.", 404);
    const { action } = z.object({ action: z.enum(["cancel", "retry"]) }).strict().parse(JSON.parse(await readBoundedText(req, 1000)));
    if (action === "cancel") return reply({ job: await cancelExport(auth.user.id, id) });
    const job = await retryExport(auth.user.id, id);
    await scheduleExport(job.id);
    return reply({ job }, 202);
  } catch (error) {
    return failure(error);
  }
}));
