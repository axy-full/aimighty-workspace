import { z } from "zod";
import { requireOwner, requireRender, withTenant } from "@/lib/auth";
import { getConsumerConnection } from "@/lib/higgsfield-consumer/oauth";
import { ConsumerGenjutsuError } from "@/lib/higgsfield-consumer/genjutsu-sources";
import { consumerGenerationInputSchema } from "@/lib/higgsfield-consumer/generation-contract";
import { CatalogueError, CONNECTED_OUTPUT_TYPES, MEDIA_LIMIT, PROMPT_LIMIT } from "@/lib/higgsfield-consumer/catalogue";
import { ConsumerVideoServiceError } from "@/lib/higgsfield-consumer/video-service";
import { requireTenant } from "@/lib/tenant";
import { AccountError, takeAccountLimit } from "@/lib/accountDb";
import { readBoundedText, RequestBodyError } from "@/lib/requestBody";
import { ConsumerOAuthError } from "@/lib/higgsfield-consumer/oauth";
import { ConsumerDiscoveryError } from "@/lib/higgsfield-consumer/mcp";
import { buildConnectedCharacter, connectedCharacters, connectedPlan, SOUL_BUILD_STILLS, SOUL_BUILD_TYPES } from "@/lib/higgsfield-consumer/characters";
import { buildConnectedElement, connectedElements } from "@/lib/higgsfield-consumer/elements";
import { ConsumerJobError } from "@/lib/higgsfield-consumer/jobs";
import { ConsumerOriginalError } from "@/lib/higgsfield-consumer/video-original";
import { ConsumerVideoError } from "@/lib/higgsfield-consumer/video-contract";
import { GENERATION_SOURCE_BYTES } from "@/lib/higgsfield-consumer/generation-sources";
import { CONNECTED_TOOLS } from "@/lib/higgsfield-consumer/tools";
import {
  connectedGenerationCatalogue,
  consumerGenerationJobs,
  presentCatalogue,
  quoteConsumerGeneration,
  submitConsumerGenerationJob,
  pollConsumerGeneration,
} from "@/lib/higgsfield-consumer/generation-service";
import { connectedExplainerPresets } from "@/lib/higgsfield-consumer/explainer-service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 180;
const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
const id = z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/);
const catalogue = z
  .object({ action: z.literal("catalogue"), refresh: z.boolean().optional(), type: z.enum(CONNECTED_OUTPUT_TYPES).optional() })
  .strict();
const quote = z
  .object({ action: z.literal("quote"), draftId: id, input: consumerGenerationInputSchema, idempotencyKey: z.uuid() })
  .strict();
const submit = z
  .object({ action: z.literal("submit"), draftId: id, id: z.uuid(), workspaceId: z.uuid(), credits: z.number().nonnegative().max(100000) })
  .strict();
