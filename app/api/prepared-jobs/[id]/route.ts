import { requireSession, withTenant } from "@/lib/auth";
import { PreparedError, decidePrepared } from "@/lib/security/prepared-jobs";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };
const headers = { "Cache-Control": "private, no-store" };

/** A person opens a prepared job in Make, or dismisses it (lib/security/prepared-jobs.ts). Never a token. */
export const PATCH = withTenant(async (req: Request, { params }: Ctx) => {
  const got = await requireSession();
  if (got.response) return got.response;
  const { id } = await params;
  if (!/^[A-Za-z0-9_.:-]{1,160}$/.test(id)) return Response.json({ error: "Which job?" }, { status: 400, headers });
  const body = await req.json().catch(() => ({}));
  try {
    return Response.json({ ok: await decidePrepared(id, body?.state, got.user.id) }, { headers });
  } catch (error) {
    if (error instanceof PreparedError) return Response.json({ error: error.message }, { status: error.status, headers });
    throw error;
  }
}, { requireRequestScope: true });
