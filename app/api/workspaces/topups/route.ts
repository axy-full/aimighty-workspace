import { NextResponse } from "next/server";
import { requireUser, withTenant } from "@/lib/auth";
import { requireTenant } from "@/lib/tenant";
import { creditState, creditsApply } from "@/lib/credits";
import { packs } from "@/lib/packs";
import { creditUsd } from "@/lib/creditTerms";
import { checkoutReady, paymentProvider, startCheckout } from "@/lib/payments";
import { listTopups, requestTopup, cancelTopup, OPEN_LIMIT } from "@/lib/topups";
import { listGrants, SUPER_ADMIN_EMAIL } from "@/lib/platform";
import { sendMail, mailConfigured, inviteOrigin } from "@/lib/mail";

export const dynamic = "force-dynamic";

/** The top-up screen's data: balance, packs, what is waiting, what came in. */
export const GET = withTenant(async function GET() {
  const got = await requireUser();
  if (got.response) return got.response;
  const ws = requireTenant();
  const applies = creditsApply(ws);
  const [credits, requests, history] = applies
    ? await Promise.all([creditState().catch(() => null), listTopups(ws.id), listGrants(ws.id, 20)])
    : [null, [], []];
  return NextResponse.json({
    applies,
    provider: paymentProvider(),
    canRequest: applies && got.user.role === "admin",
    openLimit: OPEN_LIMIT,
    /* The unit the packs were priced at, stated alongside them. `credits` also
       carries it, but only when the billing read succeeded — and the top-up
       screen's own sentence about what a credit costs must not disappear
       because a balance failed to load. Same source either way: creditUsd(). */
    creditUsd: creditUsd(),
    credits, packs: packs(), requests, history,
  });
});

/**
 * Ask for a pack. Owner or admin; the request waits for the platform to
 * answer, and nothing is charged here. `emailed` says whether the platform
 * admin was written to — never without a mail key (lib/mail mailConfigured).
 */
export const POST = withTenant(async function POST(req: Request) {
  const got = await requireUser();
  if (got.response) return got.response;
  const ws = requireTenant();
  if (!creditsApply(ws)) return NextResponse.json({ error: "The house workspace is never billed in credits; there is nothing to top up." }, { status: 400 });
  if (got.user.role !== "admin") return NextResponse.json({ error: "The owner or an admin asks for credits." }, { status: 403 });
  /* A provider this deployment cannot check out through takes no request: nothing is left waiting on the desk. */
  if (!checkoutReady()) return NextResponse.json({ error: "Buying credits is not set up on this deployment yet. Nothing was requested." }, { status: 503 });
  const body = await req.json().catch(() => ({}));
  let request: Awaited<ReturnType<typeof requestTopup>>;
  try {
    request = await requestTopup({ workspaceId: ws.id, packId: String(body.packId ?? ""), requestedBy: got.user.id, note: body.note ? String(body.note) : "" });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  let checkout: Awaited<ReturnType<typeof startCheckout>>;
  try {
    checkout = await startCheckout(request);
  } catch (e) {
    /* A request nobody can pay for does not wait on the desk: withdrawn (kept, never erased), and said. */
    await cancelTopup(request.id, ws.id).catch(() => false);
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  let emailed = false;
  if (checkout.kind === "queued" && mailConfigured() && SUPER_ADMIN_EMAIL) {
    const origin = inviteOrigin(req);
    const split = request.bonus > 0 ? ` (${request.credits.toLocaleString("en-US")} bought + ${request.bonus.toLocaleString("en-US")} free)` : "";
    const text = `${ws.name} asks for the ${request.label} pack: ${(request.credits + request.bonus).toLocaleString("en-US")} credits${split} · $${request.usd.toFixed(2)}.\n${request.note ? `Note: ${request.note}\n` : ""}\nAnswer it on the platform desk: ${origin}/admin`;
    emailed = await sendMail({ to: SUPER_ADMIN_EMAIL, subject: `Top-up requested: ${ws.name}`, text, html: `<p>${text.replace(/</g, "&lt;").replace(/\n/g, "<br>")}</p>` }).then(() => true, () => false);
  }
  return NextResponse.json({ request, checkout, emailed }, { status: 201 });
});

/** Withdraw a request that has not been answered. */
export const DELETE = withTenant(async function DELETE(req: Request) {
  const got = await requireUser();
  if (got.response) return got.response;
  const ws = requireTenant();
  if (got.user.role !== "admin") return NextResponse.json({ error: "The owner or an admin withdraws a request." }, { status: 403 });
  const id = new URL(req.url).searchParams.get("id") ?? "";
  const ok = await cancelTopup(id, ws.id);
  return ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "Nothing to cancel." }, { status: 404 });
});
