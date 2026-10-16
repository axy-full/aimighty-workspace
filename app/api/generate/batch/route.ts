import { after } from "next/server";
import { reserveRecoveryContinuation } from "@/lib/recovery";
import { requireRender, withTenant } from "@/lib/auth";
import { withGenerationRequest } from "@/lib/generationRequests";
import { admitBatch } from "@/lib/batchPress";
import { admissionResponse } from "@/lib/admissionSupport";
import { sampleWorkspaceOff } from "@/lib/demo/spend-guard.server";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * A multi-shot press as ONE job (lib/batchPress.ts): `{ members: [<a generation request>, ...] }`. Quote with `quoteOnly` (the server prices every member itself and judges the SUM
 * against the approval line); press with `maxCredits` (the total) and the quote's `fingerprint`, under an Idempotency-Key. One approval covers exactly the listed members.
 */
export const POST = withTenant(async function POST(req: Request) {
  const got = await requireRender();
  if (got.response) return got.response;
  const body = await req.clone().json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) return Response.json({ error: "Provide the shots to make." }, { status: 400 });
  const perform = async (requestClaim?: import("@/lib/generationRequests").GenerationRequest) =>
    admissionResponse(
      await admitBatch(body, got, {
        requestClaim,
        defer: async (work) => {
          after(await reserveRecoveryContinuation("after-response", work));
        },
      }),
    );
  if (body.quoteOnly === true) return perform();
  { const off = await sampleWorkspaceOff(); if (off) return off; }
  return withGenerationRequest(req, got.user.id, perform);
});
