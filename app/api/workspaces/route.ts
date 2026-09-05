import { NextResponse } from "next/server";
import { currentContext } from "@/lib/auth";
import { createWorkspace } from "@/lib/platform";
import { provisioningConfigured } from "@/lib/provision";
import { keyringConfigured } from "@/lib/keyring";

export const dynamic = "force-dynamic";

/** The workspaces this account belongs to, and which one the session is in. */
export async function GET() {
  const ctx = await currentContext();
  if (!ctx) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  return NextResponse.json({ active: ctx.workspace?.id ?? null, workspaces: ctx.workspaces });
}

/** Another workspace of one's own — a second studio, a client, a side project. */
export async function POST(req: Request) {
  const ctx = await currentContext();
  if (!ctx) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!provisioningConfigured() || !keyringConfigured()) {
    return NextResponse.json({ error: "New workspaces can't be created on this deployment yet — contact management." }, { status: 503 });
  }
  const body = await req.json().catch(() => ({}));
  const name = String(body.name ?? "").trim();
  if (!name) return NextResponse.json({ error: "Name the workspace." }, { status: 400 });
  if (ctx.workspaces.filter((w) => w.role === "owner").length >= 5) {
    return NextResponse.json({ error: "Five workspaces of your own is the ceiling — contact management for more." }, { status: 400 });
  }
  try {
    const ws = await createWorkspace({ name, owner: { id: ctx.user.id, email: ctx.user.email, name: ctx.user.name } });
    return NextResponse.json({ ok: true, workspace: { id: ws.id, name: ws.name, slug: ws.slug } });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
