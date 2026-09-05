import { NextResponse } from "next/server";
import { PROVIDERS, providerConfigured, providerVia } from "@/lib/providers";
import { MODELS } from "@/lib/models";
import { requireUser, withTenant } from "@/lib/auth";
import { activeWriter, gatewayCredits } from "@/lib/enhance";
import { safetyThreshold } from "@/lib/gemini";
import { invalidateSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

/**
 * Which vendors this deployment can actually talk to. Reports only whether
 * a key is present — never a value — so the composer can grey out an engine
 * whose key is missing and Settings can say which variable to set.
 */
export const GET = withTenant(async function GET() {
  const got = await requireUser();
  if (got.response) return got.response;
  // Settings are memoed per function for ten seconds; a person who has just
  // changed the writer must see the change, so this route always re-reads.
  invalidateSettings();
  const writer = await activeWriter();
  const credits = writer.provider === "gateway" ? await gatewayCredits() : null;
  return NextResponse.json({
    /* What is left on the gateway, when the writer runs through it. */
    gatewayCredits: credits,
    /* Who writes the prompts too thin to film — the workspace's choice on
       Settings › Prompt, resolved to what this deployment can reach. */
    refiner: writer,
    engines: PROVIDERS.map((p) => ({
      id: p.id,
      label: p.label,
      envKey: p.envKey,
      docs: p.docs,
      configured: providerConfigured(p),
      /** "key" for the vendor's own key, "gateway" for Vercel AI Gateway. */
      via: providerVia(p),
      /** Google only: where its adjustable safety thresholds sit. */
      safety: p.id === "google" ? (safetyThreshold() ?? "Google default") : undefined,
      models: MODELS.filter((m) => m.provider === p.id)
        .map((m) => ({ id: m.id, label: m.label, kind: m.kind })),
    })),
  });
});
