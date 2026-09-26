import { isEnhancerProvider } from "@/lib/shell/enhancer";
import { NextResponse } from "next/server";
import { requireUser, requireAdmin, withTenant } from "@/lib/auth";
import { allSettings, setSetting, DEFAULTS } from "@/lib/settings";
import { getPlatformLayer } from "@/lib/platform";
import { resolveModels, modelOfKind } from "@/lib/platformLayer";
import { settingProblem } from "@/lib/settingValues";

export const dynamic = "force-dynamic";

export const GET = withTenant(async function GET() {
  const got = await requireUser();
  if (got.response) return got.response;
  const [settings, layer] = await Promise.all([allSettings(), getPlatformLayer()]);
  return NextResponse.json({ settings, defaults: DEFAULTS, models: resolveModels(settings, layer), platformModels: layer.models });
});

/** Workspace-wide settings are the admin's to set — they change everyone's files. */
export const PATCH = withTenant(async function PATCH(req: Request) {
  const got = await requireAdmin();
  if (got.response) return got.response;
  const body = await req.json().catch(() => ({}));
  const keys = Object.keys(DEFAULTS);
  const changed: string[] = [];
  const entries = Object.entries(body).filter(([k]) => keys.includes(k));
  /* Every value is checked before any is written, so a refused save changes nothing. */
  for (const [k, v] of entries) {
    if (k === "promptWriter" && !["none", "byteplus", "claude"].includes(String(v))) {
      return NextResponse.json({ error: "Choose a supported prompt writer." }, { status: 400 });
    }
    if (k === "promptEnhancer" && !isEnhancerProvider(v)) {
      return NextResponse.json({ error: "Choose a supported prompt enhancer." }, { status: 400 });
    }
    if ((k === "defaultVideoModel" || k === "defaultImageModel") && String(v) !== "" && !modelOfKind(String(v), k === "defaultVideoModel" ? "video" : "image")) {
      return NextResponse.json({ error: k === "defaultVideoModel" ? "Not a video engine." : "Not a still engine." }, { status: 400 });
    }
    /* A value the reader does not know used to be stored and then read as the default — "always" turned approvals off. */
    const problem = settingProblem(k, v);
    if (problem) return NextResponse.json({ error: problem }, { status: 400 });
  }
  for (const [k, v] of entries) {
    await setSetting(k, String(v).slice(0, 400), got.user.id);
    changed.push(k);
  }
  if (!changed.length) return NextResponse.json({ error: "Nothing to change." }, { status: 400 });
  return NextResponse.json({ settings: await allSettings(), changed });
}, { requireRequestScope: true });
