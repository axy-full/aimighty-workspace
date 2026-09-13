import { NextResponse } from "next/server";
import { PROVIDERS, providerConfigured, providerVia } from "@/lib/providers";
import { MODELS, atomikMayPropose } from "@/lib/models";
import { requireUser, withTenant } from "@/lib/auth";
import { activeWriter, gatewayCredits } from "@/lib/enhance";
import { safetyThreshold } from "@/lib/gemini";
import { getSetting, invalidateSettings } from "@/lib/settings";
import { ENGINES } from "@/lib/engines";
import { estimateRefineUsd } from "@/lib/refineGate";
import { cleanRule, cleanShotCap } from "@/lib/approvalRule";
import { engineSwitches } from "@/lib/platform";

export const dynamic = "force-dynamic";

/**
 * Which vendors this deployment can actually talk to. Reports only whether
 * a key is present — never a value — so the composer can grey out an engine
 * whose key is missing and Settings can say which variable to set.
 *
 * Board 12h: each engine also says whether the platform has paused it.
 *   curl -b "$COOKIE" http://localhost:4550/api/engines
 *   { ..., engines: [{ ..., paused: boolean, pausedReason: string | null }] }
 * The composer keeps a paused engine in the list, disabled with the reason;
 * the refusal itself lives where money starts (lib/meter.ts, the spend routes).
 */
export const GET = withTenant(async function GET() {
  const got = await requireUser();
  if (got.response) return got.response;
  // Settings are memoed per function for ten seconds; a person who has just
  // changed the writer must see the change, so this route always re-reads.
  invalidateSettings();
  const writer = await activeWriter();
  const credits = writer.provider === "gateway" ? await gatewayCredits() : null;
  const switches = await engineSwitches().catch(() => null);
  return NextResponse.json({
    /* What is left on the gateway, when the writer runs through it. */
    gatewayCredits: credits,
    /* Who writes the prompts too thin to film — the workspace's choice on
       Settings › Prompt, resolved to what this deployment can reach. */
    /* And what one of its calls costs at list price — a typical idea, the house style along — so the button can say it. */
    /* The cost approval rule, so the composer can say it before the press (brief 2.2). */
    approval: { rule: cleanRule(await getSetting("approvalRule")), shotCapCredits: cleanShotCap(await getSetting("shotCapCredits")) },
    refiner: { ...writer, usdPerCall: writer.writer === "none" ? 0 : (estimateRefineUsd(writer.model, 60, 1500) ?? 0) },
    engines: PROVIDERS.map((p) => ({
      id: p.id,
      label: p.label,
      envKey: p.envKey,
      docs: p.docs,
      configured: providerConfigured(p),
      /** Switched off from the platform's desk (board 12h); the reason is shown beside it. */
      paused: switches ? !switches[p.id]?.on : false,
      pausedReason: switches && !switches[p.id]?.on ? (switches[p.id]?.reason ?? null) : null,
      kinds: ENGINES[p.id]?.kinds ?? [],
      /** "key" for the vendor's own key, "gateway" for Vercel AI Gateway. */
      via: providerVia(p),
      /** Google only: where its adjustable safety thresholds sit. */
      safety: p.id === "google" ? (safetyThreshold() ?? "Google default") : undefined,
      models: MODELS.filter((m) => m.provider === p.id)
        .map((m) => ({ id: m.id, label: m.label, kind: m.kind, use: m.use ?? null, atomikMayPropose: atomikMayPropose(m) })),
    })),
  });
});
