import { NextResponse, after } from "next/server";
import { currentContext } from "@/lib/auth";
import { createWorkspace } from "@/lib/platform";
import { provisioningConfigured } from "@/lib/provision";
import { keyringConfigured } from "@/lib/keyring";
import { deletionAllowed } from "@/lib/deletion";
import { markWorkspaceDeleted, purgeWorkspace } from "@/lib/purge";

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
