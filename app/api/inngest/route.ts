import type { NextRequest } from "next/server";
import { serve } from "inngest/next";
import { inngest, inngestConfigured } from "@/lib/inngest";
import { functions } from "@/lib/workers";

/**
 * The whole integration surface: one route, three verbs.
 *
 * PUT registers the functions with Inngest, GET reports what this
 * deployment serves, and POST is how Inngest asks a function to run. It is
 * the ONLY route in the app not behind requireUser, because the caller is
 * Inngest rather than a person — the signing key is what authenticates it,
 * which is why the key is required in production and this refuses to
 * pretend otherwise without one.
 */

export const dynamic = "force-dynamic";
// A worker gets the same ceiling as the routes whose work it will take over.
export const maxDuration = 300;

const handler = serve({ client: inngest, functions });

/**
 * A missing key is a setup step, not a crash. Say which one, in the same
 * voice the engines use on the Settings screen, rather than letting the
 * library throw something nobody can act on.
 */
function notConfigured(): Response {
  return Response.json(
    {
      configured: false,
      error:
        "Inngest isn't connected on this deployment. Add the Inngest integration " +
        "from the Vercel marketplace — it sets INNGEST_EVENT_KEY and " +
        "INNGEST_SIGNING_KEY on the project — then redeploy.",
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
