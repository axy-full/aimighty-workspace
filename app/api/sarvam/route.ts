import { after } from "next/server";
import { reserveRecoveryContinuation } from "@/lib/recovery";
import { requireRender, withTenant } from "@/lib/auth";
import { withGenerationRequest } from "@/lib/generationRequests";
import { executeSarvamAdmission, recordedSarvamReply } from "@/lib/sarvamTools";
import { admissionResponse } from "@/lib/admissionSupport";
import { sampleWorkspaceOff } from "@/lib/demo/spend-guard.server";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Sarvam's tools (lib/sarvamTools.ts): `{ tool: "speech" | "transcribe" | "translate" }`. Quote with `quoteOnly`, or approve (`maxCredits`) and run one
 * request under an Idempotency-Key. Not here at all (404) unless the engine is on for the workspace.
 */
export const POST = withTenant(async function POST(req: Request) {
  const got = await requireRender();
  if (got.response) return got.response;
  const body = await req.clone().json().catch(() => ({}));
  const perform = async (requestClaim?: import("@/lib/generationRequests").GenerationRequest) =>
    admissionResponse(
      await executeSarvamAdmission(body, got, {
        requestClaim,
        defer: async (work) => {
          after(await reserveRecoveryContinuation("after-response", work));
        },
      }),
    );
  if (body.quoteOnly === true) return perform();
  /* The sample workspace spends nothing, for anyone: answered before the request is claimed. A quote still answers. */
  { const off = await sampleWorkspaceOff(); if (off) return off; }
  /* A transcript or a translation is returned to the caller and never written to the claim (a replay answers "done, not kept"). */
  return withGenerationRequest(req, got.user.id, perform, { atomicBinding: true, recorded: recordedSarvamReply });
});