const poll = z.object({ action: z.literal("status"), draftId: id, id: z.uuid() }).strict();
/** Read-only explainer style listing (slice F6); nothing is generated from it. */
const explainer = z.object({ action: z.literal("explainer-presets"), refresh: z.boolean().optional() }).strict();
/** The account's trained characters (Soul IDs), for a Soul model's `soul_id`. */
const characters = z.object({ action: z.literal("characters") }).strict();
/** The plan gate before a Soul ID build (free read), and the build itself (Cast › Build identity; FINAL_SPEC §3 › Soul ID). */
const charactersPlan = z.object({ action: z.literal("characters-plan") }).strict();
const charactersCreate = z.object({
  action: z.literal("characters-create"),
  name: z.string().trim().min(1).max(80),
  type: z.enum(SOUL_BUILD_TYPES),
  sources: z.array(z.union([z.object({ uploadId: z.string().min(1).max(64) }).strict(), z.object({ genId: z.string().min(1).max(64) }).strict()])).min(SOUL_BUILD_STILLS.min).max(SOUL_BUILD_STILLS.max),
  /** The project the identity was built for; Particl's own record, never sent to the account. */
  projectId: z.string().min(1).max(64).optional(),
}).strict();
/** Reference elements Particl created (Cast & Elements), and one create from Particl's own images. */
const elements = z.object({ action: z.literal("elements") }).strict();
const elementsCreate = z.object({
  action: z.literal("elements-create"), name: z.string().trim().min(1).max(32), category: z.enum(["character", "environment", "prop"]), description: z.string().max(1000).default(""),
  sources: z.array(z.union([z.object({ uploadId: z.string().max(100) }).strict(), z.object({ genId: z.string().max(100) }).strict()])).min(1).max(8),
  projectId: z.string().regex(/^[a-zA-Z0-9-]{1,100}$/).optional(),
}).strict();
const requestSchema = z.discriminatedUnion("action", [catalogue, quote, submit, poll, explainer, characters, charactersPlan, charactersCreate, elements, elementsCreate]);
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
  if (error instanceof CatalogueError || error instanceof ConsumerGenjutsuError)
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
      error: error.code === "quote_expired" ? "This quote expired. Request a fresh quote before generating."
        : error.code === "capacity" ? "Four connected-account jobs are already active or awaiting reconciliation."
        : "This job changed or is unavailable. Refresh before continuing.",
    }, { status: error.status, headers });
  if (error instanceof ConsumerVideoError)
    return Response.json({ code: error.code, error: neutral(error.message) }, { status: error.status, headers });
  if (error instanceof AccountError && error.status === 429)
    return Response.json({ error: "Too many requests. Try again shortly." }, { status: 429, headers });
  if (error instanceof RequestBodyError)
    return Response.json({ error: error.message }, { status: error.status, headers });
  if (error instanceof SyntaxError)
    return Response.json({ error: "Send a valid JSON generation request." }, { status: 400, headers });
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
        types: CONNECTED_OUTPUT_TYPES,
        tools: CONNECTED_TOOLS.map((tool) => ({ name: tool.name, label: tool.label, outputType: tool.outputType, sourceKind: tool.sourceKind, extraKinds: tool.extraKinds, models: tool.models })),
        promptLimit: PROMPT_LIMIT,
        maxMedias: MEDIA_LIMIT,
        maxMediaBytes: GENERATION_SOURCE_BYTES,
        maxOriginalBytes: 100 * 1024 * 1024,
        importsMediaForQuote: true,
        cancel: false,
      },
      jobs: await consumerGenerationJobs(owner.user.id, draftId),
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
      return Response.json({ error: "Review the generation request." }, { status: 400, headers });
    const body = parsed.data;
    await takeAccountLimit(
      `hf-consumer-generation:${requireTenant().id}:${owner.user.id}:${body.action}`,
      body.action === "status" ? 30 : body.action === "catalogue" || body.action === "explainer-presets" || body.action === "characters" || body.action === "characters-plan" || body.action === "elements" ? 12 : body.action === "characters-create" || body.action === "elements-create" ? 3 : 6,
      60_000,
    );
    if (body.action === "catalogue")
      return Response.json(
        { catalogue: presentCatalogue(await connectedGenerationCatalogue(owner.user.id, { refresh: body.refresh === true }), body.type) },
        { headers },
      );
    if (body.action === "characters")
      return Response.json(await connectedCharacters(owner.user.id), { headers });
    if (body.action === "characters-plan")
      return Response.json({ plan: await connectedPlan(owner.user.id) }, { headers });
    if (body.action === "elements")
      return Response.json(await connectedElements(owner.user.id), { headers });
    if (body.action === "elements-create") {
      const render = await requireRender();
      if (render.response) return render.response;
      return Response.json({ build: await buildConnectedElement(owner.user.id, { name: body.name, category: body.category, description: body.description, sources: body.sources, projectId: body.projectId ?? null }) }, { headers });
    }
    if (body.action === "characters-create") {
      const render = await requireRender();
      if (render.response) return render.response;
      return Response.json({ build: await buildConnectedCharacter(owner.user.id, { name: body.name, type: body.type, sources: body.sources, projectId: body.projectId ?? null }) }, { headers });
    }
    if (body.action === "explainer-presets")
      return Response.json({ explainer: await connectedExplainerPresets(owner.user.id, { refresh: body.refresh === true }) }, { headers });
    if (body.action === "submit") {
      const render = await requireRender();
      if (render.response) return render.response;
      return Response.json(
        { job: await submitConsumerGenerationJob({ userId: owner.user.id, draftId: body.draftId, id: body.id }, body) },
        { headers },
      );
    }
    if (body.action === "status")
      return Response.json(await pollConsumerGeneration({ userId: owner.user.id, draftId: body.draftId, id: body.id }), { headers });
    return Response.json(
      { job: await quoteConsumerGeneration(owner.user.id, body.draftId, body.input, body.idempotencyKey) },
      { headers },
    );
  } catch (error) {
    return problem(error);
  }
}, { requireRequestScope: true });
