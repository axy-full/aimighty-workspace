import { NextResponse, after } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { setWorkspaceInternalTest, getWorkspace, setWorkspaceAllowance, setWorkspaceMode, platformKeysByDefault, grantCredits, setWorkspaceSuspended, setWorkspaceFlag, setWorkspaceLimits } from "@/lib/platform";
import { runInTenant } from "@/lib/tenant";
import { releaseHeldJobs } from "@/lib/held";

export const dynamic = "force-dynamic";

/**
 * One workspace, from the platform owner's desk: how much of the
 * platform's money it may spend a month, and whether it runs on the
 * platform's keys at all.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const got = await requireSuperAdmin();
  if (got.response) return got.response;
  const { id } = await params;
  const ws = await getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "No such workspace." }, { status: 404 });
  if (ws.legacy) return NextResponse.json({ error: "The studio's own workspace has no allowance — it is the platform." }, { status: 400 });
  const body = await req.json().catch(() => ({}));
  const out: Record<string, unknown> = { ok: true };
  if ("suspended" in body) {
    const on = Boolean(body.suspended);
    await setWorkspaceSuspended(id, on, on ? String(body.reason ?? "") : null);
    out.suspended = on;
  }
  if ("limits" in body && body.limits && typeof body.limits === "object") {
    const l = body.limits as Record<string, unknown>;
    const num = (v: unknown) => (v == null || v === "" ? null : Number(v));
    await setWorkspaceLimits(id, { concurrency: num(l.concurrency), rendersPerHour: num(l.rendersPerHour), storageGb: num(l.storageGb) });
    out.limits = true;
  }
  if ("internalTest" in body) {
    await setWorkspaceInternalTest(id, Boolean(body.internalTest));
    out.internalTest = Boolean(body.internalTest);
  }
  if ("flagged" in body) {
    const on = Boolean(body.flagged);
    await setWorkspaceFlag(id, on, on ? String(body.note ?? "") : null);
    out.flagged = on;
  }

  if ("allowanceUsd" in body) {
    const raw = body.allowanceUsd;
    const usd = raw === null || raw === "" ? null : Number(raw);
    if (usd !== null && (!Number.isFinite(usd) || usd < 0 || usd > 100_000)) {
      return NextResponse.json({ error: "The allowance is dollars a month, from 0 up." }, { status: 400 });
    }
    await setWorkspaceAllowance(id, usd);
    out.allowanceUsd = usd;
  }
  if ("grantCredits" in body) {
    const n = Number(body.grantCredits);
    if (!Number.isFinite(n) || n === 0 || Math.abs(n) > 1_000_000) {
      return NextResponse.json({ error: "Credits to add: a number, negative to take some away." }, { status: 400 });
    }
    await grantCredits(id, n, String(body.note ?? "Added by management"), got.user.id);
    // Credits arriving release what they cover, oldest take first.
    try {
      const ws = await getWorkspace(id);
      if (ws) out.released = (await runInTenant(ws, () => releaseHeldJobs({ defer: (fn) => after(fn) }))).released.length;
    } catch (e) { console.error("release after grant:", (e as Error).message); }
    out.granted = n;
  }
  if ("mode" in body) {
    const mode = body.mode === "platform" ? "platform" : body.mode === "own" ? "own" : null;
    if (!mode) return NextResponse.json({ error: "mode must be platform or own." }, { status: 400 });
    if (mode === "platform" && !platformKeysByDefault()) {
      return NextResponse.json({ error: "The platform doesn't lend its keys on this deployment." }, { status: 400 });
    }
    await setWorkspaceMode(id, mode === "platform");
    out.mode = mode;
  }
  return NextResponse.json(out);
}
