import { NextResponse, after } from "next/server";
import { currentContext,requireOwner,withTenant,SESSION_COOKIE } from "@/lib/auth";
import {cookies} from "next/headers";
import {requireTenant} from "@/lib/tenant";
import {platformDb,now,switchSessionWorkspace} from "@/lib/platform";
import {requestWorkspace,resumeWorkspace,pendingWorkspaces,workspaceCreationReadiness} from "@/lib/workspaceProvisioning";
import {accountFailure,sameOriginProblem,AccountError} from "@/lib/accountDb";
import { deletionAllowed } from "@/lib/deletion";
import { markWorkspaceDeleted, purgeWorkspace } from "@/lib/purge";

export const dynamic = "force-dynamic";
export const maxDuration=300;

/** The workspaces this account belongs to, and which one the session is in. */
export async function GET() {
  const ctx = await currentContext();
  if (!ctx) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  return NextResponse.json({ active: ctx.workspace?.id ?? null, workspaces: ctx.workspaces, pending:await pendingWorkspaces(ctx.user.id),...workspaceCreationReadiness() });
}

/** Another workspace of one's own — a second studio, a client, a side project. */
export async function POST(req: Request) {
  if(sameOriginProblem(req))return Response.json({error:'Invalid request origin.'},{status:403});
  const ctx=await currentContext();if(!ctx)return Response.json({error:'Not signed in'},{status:401});
  try{
    const body=await req.json().catch(()=>({}));
    let requestId=String(body.requestId??'');
    if(!requestId){
      const readiness=workspaceCreationReadiness();if(!readiness.canCreate)throw new AccountError(readiness.reason!,503);
      requestId=await requestWorkspace({owner:{id:ctx.user.id,email:ctx.user.email,name:ctx.user.name},name:String(body.name??'')});
    }
    const result=await resumeWorkspace(requestId,ctx.user.id);
    if(result.workspace){
      const token=(await cookies()).get(SESSION_COOKIE)?.value;if(token)await switchSessionWorkspace(token,result.workspace.id);
      return Response.json({ok:true,workspace:{id:result.workspace.id,name:result.workspace.name,slug:result.workspace.slug}},{status:201});
    }
    return Response.json({ok:true,provisioning:result.provisioning,next:'/billing?onboarding=1'},{status:202});
  }catch(error){return accountFailure(error);}
}

/** Workspace identity is editable only by its signed-in owner. */
export const PATCH=withTenant(async(req:Request)=>{
  const got=await requireOwner();if(got.response)return got.response;
  const body=await req.json().catch(()=>({})),name=String(body.name??'').trim();
  if(!name||name.length>80)return Response.json({error:'Use a workspace name between 1 and 80 characters.'},{status:400});
  const ws=requireTenant();
  await platformDb().execute({sql:'UPDATE workspaces SET name=?,updated_at=? WHERE id=? AND deleted_at IS NULL',args:[name,now(),ws.id]});
  return Response.json({ok:true,workspace:{id:ws.id,name,slug:ws.slug}});
});

/**
 * Delete the workspace the session is in: the owner, by its exact name.
 * The record goes at once; the purge — every file, the key, the database —
 * runs after the response. Everything already billed stays on the
 * platform's books.
 */
export async function DELETE(req: Request) {
  const ctx = await currentContext();
  if (!ctx) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const ws = ctx.workspace;
  if (!ws) return NextResponse.json({ error: "Pick a workspace first." }, { status: 400 });
  const body = await req.json().catch(() => ({}));
  const verdict = deletionAllowed({ name: ws.name, legacy: ws.legacy, role: ctx.role }, String(body.name ?? ""));
  if (!verdict.ok) return NextResponse.json({ error: verdict.error }, { status: 400 });
  await markWorkspaceDeleted(ws.id);
  after(async () => { await purgeWorkspace(ws); });
  const left = ctx.workspaces.filter((w) => w.id !== ws.id);
  return NextResponse.json({ ok: true, deleted: ws.id, next: left[0]?.id ?? null });
}
