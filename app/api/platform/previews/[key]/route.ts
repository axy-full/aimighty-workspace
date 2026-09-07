import { withTenant } from "@/lib/auth";
import { usingBlob, presignedReadUrl, platformPath, readPlatformBytes } from "@/lib/storage";

export const dynamic = "force-dynamic";

/** One neutral preview clip: a short-lived redirect to storage, or the bytes locally. */
export const GET = withTenant(async function GET(req: Request, ctx: { params: Promise<{ key: string }> }) {
  const { key } = await ctx.params;
  const k = decodeURIComponent(key);
  if (!/^[a-z]+:[a-z0-9_-]+$/i.test(k)) return new Response("bad key", { status: 400 });
  const file = `previews/${k}.mp4`;
  if (usingBlob()) {
    const signed = await presignedReadUrl(platformPath(file), 6);
    if (new URL(req.url).searchParams.get("stream") === "1") {
      const range = req.headers.get("range");
      const upstream = await fetch(signed, { headers: range ? { Range: range } : {}, cache: "no-store" });
      const headers = new Headers({ "Cache-Control": "private, max-age=3600" });
      for (const h of ["content-type", "content-length", "content-range", "accept-ranges"]) { const v = upstream.headers.get(h); if (v) headers.set(h, v); }
      if (!headers.has("content-type")) headers.set("content-type", "video/mp4");
      return new Response(upstream.body, { status: upstream.status, headers });
    }
    return new Response(null, { status: 302, headers: { Location: signed, "Cache-Control": "private, no-store" } });
  }
  try {
    const buf = await readPlatformBytes(file);
    return new Response(new Uint8Array(buf), { status: 200, headers: { "content-type": "video/mp4", "content-length": String(buf.length), "Cache-Control": "private, max-age=3600" } });
  } catch {
    return new Response("not found", { status: 404 });
  }
});
