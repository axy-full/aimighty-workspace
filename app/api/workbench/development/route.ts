import { after } from 'next/server';
import { z } from 'zod';
import { requireRender, requireUser, withTenant } from '@/lib/auth';
import { currentTenant, runWithStore } from '@/lib/tenant';
import { db } from '@/lib/db';
import { creditsApply } from '@/lib/credits';
import { readBoundedText, RequestBodyError } from '@/lib/requestBody';
import { reserveRecoveryContinuation } from '@/lib/recovery';
import { engineMock } from '@/lib/mock';
import { atomikPublicResponse } from '@/lib/workbench/atomik-response';
import { DevelopmentError, developmentRequestSchema, developmentState, listDevelopmentJobs, prepareDevelopmentJob, quoteDevelopmentJob, runDevelopmentStep } from '@/lib/workbench/development-server';
import { enqueueDevelopmentJob } from '@/lib/workbench/development-worker';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;
const response = (data: unknown, status = 200) => Response.json(atomikPublicResponse(data, creditsApply(currentTenant()?.workspace)), { status, headers: { 'Cache-Control': 'no-store' } });
function scopeError(req: Request, owner: string) {
  const scope = req.headers.get('X-Workbench-Scope');
  return scope && scope !== `particl-active-${currentTenant()?.workspace?.id}-${owner}`;
}
function failure(error: unknown) {
  const status = Number((error as { status?: number })?.status) || 500;
  console.error('Development workflow request failed with status', status);
  return response({ error: status >= 500 ? 'This workflow could not be updated. Check its saved status before starting another request.' : (error as Error).message }, status);
}
async function schedule(id: string, owner: string) {
  if (await enqueueDevelopmentJob(id, owner)) return;
  const store = currentTenant();
  if (!store) throw new DevelopmentError('The workspace session expired.', 401);
  after(await reserveRecoveryContinuation('development-after-response', () => runWithStore(store, async () => {
    // Real calls use one bounded phase per continuation. The authenticated
    // resume endpoint advances the next saved phase if the queue is unavailable.
    for (let count = 0; count < (engineMock() ? 12 : 1); count++) {
      const result = await runDevelopmentStep(id, owner);
      if (result.done || result.waiting || result.settlementPending) break;
    }
  })));
}
export const GET = withTenant(async (req: Request) => {
  const auth = await requireUser(); if (auth.response) return auth.response;
  if (scopeError(req, auth.user.id)) return response({ error: 'Return to the account and workspace that prepared this workflow.' }, 409);
  const url = new URL(req.url), projectId = url.searchParams.get('projectId'), requestId = url.searchParams.get('requestId') ?? undefined;
  if (!projectId || !/^[a-zA-Z0-9-]{1,100}$/.test(projectId) || (requestId && !/^[a-zA-Z0-9_-]{8,100}$/.test(requestId))) return response({ error: 'Choose a saved project and a valid request identity.' }, 400);
  try {
    const jobId = url.searchParams.get('jobId'), offset = Number(url.searchParams.get('offset') ?? 0);
    if (jobId) {
      if (!/^wb_development_[a-f0-9-]+$/.test(jobId) || !Number.isSafeInteger(offset) || offset < 0) return response({ error: 'Choose a valid result section.' }, 400);
      const [job] = await listDevelopmentJobs(auth.user.id, projectId, undefined, undefined, jobId, offset);
      return job ? response({ job }) : response({ error: 'This development job was not found.' }, 404);
    }
    return response(await developmentState(auth.user.id, projectId, requestId));
  }
  catch (error) { return failure(error); }
});
const resumeSchema = z.object({ resume: z.literal(true), projectId: z.string().regex(/^[a-zA-Z0-9-]{1,100}$/), jobId: z.string().regex(/^wb_development_[a-f0-9-]+$/) }).strict();
export const POST = withTenant(async (req: Request) => {
  const auth = await requireRender(); if (auth.response) return auth.response;
  if (scopeError(req, auth.user.id)) return response({ error: 'Return to the account and workspace that prepared this workflow.' }, 409);
  const origin = req.headers.get('origin');
  if (origin && origin !== new URL(req.url).origin) return response({ error: 'Invalid request origin.' }, 403);
  let value: unknown;
  try { value = JSON.parse(await readBoundedText(req, 12000)); }
  catch (error) { return response({ error: error instanceof RequestBodyError && error.status === 413 ? 'Keep these development instructions under 12 KB.' : 'Invalid request JSON.' }, error instanceof RequestBodyError ? error.status : 400); }
  try {
    const resume = resumeSchema.safeParse(value);
    if (resume.success) {
      const jobs = await listDevelopmentJobs(auth.user.id, resume.data.projectId, undefined, undefined, resume.data.jobId);
      const job = jobs.find(job => job.id === resume.data.jobId);
      if (!job) throw new DevelopmentError('This development job was not found in the selected project.', 404);
      // A row exists before reservation. Never let a simultaneous resume
      // dispatch provider work until admission has actually committed.
      const admitted = (await db().execute({ sql: "SELECT 1 FROM workbench_development_jobs WHERE id=? AND owner=? AND status='running'", args: [job.id, auth.user.id] })).rows.length;
      if (admitted && job.status === 'queued') await schedule(job.id, auth.user.id);
      return response({ job }, ['queued', 'running'].includes(job.status) ? 202 : 200);
    }
    const parsed = developmentRequestSchema.extend({ quoteOnly: z.boolean().optional() }).safeParse(value);
    if (!parsed.success) return response({ error: 'Check the development mode, model, effort and instructions.' }, 400);
    const { quoteOnly, ...input } = parsed.data;
    if (quoteOnly) return response(await quoteDevelopmentJob(input, auth.user.id));
    const prepared = await prepareDevelopmentJob(input, auth.user.id, auth.token);
    if (prepared.scheduled) await schedule(prepared.job.id, auth.user.id);
    return response({ job: prepared.job }, ['queued', 'running'].includes(prepared.job.status) ? 202 : 200);
  } catch (error) { return failure(error); }
});
