import { NextResponse } from "next/server";
import { requireRender, withTenant } from "@/lib/auth";
import { transcribe } from "@/lib/transcription";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Grok transcription of one stored original: quote with `quoteOnly`, then transcribe at the approved ceiling. */
export const POST = withTenant(async function POST(req: Request) {
  const got = await requireRender();
  if (got.response) return got.response;
  const origin = req.headers.get("origin");
  if (origin && origin !== new URL(req.url).origin) return NextResponse.json({ error: "Invalid request origin" }, { status: 403 });
  const body = await req.json().catch(() => ({}));
  const reply = await transcribe(body, got.user.id);
  return NextResponse.json(reply.body, { status: reply.status, headers: { "Cache-Control": "no-store" } });
});
