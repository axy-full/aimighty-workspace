import { z } from "zod";
import { requireRender, withTenant } from "@/lib/auth";
import { currentTenant } from "@/lib/tenant";
import { readBoundedText } from "@/lib/requestBody";
import { sampleWorkspaceOff } from "@/lib/demo/spend-guard.server";
import { NOTHING_BILLED, PDF_PRICE, PdfError, deckRequestSchema } from "@/lib/pdf/contract";
import { makeDeckPdf } from "@/lib/pdf/run";
import { pdfAllowedFor } from "@/lib/pdf/switch";

/**
 * Deck PDFs (treatment, pitch deck, PPM deck): our own templates printed to PDF on our own export worker. FREE to customers (0 cr).
 * Off unless PDF_EXPORTS is on AND the workspace is the house workspace or one the owner lists (lib/pdf/switch.ts): otherwise every
 * method answers 404 before the body is read or anything is written or sent. The PDF is made while the request waits (a few seconds)
 * and comes back as an upload, opened by the same route as every other upload.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

const noStore = { "Cache-Control": "private, no-store" };
const reply = (data: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(data, { status, headers: { ...noStore, ...headers } });
const notFound = () => reply({ error: "Not found." }, 404);

export const GET = withTenant(async () => {
  if (!(await pdfAllowedFor(currentTenant()?.workspace))) return notFound();
  return reply({ price: PDF_PRICE, kinds: deckRequestSchema.shape.kind.options });
});

export const POST = withTenant(async (req: Request) => {
  if (!(await pdfAllowedFor(currentTenant()?.workspace))) return notFound();
  const auth = await requireRender();
  if (auth.response) return auth.response;
  try {
    const input = deckRequestSchema.parse(JSON.parse(await readBoundedText(req, 64 * 1024)));
    const sample = await sampleWorkspaceOff();
    if (sample) return sample;
    const deck = await makeDeckPdf(input, { id: auth.user.id, role: auth.user.role });
    return reply({ deck });
  } catch (error) {
    if (error instanceof PdfError) return reply({ error: error.message }, error.status, error.retryAfterSeconds ? { "Retry-After": String(error.retryAfterSeconds) } : {});
    if (error instanceof z.ZodError || error instanceof SyntaxError) return reply({ error: "The deck request is not valid." }, 400);
    const status = Number((error as { status?: number })?.status) || 500;
    return reply({ error: status >= 500 ? `The PDF could not be made. ${NOTHING_BILLED}` : (error as Error).message }, status);
  }
});
