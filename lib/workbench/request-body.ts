/** Keep the complete source while bounding actual network bytes, including chunked requests. */
export async function readProjectBody(
  req: Request,
): Promise<
  { ok: true; value: unknown } | { ok: false; status: number; error: string }
> {
  const limit = 3_500_000;
  const large = () => ({
    ok: false as const,
    status: 413,
    error: "Production exceeds the 3.5 MB limit.",
  });
  if (Number(req.headers.get("content-length") || 0) > limit) return large();
  const reader = req.body?.getReader();
  if (!reader)
    return {
      ok: false,
      status: 400,
      error: "Send the complete production JSON.",
    };
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0,
    text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > limit) {
        await reader.cancel();
        return large();
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return { ok: true, value: JSON.parse(text) };
  } catch {
    await reader.cancel().catch(() => {});
    return {
      ok: false,
      status: 400,
      error: "Send valid UTF-8 production JSON.",
    };
  } finally {
    reader.releaseLock();
  }
}
