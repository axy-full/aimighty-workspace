import { requireSession, withTenant } from "@/lib/auth";
import { withdrawConsent } from "@/lib/security/consent";
import { ConsentError } from "@/lib/security/consent-words";
import { PeopleOnlyError } from "@/lib/security/people-only";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };
const headers = { "Cache-Control": "private, no-store" };

/** Withdraw a consent record: marked, never erased (lib/security/consent.ts). People only. */
export const DELETE = withTenant(async (_req: Request, { params }: Ctx) => {
  const got = await requireSession();
  if (got.response) return got.response;
  const { id } = await params;
  if (!/^[A-Za-z0-9_.:-]{1,160}$/.test(id)) return Response.json({ error: "Which consent record?" }, { status: 400, headers });
  try {
    return Response.json({ ok: await withdrawConsent(id, { user: got.user }) }, { headers });
  } catch (error) {
    if (error instanceof ConsentError || error instanceof PeopleOnlyError) return Response.json({ error: error.message }, { status: error.status, headers });
    throw error;
  }
}, { requireRequestScope: true });
