import { requireUser, withTenant } from "@/lib/auth";
import { downloadFilename } from "@/lib/downloadName";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };
const MAX = 2000;

/**
 * The workspace's naming template (R9) for the renders an export carries, so
 * the editorial package, its EDL/FCPXML/XML and the shot list name media the
 * way the workspace's downloads do. Names come back without an extension; the
 * export adds the one its bytes actually have.
 */
export const POST = withTenant(async (req: Request) => {
  const got = await requireUser();
  if (got.response) return got.response;
  const body = (await req.json().catch(() => null)) as { generationIds?: unknown } | null;
  const ids = Array.isArray(body?.generationIds) ? [...new Set(body.generationIds.filter((id): id is string => typeof id === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(id)))] : [];
  if (ids.length > MAX) return Response.json({ error: `An export can name at most ${MAX.toLocaleString("en-US")} renders.` }, { status: 413, headers: NO_STORE });
  const names: Record<string, string> = {};
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const resolved = await Promise.all(batch.map((id) => downloadFilename(id, "")));
    batch.forEach((id, j) => { names[id] = resolved[j]; });
  }
  return Response.json({ names }, { headers: NO_STORE });
});
