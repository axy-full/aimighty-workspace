import { recoveryRoute } from "@/lib/recovery";
import { NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { readRollout, setNewInterfaceEveryone } from "@/lib/shell/new-interface.server";

export const dynamic = "force-dynamic";

/**
 * The new-interface switch for every workspace at once (lib/shell/new-interface.ts), from the platform owner's desk.
 * Per-workspace flips go through PATCH /api/admin/workspaces/[id] (`newInterface`). The platform owner only; a
 * workspace's own admin can never turn it on, and nothing here touches money, plans or sign-in.
 */
export const GET = recoveryRoute(async function GET() {
  const got = await requireSuperAdmin();
  if (got.response) return got.response;
  const rollout = await readRollout();
  return NextResponse.json({ everyone: rollout.everyone, workspaces: rollout.workspaces.length });
});

export const PATCH = recoveryRoute(async function PATCH(req: Request) {
  const got = await requireSuperAdmin();
  if (got.response) return got.response;
  const body = await req.json().catch(() => ({}));
  if (typeof body.everyone !== "boolean") return NextResponse.json({ error: "everyone must be true or false." }, { status: 400 });
  const rollout = await setNewInterfaceEveryone(body.everyone, got.user.id);
  return NextResponse.json({ ok: true, everyone: rollout.everyone });
});
