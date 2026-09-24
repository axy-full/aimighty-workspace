import { NextResponse } from "next/server";
import { requireUser, withTenant } from "@/lib/auth";
import { elevenConfigured, listVoices } from "@/lib/elevenlabs";
import { GROK_TTS_MODEL, grokVoiceConfigured, listGrokVoices } from "@/lib/xaiVoice";

export const dynamic = "force-dynamic";

/** The voices, fresh from the account (bypassing the ten-minute memo). */
export const GET = withTenant(async function GET(req: Request) {
  const got = await requireUser();
  if (got.response) return got.response;
  const q = new URL(req.url).searchParams;
  const force = q.get("refresh") === "1";
  /* Grok Voice's own voices (xAI's built-in list) when that model is chosen. */
  if (q.get("model") === GROK_TTS_MODEL) {
    if (!grokVoiceConfigured()) return NextResponse.json({ voices: [], configured: false });
    try { return NextResponse.json({ voices: (await listGrokVoices(force)).map((v) => ({ id: v.id, name: v.name })), configured: true }); }
    catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 502 }); }
  }
  if (!elevenConfigured()) return NextResponse.json({ voices: [], configured: false });
  try {
    return NextResponse.json({ voices: await listVoices(force), configured: true });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
});
