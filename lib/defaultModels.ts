import { allSettings } from "./settings";
import { getPlatformLayer } from "./platform";
import { resolveModels, type PlatformModels } from "./platformLayer";

/** The engines this workspace's composer opens on: its Defaults & caps, else the platform's. Tenant-scoped through allSettings(). */
export async function effectiveModels(): Promise<PlatformModels> {
  const [settings, layer] = await Promise.all([allSettings(), getPlatformLayer()]);
  return resolveModels(settings, layer);
}
