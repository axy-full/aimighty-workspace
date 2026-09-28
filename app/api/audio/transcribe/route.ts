import { NextResponse } from "next/server";
import { requireRender, withTenant } from "@/lib/auth";
import { withGenerationRequest, type GenerationRequest } from "@/lib/generationRequests";
import { transcribe } from "@/lib/transcription";

export const dynamic = "force-dynamic";
/* A transcription's claim is known to be gone at twice this (TRANSCRIPTION_STALE_MS, lib/generationRequests.ts): raise both together. */
export const maxDuration = 300;

/**
 * Grok transcription of one stored original: quote with `quoteOnly`, then
 * transcribe under an Idempotency-Key, refused if the estimate has passed the
 * price shown (`maxCredits`). The same key is answered from its saved reply —
 * the transcript and what it was charged — and never billed again; a lost
 * reply is asked about through POST /api/generate/check, never re-sent. The
 * transcript is saved before it is charged, so a reply lost at any point
 * after the provider's answer was saved still comes back from the check.
 */
export const POST = withTenant(async function POST(req: Request) {
  const got = await requireRender();
  if (got.response) return got.response;
  const origin = req.headers.get("origin");
  if (origin && origin !== new URL(req.url).origin) return NextResponse.json({ error: "Invalid request origin" }, { status: 403 });
  const body = await req.clone().json().catch(() => ({}));
  const perform = async (claim?: GenerationRequest) => {
    const reply = await transcribe(body, got.user.id, { claim });
    return NextResponse.json(reply.body, { status: reply.status, headers: { "Cache-Control": "no-store" } });
  };
  return body?.quoteOnly === true ? perform() : withGenerationRequest(req, got.user.id, perform);
});
