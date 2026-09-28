import { z } from "zod";
import { withTenant } from "@/lib/auth";
import { requireTenant } from "@/lib/tenant";
import { AccountError, takeAccountLimit } from "@/lib/accountDb";
import { readBoundedText, RequestBodyError } from "@/lib/requestBody";
import { ConsumerOAuthError } from "@/lib/higgsfield-consumer/oauth";
import { ConsumerDiscoveryError } from "@/lib/higgsfield-consumer/mcp";
import { ConsumerJobError } from "@/lib/higgsfield-consumer/jobs";
import { ConsumerOriginalError } from "@/lib/higgsfield-consumer/video-original";
import { ConsumerVideoError, consumerVideoInputSchema } from "@/lib/higgsfield-consumer/video-contract";
import { SETUP_TYPE_IDS, connectedMarketingSetup } from "@/lib/higgsfield-consumer/marketing-setup";
/* The standalone guard runs inside the quote services; a refusal answers 409 setup_not_particl. */
import { ConsumerSetupError } from "@/lib/higgsfield-consumer/marketing-records";
import { websiteProblem } from "@/lib/higgsfield-consumer/website-problems";
import { consumerCapacityMessage, takeWebsiteAccountRead, websiteToolCaller, websiteToolSpend, websiteToolsAvailability } from "@/lib/higgsfield-consumer/route-access";
import { readFunding } from "@/lib/higgsfield-consumer/funding";
import {
  MARKETING_VIDEO_REHEARSAL, ConsumerVideoServiceError, ensureConsumerRehearsal,
  consumerMarketingJobs, quoteConsumerMarketingVideo, submitConsumerMarketingVideo,
  pollConsumerMarketingVideo,
} from "@/lib/higgsfield-consumer/video-service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 180;
const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
const id = z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/);
const quote = z.object({ action: z.literal("quote"), draftId: id, input: consumerVideoInputSchema, idempotencyKey: z.uuid() }).strict();
const rehearse = z.object({ action: z.literal("quote-rehearsal"), idempotencyKey: z.uuid() }).strict();
/* A job on the platform's website account is approved by its Particl credits alone: it names no wallet. */
const submit = z.object({ action: z.literal("submit"), draftId: id, id: z.uuid(), workspaceId: z.uuid().nullable().optional(), credits: z.number().nonnegative().max(100000) }).strict();
const poll = z.object({ action: z.literal("status"), draftId: id, id: z.uuid() }).strict();
/** FINAL_SPEC §2.3: the account's setup items, by type; read-only, never billed. */
const setup = z.object({ action: z.literal("setup"), types: z.array(z.enum(SETUP_TYPE_IDS)).min(1).max(SETUP_TYPE_IDS.length).optional() }).strict();
const requestSchema = z.discriminatedUnion("action", [quote, rehearse, submit, poll, setup]);
function problem(error: unknown) {
  if (error instanceof ConsumerJobError && error.code === "particl_quote_unavailable")
    return Response.json({ code: error.code, error: error.message }, { status: error.status, headers });
  const website = websiteProblem(error);
  if (website) return Response.json(website.body, { status: website.status, headers });
  if (error instanceof ConsumerOriginalError)
    return Response.json({ code: `original_${error.code}`, error: error.message }, {
      status: error.code === "quota" ? 507 : error.code === "timeout" ? 504 : error.code === "storage_unavailable" ? 503 : error.code === "invalid_video" ? 422 : error.code === "not_found" ? 404 : 409,
      headers,
    });
  if (error instanceof ConsumerOAuthError || error instanceof ConsumerDiscoveryError || error instanceof ConsumerVideoServiceError)
    return Response.json({ code: error.code, error: error.message }, { status: error.status, headers });
  if (error instanceof ConsumerJobError)
    return Response.json({ code: error.code, error: error.code === "quote_expired" ? "This quote expired. Request a fresh quote before generating." : error.code === "capacity" ? consumerCapacityMessage() : "This job changed or is unavailable. Refresh before continuing." }, { status: error.status, headers });
  if (error instanceof ConsumerVideoError || error instanceof ConsumerSetupError)
    return Response.json({ code: error.code, error: error.message }, { status: error.status, headers });
  if (error instanceof AccountError && error.status === 429)
    return Response.json({ error: "Too many requests. Try again shortly." }, { status: 429, headers });
  if (error instanceof RequestBodyError)
    return Response.json({ error: error.message }, { status: error.status, headers });
  if (error instanceof SyntaxError)
    return Response.json({ error: "Send a valid JSON marketing request." }, { status: 400, headers });
  return Response.json({ error: "The connected account could not complete this request. Check the saved job before trying again." }, { status: 503, headers });
}
export const GET = withTenant(async (req: Request) => {
  const caller = await websiteToolCaller(); if (caller.response) return caller.response;
  const draftId = new URL(req.url).searchParams.get("draftId") ?? undefined;
  if (draftId !== undefined && !id.safeParse(draftId).success)
    return Response.json({ error: "Choose a valid project." }, { status: 400, headers });
  try {
    return Response.json({
      jobs: await consumerMarketingJobs(caller.user.id, draftId),
      // A managed workspace: whether the platform's website tools can take this work now.
      ...(caller.managed ? { websiteTools: await websiteToolsAvailability({ workflow: "marketing-video" }) } : {}),
    }, { headers });
  }
  catch (error) { return problem(error); }
}, { requireRequestScope: true });
export const POST = withTenant(async (req: Request) => {
  const caller = await websiteToolCaller(); if (caller.response) return caller.response;
  const userId = caller.user.id;
  try {
    const raw = JSON.parse(await readBoundedText(req, 24000));
    const parsed = requestSchema.safeParse(raw);
    if (!parsed.success) return Response.json({ error: "Review the marketing video request." }, { status: 400, headers });
    const body = parsed.data;
    // The owner's own connection check stays the owner's.
    if (body.action === "quote-rehearsal" && !caller.user.owner) return Response.json({ error: "The workspace owner only." }, { status: 403, headers });
    await takeAccountLimit(`hf-consumer-video:${requireTenant().id}:${userId}:${body.action}`, body.action === "status" ? 30 : 6, 60_000);
    await takeWebsiteAccountRead(caller);
    if (body.action === "submit") {
      const refused = await websiteToolSpend(caller, "submit"); if (refused) return refused;
      return Response.json({ job: await submitConsumerMarketingVideo({ userId, draftId: body.draftId, id: body.id }, body) }, { headers });
    }
    if (body.action === "status") return Response.json(await pollConsumerMarketingVideo({ userId, draftId: body.draftId, id: body.id }), { headers });
    if (body.action === "setup") return Response.json(await connectedMarketingSetup(userId, body.types ?? undefined, await readFunding({ workflow: "marketing-video" })), { headers });
    const refused = await websiteToolSpend(caller, "quote"); if (refused) return refused;
    const draftId = body.action === "quote-rehearsal" ? await ensureConsumerRehearsal(userId) : body.draftId;
    const input = body.action === "quote-rehearsal" ? MARKETING_VIDEO_REHEARSAL : body.input;
    return Response.json({ job: await quoteConsumerMarketingVideo(userId, draftId, input, body.idempotencyKey) }, { headers });
  } catch (error) { return problem(error); }
}, { requireRequestScope: true });
