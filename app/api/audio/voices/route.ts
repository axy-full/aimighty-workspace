import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { elevenConfigured, listVoices } from "@/lib/elevenlabs";

export const dynamic = "force-dynamic";

/** The voices, fresh from the account (bypassing the ten-minute memo). */
export async function GET(req: Request) {
  const got = await requireUser();
  if (got.response) return got.response;
  if (!elevenConfigured()) return NextResponse.json({ voices: [], configured: false });
  const force = new URL(req.url).searchParams.get("refresh") === "1";
  try {
    return NextResponse.json({ voices: await listVoices(force), configured: true });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
