import {reserveRecoveryContinuation} from "@/lib/recovery";
import { after } from 'next/server';
import { z } from 'zod';
import { requireRender, requireUser, withTenant } from '@/lib/auth';
import { currentTenant, runWithStore } from '@/lib/tenant';
import { creditsApply } from '@/lib/credits';
import { atomikPublicResponse } from '@/lib/workbench/atomik-response';
import { atomikRequestSchema, atomikState, AtomikError, prepareAtomikJob, quoteAtomikJob, runAtomikJob, listAtomikJobs } from '@/lib/workbench/atomik-server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 120;
const response = (value: unknown, status = 200) => Response.json(atomikPublicResponse(value, creditsApply(currentTenant()?.workspace)), { status, headers: { 'Cache-Control': 'no-store' } });
function wrongScope(req: Request, userId: string) {
  const scope = req.headers.get('X-Workbench-Scope');
  return scope && scope !== `particl-active-${currentTenant()?.workspace?.id}-${userId}`;
}
function failure(error: unknown) {
  const status = error instanceof AtomikError ? error.status : Number((error as { status?: number })?.status) || 500;
  console.error('Workbench Atomik request failed with status', status);
  return response({ error: status === 500 ? 'Atomik could not save this request. Refresh the job history before trying again.' : (error as Error).message }, status);
}
export const GET = withTenant(async (req: Request) => {
  const auth = await requireUser();
  if (auth.response) return auth.response;
  if (wrongScope(req, auth.user.id)) return response({ error: 'This workspace or account changed. Return to the original production.' }, 409);
  const projectId = new URL(req.url).searchParams.get('projectId');
  if (!projectId || !/^[a-zA-Z0-9-]{1,100}$/.test(projectId)) return response({ error: 'Choose a saved production.' }, 400);
  const requestId = new URL(req.url).searchParams.get('requestId');
  if (requestId && !/^[a-zA-Z0-9_-]{8,100}$/.test(requestId)) return response({ error: 'Invalid request identity.' }, 400);
  try {
    if (requestId) return response({ jobs: await listAtomikJobs(auth.user.id, projectId, undefined, requestId) });
    return response(await atomikState(auth.user.id, projectId));
  }
  catch (error) { return failure(error); }
});
export const POST = withTenant(async (req: Request) => {
  const auth = await requireRender();
  if (auth.response) return auth.response;
  if (wrongScope(req, auth.user.id)) return response({ error: 'This workspace or account changed. Return to the original production.' }, 409);
  const origin = req.headers.get('origin');
  if (origin && origin !== new URL(req.url).origin) return response({ error: 'Invalid request origin.' }, 403);
  if (Number(req.headers.get('content-length') || 0) > 20000) return response({ error: 'Keep this request under 20 KB.' }, 413);
  const raw = await req.text();
  if (raw.length > 20000) return response({ error: 'Keep this request under 20 KB.' }, 413);
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return response({ error: 'Invalid request JSON.' }, 400); }
  const parsed = atomikRequestSchema.extend({ quoteOnly: z.boolean().optional() }).safeParse(value);
  if (!parsed.success) return response({ error: 'Check the request, model, depth and selected references.' }, 400);
  try {
    const { quoteOnly, ...input } = parsed.data;
    if (quoteOnly) return response(await quoteAtomikJob(input, auth.user.id));
    const prepared = await prepareAtomikJob(input, auth.user.id, auth.token);
    if (prepared.scheduled) {
      const store = currentTenant();
      if (!store) throw new AtomikError('This workspace session expired. Reload the production.', 401);
      after(await reserveRecoveryContinuation('after-response', () => runWithStore(store, () => runAtomikJob(prepared.job.id, auth.user.id))));
    }
    return response({ job: prepared.job, ...prepared.job }, prepared.job.status === 'queued' || prepared.job.status === 'running' ? 202 : 200);
  } catch (error) { return failure(error); }
});
