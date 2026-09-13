import { NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { platformLayerState, setPlatformLayer, resetPlatformLayer } from "@/lib/platform";
import { DEFAULT_LAYER, LAYER_KEYS, type LayerKey } from "@/lib/platformLayer";
import { CATEGORIES } from "@/lib/studio";
import { PLATFORM_RECIPES } from "@/lib/runs";

export const dynamic = "force-dynamic";

/**
 * The platform layer as it stands, its defaults, and the camera bank as it reads today.
 *
 * Board 12h adds the one-line summary the desk prints ('What every new studio starts with'):
 *   curl -b "$COOKIE" http://localhost:4550/api/admin/platform-layer
 *   { layer, stored, defaults, cameraBank,                       // as before
 *     summary: { setupRows, rules, recipes, starter, capCredits, warnPct, grantBudgetUsd } }
 *   setupRows = the Setup categories (CATEGORIES), rules = layer.rules, recipes = PLATFORM_RECIPES
 *   (a constant, seeded per workspace — not a layer key), starter = the demo production's name,
 *   capCredits/warnPct/grantBudgetUsd = layer.caps. Every number is read, none is typed.
 * PATCH is unchanged: { key, value } | { key, reset: true }, key one of LAYER_KEYS.
 */
export async function GET() {
  const got = await requireSuperAdmin();
  if (got.response) return got.response;
  const state = await platformLayerState();
  const bank = CATEGORIES.filter((c) => c.key === "move" || c.key === "technique").flatMap((c) =>
    c.options.map((o) => ({ kind: c.key, value: o.value, label: o.label, module: (o as { module?: string }).module ?? "" })));
  const layer = state.value;
  const summary = {
    setupRows: CATEGORIES.length,
    rules: layer.rules.length,
    recipes: PLATFORM_RECIPES.length,
    starter: layer.starter.name,
    capCredits: layer.caps.defaultCapCredits,
    warnPct: layer.caps.warnPct,
    grantBudgetUsd: layer.caps.grantBudgetUsd ?? null,
  };
  return NextResponse.json({ layer, stored: state.stored, defaults: DEFAULT_LAYER, cameraBank: bank, summary });
}

/** Override one part of the layer, or put it back to the default. */
export async function PATCH(req: Request) {
  const got = await requireSuperAdmin();
  if (got.response) return got.response;
  const body = await req.json().catch(() => ({}));
  const key = String(body.key ?? "") as LayerKey;
  if (!LAYER_KEYS.includes(key)) return NextResponse.json({ error: `key must be one of ${LAYER_KEYS.join(", ")}.` }, { status: 400 });
  const layer = body.reset ? await resetPlatformLayer(key) : await setPlatformLayer(key, body.value, got.user.id);
  const state = await platformLayerState();
  return NextResponse.json({ ok: true, layer, stored: state.stored });
}
