import { requireSession, withTenant } from "@/lib/auth";
import { listConsents, recordConsent } from "@/lib/security/consent";
import { ConsentError } from "@/lib/security/consent-words";
import { PeopleOnlyError } from "@/lib/security/people-only";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };
const ID = /^[A-Za-z0-9_.:-]{1,160}$/;

function refused(error: unknown): Response {
  if (error instanceof ConsentError || error instanceof PeopleOnlyError) return Response.json({ error: error.message }, { status: error.status, headers });
  throw error;
}

/**
 * Identity consent records (lib/security/consent.ts). A production's records, for the Cast card.
 *
 * Session only, both ways: a record names a real person and links their recording, so an API or MCP token can
 * neither read nor write one, and recording consent is people-only (owner rule).
 */
export const GET = withTenant(async (req: Request) => {
  const got = await requireSession();
  if (got.response) return got.response;
  const q = new URL(req.url).searchParams;
  const projectId = q.get("projectId") ?? "";
  const subject = q.get("subject");
  if (!ID.test(projectId) || (subject != null && !ID.test(subject))) return Response.json({ error: "Which production?" }, { status: 400, headers });
  try {
    return Response.json({ consents: await listConsents(projectId, subject) }, { headers });
  } catch (error) { return refused(error); }
});

export const POST = withTenant(async (req: Request) => {
  const got = await requireSession();
  if (got.response) return got.response;
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return Response.json({ error: "Send the consent record." }, { status: 400, headers });
  try {
    const consent = await recordConsent(body, { user: got.user });
    return Response.json({ consent }, { status: 201, headers });
  } catch (error) { return refused(error); }
}, { requireRequestScope: true });
