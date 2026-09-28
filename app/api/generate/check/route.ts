import { requireUser, withTenant } from "@/lib/auth";
import { requireTenant } from "@/lib/tenant";
import { checkGenerationRequest, generationFingerprint } from "@/lib/generationRequests";
import { checkTranscriptionRequest } from "@/lib/transcription";
import { workbenchScopeProblem } from "@/lib/workbench/request-scope";

export const dynamic = "force-dynamic";

/** The paid routes whose claim is bound in the same write as the job it makes (atomicBinding). */
const CHECKABLE = new Set(["/api/generate", "/api/audio", "/api/audio/dub"]);
/** Transcription answers in its reply rather than with a job: its check returns that saved reply (checkTranscriptionRequest). */
const TRANSCRIBE = "/api/audio/transcribe";
const KEY = /^[A-Za-z0-9._:-]{8,160}$/;

/**
 * Did a paid request whose reply was lost land? The browser that claimed it
 * asks before it does anything else about it, naming the request exactly as
 * it was sent: its Idempotency-Key, route and body. Landed: the job is
 * followed (for a transcription, its saved transcript is returned), and
 * nothing is sent again. Never arrived: its key is fenced here, so it cannot
 * land afterwards, and what is on screen now may go under a new key at the
 * price on the button. The person's own claims, in this workspace's database
 * only. Nothing here spends.
 */
export const POST = withTenant(async function POST(req: Request) {
  const got = await requireUser();
  if (got.response) return got.response;
  const problem = workbenchScopeProblem(req, requireTenant().id, got.user.id, !got.token);
  if (problem) return Response.json({ error: problem }, { status: 409 });
  const input = (await req.json().catch(() => null)) as { key?: unknown; endpoint?: unknown; body?: unknown } | null;
  let body: unknown = null;
  try { body = typeof input?.body === "string" ? JSON.parse(input.body) : null; } catch { body = null; }
  if (!input || typeof input.key !== "string" || !KEY.test(input.key) || typeof input.endpoint !== "string" || !(CHECKABLE.has(input.endpoint) || input.endpoint === TRANSCRIBE) || !body || typeof body !== "object" || Array.isArray(body))
    return Response.json({ error: "Name the request to check: its key, route and body." }, { status: 400 });
  const asked = {
    userId: got.user.id,
    key: input.key,
    /* What POST to that route computed for it (withGenerationRequest). */
    fingerprint: generationFingerprint({ method: "POST", path: input.endpoint, body }),
  };
  const checked = input.endpoint === TRANSCRIBE ? await checkTranscriptionRequest(asked) : await checkGenerationRequest(asked);
  if (checked.state === "mismatch") return Response.json({ error: "This Idempotency-Key names a different request." }, { status: 409 });
  return Response.json(checked, { headers: { "Cache-Control": "no-store" } });
});
