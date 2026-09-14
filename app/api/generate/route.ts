import { after } from "next/server";
import { requireRender, withTenant } from "@/lib/auth";
import { withGenerationRequest } from "@/lib/generationRequests";
import { executeGenerationAdmission } from "@/lib/generationAdmission";
import { admissionResponse } from "@/lib/admissionSupport";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export const POST = withTenant(async function POST(req: Request) {
  const got = await requireRender();
  if (got.response) return got.response;
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
        defer: (work) =>
          after(async () => {
            await work();
          }),
      }),
    );
  });
});
