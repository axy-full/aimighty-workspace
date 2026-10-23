import { after } from "next/server";
import { reserveRecoveryContinuation } from "@/lib/recovery";
import { requireRender, withTenant } from "@/lib/auth";
import { withGenerationRequest } from "@/lib/generationRequests";
import { executeRecraftAdmission } from "@/lib/recraftImage";
import { admissionResponse } from "@/lib/admissionSupport";
import { sampleWorkspaceOff } from "@/lib/demo/spend-guard.server";
import { tokenSpendRefusal } from "@/lib/tokenSpend";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Recraft (lib/recraftImage.ts): `{ tool: "image" | "remove_background" | "vectorize" }`. Quote with `quoteOnly`, or approve (`maxCredits`) and fund one job under an Idempotency-Key. SVG output is refused (no sanitiser yet).
 * Not here at all (404) unless the engine is on for the workspace.
 */
export const POST = withTenant(async function POST(req: Request) {
  const got = await requireRender();
  if (got.response) return got.response;
  const body = await req.clone().json().catch(() => ({}));
  const perform = async (requestClaim?: import("@/lib/generationRequests").GenerationRequest) =>
    admissionResponse(
      await executeRecraftAdmission(body, got, {
        requestClaim,
        defer: async (work) => {
          after(await reserveRecoveryContinuation("after-response", work));
        },
      }),
    );
  if (body.quoteOnly === true) return perform();
  /* The sample workspace spends nothing, for anyone: answered before the request is claimed. A quote still answers. */
  { const off = await sampleWorkspaceOff(); if (off) return off; }
  /* A token or an MCP client spends only with a ceiling and the quote it was approved at, as `maxCredits` (lib/tokenSpend.ts): refused before
     the request is claimed. A person's press is not asked here. */
  { const refused = tokenSpendRefusal({ maxCredits: body.maxCredits }, got.token); if (refused) return refused; }
  return withGenerationRequest(req, got.user.id, perform, { atomicBinding: true });
});
