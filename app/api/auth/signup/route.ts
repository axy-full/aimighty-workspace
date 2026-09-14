import {recoveryRoute} from '@/lib/recovery';
import {cookies} from 'next/headers';
import {SESSION_COOKIE,createSession,currentContext,sourceKey} from '@/lib/auth';
import {platformDb,platformReady,now,switchSessionWorkspace} from '@/lib/platform';
import {policyAccepted} from '@/lib/policyAccept';
import {accountFailure,accountJson,AccountError,sameOriginProblem} from '@/lib/accountDb';
import {beginSignup,deliverSignupVerification,signupReadiness,acceptSignupInvitation} from '@/lib/signupRegistration';
import {resumeWorkspace,workspaceCreationReadiness} from '@/lib/workspaceProvisioning';

export const dynamic='force-dynamic';
export const maxDuration=300;
export const POST = recoveryRoute(async function POST(req:Request){
 if(sameOriginProblem(req))return Response.json({error:'Invalid request origin.'},{status:403});
 try{
  const body=await accountJson(req);
  if(!policyAccepted(body))throw new AccountError('Read the content policy and terms, and tick the box.');
  const input={name:String(body.name??''),email:String(body.email??''),workspace:String(body.workspace??''),password:String(body.password??''),planId:String(body.planId??''),cadence:String(body.cadence??'')};
  const code=String(body.code??'').trim();
  if(code){
   const readiness=workspaceCreationReadiness();if(!readiness.canCreate)throw new AccountError(readiness.reason!,503);
   const ctx=await currentContext();
   const accepted=await acceptSignupInvitation({...input,code},ctx?.user.id);
   // The account and resumable request survive every subsequent resource error.
   const session=await createSession(accepted.owner.id);
   (await cookies()).set(SESSION_COOKIE,session,{httpOnly:true,sameSite:'lax',secure:process.env.NODE_ENV==='production',path:'/',maxAge:30*86400});
   const result=await resumeWorkspace(accepted.requestId,accepted.owner.id);
   if(result.workspace){await switchSessionWorkspace(session,result.workspace.id);return Response.json({ok:true,workspace:{id:result.workspace.id,name:result.workspace.name,slug:result.workspace.slug},next:'/workbench?onboarding=1'});}
   return Response.json({ok:true,provisioning:result.provisioning,next:'/billing?onboarding=1'},{status:202});
  }
  const readiness=signupReadiness();if(!readiness.open)throw new AccountError(readiness.reason!,503);
  const registration=await beginSignup(input,sourceKey(req));
  const origin=process.env.APP_ORIGIN?.replace(/\/$/,'')||new URL(req.url).origin;
  await deliverSignupVerification(registration,origin);
  return Response.json({ok:true,verificationRequired:true,email:registration.email,message:'Check your email to verify your address. No credits or subscription are charged until you choose and pay for a plan.'},{status:202});
 }catch(error){
  if(error instanceof AccountError&&error.status===409)return Response.json({error:error.message,needsSignIn:true},{status:409});
  return accountFailure(error);
 }
});
export const GET = recoveryRoute(async function GET(req:Request){
 const code=new URL(req.url).searchParams.get('code');
 if(!code)return Response.json(signupReadiness(),{headers:{'Cache-Control':'no-store'}});
 await platformReady();
 const inv=(await platformDb().execute({sql:'SELECT email,name,used_at,expires_at FROM signup_invites WHERE code=?',args:[code]})).rows[0];
 if(!inv)return Response.json({error:'That invitation is not valid.'},{status:404});
 if(inv.used_at)return Response.json({error:'This invitation has already been used. Sign in to continue your workspace setup.'},{status:409});
 if(Number(inv.expires_at)<now())return Response.json({error:'This invitation has expired.'},{status:410});
 return Response.json({ok:true,email:inv.email,name:inv.name,open:workspaceCreationReadiness().canCreate},{headers:{'Cache-Control':'no-store'}});
});
