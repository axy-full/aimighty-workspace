import { NextResponse } from "next/server";
import { requireUser, withTenant } from "@/lib/auth";
import { getIdentity, updateIdentity, deleteIdentity, syncIdentity } from "@/lib/identities";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

const publicView = (i: Awaited<ReturnType<typeof getIdentity>>) =>
  i ? { ...i, loraUrl: undefined, configUrl: undefined, trained: Boolean(i.loraUrl) } : null;

/** One identity — asked about at the trainer if it is still training. */
export const GET = withTenant(async function GET(_req: Request, { params }: Ctx) {
  const got = await requireUser();
  if (got.response) return got.response;
  const { id } = await params;
  const found = await getIdentity(id);
  if (!found) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const { identity, progress } = await syncIdentity(found);
  return NextResponse.json({ identity: publicView(identity), progress });
});

export const PATCH = withTenant(async function PATCH(req: Request, { params }: Ctx) {
  const got = await requireUser();
  if (got.response) return got.response;
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  try {
    const identity = await updateIdentity(id, {
      name: body.name !== undefined ? String(body.name) : undefined,
      description: body.description !== undefined ? String(body.description) : undefined,
      photos: Array.isArray(body.photos) ? body.photos.map(String) : undefined,
      coverUploadId: body.coverUploadId !== undefined ? (body.coverUploadId ? String(body.coverUploadId) : null) : undefined,
    });
    return NextResponse.json({ identity: publicView(identity) });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
});

/** Removing an identity keeps its renders; they are on the ledger. */
export const DELETE = withTenant(async function DELETE(_req: Request, { params }: Ctx) {
  const got = await requireUser();
  if (got.response) return got.response;
  const { id } = await params;
  await deleteIdentity(id);
  return NextResponse.json({ ok: true });
});
