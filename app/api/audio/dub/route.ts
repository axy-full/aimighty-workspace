import { after } from "next/server";
import { reserveRecoveryContinuation } from "@/lib/recovery";
import { requireRender, withTenant } from "@/lib/auth";
import { withGenerationRequest } from "@/lib/generationRequests";
import { executeDubbingAdmission } from "@/lib/dubbing";
import { admissionResponse } from "@/lib/admissionSupport";
import { sampleWorkspaceOff } from "@/lib/demo/spend-guard.server";
import { tokenSpendRefusal } from "@/lib/tokenSpend";
import { pressFigureRefusal } from "@/lib/pressFigure";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Dubbing: quote with `quoteOnly`, or fund one asynchronous project under an Idempotency-Key. */
export const POST = withTenant(async function POST(req: Request) {
  const got = await requireRender();
  if (got.response) return got.response;
  const body = await req.clone().json().catch(() => ({}));
  const perform = async (requestClaim?: import("@/lib/generationRequests").GenerationRequest) =>
    admissionResponse(
      await executeDubbingAdmission(body, got, {
        requestClaim,
        defer: async (work) => {
          after(await reserveRecoveryContinuation("after-response", work));
        },
      }),
    );
  if (body.quoteOnly === true) return perform();
  /* The sample workspace spends nothing: answered before the request is claimed. A quote still answers. */
  { const off = await sampleWorkspaceOff(); if (off) return off; }
  /* A token or an MCP client spends only with a ceiling and the quote it was approved at, as `maxCredits` (lib/tokenSpend.ts):
     refused before the request is claimed. */
  { const refused = tokenSpendRefusal({ maxCredits: body.maxCredits }, got.token); if (refused) return refused; }
  /* A person's press carries the figure that was on its button, like the Director press (owner, 21 Oct 2026; lib/pressFigure.ts):
     one without it is refused before the request is claimed, nothing filed, held or charged. A figure under today's price is
     refused by admission's own price check, with the new figure. */
  { const refused = pressFigureRefusal(body.maxCredits); if (refused) return refused; }
  return withGenerationRequest(req, got.user.id, perform, { atomicBinding: true });
});
