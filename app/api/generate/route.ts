import { after } from "next/server";
import { reserveRecoveryContinuation } from "@/lib/recovery";
import { requireRender, withTenant } from "@/lib/auth";
import { withGenerationRequest } from "@/lib/generationRequests";
import { executeGenerationAdmission } from "@/lib/generationAdmission";
import { admissionResponse } from "@/lib/admissionSupport";
import { sampleWorkspaceOff } from "@/lib/demo/spend-guard.server";
import { tokenSpendRefusal } from "@/lib/tokenSpend";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export const POST = withTenant(async function POST(req: Request) {
  const got = await requireRender();
  if (got.response) return got.response;
  /* The sample workspace spends nothing: answered before the request is claimed. */
  { const off = await sampleWorkspaceOff(); if (off) return off; }
  /* A token or an MCP client starts a take only with a ceiling and the quote it was approved at: its price as `maxCredits` and the
     quote's `quoteFingerprint` (lib/tokenSpend.ts). Refused before the request is claimed; a person's press is not asked here. */
  {
    const asked = await req.clone().json().catch(() => null);
    const refused = tokenSpendRefusal({ maxCredits: asked?.maxCredits, fingerprint: asked?.quoteFingerprint, needsFingerprint: true }, got.token);
    if (refused) return refused;
  }
  return withGenerationRequest(req, got.user.id, async (requestClaim) => {
    const body = await req.json().catch(() => ({}));
    if (!body || typeof body !== "object" || Array.isArray(body))
      return Response.json(
        { error: "Provide a generation request." },
        { status: 400 },
      );
    const fingerprint = body.quoteFingerprint;
    if (
      fingerprint != null &&
      (typeof fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(fingerprint))
    )
      return Response.json(
        { error: "Review a fresh generation quote." },
        { status: 400 },
      );
    delete body.quoteFingerprint;
    return admissionResponse(
      await executeGenerationAdmission(body, got, {
        requestClaim,
        checkpoint: fingerprint
          ? (value) =>
              value.quote.fingerprint === fingerprint
                ? undefined
                : {
                    status: 409,
                    body: {
                      error:
                        "The source, settings or price changed. Review a fresh quote before editing.",
                    },
                  }
          : undefined,
        defer: async (work) => {
          after(await reserveRecoveryContinuation("after-response", work));
        },
      }),
    );
  }, { atomicBinding: true });
});
