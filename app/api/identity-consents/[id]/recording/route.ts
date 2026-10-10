import { requireSession, withTenant } from "@/lib/auth";
import { readConsentRecording } from "@/lib/security/consent";
import { ConsentError } from "@/lib/security/consent-words";
import { PeopleOnlyError } from "@/lib/security/people-only";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** A consent record's recording, to the recorder, an owner or an admin, signed in. Never a token. */
export const GET = withTenant(async (_req: Request, { params }: Ctx) => {
  const got = await requireSession();
  if (got.response) return got.response;
  const { id } = await params;
  if (!/^[A-Za-z0-9_.:-]{1,160}$/.test(id)) return Response.json({ error: "Which consent record?" }, { status: 400 });
  try {
    const { bytes, mime } = await readConsentRecording(id, { user: got.user });
    return new Response(new Uint8Array(bytes), { headers: { "Content-Type": mime, "Content-Length": String(bytes.length), "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
  } catch (error) {
    if (error instanceof ConsentError || error instanceof PeopleOnlyError) return Response.json({ error: error.message }, { status: error.status });
    throw error;
  }
});
