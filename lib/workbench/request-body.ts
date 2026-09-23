import { gunzipSync } from "node:zlib";
import { readBoundedBytes, readBoundedText, RequestBodyError } from "../requestBody";
import { PROJECT_ENCODING_HEADER, PROJECT_JSON_BYTES, PROJECT_WIRE_BYTES } from "./project-limits";

/**
 * Keep the complete source while bounding actual network bytes, including
 * chunked requests. A feature-sized project arrives gzipped (the browser packs
 * saves over 256 KB); it is bounded twice, on the wire and once unpacked.
 */
export async function readProjectBody(
  req: Request,
): Promise<
  { ok: true; value: unknown } | { ok: false; status: number; error: string }
> {
  if (!req.body)
    return {
      ok: false,
      status: 400,
      error: "Send the complete project JSON.",
    };
  const tooLarge = { ok: false as const, status: 413, error: "Project exceeds the 24 MB limit." };
  try {
    if (req.headers.get(PROJECT_ENCODING_HEADER) === "gzip") {
      const packed = await readBoundedBytes(req, PROJECT_WIRE_BYTES);
      let text: string;
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(gunzipSync(packed, { maxOutputLength: PROJECT_JSON_BYTES })); }
      catch (error) {
        if ((error as { code?: string }).code === "ERR_BUFFER_TOO_LARGE" || error instanceof RangeError) return tooLarge;
        throw error;
      }
      return { ok: true, value: JSON.parse(text) };
    }
    return { ok: true, value: JSON.parse(await readBoundedText(req, PROJECT_WIRE_BYTES)) };
  } catch (error) {
    if (error instanceof RequestBodyError && error.status === 413)
      return req.headers.get(PROJECT_ENCODING_HEADER) === "gzip" ? tooLarge : { ok: false, status: 413, error: "Project exceeds the 4 MB limit for an uncompressed save." };
    return {
      ok: false,
      status: 400,
      error: "Send valid UTF-8 project JSON.",
    };
  }
}
