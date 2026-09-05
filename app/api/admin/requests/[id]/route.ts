import { NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { platformDb, platformReady, now } from "@/lib/platform";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** Mark an access request handled (declined, or answered by other means). */
export async function PATCH(_req: Request, { params }: Ctx) {
  const got = await requireSuperAdmin();
  if (got.response) return got.response;
  await platformReady();
  const { id } = await params;
  await platformDb().execute({ sql: `UPDATE access_requests SET handled_at = ? WHERE id = ?`, args: [now(), id] });
  return NextResponse.json({ ok: true });
}
