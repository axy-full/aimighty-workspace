import { z } from "zod";
import { requireOwner, requireRender, withTenant } from "@/lib/auth";
import { getConsumerConnection } from "@/lib/higgsfield-consumer/oauth";
import { ConsumerGenjutsuError } from "@/lib/higgsfield-consumer/genjutsu-sources";
import {
  MARKETING_TEMPLATE_CATEGORIES,
  MARKETING_TEMPLATE_LIMITS,
  MarketingTemplateError,
  consumerMarketingTemplateInputSchema,
} from "@/lib/higgsfield-consumer/marketing-templates";
import { ConsumerVideoServiceError } from "@/lib/higgsfield-consumer/video-service";
import { requireTenant } from "@/lib/tenant";
import { AccountError, takeAccountLimit } from "@/lib/accountDb";
import { readBoundedText, RequestBodyError } from "@/lib/requestBody";
import { ConsumerOAuthError } from "@/lib/higgsfield-consumer/oauth";
import { ConsumerDiscoveryError } from "@/lib/higgsfield-consumer/mcp";
import { ConsumerJobError } from "@/lib/higgsfield-consumer/jobs";
import { ConsumerOriginalError } from "@/lib/higgsfield-consumer/video-original";
import { ConsumerVideoError } from "@/lib/higgsfield-consumer/video-contract";
import { GENERATION_SOURCE_BYTES } from "@/lib/higgsfield-consumer/generation-sources";
import {
  connectedMarketingTemplateCatalogue,
  connectedMarketingTemplateCosts,
  consumerMarketingTemplateJobs,
  presentMarketingTemplates,
  quoteConsumerMarketingTemplate,
  submitConsumerMarketingTemplateJob,
  pollConsumerMarketingTemplate,
} from "@/lib/higgsfield-consumer/marketing-template-service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 180;
const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
const id = z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/);
const catalogue = z
  .object({
    action: z.literal("catalogue"),
    refresh: z.boolean().optional(),
    category: z.enum(MARKETING_TEMPLATE_CATEGORIES).optional(),
    search: z.string().max(120).optional(),
    limit: z.number().int().min(1).max(400).optional(),
  })
  .strict();
const costs = z.object({ action: z.literal("costs"), refresh: z.boolean().optional() }).strict();
const quote = z
  .object({ action: z.literal("quote"), draftId: id, input: consumerMarketingTemplateInputSchema, idempotencyKey: z.uuid() })
  .strict();
const submit = z
  .object({ action: z.literal("submit"), draftId: id, id: z.uuid(), workspaceId: z.uuid(), credits: z.number().nonnegative().max(100000) })
  .strict();
const poll = z.object({ action: z.literal("status"), draftId: id, id: z.uuid() }).strict();
const requestSchema = z.discriminatedUnion("action", [catalogue, costs, quote, submit, poll]);
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
  if (error instanceof MarketingTemplateError || error instanceof ConsumerGenjutsuError)
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
      error: error.code === "quote_expired" ? "This quote expired. Request a fresh quote before creating."
        : error.code === "capacity" ? "All four connected-account slots are in use. Workspace › Engines lists yours."
        : "This job changed or is unavailable. Refresh before continuing.",
    }, { status: error.status, headers });
  if (error instanceof ConsumerVideoError)
    return Response.json({ code: error.code, error: neutral(error.message) }, { status: error.status, headers });
  if (error instanceof AccountError && error.status === 429)
    return Response.json({ error: "Too many requests. Try again shortly." }, { status: 429, headers });
  if (error instanceof RequestBodyError)
    return Response.json({ error: error.message }, { status: error.status, headers });
  if (error instanceof SyntaxError)
    return Response.json({ error: "Send a valid JSON template request." }, { status: 400, headers });
  return Response.json({ error: "The connected account could not complete this request. Check the saved job before trying again." }, { status: 503, headers });
}
export const GET = withTenant(async (req: Request) => {
  const owner = await requireOwner();
  if (owner.response) return owner.response;
  const draftId = new URL(req.url).searchParams.get("draftId") ?? "";
  if (!id.safeParse(draftId).success)
    return Response.json({ error: "Choose a valid project." }, { status: 400, headers });
  try {
    return Response.json({
      connection: await getConsumerConnection({ workspaceId: requireTenant().id, userId: owner.user.id }),
      capabilities: {
        categories: MARKETING_TEMPLATE_CATEGORIES,
        promptLimit: MARKETING_TEMPLATE_LIMITS.prompt,
        maxProductBytes: GENERATION_SOURCE_BYTES,
        maxOriginalBytes: 100 * 1024 * 1024,
        importsMediaForQuote: true,
        cancel: false,
      },
      jobs: await consumerMarketingTemplateJobs(owner.user.id, draftId),
    }, { headers });
  } catch (error) {
    return problem(error);
  }
}, { requireRequestScope: true });
export const POST = withTenant(async (req: Request) => {
  const owner = await requireOwner();
  if (owner.response) return owner.response;
  try {
    const raw = JSON.parse(await readBoundedText(req, 48000));
    const parsed = requestSchema.safeParse(raw);
    if (!parsed.success)
      return Response.json({ error: "Review the template request." }, { status: 400, headers });
    const body = parsed.data;
    await takeAccountLimit(
      `hf-consumer-marketing-templates:${requireTenant().id}:${owner.user.id}:${body.action}`,
      body.action === "status" ? 30 : body.action === "catalogue" || body.action === "costs" ? 12 : 6,
      60_000,
    );
    if (body.action === "catalogue") {
      const listing = await connectedMarketingTemplateCatalogue(owner.user.id, { refresh: body.refresh === true });
      let table = null;
      try {
        table = await connectedMarketingTemplateCosts(owner.user.id, { refresh: body.refresh === true });
      } catch (error) {
        // Browsing stays available without prices; quoting decides whether a price exists.
        if (!(error instanceof MarketingTemplateError || error instanceof ConsumerVideoError)) throw error;
      }
      return Response.json(
        { catalogue: presentMarketingTemplates(listing, table, { category: body.category, search: body.search, limit: body.limit }) },
        { headers },
      );
    }
    if (body.action === "costs") {
      const table = await connectedMarketingTemplateCosts(owner.user.id, { refresh: body.refresh === true });
      return Response.json({ costs: { version: table.version, entries: table.entries.length, fetchedAt: table.fetchedAt } }, { headers });
    }
    if (body.action === "submit") {
      const render = await requireRender();
      if (render.response) return render.response;
      return Response.json(
        { job: await submitConsumerMarketingTemplateJob({ userId: owner.user.id, draftId: body.draftId, id: body.id }, body) },
        { headers },
      );
    }
    if (body.action === "status")
      return Response.json(await pollConsumerMarketingTemplate({ userId: owner.user.id, draftId: body.draftId, id: body.id }), { headers });
    return Response.json(
      { job: await quoteConsumerMarketingTemplate(owner.user.id, body.draftId, body.input, body.idempotencyKey) },
      { headers },
    );
  } catch (error) {
    return problem(error);
  }
}, { requireRequestScope: true });
