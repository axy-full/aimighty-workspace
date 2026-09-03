import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { startTraining } from "@/lib/identities";

export const dynamic = "force-dynamic";
export const maxDuration = 120;
type Ctx = { params: Promise<{ id: string }> };

/** Hand the photos to the trainer. Returns as soon as the job is queued. */
export async function POST(_req: Request, { params }: Ctx) {
  const got = await requireUser();
  if (got.response) return got.response;
  const { id } = await params;
  try {
    const identity = await startTraining(id);
    return NextResponse.json({ identity: { ...identity, loraUrl: undefined, configUrl: undefined, trained: false } }, { status: 202 });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
