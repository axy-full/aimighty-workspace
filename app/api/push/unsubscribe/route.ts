import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { removeSubscription } from "@/lib/push";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const got = await requireUser();
  if (got.response) return got.response;
  const body = await req.json().catch(() => ({}));
  if (body.endpoint) await removeSubscription(String(body.endpoint));
  return NextResponse.json({ ok: true });
}
