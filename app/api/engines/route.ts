import { NextResponse } from "next/server";
import { PROVIDERS, providerConfigured } from "@/lib/providers";
import { MODELS } from "@/lib/models";
import { requireUser } from "@/lib/auth";
import { refinerDescription } from "@/lib/enhance";

export const dynamic = "force-dynamic";

/**
 * Which vendors this deployment can actually talk to. Reports only whether
 * a key is present — never a value — so the composer can grey out an engine
 * whose key is missing and Settings can say which variable to set.
 */
export async function GET() {
  const got = await requireUser();
  if (got.response) return got.response;
  const writer = refinerDescription();
  return NextResponse.json({
    /* Who writes the prompts too thin to film: shown on Settings › Engines
       and greyed in the composer's menu when it cannot be reached. */
    refiner: {
      ...writer,
      configured: writer.provider !== "byteplus" || Boolean(process.env.ARK_API_KEY),
    },
    engines: PROVIDERS.map((p) => ({
      id: p.id,
      label: p.label,
      envKey: p.envKey,
      docs: p.docs,
      configured: providerConfigured(p),
      models: MODELS.filter((m) => m.provider === p.id)
        .map((m) => ({ id: m.id, label: m.label, kind: m.kind })),
    })),
  });
}
