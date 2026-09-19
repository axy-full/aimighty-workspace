import type { NextRequest } from "next/server";
import { serve } from "inngest/next";
import { inngest, inngestConfigured } from "@/lib/inngest";
import { dispatchMode } from "@/lib/dispatch";
import { functions } from "@/lib/workers";
import { developmentWorker } from "@/lib/workbench/development-worker";

/**
 * The whole Inngest integration surface: one route, three verbs.
 *
 * PUT registers the functions with Inngest, GET reports what this
 * deployment serves, and POST is how Inngest asks a function to run. Like
 * /api/worker it is not behind requireUser, because the caller is Inngest
 * rather than a person — the signing key is what authenticates it.
 *
 * Inngest is optional now (docs/native-dispatch.md): this route only
 * answers when DISPATCH_MODE=inngest and both keys are present. Otherwise
 * dispatch is native and this says so, rather than letting the library
 * throw something nobody can act on.
 */

export const dynamic = "force-dynamic";
// A worker gets the same ceiling as the routes whose work it will take over.
export const maxDuration = 300;

const handler = serve({ client: inngest, functions: [...functions, developmentWorker] });

function notConfigured(): Response {
  return Response.json(
    {
      configured: false,
      dispatch: { mode: dispatchMode() },
      error:
        "Inngest isn't the dispatcher on this deployment: background work is " +
        `dispatched ${dispatchMode() === "native" ? "natively through /api/worker" : "inline"}. ` +
        "To use Inngest instead, set DISPATCH_MODE=inngest and add INNGEST_EVENT_KEY " +
        "and INNGEST_SIGNING_KEY (the Vercel marketplace integration sets both), then redeploy.",
    },
    { status: 503 }
  );
}

export async function GET(req: NextRequest, ctx: unknown) {
  if (!inngestConfigured()) return notConfigured();
  return handler.GET(req, ctx);
}

export async function POST(req: NextRequest, ctx: unknown) {
  if (!inngestConfigured()) return notConfigured();
  return handler.POST(req, ctx);
}

export async function PUT(req: NextRequest, ctx: unknown) {
  if (!inngestConfigured()) return notConfigured();
  return handler.PUT(req, ctx);
}
