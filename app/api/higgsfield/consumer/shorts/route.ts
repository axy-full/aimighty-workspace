import { z } from "zod";
import { requireOwner, requireRender, withTenant } from "@/lib/auth";
import { getConsumerConnection, ConsumerOAuthError } from "@/lib/higgsfield-consumer/oauth";
import { ConsumerGenjutsuError } from "@/lib/higgsfield-consumer/genjutsu-sources";
import { ConsumerVideoServiceError } from "@/lib/higgsfield-consumer/video-service";
import { requireTenant } from "@/lib/tenant";
import { AccountError, takeAccountLimit } from "@/lib/accountDb";
import { readBoundedText, RequestBodyError } from "@/lib/requestBody";
import { ConsumerDiscoveryError } from "@/lib/higgsfield-consumer/mcp";
import { ConsumerJobError } from "@/lib/higgsfield-consumer/jobs";
import { ConsumerOriginalError } from "@/lib/higgsfield-consumer/video-original";
import { ConsumerVideoError } from "@/lib/higgsfield-consumer/video-contract";
import { GENERATION_SOURCE_BYTES } from "@/lib/higgsfield-consumer/generation-sources";
import { SHORTS_ASPECT_RATIOS, SHORTS_LIMITS, ShortsStudioError, consumerShortsInputSchema } from "@/lib/higgsfield-consumer/shorts-studio";
import {
  connectedShortsPresets,
  consumerShortsJobs,
  pollConsumerShorts,
  quoteConsumerShorts,
  submitConsumerShortsJob,
} from "@/lib/higgsfield-consumer/shorts-service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 180;
const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
const id = z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/);
const presets = z.object({ action: z.literal("presets"), refresh: z.boolean().optional() }).strict();
const quote = z.object({ action: z.literal("quote"), draftId: id, input: consumerShortsInputSchema, idempotencyKey: z.uuid() }).strict();
const submit = z
  .object({ action: z.literal("submit"), draftId: id, id: z.uuid(), workspaceId: z.uuid(), credits: z.number().nonnegative().max(100000) })
  .strict();
const poll = z.object({ action: z.literal("status"), draftId: id, id: z.uuid() }).strict();
const requestSchema = z.discriminatedUnion("action", [presets, quote, submit, poll]);
/** Shared consumer error classes predate the product vocabulary; this surface
 * speaks only of the connected account. */
const neutral = (message: string) =>
  message
    .replace(/\b(?:the|your|The|Your) Higgsfield\b/g, "the connected account")
    .replace(/\bHiggsfield(?:’s|'s)\b/g, "the connected account’s")
    .replace(/\bHiggsfield\b/g, "the connected account")
    .replace(/\bselected the connected account\b/g, "selected connected-account")
    .replace(/\bthe connected account account\b/g, "the connected account")
    .replace(/^the connected/, "The connected");
function problem(error: unknown) {
  if (error instanceof ShortsStudioError || error instanceof ConsumerGenjutsuError)
    return Response.json({ code: error.code, error: neutral(error.message) }, { status: error.status, headers });
  if (error instanceof ConsumerOriginalError)
    return Response.json({ code: `original_${error.code}`, error: neutral(error.message) }, {
      status: error.code === "quota" ? 507 : error.code === "timeout" ? 504 : error.code === "storage_unavailable" ? 503 : error.code === "invalid_video" ? 422 : error.code === "not_found" ? 404 : 409,
      headers,
    });
  if (error instanceof ConsumerOAuthError || error instanceof ConsumerDiscoveryError || error instanceof ConsumerVideoServiceError)
    return Response.json({ code: error.code, error: neutral(error.message) }, { status: error.status, headers });
  if (error instanceof ConsumerJobError)
    return Response.json({
      code: error.code,
      error: error.code === "quote_expired" ? "This quote expired. Request a fresh quote before making shorts."
        : error.code === "capacity" ? "Four connected-account jobs are already active or awaiting reconciliation."
        : "This session changed or is unavailable. Refresh before continuing.",
    }, { status: error.status, headers });
  if (error instanceof ConsumerVideoError)
    return Response.json({ code: error.code, error: neutral(error.message) }, { status: error.status, headers });
  if (error instanceof AccountError && error.status === 429)
    return Response.json({ error: "Too many requests. Try again shortly." }, { status: 429, headers });
  if (error instanceof RequestBodyError)
    return Response.json({ error: error.message }, { status: error.status, headers });
  if (error instanceof SyntaxError)
    return Response.json({ error: "Send a valid JSON Shorts request." }, { status: 400, headers });
  return Response.json({ error: "The connected account could not complete this request. Check the saved session before trying again." }, { status: 503, headers });
}
const capabilities = () => ({
  shorts: true,
  aspectRatios: SHORTS_ASPECT_RATIOS,
  resolution: "720p" as const,
  minSourceSeconds: SHORTS_LIMITS.minSeconds,
  maxSourceSeconds: SHORTS_LIMITS.maxSeconds,
  maxClips: SHORTS_LIMITS.clips,
  sourceKind: "video" as const,
  maxSourceBytes: GENERATION_SOURCE_BYTES,
  maxOriginalBytes: 100 * 1024 * 1024,
  importsMediaForQuote: true,
  priceSources: ["get_cost"] as const,
  cancel: false,
});
export const GET = withTenant(async (req: Request) => {
  const owner = await requireOwner();
  if (owner.response) return owner.response;
  const draftId = new URL(req.url).searchParams.get("draftId") ?? "";
  if (!id.safeParse(draftId).success)
    return Response.json({ error: "Choose a valid project." }, { status: 400, headers });
  try {
    return Response.json({
      connection: await getConsumerConnection({ workspaceId: requireTenant().id, userId: owner.user.id }),
      capabilities: capabilities(),
      jobs: await consumerShortsJobs(owner.user.id, draftId),
    }, { headers });
  } catch (error) {
    return problem(error);
  }
}, { requireRequestScope: true });
export const POST = withTenant(async (req: Request) => {
  const owner = await requireOwner();
  if (owner.response) return owner.response;
  try {
    const raw = JSON.parse(await readBoundedText(req, 16000));
    const parsed = requestSchema.safeParse(raw);
    if (!parsed.success)
      return Response.json({ error: "Review the Shorts request." }, { status: 400, headers });
    const body = parsed.data;
    await takeAccountLimit(
      `hf-consumer-shorts:${requireTenant().id}:${owner.user.id}:${body.action}`,
      body.action === "status" ? 30 : body.action === "presets" ? 12 : 6,
      60_000,
    );
    if (body.action === "presets")
      return Response.json({ presets: await connectedShortsPresets(owner.user.id, { refresh: body.refresh === true }) }, { headers });
    if (body.action === "submit") {
      const render = await requireRender();
      if (render.response) return render.response;
      return Response.json(
        { job: await submitConsumerShortsJob({ userId: owner.user.id, draftId: body.draftId, id: body.id }, body) },
        { headers },
      );
    }
    if (body.action === "status")
      return Response.json(await pollConsumerShorts({ userId: owner.user.id, draftId: body.draftId, id: body.id }), { headers });
    return Response.json(
      { job: await quoteConsumerShorts(owner.user.id, body.draftId, body.input, body.idempotencyKey) },
      { headers },
    );
  } catch (error) {
    return problem(error);
  }
}, { requireRequestScope: true });
