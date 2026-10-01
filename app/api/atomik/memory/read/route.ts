import { NextResponse } from "next/server";
import { requireRender, withTenant } from "@/lib/auth";
import { readBoundedText, RequestBodyError } from "@/lib/requestBody";
import { resolveModel } from "@/lib/atomik";
import { gatewayReachable } from "@/lib/gateway";
import { vendorKey } from "@/lib/vendorKeys";
import { withGenerationRequest } from "@/lib/generationRequests";
import { PaidTextError, paidTextFailure, paidTextQuoteResponse, paidTextQuoteScopeFailure, requestMaxCredits } from "@/lib/paidText";
import { textRunCost } from "@/lib/textRunCost";
import { PROJECT_ID } from "@/lib/atomikMemoryText";
import { quoteMemoryRead, readText, runMemoryRead } from "@/lib/atomikMemoryRead";

export const dynamic = "force-dynamic";
/* A bounded 270 s provider attempt has room to finish before this route ends. */
export const maxDuration = 300;

/**
 * Atomik reads a paste or a document and proposes Memory entries
 * (lib/atomikMemoryRead.ts). Paid, so it needs the right to spend, and for a
 * signed-in person only, like the rest of Memory: an API token is refused.
 *
 *  POST {text, model?, projectId?, quoteOnly: true}   the approximate price: no claim, nothing reserved or sent
 *  POST {text, model?, projectId?, maxCredits}        the read, under the quoted ceiling the person approved,
 *                                                      sent once under its Idempotency-Key; a lost reply is
 *                                                      recovered with the same key, never read twice
 *
 * The reply lists the proposals for review and what the read was billed. None
 * is saved: the person ticks what to keep (POST /api/atomik/memory › keep).
 */

/** A 20,000-character paste, in any script, with its JSON around it. */
const BODY_BYTES = 100_000;

export const POST = withTenant(async (req: Request) => {
  const got = await requireRender();
  if (got.response) return got.response;
  if (got.token) return Response.json({ error: "Memory is for signed-in people. API tokens cannot read into it." }, { status: 403 });
  let body: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(await readBoundedText(req.clone(), BODY_BYTES));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new RequestBodyError(400);
    body = value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof RequestBodyError && error.status === 413) return Response.json({ error: "Atomik reads at most 20,000 characters at a time." }, { status: 413 });
    return Response.json({ error: "Invalid request JSON." }, { status: 400 });
  }
  const quoteOnly = body.quoteOnly === true;
  if (quoteOnly) { const scopeFailure = paidTextQuoteScopeFailure(req); if (scopeFailure) return scopeFailure; }
  const run = async () => {
    try {
      const text = readText(body.text);
      if (!gatewayReachable() && !vendorKey("openai"))
        return NextResponse.json({ error: "Atomik's reader isn't connected for this workspace. Use the free import, or ask the platform to connect it." }, { status: 503 });
      /* Atomik's model policy: Claude, OpenAI or Grok (lib/atomikModelPolicy), Auto by default; never swapped for another paid model. */
      const model = await resolveModel(typeof body.model === "string" ? body.model.slice(0, 120) : "auto", "idea");
      if (quoteOnly) return paidTextQuoteResponse(await quoteMemoryRead({ text, model }));
      /* Never without the price the person approved: the read is reserved and refused against it. */
      if (body.maxCredits === undefined) throw new PaidTextError("Review the price before Atomik reads this.", 409);
      const maxCredits = requestMaxCredits(body.maxCredits)!;
      const projectId = typeof body.projectId === "string" && PROJECT_ID.test(body.projectId) ? body.projectId : null;
      const result = await runMemoryRead({ text, model, maxCredits, projectId, createdBy: got.user.id });
      /* Credits as billed for a workspace on credits; dollars only for one on its own keys. */
      return NextResponse.json({ id: result.id, model, entries: result.read.entries, skipped: result.read.skipped, ...(await textRunCost(result)) });
    } catch (error) { return paidTextFailure(error); }
  };
  return quoteOnly ? run() : withGenerationRequest(req, got.user.id, run);
}, { requireRequestScope: true });
