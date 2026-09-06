import { NextResponse, after } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { topupQueue, decideTopup } from "@/lib/topups";
import { paymentProvider } from "@/lib/payments";

export const dynamic = "force-dynamic";

/** The platform's top-up queue. */
export async function GET() {
  const got = await requireSuperAdmin();
  if (got.response) return got.response;
  const queue = await topupQueue();
  return NextResponse.json({ ...queue, provider: paymentProvider() });
}

/** Answer one: approve adds the credits and releases held takes; decline leaves the balance alone. */
export async function PATCH(req: Request) {
  const got = await requireSuperAdmin();
  if (got.response) return got.response;
  const body = await req.json().catch(() => ({}));
  const action = body.action === "approve" ? "approve" : body.action === "decline" ? "decline" : null;
  if (!action || !body.id) return NextResponse.json({ error: "id and action (approve | decline) are needed." }, { status: 400 });
  try {
    const out = await decideTopup({ id: String(body.id), action, by: got.user.id, note: body.note ? String(body.note) : "", defer: (fn) => after(fn) });
    return NextResponse.json({ ok: true, ...out });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 409 });
  }
}
