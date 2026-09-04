import { NextResponse } from "next/server";
import { requireUser, requireAdmin } from "@/lib/auth";
import { listChecks, recordCheck, deleteCheck } from "@/lib/reconcile";

export const dynamic = "force-dynamic";

/** Every reading anyone has taken from a vendor's console. */
export async function GET(req: Request) {
  const got = await requireUser();
  if (got.response) return got.response;
  const provider = new URL(req.url).searchParams.get("provider") ?? undefined;
  return NextResponse.json({ checks: await listChecks(provider || undefined) });
}

/** Record what the console says. Admin only: it moves the headline figure. */
export async function POST(req: Request) {
  const got = await requireAdmin();
  if (got.response) return got.response;
  const body = await req.json().catch(() => ({}));
  const num = (v: unknown) =>
    v == null || v === "" || !Number.isFinite(Number(v)) ? null : Math.max(0, Number(v));
  try {
    const check = await recordCheck({
      provider: String(body.provider ?? "byteplus"),
      balanceUsd: num(body.balanceUsd),
      spendUsd: num(body.spendUsd),
      note: String(body.note ?? ""),
      // A reading is often typed up after the fact; let it carry its real date.
      checkedAt: body.checkedAt ? Number(body.checkedAt) : undefined,
      userId: got.user.id,
    });
    return NextResponse.json({ check }, { status: 201 });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}

export async function DELETE(req: Request) {
  const got = await requireAdmin();
  if (got.response) return got.response;
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  await deleteCheck(id);
  return NextResponse.json({ ok: true });
}
