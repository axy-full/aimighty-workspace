import { after } from "next/server";
import { reserveRecoveryContinuation } from "@/lib/recovery";
import { requireRender, withTenant } from "@/lib/auth";
import { withGenerationRequest } from "@/lib/generationRequests";
import { executeRunwayAdmission } from "@/lib/runwayTools";
import { admissionResponse } from "@/lib/admissionSupport";
import { sampleWorkspaceOff } from "@/lib/demo/spend-guard.server";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Runway (lib/runwayTools.ts): `{ tool: "performance" | "edit" | "video" }`. Quote with `quoteOnly`, or approve (`maxCredits`) and fund one asynchronous job under an
 * Idempotency-Key. No face is checked (owner, 16 Oct 2026). On standby: not here at all (404) except in the house workspace with the engine on.
 */
export const POST = withTenant(async function POST(req: Request) {
  const got = await requireRender();
  if (got.response) return got.response;
  const body = await req.clone().json().catch(() => ({}));
  const perform = async (requestClaim?: import("@/lib/generationRequests").GenerationRequest) =>
    admissionResponse(
      await executeRunwayAdmission(body, got, {
        requestClaim,
        defer: async (work) => {
          after(await reserveRecoveryContinuation("after-response", work));
        },
      }),
    );
  if (body.quoteOnly === true) return perform();
  /* The sample workspace spends nothing, for anyone: answered before the request is claimed. A quote still answers. */
  { const off = await sampleWorkspaceOff(); if (off) return off; }
  return withGenerationRequest(req, got.user.id, perform, { atomicBinding: true });
});
