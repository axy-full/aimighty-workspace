import { after } from "next/server";
import { reserveRecoveryContinuation } from "@/lib/recovery";
import { requireRender, requireUser, withTenant } from "@/lib/auth";
import { ANSWER_AFTER_MS, withGenerationRequest } from "@/lib/generationRequests";
import { admitHindiVersion, hindiVersionOn, hindiVersionStatus, recordedHindiReply } from "@/lib/hindiVersion";
import { admissionResponse } from "@/lib/admissionSupport";
import { sampleWorkspaceOff } from "@/lib/demo/spend-guard.server";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * The Hindi version (lib/hindiVersion.ts): translate, speak and lip-sync a cut's lines under one price and one approval. Quote with `quoteOnly`, or approve
 * (`maxCredits`) under an Idempotency-Key: the run goes on after the reply when it takes long, and a replay under the key gets its answer. Not here at all (404)
 * unless Sarvam is on for the workspace.
 */
export const POST = withTenant(async function POST(req: Request) {
  const got = await requireRender();
  if (got.response) return got.response;
  const body = await req.clone().json().catch(() => ({}));
  const perform = async (requestClaim?: import("@/lib/generationRequests").GenerationRequest) =>
    admissionResponse(
      await admitHindiVersion(body, got, {
        requestClaim,
        defer: async (work) => {
          after(await reserveRecoveryContinuation("after-response", work));
        },
      }),
    );
  if (body.quoteOnly === true) return perform();
  /* The sample workspace spends nothing, for anyone: answered before the request is claimed. A quote still answers. */
  { const off = await sampleWorkspaceOff(); if (off) return off; }
  return withGenerationRequest(req, got.user.id, perform, { answerAfterMs: ANSWER_AFTER_MS, recorded: recordedHindiReply });
});

/** Where a version stands: `?versionId=`. The lines, the voice and the synced take of each, from the takes it made. Reads only; the Hindi text is the voice take's own prompt. */
export const GET = withTenant(async function GET(req: Request) {
  const got = await requireUser();
  if (got.response) return got.response;
  if (!(await hindiVersionOn())) return Response.json({ error: "There is no such tool here." }, { status: 404 });
  const versionId = new URL(req.url).searchParams.get("versionId") ?? "";
  const status = await hindiVersionStatus(versionId);
  if (!status) return Response.json({ error: "There is no such version." }, { status: 404 });
  return Response.json(status);
});
