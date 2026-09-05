import { NextResponse } from "next/server";
import { requireUser, withTenant } from "@/lib/auth";
import { elevenConfigured, subscription } from "@/lib/elevenlabs";

export const dynamic = "force-dynamic";

/** Where the ElevenLabs account stands this cycle: credits used and left. */
export const GET = withTenant(async function GET() {
  const got = await requireUser();
  if (got.response) return got.response;
  if (!elevenConfigured()) return NextResponse.json({ configured: false, account: null });
  try {
    return NextResponse.json({ configured: true, account: await subscription() });
  } catch (e) {
    return NextResponse.json({ configured: true, account: null, error: (e as Error).message });
  }
});
