import { currentTenant } from "./tenant";

/**
 * Whose key pays for a render.
 *
 * Every workspace brings its own vendor keys, sealed in its record and
 * unsealed only inside the process that is about to use them. The one
 * exception is the platform's own workspace — the studio that runs the
 * deployment — which may fall back to the environment's keys. Nobody else
 * ever reaches those: a workspace without a key of its own for a vendor
 * simply has that vendor unrouted.
 */
export type VendorKeyName = "ark" | "gemini" | "gateway" | "fal" | "elevenlabs";

const ENV: Record<VendorKeyName, string> = {
  ark: "ARK_API_KEY", gemini: "GEMINI_API_KEY", gateway: "AI_GATEWAY_API_KEY",
  fal: "FAL_KEY", elevenlabs: "ELEVENLABS_API_KEY",
};

export const VENDOR_KEYS: { name: VendorKeyName; label: string; does: string }[] = [
  { name: "ark", label: "BytePlus ModelArk", does: "Seedance video · Seedream prompt writer" },
  { name: "gateway", label: "Vercel AI Gateway", does: "Claude prompt writer · Nano Banana stills" },
  { name: "gemini", label: "Google Gemini", does: "Nano Banana stills, direct" },
  { name: "fal", label: "fal.ai", does: "Identity training · portrait renders" },
  { name: "elevenlabs", label: "ElevenLabs", does: "Voice · sound effects · music" },
];

export function vendorKey(name: VendorKeyName): string | null {
  const ws = currentTenant()?.workspace;
  if (ws && !ws.usesPlatformKeys) return ws.keys[name] || null;
  return process.env[ENV[name]] || null;
}

/** The same lookup by environment-variable name, for code that speaks in those. */
export function vendorKeyForEnv(envName: string): string | null {
  const entry = (Object.entries(ENV) as [VendorKeyName, string][]).find(([, e]) => e === envName);
  return entry ? vendorKey(entry[0]) : null;
}

/**
 * May this workspace use the deployment's own identity (Vercel OIDC) at
 * the gateway? Only the platform's workspace: that identity bills the
 * deployment's credit, and the deployment belongs to one studio.
 */
export function deploymentIdentityAllowed(): boolean {
  const ws = currentTenant()?.workspace;
  return !ws || ws.usesPlatformKeys;
}
