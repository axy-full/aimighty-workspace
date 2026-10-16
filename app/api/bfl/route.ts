import { after } from "next/server";
import { reserveRecoveryContinuation } from "@/lib/recovery";
import { requireRender, withTenant } from "@/lib/auth";
import { withGenerationRequest } from "@/lib/generationRequests";
import { executeBflAdmission } from "@/lib/bflImage";
import { executeBflUpscaleAdmission } from "@/lib/bflUpscale";
import { admissionResponse } from "@/lib/admissionSupport";
import { sampleWorkspaceOff } from "@/lib/demo/spend-guard.server";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * FLUX.2 through BFL (lib/bflImage.ts): `{ tool: "image" | "edit" }`; and FLUX Video Upscale (lib/bflUpscale.ts): `{ tool: "upscale" }`, a clip in, the same clip larger out. Quote with `quoteOnly`, or approve (`maxCredits`) and fund one asynchronous job under an
 * Idempotency-Key. No face is checked (owner, 16 Oct 2026). Not here at all (404) unless the engine is on for the workspace.
 */
export const POST = withTenant(async function POST(req: Request) {
  const got = await requireRender();
  if (got.response) return got.response;
  const body = await req.clone().json().catch(() => ({}));
  const admit = body.tool === "upscale" ? executeBflUpscaleAdmission : executeBflAdmission;
  const perform = async (requestClaim?: import("@/lib/generationRequests").GenerationRequest) =>
    admissionResponse(
      await admit(body, got, {
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
