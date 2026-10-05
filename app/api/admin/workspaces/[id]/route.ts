import {recoveryRoute} from '@/lib/recovery';
import { NextResponse, after } from "next/server";
import { asPlanId } from "@/lib/plans";
import { requireSuperAdmin } from "@/lib/auth";
import { setWorkspaceInternalTest, getWorkspace, setWorkspaceAllowance, setWorkspaceMode, platformKeysByDefault, grantCredits, setWorkspaceSuspended, setWorkspaceFlag, setWorkspaceLimits, setWorkspacePlan } from "@/lib/platform";
import { runInTenant } from "@/lib/tenant";
import { releaseHeldJobs } from "@/lib/held";
import { restoreDeletedWorkspace } from "@/lib/purge";
import { HOUSE_NOT_BILLED, isHouseWorkspace } from "@/lib/houseWorkspace";
import { setWorkspaceNewInterface } from "@/lib/shell/new-interface.server";

export const dynamic = "force-dynamic";

/**
 * One workspace, from the platform owner's desk: how much of the
 * platform's money it may spend a month, and whether it runs on the
 * platform's keys at all.
 */
export const PATCH = recoveryRoute(async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const got = await requireSuperAdmin();
  if (got.response) return got.response;
  const { id } = await params;
  const ws = await getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "No such workspace." }, { status: 404 });
  const body = await req.json().catch(() => ({}));
  /* A deleted workspace keeps its database and files, so it can be restored,
     and marked (suspended, flagged) before it is. Credits, plans and limits
     wait until then: a grant to a workspace nobody can open is money on a
     closed door. */
  if (body.restore === true) {
    if (!ws.deletedAt) return NextResponse.json({ error: "This workspace is not deleted." }, { status: 400 });
    try { await restoreDeletedWorkspace(id, got.user.id); }
    catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 409 }); }
    return NextResponse.json({ ok: true, restored: true });
  }
  const markKeys = ["suspended", "reason", "flagged", "note"];
  if (ws.deletedAt && Object.keys(body).some((k) => !markKeys.includes(k))) return NextResponse.json({ error: "This workspace was deleted. Restore it before changing it." }, { status: 409 });
  if ("mode" in body && body.mode !== "platform")
    return NextResponse.json({ error: "All workspaces use Particl credits and managed engines." }, { status: 400 });
  /* The house workspace is never billed in credits (lib/houseWorkspace.ts): a
     grant or an allowance means nothing there. Everything else — suspending
     it, its limits, its flags, its plan, and whether it is the platform's
     test workspace — applies to it like any other. Checked before anything
     is written, so a mixed request changes nothing. */
  if (isHouseWorkspace(ws) && ["grantCredits", "allowanceUsd"].some((k) => k in body))
    return NextResponse.json({ error: HOUSE_NOT_BILLED }, { status: 400 });
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
  /* The per-workspace "new interface" switch (lib/shell/new-interface.ts): a workspace setting, off by default, the platform
     owner's alone. It changes which screens the shell draws, never what anything costs, who may sign in, or what is stored. */
  if ("newInterface" in body) {
    if (typeof body.newInterface !== "boolean") return NextResponse.json({ error: "newInterface must be true or false." }, { status: 400 });
    if (!(await setWorkspaceNewInterface(id, body.newInterface, got.user.id))) return NextResponse.json({ error: "The new interface could not be changed for this workspace." }, { status: 400 });
    out.newInterface = body.newInterface;
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
    /* `manual`, which counts as free. Management adding credits is usually
       goodwill; when it is a payment taken off-platform there is nowhere yet
       to say so, and booking goodwill as revenue is the worse mistake. */
    await grantCredits(id, n, String(body.note ?? "Added by management"), got.user.id, "manual");
    // Credits arriving release what they cover, oldest take first.
    try {
      const ws = await getWorkspace(id);
      if (ws) out.released = (await runInTenant(ws, () => releaseHeldJobs({ defer: (fn) => after(fn) }))).released.length;
    } catch (e) { console.error("release after grant:", (e as Error).message); }
    out.granted = n;
  }
  if ("planId" in body) {
    /* null takes a workspace off its plan. An unknown id is refused rather
       than quietly stored: a workspace pointing at a plan that does not
       exist would read as "no plan" everywhere and be impossible to tell
       from one that genuinely has none. */
    const raw = body.planId;
    const plan = raw === null ? null : asPlanId(raw);
    if (raw !== null && !plan) {
      return NextResponse.json({ error: `No such plan: ${String(raw)}.` }, { status: 400 });
    }
    await setWorkspacePlan(id, plan);
    out.planId = plan;
  }
  if ("mode" in body) {
    const mode = body.mode === "platform" ? "platform" : body.mode === "own" ? "own" : null;
    if (!mode) return NextResponse.json({ error: "mode must be platform or own." }, { status: 400 });
    if (mode === "platform" && !platformKeysByDefault()) {
      return NextResponse.json({ error: "The platform doesn't lend its keys on this deployment." }, { status: 400 });
    }
    await setWorkspaceMode(id, mode === "platform", got.user.id);
    out.mode = mode;
  }
  return NextResponse.json(out);
});
