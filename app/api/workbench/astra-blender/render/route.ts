import { after } from 'next/server';
import { z } from 'zod';
import { requireUser, requireRender, withTenant } from '@/lib/auth';
import { currentTenant, requireTenant, runWithStore } from '@/lib/tenant';
import { readBoundedText } from '@/lib/requestBody';
import { workbenchScopeProblem } from '@/lib/workbench/request-scope';
import { reserveRecoveryContinuation } from '@/lib/recovery';
import { astraRenderRequestSchema, AstraRenderError, astraRenderAvailability, listAstraRenderJobs, quoteAstraRender, prepareAstraRender, runAstraRender, cancelAstraRenderJob } from '@/lib/astra-blender/render-jobs';
import { enqueueAstraRender, recoverAstraRenders } from '@/lib/astra-blender/render-dispatch';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;
const response = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'private, no-store' } });
function scope(req: Request, id: string, token: boolean) { const problem = workbenchScopeProblem(req, requireTenant().id, id, !token); if (problem)
    return response({ error: problem }, 409); if (req.method !== 'GET' && req.headers.get('origin') && req.headers.get('origin') !== new URL(req.url).origin)
    return response({ error: 'Invalid request origin.' }, 403); return null; }
function failure(error: unknown) { const status = error instanceof AstraRenderError ? error.status : error instanceof z.ZodError || error instanceof SyntaxError ? 400 : Number((error as {
    status?: number;
})?.status) || 500; return response({ error: status >= 500 ? 'The render request could not finish. Check its saved job status before trying again.' : (error as Error).message }, status); }
export const GET = withTenant(async (req: Request) => { const auth = await requireUser(); if (auth.response)
    return auth.response; const problem = scope(req, auth.user.id, !!auth.token); if (problem)
    return problem; try {
    const params = new URL(req.url).searchParams, projectId = z.string().regex(/^[a-zA-Z0-9-]{1,100}$/).parse(params.get('projectId')), requestId = z.string().regex(/^[a-zA-Z0-9_-]{8,100}$/).optional().parse(params.get('requestId') ?? undefined);
    const jobs = await listAstraRenderJobs(auth.user.id, projectId, requestId);
    const store = currentTenant()!;
    after(await reserveRecoveryContinuation('after-response', () => runWithStore(store, () => recoverAstraRenders({ limit: 1, deadlineAt: Date.now() + 250000 }))));
    return response({ runtime: astraRenderAvailability(), jobs });
}
catch (error) {
    return failure(error);
} });
export const POST = withTenant(async (req: Request) => { const auth = await requireRender(); if (auth.response)
    return auth.response; const problem = scope(req, auth.user.id, !!auth.token); if (problem)
    return problem; try {
    const input = astraRenderRequestSchema.parse(JSON.parse(await readBoundedText(req, 4000)));
    if (input.quoteOnly)
        return response(await quoteAstraRender(input, auth.user.id));
    const result = await prepareAstraRender(input, auth.user.id, auth.token);
    if (result.scheduled) {
        const store = currentTenant()!;
        after(await reserveRecoveryContinuation('after-response', () => runWithStore(store, async () => { if (!await enqueueAstraRender(result.job.id))
            await runAstraRender(result.job.id); })));
    }
    return response({ job: result.job }, result.duplicate ? 200 : 202);
}
catch (error) {
    return failure(error);
} });
export const PATCH = withTenant(async (req: Request) => { const auth = await requireRender(); if (auth.response)
    return auth.response; const problem = scope(req, auth.user.id, !!auth.token); if (problem)
    return problem; try {
    const input = z.object({ projectId: z.string().regex(/^[a-zA-Z0-9-]{1,100}$/), jobId: z.string().regex(/^astra_render_[a-f0-9]{32}$/), action: z.literal('cancel') }).strict().parse(JSON.parse(await readBoundedText(req, 2000)));
    return response({ job: await cancelAstraRenderJob(auth.user.id, input.projectId, input.jobId) });
}
catch (error) {
    return failure(error);
} });
