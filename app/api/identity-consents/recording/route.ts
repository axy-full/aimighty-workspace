import { requireSession, withTenant } from "@/lib/auth";
import { MAX_RECORDING_BYTES, storeConsentRecording } from "@/lib/security/consent";
import { ConsentError } from "@/lib/security/consent-words";
import { PeopleOnlyError } from "@/lib/security/people-only";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };

/**
 * The recording of a person agreeing, for a consent record (lib/security/consent.ts). Its own store, never an upload:
 * it is not listed in the library, can't be picked as a reference and is never sent to an engine. People only.
 */
export const POST = withTenant(async (req: Request) => {
  const got = await requireSession();
  if (got.response) return got.response;
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_RECORDING_BYTES) return Response.json({ error: "Keep the recording under 4 MB: about a minute of the person agreeing." }, { status: 413, headers });
  try {
    const bytes = Buffer.from(await req.arrayBuffer());
    const recording = await storeConsentRecording({ bytes, mime: req.headers.get("content-type") ?? "" }, { user: got.user });
    return Response.json({ recording }, { status: 201, headers });
  } catch (error) {
    if (error instanceof ConsentError || error instanceof PeopleOnlyError) return Response.json({ error: error.message }, { status: error.status, headers });
    throw error;
  }
}, { requireRequestScope: true });
