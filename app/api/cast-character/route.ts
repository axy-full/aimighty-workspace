import { after } from "next/server";
import { reserveRecoveryContinuation } from "@/lib/recovery";
import { requireRender, requireUser, withTenant } from "@/lib/auth";
import { ANSWER_AFTER_MS, withGenerationRequest } from "@/lib/generationRequests";
import { admitCastCharacter, castCharacterOn, castCharacterStatus } from "@/lib/castCharacter";
import { admissionResponse } from "@/lib/admissionSupport";
import { sampleWorkspaceOff } from "@/lib/demo/spend-guard.server";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * An AI-made character (lib/castCharacter.ts): portrait, character sheet, cast member and identity under one price and one approval. Quote with `quoteOnly`, or approve
 * (`maxCredits`) under an Idempotency-Key: the run goes on after the reply when it takes long, and a replay under the key gets its answer. AI-made only: no consent is asked.
 */
export const POST = withTenant(async function POST(req: Request) {
  const got = await requireRender();
  if (got.response) return got.response;
  const body = await req.clone().json().catch(() => ({}));
  const perform = async (requestClaim?: import("@/lib/generationRequests").GenerationRequest) =>
    admissionResponse(
      await admitCastCharacter(body, got, {
        requestClaim,
        defer: async (work) => {
          after(await reserveRecoveryContinuation("after-response", work));
        },
      }),
    );
  if (body.quoteOnly === true) return perform();
  /* The sample workspace spends nothing, for anyone: answered before the request is claimed. A quote still answers. */
  { const off = await sampleWorkspaceOff(); if (off) return off; }
  return withGenerationRequest(req, got.user.id, perform, { answerAfterMs: ANSWER_AFTER_MS });
});

/** Where a character stands: `?versionId=`. Reads only. */
export const GET = withTenant(async function GET(req: Request) {
  const got = await requireUser();
  if (got.response) return got.response;
  if (!(await castCharacterOn())) return Response.json({ error: "There is no such tool here." }, { status: 404 });
  const status = await castCharacterStatus(new URL(req.url).searchParams.get("versionId") ?? "", got.user.id);
  if (!status) return Response.json({ error: "There is no such character." }, { status: 404 });
  return Response.json(status);
});
