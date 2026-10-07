import { requireSuperAdmin, withTenant } from "@/lib/auth";
import { isHouseWorkspace } from "@/lib/houseWorkspace";
import { platformOwnerScrub } from "@/lib/platformOwnerScrub";
import { requireTenant } from "@/lib/tenant";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };

/**
 * What this workspace stored about the platform owner before the rule
 * (lib/platformOwnerScrub.ts). GET is the dry run: counts per column, nothing
 * written. POST rewrites, only with `confirm: true` and the dry run's total
 * as `expected`, so what runs is what was seen. The platform owner only,
 * inside the one workspace their session is in.
 */
export const GET = withTenant(async () => {
  const got = await requireSuperAdmin();
  if (got.response) return got.response;
  const ws = requireTenant();
  if (isHouseWorkspace(ws)) return Response.json({ error: "The house workspace keeps the platform owner's name." }, { status: 400, headers });
  return Response.json(await platformOwnerScrub({ apply: false }), { headers });
});

export const POST = withTenant(async (req: Request) => {
  const got = await requireSuperAdmin();
  if (got.response) return got.response;
  const ws = requireTenant();
  if (isHouseWorkspace(ws)) return Response.json({ error: "The house workspace keeps the platform owner's name." }, { status: 400, headers });
  const body = (await req.json().catch(() => ({}))) as { confirm?: unknown; expected?: unknown };
  if (body.confirm !== true || typeof body.expected !== "number") {
    return Response.json({ error: "Run the dry run first, then confirm its total." }, { status: 400, headers });
  }
  const dry = await platformOwnerScrub({ apply: false });
  if (dry.total !== body.expected) {
    return Response.json({ error: "The count changed since the dry run. Check it again.", dryRun: dry }, { status: 409, headers });
  }
  return Response.json(await platformOwnerScrub({ apply: true }), { headers });
}, { requireRequestScope: true });
