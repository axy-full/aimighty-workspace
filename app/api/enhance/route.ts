import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { enhancePrompt } from "@/lib/enhance";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request) {
  const got = await requireUser();
  if (got.response) return got.response;

  const body = await req.json().catch(() => ({}));
  const prompt = String(body.prompt ?? "").trim();
  if (!prompt) return NextResponse.json({ error: "Write something first." }, { status: 400 });
  if (prompt.length > 10000) return NextResponse.json({ error: "Prompt too long." }, { status: 400 });

  const citations: string[] = Array.isArray(body.citations)
    ? body.citations.map(String).slice(0, 60)
    : [];

  try {
    const refined = await enhancePrompt({ prompt, citations });
    return NextResponse.json({ prompt: refined });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
