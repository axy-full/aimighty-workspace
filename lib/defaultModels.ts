import { allSettings } from "./settings";
import { getPlatformLayer } from "./platform";
import { resolveModels, type PlatformModels } from "./platformLayer";

/** The engines this workspace's composer opens on: its Defaults & caps, else the platform's. Tenant-scoped through allSettings(). */
export async function effectiveModels(): Promise<PlatformModels> {
  const [settings, layer] = await Promise.all([allSettings(), getPlatformLayer()]);
  return resolveModels(settings, layer);
}

/**
 * The engines a composer opens on, and nothing else: what a person is sent (GET /api/me, and the session every page is rendered with).
 * The text jobs' models are the platform's, read by its console on its own route, and a thinking model is never sent to a person
 * (Amendment (iii) §E); GET /api/settings sends the same two.
 */
export async function memberModels(): Promise<Pick<PlatformModels, "video" | "image">> {
  const { video, image } = await effectiveModels();
  return { video, image };
}
