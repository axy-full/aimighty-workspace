import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { PROVIDERS, providerConfigured, providerBaseUrl } from "@/lib/providers";
import { MODELS } from "@/lib/models";
import { allSettings } from "@/lib/settings";
import { usingBlob } from "@/lib/storage";
import { IMAGE_LIMITS } from "@/lib/imagemeta";

export const dynamic = "force-dynamic";

/**
 * The facts behind the platform page. Everything here is READ OFF THE RUNNING
 * SYSTEM rather than typed into a document — limits come from the provider
 * registry, storage mode from the env, the filename protocol from settings.
 * A page that answers "are files compressed?" must not be able to go stale.
 */
export async function GET() {
  const got = await requireUser();
  if (got.response) return got.response;
  const settings = await allSettings();

  return NextResponse.json({
    storage: {
      mode: usingBlob() ? "vercel-blob-private" : "local-disk",
      region: process.env.VERCEL_REGION ?? "local",
      database: process.env.TURSO_DATABASE_URL ? "turso" : "sqlite",
      maxImageBytes: IMAGE_LIMITS.maxBytes,
      maxRequestBytes: IMAGE_LIMITS.maxRequestBytes,
      chunkedUploads: true,
      chunkedMaxBytes: 2 * 1024 * 1024 * 1024,
      derivesForApi: settings.deriveForApi !== "0",
      namingTemplate: settings.namingTemplate,
    },
    providers: PROVIDERS.map((p) => ({
      id: p.id,
      label: p.label,
      configured: providerConfigured(p),
      baseUrl: providerBaseUrl(p),
      docs: p.docs,
      limits: p.limits,
      rateLimit: p.rateLimit,
      billsFailures: p.billsFailures,
      models: MODELS.filter((m) => m.provider === p.id).map((m) => ({
        id: m.id, label: m.label, kind: m.kind,
      })),
    })),
    reliability: {
      maxRetries: Number(settings.maxRetries ?? 2),
      cron: "/api/cron/sync every 10 minutes",
      health: "/api/health (add ?deep=1 for a live storage probe)",
    },
  });
}
