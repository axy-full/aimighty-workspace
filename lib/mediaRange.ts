export type ByteRange = { start: number; end: number; total: number };
/** Only a single finite byte range is accepted; multipart responses are never fabricated. */
export function byteRange(
  header: string | null,
  total: number,
): ByteRange | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (
    !match ||
    !Number.isSafeInteger(total) ||
    total < 1 ||
    (!match[1] && !match[2])
  )
    throw new Error("Unsatisfiable byte range");
  let start: number, end: number;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix < 1)
      throw new Error("Unsatisfiable byte range");
    start = Math.max(0, total - suffix);
    end = total - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : total - 1;
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start >= total ||
      end < start
    )
      throw new Error("Unsatisfiable byte range");
    end = Math.min(end, total - 1);
  }
  return { start, end, total };
}
