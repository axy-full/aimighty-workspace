export class RequestBodyError extends Error {
  constructor(public status: 400 | 413) {
    super(
      status === 413 ? "Request body is too large." : "Invalid request body.",
    );
    this.name = "RequestBodyError";
  }
}

/** Count wire bytes before decoding, including when Content-Length is absent or false. */
export async function readBoundedText(
  req: Request,
  limit: number,
): Promise<string> {
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new Error("Invalid body limit.");
  if (Number(req.headers.get("content-length") || 0) > limit) {
    // Cancellation is best effort; a broken source must not delay or change the 413.
    void req.body?.cancel().catch(() => {});
    throw new RequestBodyError(413);
  }
  if (!req.body) throw new RequestBodyError(400);
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = req.body.getReader();
  } catch {
    throw new RequestBodyError(400);
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0,
    text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > limit) throw new RequestBodyError(413);
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error instanceof RequestBodyError ? error : new RequestBodyError(400);
  } finally {
    reader.releaseLock();
  }
}

/** Count wire bytes like readBoundedText, but keep them raw (a compressed body). */
export async function readBoundedBytes(
  req: Request,
  limit: number,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new Error("Invalid body limit.");
  if (Number(req.headers.get("content-length") || 0) > limit) {
    void req.body?.cancel().catch(() => {});
    throw new RequestBodyError(413);
  }
  if (!req.body) throw new RequestBodyError(400);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > limit) throw new RequestBodyError(413);
      chunks.push(chunk.value);
    }
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error instanceof RequestBodyError ? error : new RequestBodyError(400);
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.byteLength; }
  return out;
}
