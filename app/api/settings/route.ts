import { NextResponse } from "next/server";
import { requireUser, requireAdmin } from "@/lib/auth";
import { allSettings, setSetting, DEFAULTS } from "@/lib/settings";

export const dynamic = "force-dynamic";

export async function GET() {
  const got = await requireUser();
  if (got.response) return got.response;
  return NextResponse.json({ settings: await allSettings(), defaults: DEFAULTS });
}

/** Workspace-wide settings are the admin's to set — they change everyone's files. */
export async function PATCH(req: Request) {
  const got = await requireAdmin();
  if (got.response) return got.response;
  const body = await req.json().catch(() => ({}));
  const keys = Object.keys(DEFAULTS);
  const changed: string[] = [];
  for (const [k, v] of Object.entries(body)) {
    if (!keys.includes(k)) continue;
    if (k === "promptWriter" && !["none", "byteplus", "claude"].includes(String(v))) {
      return NextResponse.json({ error: "Prompt writer must be none, byteplus or claude." }, { status: 400 });
    }
    await setSetting(k, String(v).slice(0, 400), got.user.id);
    changed.push(k);
  }
  if (!changed.length) return NextResponse.json({ error: "Nothing to change." }, { status: 400 });
  return NextResponse.json({ settings: await allSettings(), changed });
}
