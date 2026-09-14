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
  return withGenerationRequest(req, got.user.id, async (requestClaim) =>
    admissionResponse(
      await executeGenerationAdmission(
        await req.json().catch(() => ({})),
        got,
        {
          requestClaim,
          defer: (work) =>
            after(async () => {
              await work();
            }),
        },
      ),
    ),
  );
});
