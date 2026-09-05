import { NextResponse } from "next/server";
import { requireUser, withTenant } from "@/lib/auth";
import { saveSubscription } from "@/lib/push";

export const dynamic = "force-dynamic";

export const POST = withTenant(async function POST(req: Request) {
  const got = await requireUser();
  if (got.response) return got.response;

  const body = await req.json().catch(() => ({}));
  const sub = body.subscription;
  if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
    return NextResponse.json({ error: "Bad subscription" }, { status: 400 });
  }
  if (!/^https:\/\//.test(String(sub.endpoint))) {
    return NextResponse.json({ error: "Bad endpoint" }, { status: 400 });
  }
  await saveSubscription(got.user.id, sub);
  return NextResponse.json({ ok: true });
});
