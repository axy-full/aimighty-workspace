import { NextResponse } from "next/server";
import { allowanceCheck } from "@/lib/allowance";
import { requireUser, withTenant } from "@/lib/auth";
import {
  listIdentities, createIdentity, syncIdentity,
  MIN_PHOTOS, MAX_PHOTOS, RECOMMENDED_PHOTOS, TRAIN_STEPS, trainCostUsd, RENDER_USD_PER_MP, TRAINER,
} from "@/lib/identities";
import { falConfigured } from "@/lib/fal";
import { creditsApply } from "@/lib/credits";
import { billCredits } from "@/lib/creditTerms";
import { currentTenant } from "@/lib/tenant";

export const dynamic = "force-dynamic";

/** The identities this project can see, and the terms training runs on. */
export const GET = withTenant(async function GET(req: Request) {
  const got = await requireUser();
  if (got.response) return got.response;
  const url = new URL(req.url);
  const projectId = url.searchParams.get("projectId");
  const identities = await listIdentities(projectId && projectId !== "all" && projectId !== "unfiled" ? projectId : null);
  /* The queue strip (brief 1.3) asks every few seconds only to know what is
     training. It reads the rows as they stand — asking fal about each one on
     every poll would be a vendor call per wall, per person, per fifteen
     seconds. The Studio, which shows progress, still syncs. */
  const inCredits = creditsApply(currentTenant()?.workspace);
  if (url.searchParams.get("live") === "1") {
    return NextResponse.json({
      identities: identities.filter((i) => i.status === "training")
        /* The unit this workspace pays in, like every other priced row. The
           queue strip used to be handed the vendor's dollars and convert them
           in the browser, which needed the margin to be there to convert with. */
        .map((i) => ({
          id: i.id, name: i.name, status: i.status, steps: i.steps, createdAt: i.createdAt,
          costUsd: inCredits ? null : i.costUsd,
          creditsBilled: inCredits && i.costUsd != null ? billCredits(i.costUsd, "identity-training") : null,
        })),
    });
  }
  // Anything mid-training gets asked about while the list is being read, so
  // the grid never shows a face as training after the trainer has finished.
  const synced = await Promise.all(identities.map(async (i) =>
    i.status === "training" ? (await syncIdentity(i)).identity : i));
  return NextResponse.json({
    identities: synced.map((i) => ({ ...i, loraUrl: undefined, configUrl: undefined, trained: Boolean(i.loraUrl) })),
    terms: {
      configured: falConfigured(),
      trainer: TRAINER,
      minPhotos: MIN_PHOTOS, maxPhotos: MAX_PHOTOS, recommended: RECOMMENDED_PHOTOS,
      steps: TRAIN_STEPS,
      /* The unit this workspace pays in. `trainCostUsd` is the vendor's price
         for a training run; a credit workspace is quoted the charge instead. */
      trainCostUsd: inCredits ? null : trainCostUsd(),
      trainCredits: inCredits ? billCredits(trainCostUsd(), "identity-training") : null,
      renderUsdPerMp: inCredits ? null : RENDER_USD_PER_MP,
    },
  });
});

export const POST = withTenant(async function POST(req: Request) {
  const got = await requireUser();
  if (got.response) return got.response;
  const allowance = await allowanceCheck("fal");
  if (!allowance.ok) return NextResponse.json({ error: allowance.error }, { status: allowance.status });
  const body = await req.json().catch(() => ({}));
  try {
    const identity = await createIdentity({
      name: String(body.name ?? ""),
      description: String(body.description ?? ""),
      photos: Array.isArray(body.photos) ? body.photos.map(String) : [],
      projectId: body.projectId ? String(body.projectId) : null,
      userId: got.user.id,
    });
    return NextResponse.json({ identity: { ...identity, loraUrl: undefined, configUrl: undefined } }, { status: 201 });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
});
