import { NextResponse } from "next/server";
import { requireUser, withTenant } from "@/lib/auth";
import { listElements, ensureRig, createElement, addVersion, syncTrainedVersions } from "@/lib/elements";
import { isElementKind } from "@/lib/rig";
import { getSetting } from "@/lib/settings";

/**
 * The element library of the workspace in scope (brief 3).
 *
 * Read-only for now: what the layer holds, so the surfaces built on top of it
 * have something to read and so the backfill can be seen to have happened.
 * The first read of a workspace's library is what runs the backfill, once, so
 * no cold start pays for a migration nobody asked for.
 */
export const dynamic = "force-dynamic";

export const GET = withTenant(async function GET(req: Request) {
  const got = await requireUser();
  if (got.response) return got.response;

  const backfill = await ensureRig(got.user.id);
  /* A face that finished training since the last read becomes its asset's current version. */
  try { await syncTrainedVersions(); } catch { /* the list still answers */ }

  const projectId = new URL(req.url).searchParams.get("projectId");
  const scoped = projectId && projectId !== "all" && projectId !== "unfiled" ? projectId : null;
  const elements = await listElements(scoped);

  return NextResponse.json({ elements, backfill });
});

/**
 * A new asset (design/particl-v2/README.md §11, §12): creating is free. A
 * name and a kind make it, with its kind's attributes in place and empty; a
 * reference (`fromUploadId`) or a take (`fromGenId`) becomes the first
 * attribute's first version, current at once. Nothing here trains anything —
 * the priced switch is the sheet's (§12), and the sheet is step 8's.
 */
export const POST = withTenant(async function POST(req: Request) {
  const got = await requireUser();
  if (got.response) return got.response;
  const b = await req.json().catch(() => ({}));
  /* CR1 §10 Duplicate: a copy of an existing asset — same kind, same references, nothing trained. */
  if (typeof b?.cloneOf === "string" && b.cloneOf) {
    const { cloneElement } = await import("@/lib/elements");
    const copy = await cloneElement(b.cloneOf, got.user.id, typeof b?.name === "string" && b.name.trim() ? b.name.trim() : undefined);
    if (!copy) return NextResponse.json({ error: "No such element." }, { status: 404 });
    return NextResponse.json({ element: copy }, { status: 201 });
  }
  const name = String(b?.name ?? "").trim().slice(0, 60);
  if (!name) return NextResponse.json({ error: "Name it first — you'll type it as @Name." }, { status: 400 });
  const kind = isElementKind(b?.kind) ? b.kind : "character";
  const projectId = typeof b?.projectId === "string" && b.projectId ? b.projectId : null;
  const fromGenId = typeof b?.fromGenId === "string" && b.fromGenId ? b.fromGenId : null;
  const fromUploadId = typeof b?.fromUploadId === "string" && b.fromUploadId ? b.fromUploadId : null;
  const castId = typeof b?.castId === "string" && b.castId ? b.castId : null;
  const identityId = typeof b?.identityId === "string" && b.identityId ? b.identityId : null;
  const description = typeof b?.description === "string" ? b.description.slice(0, 400) : "";
  const refs: { uploadId: string | null; genId: string | null }[] = Array.isArray(b?.references)
    ? b.references.filter((r: unknown) => r && typeof r === "object").map((r: Record<string, unknown>) => ({ uploadId: typeof r.uploadId === "string" ? r.uploadId : null, genId: typeof r.genId === "string" ? r.genId : null })).filter((r: { uploadId: string | null; genId: string | null }) => r.uploadId || r.genId).slice(0, 24)
    : (fromUploadId || fromGenId) ? [{ uploadId: fromUploadId, genId: fromGenId }] : [];
  const el = await createElement({ name, kind, description, projectId, castId, fromGenId: fromGenId ?? refs[0]?.genId ?? null }, got.user.id);
  const first = el.attributes[0];
  if (first) {
    /* Every reference is a version of the first attribute (the canonical still, the plate, the look), the first one current (§12: attributes are read from references). */
    for (let i = 0; i < refs.length; i++) {
      const r = refs[i];
      await addVersion(first.id, r.uploadId ? { uploadId: r.uploadId } : { genId: r.genId }, { label: `v${i + 1}`, makeCurrent: i === 0 }, got.user.id);
    }
    /* A trained face is a version too — pending until the trainer finishes, so nothing points at it yet. */
    if (identityId) await addVersion(first.id, { identityId }, { label: "trained", status: "pending" }, got.user.id);
  }
  /* §13 · Rig & locks: a workspace that locks new assets locks this one from the start. */
  if ((await getSetting("lockNewAssets")) === "1") { const { setElementLock } = await import("@/lib/elements"); await setElementLock(el.id, true, got.user.id); }
  const { getElement } = await import("@/lib/elements");
  return NextResponse.json({ element: (await getElement(el.id)) ?? el }, { status: 201 });
});
