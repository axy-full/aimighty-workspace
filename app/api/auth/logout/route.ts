import { accountRequestScopeMatches } from "@/lib/accountRequestScope";
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { SESSION_COOKIE, destroySession, currentContext } from "@/lib/auth";
import { sameOriginProblem } from "@/lib/accountDb";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (sameOriginProblem(req)) return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) {
    const ctx=await currentContext();
    if((req.headers.has("X-Workbench-Scope")||ctx?.workspace)&&(!ctx||!accountRequestScopeMatches(req,ctx)))return NextResponse.json({error:"Your account or workspace changed. Reload before signing out."},{status:409});
    await destroySession(token);
  }
  jar.delete(SESSION_COOKIE);
  return NextResponse.json({ ok: true });
}
