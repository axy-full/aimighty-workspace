import { recoveryRoute } from "@/lib/recovery";
import { NextResponse } from "next/server";
import { currentContext, requireSuperAdmin } from "@/lib/auth";
import { AccountError, sameOriginProblem, takeAccountLimit } from "@/lib/accountDb";
import { workbenchScopeProblem } from "@/lib/workbench/request-scope";
import { backfillConsumerSubject } from "@/lib/higgsfield-consumer/oauth";
import {
  PlatformAccountError,
  designatePlatformAccount,
  platformAccountStatus,
  releasePlatformAccount,
  setPlatformAccountPaused,
  setPlatformAccountTools,
} from "@/lib/higgsfield-consumer/platform-account";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };

/**
 * The platform desk's website tools account: which connected account runs
 * website-only tools for every managed workspace, whether it can serve new
 * work, and which tools are switched on. The platform owner only, in a
 * signed-in browser; API tokens never reach it. Nothing here spends, and no
 * answer carries a token, a grant, an account identifier, a wallet or a price.
 */
async function caller() {
  const ctx = await currentContext();
  return ctx?.workspace && ctx.role === "owner" ? { ctx, identity: { workspaceId: ctx.workspace.id, userId: ctx.user.id } } : { ctx, identity: null };
}

export const GET = recoveryRoute(async function GET() {
  const got = await requireSuperAdmin();
  if (got.response) return got.response;
  try {
    const { identity } = await caller();
    return NextResponse.json(await platformAccountStatus(identity), { headers });
  } catch {
    return NextResponse.json({ error: "The website tools account could not be read. Try again." }, { status: 503, headers });
  }
});

/**
 * `designate`: the caller's own connection in the workspace they are in, which
 * they must own. `pause` / `resume`: new work stops or starts again; accepted
 * jobs keep collecting. `release`: stop designating. `tools`: the allowlist.
 */
export const POST = recoveryRoute(async function POST(req: Request) {
  if (sameOriginProblem(req)) return NextResponse.json({ error: "Invalid request origin." }, { status: 403, headers });
  const got = await requireSuperAdmin();
  if (got.response) return got.response;
  const { ctx, identity } = await caller();
  if (!ctx?.workspace) return NextResponse.json({ error: "Pick a workspace first." }, { status: 409, headers });
  if (ctx.mfaRequired)
    return NextResponse.json({ code: "MFA_REQUIRED", error: "This workspace requires two-step sign-in. Set up your authenticator to continue.", securityUrl: "/account/security" }, { status: 428, headers });
  if (workbenchScopeProblem(req, ctx.workspace.id, ctx.user.id, true))
    return NextResponse.json({ error: "Your account or workspace changed. Reload this page before continuing." }, { status: 409, headers });
  const body = (await req.json().catch(() => null)) as { action?: unknown; tools?: unknown; acknowledge?: unknown } | null;
  // Moving or releasing while its jobs are still in flight needs this, said once by the person.
  const acknowledgeInFlight = body?.acknowledge === true;
  const action = body?.action;
  if (!["designate", "pause", "resume", "release", "tools"].includes(String(action)) || (action === "tools" && !Array.isArray(body?.tools)))
    return NextResponse.json({ error: "Review the request." }, { status: 400, headers });
  try {
    await takeAccountLimit(`website-account:${ctx.user.id}`, 20, 60_000);
    if (action === "designate") {
      if (!identity) return NextResponse.json({ error: "Designate from a workspace you own." }, { status: 403, headers });
      // A grant that never recorded its account learns it with one free read first.
      await backfillConsumerSubject(identity);
      await designatePlatformAccount(identity, ctx.user.id, Date.now(), { acknowledgeInFlight });
    } else if (action === "pause" || action === "resume") await setPlatformAccountPaused(action === "pause", ctx.user.id);
    else if (action === "release") await releasePlatformAccount(ctx.user.id, { acknowledgeInFlight });
    else await setPlatformAccountTools(body!.tools as unknown[], ctx.user.id);
    return NextResponse.json(await platformAccountStatus(identity), { headers });
  } catch (error) {
    if (error instanceof PlatformAccountError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status, headers });
    if (error instanceof AccountError && error.status === 429) return NextResponse.json({ error: "Too many requests. Try again shortly." }, { status: 429, headers });
    return NextResponse.json({ error: "The website tools account could not be changed. Try again." }, { status: 503, headers });
  }
});
