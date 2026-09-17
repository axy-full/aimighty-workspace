import { requireUser, withTenant } from "@/lib/auth";
import { getSoulIdentity, syncSoulIdentity } from "@/lib/soulIdentities";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
export const GET = withTenant(
  async (
    _request: Request,
    { params }: { params: Promise<{ id: string }> },
  ) => {
    const got = await requireUser();
    if (got.response) return got.response;
    const { id } = await params;
    const found = await getSoulIdentity(id);
    if (!found)
      return Response.json({ error: "Soul ID not found." }, { status: 404 });
    return Response.json(
      { identity: (await syncSoulIdentity(id)) ?? found },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  },
);
