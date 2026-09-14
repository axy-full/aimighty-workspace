import { NextResponse } from "next/server";
import { requireUser, withTenant } from "@/lib/auth";
import { saveSubscription, knownPushService } from "@/lib/push";

export const dynamic = "force-dynamic";

export const POST = withTenant(async function POST(req: Request) {
  const got = await requireUser();
  if (got.response) return got.response;

  const body = await req.json().catch(() => ({}));
  const sub = body.subscription;
  if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
    return NextResponse.json({ error: "Bad subscription" }, { status: 400 });
  }
  /* An endpoint is a URL this server will POST to, unprompted, every time a
     notification fires — so "starts with https" is not enough of a check. It
     is a standing instruction to make outbound requests to wherever the
     caller named, which is an SSRF primitive with a scheduler attached.
     A push endpoint always belongs to a browser's own push service, and
     there are four. Anything else is not a subscription. */
  if (!knownPushService(String(sub.endpoint))) {
    return NextResponse.json({ error: "That isn't a push service endpoint." }, { status: 400 });
  }
  await saveSubscription(got.user.id, sub);
  return NextResponse.json({ ok: true });
}, { requireRequestScope: true });
