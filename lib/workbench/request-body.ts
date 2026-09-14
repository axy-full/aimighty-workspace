import { readBoundedText, RequestBodyError } from "../requestBody";

/** Keep the complete source while bounding actual network bytes, including chunked requests. */
export async function readProjectBody(
  req: Request,
): Promise<
  { ok: true; value: unknown } | { ok: false; status: number; error: string }
> {
  if (!req.body)
    return {
      ok: false,
      status: 400,
      error: "Send the complete production JSON.",
    };
  try {
    return { ok: true, value: JSON.parse(await readBoundedText(req, 3_500_000)) };
  } catch (error) {
    if (error instanceof RequestBodyError && error.status === 413)
      return { ok: false, status: 413, error: "Production exceeds the 3.5 MB limit." };
    return {
      ok: false,
      status: 400,
      error: "Send valid UTF-8 production JSON.",
    };
  }
}
