import { NextResponse } from "next/server";
import { db, ready, now, id } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { PROVIDERS } from "@/lib/providers";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const got = await requireAdmin();
  if (got.response) return got.response;
  await ready();
  const body = await req.json().catch(() => ({}));
  const amount = Number(body.amountUsd);
  if (!Number.isFinite(amount) || amount === 0)
    return NextResponse.json({ error: "A non-zero amount is required" }, { status: 400 });

  const provider = PROVIDERS.some((p) => p.id === body.provider) ? String(body.provider) : "byteplus";
  await db().execute({
    sql: `INSERT INTO topups (id, provider, amount_usd, note, created_at) VALUES (?,?,?,?,?)`,
    args: [id("top"), provider, amount, String(body.note ?? "").slice(0, 200), now()],
  });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request) {
  const got = await requireAdmin();
  if (got.response) return got.response;
  await ready();
  const topupId = new URL(req.url).searchParams.get("id");
  if (!topupId) return NextResponse.json({ error: "id required" }, { status: 400 });
  await db().execute({ sql: `DELETE FROM topups WHERE id=?`, args: [topupId] });
  return NextResponse.json({ ok: true });
}
