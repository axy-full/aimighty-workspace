import { requireUser, withTenant } from "@/lib/auth";
import { requireTenant } from "@/lib/tenant";
import { workbenchScopeProblem } from "@/lib/workbench/request-scope";
import { higgsfieldConfigured } from "@/lib/higgsfield";
import { AccountError, takeAccountLimit } from "@/lib/accountDb";
import {
  listMarketingPresets,
  MARKETING_CAPABILITIES,
  MarketingError,
} from "@/lib/higgsfieldMarketing";

export const dynamic = "force-dynamic";
export const maxDuration = 30;
const headers = { "Cache-Control": "private, no-store" };

/** Only public preset metadata is returned; no provider account or media records. */
export const GET = withTenant(async (req: Request) => {
  const got = await requireUser();
  if (got.response) return got.response;
  const workspace = requireTenant();
  const problem = workbenchScopeProblem(
    req,
    workspace.id,
    got.user.id,
    !got.token,
  );
  if (problem)
    return Response.json({ error: problem }, { status: 409, headers });
  if (!higgsfieldConfigured())
    return Response.json(
      {
        configured: false,
        error:
          "Connect the identity account before discovering Product image presets.",
        code: "not_configured",
      },
      { status: 503, headers },
    );
  try {
    await takeAccountLimit(
      `higgsfield-presets:${workspace.id}:${got.user.id}`,
      30,
      60_000,
    );
    const query = new URL(req.url).searchParams;
    /* `search` narrows the catalogue at the provider (1–100 characters); a page of it goes by the same cursor. */
    const page = await listMarketingPresets(
      query.get("cursor") ?? undefined,
      query.get("search") ?? undefined,
    );
    return Response.json(
      { configured: true, ...page, capabilities: MARKETING_CAPABILITIES },
      { headers },
    );
  } catch (error) {
    const known =
      error instanceof MarketingError || error instanceof AccountError;
    return Response.json(
      {
        configured: true,
        error: known
          ? error.message
          : "Product image presets are temporarily unavailable.",
        code:
          error instanceof MarketingError
            ? error.code
            : error instanceof AccountError
              ? "rate_limited"
              : "provider_unavailable",
      },
      { status: known ? error.status : 503, headers },
    );
  }
});
