import { requireUser, withTenant } from "@/lib/auth";
import { db, ready } from "@/lib/db";
import { downloadFilename, noTakeFilename } from "@/lib/downloadName";
import { mayReadTake } from "@/lib/draftProject";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };
const MAX = 2000;

/**
 * The workspace's naming template (R9) for the renders an export carries, so
 * the editorial package, its EDL/FCPXML/XML and the shot list name media the
 * way the workspace's downloads do. Names come back without an extension; the
 * export adds the one its bytes actually have.
 *
 * A name carries the production, scene, shot and maker, so only a take this
 * person may read is named (lib/draftProject.ts mayReadTake). A take of a
 * private board they may not see is answered as an id that names no take:
 * the template with the id alone, the same answer and the same status.
 */
export const POST = withTenant(async (req: Request) => {
  const got = await requireUser();
  if (got.response) return got.response;
  const body = (await req.json().catch(() => null)) as { generationIds?: unknown } | null;
  const ids = Array.isArray(body?.generationIds) ? [...new Set(body.generationIds.filter((id): id is string => typeof id === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(id)))] : [];
  if (ids.length > MAX) return Response.json({ error: `An export can name at most ${MAX.toLocaleString("en-US")} renders.` }, { status: 413, headers: NO_STORE });
  await ready();
  const names: Record<string, string> = {};
  const readable = new Map<string, Promise<boolean>>();
  const mayRead = (projectId: string | null) => {
    const key = projectId ?? "";
    if (!readable.has(key)) readable.set(key, mayReadTake(got.user, projectId));
    return readable.get(key)!;
  };
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    /* One read per batch: which of these ids are takes of this workspace (the tenant's database), and the project each is filed under. */
    const rows = (await db().execute({ sql: "SELECT id, project_id FROM generations WHERE id IN (SELECT value FROM json_each(?))", args: [JSON.stringify(batch)] })).rows;
    const projectOf = new Map(rows.map((row) => [String(row.id), row.project_id == null ? null : String(row.project_id)]));
    const resolved = await Promise.all(batch.map(async (id) =>
      projectOf.has(id) && (await mayRead(projectOf.get(id)!)) ? downloadFilename(id, "") : noTakeFilename(id, "")));
    batch.forEach((id, j) => { names[id] = resolved[j]; });
  }
  return Response.json({ names }, { headers: NO_STORE });
});
