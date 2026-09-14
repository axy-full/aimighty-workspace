import {recoveryRoute} from '@/lib/recovery';
import { NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { platformLayerState, setPlatformLayer, resetPlatformLayer } from "@/lib/platform";
import { DEFAULT_LAYER, LAYER_KEYS, type LayerKey } from "@/lib/platformLayer";
import { CATEGORIES } from "@/lib/studio";

export const dynamic = "force-dynamic";

/** The platform layer as it stands, its defaults, and the camera bank as it reads today. */
export const GET = recoveryRoute(async function GET() {
  const got = await requireSuperAdmin();
  if (got.response) return got.response;
  const state = await platformLayerState();
  const bank = CATEGORIES.filter((c) => c.key === "move" || c.key === "technique").flatMap((c) =>
    c.options.map((o) => ({ kind: c.key, value: o.value, label: o.label, module: (o as { module?: string }).module ?? "" })));
  return NextResponse.json({ layer: state.value, stored: state.stored, defaults: DEFAULT_LAYER, cameraBank: bank });
});

/** Override one part of the layer, or put it back to the default. */
export const PATCH = recoveryRoute(async function PATCH(req: Request) {
  const got = await requireSuperAdmin();
  if (got.response) return got.response;
  const body = await req.json().catch(() => ({}));
  const key = String(body.key ?? "") as LayerKey;
  if (!LAYER_KEYS.includes(key)) return NextResponse.json({ error: `key must be one of ${LAYER_KEYS.join(", ")}.` }, { status: 400 });
  const layer = body.reset ? await resetPlatformLayer(key) : await setPlatformLayer(key, body.value, got.user.id);
  const state = await platformLayerState();
  return NextResponse.json({ ok: true, layer, stored: state.stored });
});
