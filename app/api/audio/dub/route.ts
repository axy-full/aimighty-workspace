import { after } from "next/server";
import { reserveRecoveryContinuation } from "@/lib/recovery";
import { requireRender, withTenant } from "@/lib/auth";
import { withGenerationRequest } from "@/lib/generationRequests";
import { executeDubbingAdmission } from "@/lib/dubbing";
import { admissionResponse } from "@/lib/admissionSupport";

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
  return body.quoteOnly === true ? perform() : withGenerationRequest(req, got.user.id, perform);
});
