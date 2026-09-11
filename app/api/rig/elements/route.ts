import { NextResponse } from "next/server";
import { requireUser, withTenant } from "@/lib/auth";
import { listElements, ensureRig, createElement, addVersion } from "@/lib/elements";
import { isElementKind } from "@/lib/rig";

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
  const name = String(b?.name ?? "").trim().slice(0, 60);
  if (!name) return NextResponse.json({ error: "Name it first — you'll type it as @Name." }, { status: 400 });
  const kind = isElementKind(b?.kind) ? b.kind : "character";
  const projectId = typeof b?.projectId === "string" && b.projectId ? b.projectId : null;
  const fromGenId = typeof b?.fromGenId === "string" && b.fromGenId ? b.fromGenId : null;
  const fromUploadId = typeof b?.fromUploadId === "string" && b.fromUploadId ? b.fromUploadId : null;
  const el = await createElement({ name, kind, projectId, fromGenId }, got.user.id);
  const first = el.attributes[0];
  if (first && (fromUploadId || fromGenId)) {
    await addVersion(first.id, fromUploadId ? { uploadId: fromUploadId } : { genId: fromGenId }, { label: "v1", makeCurrent: true }, got.user.id);
  }
  const { getElement } = await import("@/lib/elements");
  return NextResponse.json({ element: (await getElement(el.id)) ?? el }, { status: 201 });
});
