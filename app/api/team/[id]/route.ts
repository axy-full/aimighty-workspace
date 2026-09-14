import { securityAuditStatement } from "@/lib/securityAudit";
import { NextResponse } from "next/server";
import { requireAdmin, withTenant, isPlatformOwner } from "@/lib/auth";
import { requireTenant } from "@/lib/tenant";
import { platformDb, platformReady, now, getPlatformLayer } from "@/lib/platform";
import {accountTransaction,accountFailure,AccountError} from "@/lib/accountDb";
import {repairPendingMemberships,ensureMemberSeat} from "@/lib/teamInvitations";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };
/* eslint-disable @typescript-eslint/no-explicit-any */

const PROTECTED = { error: "That account owns the workspace. It can't be demoted, disabled or removed." };

async function member(wsId: string, accountId: string) {
  const rs = await platformDb().execute({
    sql: `SELECT a.id, a.email, a.name, m.role, m.disabled FROM memberships m JOIN accounts a ON a.id = m.account_id
          WHERE m.workspace_id = ? AND m.account_id = ? AND a.deleted_at IS NULL LIMIT 1`,
    args: [wsId, accountId],
  });
  return (rs.rows[0] as any) ?? null;
}

/** Change standing, disable or re-enable, or clear a lockout — within this workspace. */
export const PATCH = withTenant(async function PATCH(req: Request, { params }: Ctx) {
  const got = await requireAdmin();
  if (got.response) return got.response;
  const ws = requireTenant();
  await platformReady();
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  if(body.role!==undefined&&!['admin','member'].includes(String(body.role)))return Response.json({error:'Choose admin or member.'},{status:400});
  if(body.disabled!==undefined&&typeof body.disabled!=='boolean')return Response.json({error:'Disabled must be true or false.'},{status:400});
  if(body.role===undefined&&body.disabled===undefined&&body.unlock!==true)return Response.json({error:"Choose a membership change."},{status:400});
  const target = await member(ws.id, id);
  if (!target) return NextResponse.json({ error: "No such member" }, { status: 404 });
  const owner = got.user.owner || (await isPlatformOwner(got.user));

  if (body.role !== undefined && !owner) {
    return NextResponse.json({ error: "Only the workspace owner can change what someone is." }, { status: 403 });
  }
  if (target.role === "owner") {
    const harmful = (body.role !== undefined && body.role !== "admin") || (body.disabled !== undefined && Boolean(body.disabled));
    if (harmful) return NextResponse.json(PROTECTED, { status: 400 });
  }
  if (id === got.user.id && body.disabled === true) {
    return NextResponse.json({ error: "You can't disable your own account." }, { status: 400 });
  }

  const layer=await getPlatformLayer();
  try{await accountTransaction(async tx=>{
    const fresh=(await tx.execute({sql:'SELECT role,disabled FROM memberships WHERE workspace_id=? AND account_id=?',args:[ws.id,id]})).rows[0];
    if(!fresh)throw new AccountError("No such member",404);
    if(fresh.role==="owner"&&(body.role!==undefined||body.disabled===true))throw new AccountError(PROTECTED.error,400);
    if(body.disabled===false&&fresh.disabled)await ensureMemberSeat(tx,ws,layer);
    if ((body.role === "admin" || body.role === "member") && target.role !== "owner")
      await tx.execute({sql:"UPDATE memberships SET role=? WHERE workspace_id=? AND account_id=? AND role<>'owner'",args:[body.role,ws.id,id]});
    if(typeof body.disabled==='boolean'){
      await tx.execute({sql:"UPDATE memberships SET disabled=? WHERE workspace_id=? AND account_id=? AND role<>'owner'",args:[body.disabled?1:0,ws.id,id]});
      if(body.disabled){
        await tx.execute({sql:'DELETE FROM workspace_invites WHERE workspace_id=? AND email=? AND used_at IS NULL',args:[ws.id,String(target.email)]});
        await tx.execute({sql:'DELETE FROM p_sessions WHERE workspace_id=? AND account_id=?',args:[ws.id,id]});
      }
    }
    if(body.unlock===true||body.disabled===false)await tx.execute({sql:"UPDATE accounts SET failed_count=0,locked_until=NULL WHERE id=?",args:[id]});
    await tx.execute(securityAuditStatement({workspaceId:ws.id,actorId:got.user.id,action:"member.updated",targetType:"member",targetId:id,details:{...(body.role!==undefined?{role:body.role}:{}),...(typeof body.disabled==="boolean"?{disabled:body.disabled}:{}),...(body.unlock===true?{unlocked:true}:{})}}));
    await tx.execute({sql:'INSERT INTO membership_mirrors(workspace_id,account_id,updated_at) VALUES(?,?,?) ON CONFLICT(workspace_id,account_id) DO UPDATE SET updated_at=excluded.updated_at',args:[ws.id,id,now()]});
  });}catch(error){return accountFailure(error);}
  await repairPendingMemberships(id).catch(()=>{});
  return NextResponse.json({ ok: true });
}, { requireRequestScope: true });

/**
 * Remove someone from this workspace. Their account lives on — they may
 * belong to other workspaces — and their renders here keep their name.
 */
export const DELETE = withTenant(async function DELETE(_req: Request, { params }: Ctx) {
  const got = await requireAdmin();
  if (got.response) return got.response;
  const ws = requireTenant();
  await platformReady();
  const { id } = await params;
  if (id === got.user.id) return NextResponse.json({ error: "You can't remove yourself." }, { status: 400 });
  const target = await member(ws.id, id);
  if (!target) return NextResponse.json({ error: "No such member" }, { status: 404 });
  if (target.role === "owner") return NextResponse.json(PROTECTED, { status: 400 });
  try{await accountTransaction(async tx=>{
    const fresh=(await tx.execute({sql:"SELECT role FROM memberships WHERE workspace_id=? AND account_id=?",args:[ws.id,id]})).rows[0];
    if(!fresh)throw new AccountError("No such member",404);
    if(fresh.role==="owner")throw new AccountError(PROTECTED.error,400);
    await tx.execute({sql:"DELETE FROM memberships WHERE workspace_id=? AND account_id=? AND role<>'owner'",args:[ws.id,id]});
    await tx.execute({sql:'DELETE FROM p_sessions WHERE account_id=? AND workspace_id=?',args:[id,ws.id]});
    await tx.execute({sql:'DELETE FROM workspace_invites WHERE workspace_id=? AND email=? AND used_at IS NULL',args:[ws.id,String(target.email)]});
    await tx.execute({sql:'DELETE FROM membership_mirrors WHERE workspace_id=? AND account_id=?',args:[ws.id,id]});
    await tx.execute(securityAuditStatement({workspaceId:ws.id,actorId:got.user.id,action:"member.removed",targetType:"member",targetId:id}));
  });}catch(error){return accountFailure(error);}
  // Platform membership removal already revokes access even if this mirror is offline.
  const {db}=await import('@/lib/db');
  await db().batch([
    {sql:'UPDATE users SET disabled=1,deleted_at=? WHERE id=?',args:[now(),id]},
    {sql:'UPDATE api_tokens SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL',args:[now(),id]},
  ],'write').catch(()=>{});
  return NextResponse.json({ ok: true, name: target.name });
}, { requireRequestScope: true });
