/**
 * A response body read into memory, but never past a stated size.
 *
 * For small provider files (stills, audio lines) that are kept whole on
 * purpose. A declared Content-Length over the cap is refused before a byte
 * is read; an undeclared or understated one is cut off the moment it passes
 * the cap, and the connection is cancelled. Large media goes through the
 * streaming store instead (storeVideo in lib/storage.ts).
 */

export class BodyTooLargeError extends Error {
  readonly code = "BODY_TOO_LARGE";
  constructor(readonly limit: number, message?: string) {
    super(message ?? `The file is larger than the ${Math.round(limit / (1024 * 1024))} MB limit.`);
    this.name = "BodyTooLargeError";
  }
}

export async function readBodyCapped(res: Response, maxBytes: number, message?: string): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("Invalid file limit.");
  const declared = res.headers.get("content-length");
  if (declared != null && Number(declared) > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw new BodyTooLargeError(maxBytes, message);
  }
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader(), chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new BodyTooLargeError(maxBytes, message);
      }
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    }
    return Buffer.concat(chunks, total);
  } finally { reader.releaseLock(); }
}
