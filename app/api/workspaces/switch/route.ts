import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { SESSION_COOKIE, currentContext } from "@/lib/auth";
import { switchSessionWorkspace } from "@/lib/platform";
import {sameOriginProblem} from "@/lib/accountDb";

export const dynamic = "force-dynamic";

/** Move this session into another workspace the account belongs to. */
export async function POST(req: Request) {
  if(sameOriginProblem(req))return Response.json({error:"Invalid request origin."},{status:403});
  const ctx = await currentContext();
  if (!ctx) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const id = String(body.id ?? "");
  if (!ctx.workspaces.some((w) => w.id === id)) return NextResponse.json({ error: "Not a workspace of yours." }, { status: 403 });
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  await switchSessionWorkspace(token, id);
  return NextResponse.json({ ok: true, active: id });
}
