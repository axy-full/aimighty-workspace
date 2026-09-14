import {recoveryRoute} from '@/lib/recovery';
import { NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { platformDb, platformReady } from "@/lib/platform";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ code: string }> };

export const DELETE = recoveryRoute(async function DELETE(_req: Request, { params }: Ctx) {
  const got = await requireSuperAdmin();
  if (got.response) return got.response;
  await platformReady();
  const { code } = await params;
  await platformDb().execute({ sql: `DELETE FROM signup_invites WHERE code = ? AND used_at IS NULL`, args: [code] });
  return NextResponse.json({ ok: true });
});
