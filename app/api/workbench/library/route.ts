import { requireSession, withTenant } from '@/lib/auth';
import { requireTenant } from '@/lib/tenant';
import { workbenchScopeProblem } from '@/lib/workbench/request-scope';
import { AssetQueryError } from '@/lib/assetPagination';
import { listProjectLibrary, linkProjectLibraryUpload, unlinkProjectLibraryUpload, ProjectLibraryError } from '@/lib/workbench/project-library';

export const dynamic = 'force-dynamic';
const headers = {'Cache-Control':'private, no-store'};
function failure(error: unknown) {
  if (error instanceof AssetQueryError || error instanceof ProjectLibraryError)
    return Response.json({error:error.message},{status:error instanceof ProjectLibraryError?error.status:400,headers});
  throw error;
}
export const GET = withTenant(async(req: Request) => {
  const auth = await requireSession(); if (auth.response) return auth.response;
  const problem = workbenchScopeProblem(req,requireTenant().id,auth.user.id,true);
  if (problem) return Response.json({error:problem},{status:409,headers});
  try { return Response.json(await listProjectLibrary(auth.user.id,new URL(req.url).searchParams),{headers}); }
  catch (error) { return failure(error); }
});
async function changeFiling(req:Request,remove:boolean) {
  const auth = await requireSession(); if (auth.response) return auth.response;
  const problem = workbenchScopeProblem(req,requireTenant().id,auth.user.id,true);
  if (problem) return Response.json({error:problem},{status:409,headers});
  if (req.headers.get('origin') && req.headers.get('origin') !== new URL(req.url).origin)
    return Response.json({error:'Invalid request origin.'},{status:403,headers});
  const body = await req.json().catch(()=>null);
  if (!body || typeof body.projectId !== 'string' || typeof body.uploadId !== 'string' || Object.keys(body).some(key=>!['projectId','uploadId'].includes(key)))
    return Response.json({error:'Choose a saved Studio project and upload.'},{status:400,headers});
  try { await (remove?unlinkProjectLibraryUpload:linkProjectLibraryUpload)(auth.user.id,body.projectId,body.uploadId); return Response.json({ok:true},{headers}); }
  catch (error) { return failure(error); }
}
export const POST=withTenant((req:Request)=>changeFiling(req,false));
export const DELETE=withTenant((req:Request)=>changeFiling(req,true));
