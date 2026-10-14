import { z } from "zod";
import { requireUser, withTenant } from "@/lib/auth";
import { requireTenant } from "@/lib/tenant";
import { AccountError, takeAccountLimit } from "@/lib/accountDb";
import { readBoundedText, RequestBodyError } from "@/lib/requestBody";
import { readDraft } from "@/lib/workbench/records";
import { workbenchScopeProblem } from "@/lib/workbench/request-scope";
import { extractProduct } from "@/lib/workbench/product-extraction";
import { ProductExtractionError } from "@/lib/workbench/product-fetch";

export const runtime = "nodejs";
export const maxDuration = 30;
const headers = { "Cache-Control": "private, no-store" };
const inputSchema = z
  .object({
    projectId: z.string().regex(/^[a-zA-Z0-9-]{1,100}$/),
    url: z.string().trim().min(1).max(2048),
  })
  .strict();
/** Read-only POST keeps product URLs out of browser/API query logs. */
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
          { error: "Send a valid product URL and saved project." },
          { status: 400, headers },
        );
      }
      const input = inputSchema.safeParse(value);
      if (!input.success)
        return Response.json(
          { error: "Choose a saved project and a public product URL." },
          { status: 400, headers },
        );
      if (!(await readDraft(auth.user.id, input.data.projectId)))
        return Response.json(
          {
            error:
              "Save this project in your workspace before inspecting a product page.",
          },
          { status: 404, headers },
        );
      await takeAccountLimit(
        `product-extraction:${workspace.id}:${auth.user.id}`,
        10,
        60_000,
      );
      return Response.json(await extractProduct(input.data.url), { headers });
    } catch (error) {
      const known =
        error instanceof ProductExtractionError ||
        error instanceof AccountError ||
        error instanceof RequestBodyError;
      return Response.json(
        {
          error: known
            ? error.message
            : "The product page could not be inspected. Try again or enter its details manually.",
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
