import { requireSession, withTenant } from "@/lib/auth";
import { MAX_RECORDING_BYTES, storeConsentRecording } from "@/lib/security/consent";
import { ConsentError } from "@/lib/security/consent-words";
import { PeopleOnlyError } from "@/lib/security/people-only";
import { readBoundedBytes, RequestBodyError } from "@/lib/requestBody";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };
const TOO_LONG = "Keep the recording under 4 MB: about a minute of the person agreeing.";

/**
 * The recording of a person agreeing, for a consent record (lib/security/consent.ts). Its own store, never an upload:
 * it is not listed in the library, can't be picked as a reference and is never sent to an engine. People only.
 */
export const POST = withTenant(async (req: Request) => {
  const got = await requireSession();
  if (got.response) return got.response;
  /* Counted as it arrives, Content-Length or not (a chunked body has none): stopped at the limit, never buffered past it
     (review of #558, L-D). */
  let body: Uint8Array;
  try {
    body = await readBoundedBytes(req, MAX_RECORDING_BYTES);
  } catch (error) {
    if (!(error instanceof RequestBodyError)) throw error;
    return Response.json({ error: error.status === 413 ? TOO_LONG : "Send the recording as the request body." }, { status: error.status, headers });
  }
  try {
    const bytes = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
    const recording = await storeConsentRecording({ bytes, mime: req.headers.get("content-type") ?? "" }, { user: got.user });
    return Response.json({ recording }, { status: 201, headers });
  } catch (error) {
    if (error instanceof ConsentError || error instanceof PeopleOnlyError) return Response.json({ error: error.message }, { status: error.status, headers });
    throw error;
  }
}, { requireRequestScope: true });
