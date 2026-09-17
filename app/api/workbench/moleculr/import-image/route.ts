import { z } from "zod";
import { requireUser, withTenant } from "@/lib/auth";
import { requireTenant } from "@/lib/tenant";
import { AccountError, takeAccountLimit } from "@/lib/accountDb";
import { readBoundedText, RequestBodyError } from "@/lib/requestBody";
import { attachmentDisposition } from "@/lib/contentDisposition";
import { readDraft } from "@/lib/workbench/records";
import { workbenchScopeProblem } from "@/lib/workbench/request-scope";
import { downloadProductImage } from "@/lib/workbench/product-image";
import { ProductExtractionError } from "@/lib/workbench/product-fetch";

export const runtime = "nodejs";
export const maxDuration = 30;
const headers = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
};
const inputSchema = z
  .object({
    projectId: z.string().regex(/^[a-zA-Z0-9-]{1,100}$/),
    url: z.string().trim().min(1).max(2048),
  })
  .strict();
/** The validated master is bounded in memory; emit only on consumer demand so
 * Vercel uses a streamed response rather than its buffered payload path. */
function originalStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  let source: Uint8Array | null = bytes;
  let offset = 0;
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (!source) {
          controller.close();
          return;
        }
        const end = Math.min(offset + 64 * 1024, source.byteLength);
        controller.enqueue(source.subarray(offset, end));
        offset = end;
        if (offset === source.byteLength) {
          source = null;
          controller.close();
        }
      },
      cancel() {
        source = null;
      },
    },
    { highWaterMark: 0 },
  );
}
/** Explicit authenticated download only; normal uploads own persistence/quotas. */
export const POST = withTenant(
  async (req: Request) => {
    const auth = await requireUser();
    if (auth.response) return auth.response;
    const workspace = requireTenant();
    const scope = workbenchScopeProblem(
      req,
      workspace.id,
      auth.user.id,
      !auth.token,
    );
    if (scope) return Response.json({ error: scope }, { status: 409, headers });
    try {
      let value: unknown;
      try {
        value = JSON.parse(await readBoundedText(req, 4096));
      } catch (error) {
        if (error instanceof RequestBodyError) throw error;
        return Response.json(
          { error: "Send a valid image URL and saved project." },
          { status: 400, headers },
        );
      }
      const input = inputSchema.safeParse(value);
      if (!input.success)
        return Response.json(
          { error: "Choose a saved project and a public image URL." },
          { status: 400, headers },
        );
      if (!(await readDraft(auth.user.id, input.data.projectId)))
        return Response.json(
          {
            error:
              "Save this project in your workspace before importing an image.",
          },
          { status: 404, headers },
        );
      await takeAccountLimit(
        `product-image:${workspace.id}:${auth.user.id}`,
        12,
        60_000,
      );
      const original = await downloadProductImage(input.data.url);
      return new Response(originalStream(original.bytes), {
        headers: {
          ...headers,
          "Content-Type": original.mime,
          "Content-Disposition": attachmentDisposition(original.filename),
        },
      });
    } catch (error) {
      const known =
        error instanceof ProductExtractionError ||
        error instanceof AccountError ||
        error instanceof RequestBodyError;
      return Response.json(
        {
          error: known
            ? error.message
            : "The image could not be imported. Download an original you own and upload it directly.",
          code:
            error instanceof ProductExtractionError
              ? error.code
              : error instanceof AccountError
                ? "rate_limited"
                : "invalid_request",
        },
        { status: known ? error.status : 503, headers },
      );
    }
  },
  { requireRequestScope: true, readOnlyPostTransport: true },
);
